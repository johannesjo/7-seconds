-- The match referee: server-authoritative online play, random matchmaking with
-- AI commanders, ranked Elo with Play Games profiles, and turn alert devices.
-- See docs/online-play.md. Applied by scripts/apply-migrations.mjs in one
-- transaction.
--
-- Until now clients wrote matches and turns directly: they committed hashed
-- plans, revealed them, resolved each round and wrote the result, and RLS
-- could only protect identity columns. A player could claim a win, rewrite the
-- board or join any open match listed through RLS. From here on every gameplay
-- write goes through the `match-referee` Edge Function, which calls the
-- service-only functions below:
--
--   * Plans are held in `match_plans`, which no client can read. A round is
--     resolved by the referee the moment both plans are in, with the same
--     deterministic engine the clients animate, and only then are both plans
--     published on `turns`. No commit-reveal step is left for players to do.
--   * Clients can only read their own matches (RLS select) and follow them
--     with Realtime. Joining, forfeiting and matchmaking are referee actions.
--   * Every match carries its rules version. Matches made before this
--     migration can't be resolved under the referee's protocol, so the ones
--     still in play end here (finish_reason 'version').

create schema if not exists seven_private;
revoke all on schema seven_private from public;
do $$ begin
  if exists (select from pg_roles where rolname = 'anon') then
    execute 'revoke all on schema seven_private from anon';
    execute 'grant usage on schema seven_private to anon, authenticated, service_role';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

alter table public.matches
  add column if not exists rules integer not null default 1,
  add column if not exists ranked boolean not null default false,
  add column if not exists matchmaking boolean not null default false,
  -- The start state and seed of the round before current_round, so a player
  -- who wasn't watching can replay what happened while they were away.
  add column if not exists prev_state jsonb,
  add column if not exists prev_seed bigint,
  add column if not exists host_name text check (char_length(host_name) between 1 and 40),
  add column if not exists guest_name text check (char_length(guest_name) between 1 and 40),
  -- The guest seat is held by an AI commander.
  add column if not exists guest_bot boolean not null default false,
  add column if not exists finish_reason text
    check (finish_reason in ('battle','forfeit','timeout','cancelled','abandoned','version')),
  add column if not exists finished_at timestamptz;

-- Turn rows are now written by the referee: a row with null paths marks a
-- submitted plan; the paths appear once the round has been resolved.
alter table public.turns alter column commit_hash drop not null;

create index if not exists matches_queue_idx on public.matches (ranked, created_at)
  where matchmaking and status = 'open';

-- ---------------------------------------------------------------------------
-- Tables only the referee touches
-- ---------------------------------------------------------------------------

create table if not exists public.match_plans (
  match_id   text not null references public.matches(id) on delete cascade,
  round      int  not null,
  team       text not null check (team in ('blue','red')),
  paths      jsonb not null,
  created_at timestamptz not null default now(),
  primary key (match_id, round, team)
);

-- AI commanders. Not Supabase users: no session can ever act as them.
create table if not exists public.match_bots (
  player     uuid primary key,
  name       text not null check (char_length(name) between 1 and 40),
  difficulty text not null check (difficulty in ('recruit','veteran')),
  -- Their fixed ranked rating: it states how strong each one is.
  rating     integer not null,
  enabled    boolean not null default true
);

insert into public.match_bots(player, name, difficulty, rating) values
  ('00000000-0000-4000-8000-000000007a01', 'Cadet Pip (AI)', 'recruit', 1100),
  ('00000000-0000-4000-8000-000000007a02', 'Major Flint (AI)', 'veteran', 1300)
on conflict (player) do nothing;

-- Ranked: a verified Play Games player per permanent (Google) Supabase user.
create table if not exists public.ranked_profiles (
  player        uuid primary key,
  pgs_player_id text not null unique,
  display_name  text not null check (char_length(display_name) between 1 and 100),
  avatar_url    text check (avatar_url is null or avatar_url ~ '^https://lh[0-9]+\.(googleusercontent|ggpht)\.com/[^[:space:]"''<>\\]+$'),
  rating        integer not null default 1200,
  peak_rating   integer not null default 1200,
  games         integer not null default 0,
  wins          integer not null default 0,
  losses        integer not null default 0,
  created_at    timestamptz not null default now()
);
create index if not exists ranked_profiles_ladder on public.ranked_profiles (rating desc) where games > 0;

insert into public.ranked_profiles(player, pgs_player_id, display_name, rating, peak_rating)
  select player, 'ai:' || difficulty, name, rating, rating from public.match_bots
on conflict (player) do nothing;

-- One per rated match. Outlives the match, so history survives its deletion.
create table if not exists public.ranked_results (
  match_id     text primary key,
  host_player  uuid,
  guest_player uuid,
  winner       text not null check (winner in ('blue','red')),
  host_delta   integer not null,
  guest_delta  integer not null,
  reason       text not null check (reason in ('battle','forfeit','timeout')),
  rounds       integer not null,
  finished_at  timestamptz not null default now()
);
create index if not exists ranked_results_host on public.ranked_results (host_player, finished_at desc);
-- 17. Seat lookups (live counts, a player's matches) use these.
create index if not exists matches_host_idx on public.matches (host_player);
create index if not exists matches_guest_idx on public.matches (guest_player);
create index if not exists ranked_results_guest on public.ranked_results (guest_player, finished_at desc);

-- Turn alert devices (Firebase Cloud Messaging tokens) per Supabase user.
create table if not exists public.push_devices (
  player     uuid not null,
  token      text not null check (char_length(token) between 20 and 4096),
  updated_at timestamptz not null default now(),
  primary key (player, token)
);
create index if not exists push_devices_token on public.push_devices (token);

do $$
declare t text;
begin
  foreach t in array array['match_plans','match_bots','ranked_profiles','ranked_results','push_devices'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_no_client_access', t);
    execute format('create policy %I on public.%I for all to public using (false) with check (false)', t || '_no_client_access', t);
    if exists (select from pg_roles where rolname = 'anon') then
      execute format('revoke all on public.%I from anon, authenticated', t);
    end if;
  end loop;
end $$;

-- A new match must not take the id of a rated match that was deleted (with a
-- ranked profile): it would inherit that result and never be rated itself.
-- unique_violation makes the referee draw another id.
create or replace function seven_private.fresh_match_id()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  if exists (select 1 from public.ranked_results where match_id = new.id) then
    raise exception 'Match id already used' using errcode = 'unique_violation';
  end if;
  return new;
end;
$$;
revoke all on function seven_private.fresh_match_id() from public;
drop trigger if exists matches_fresh_id on public.matches;
create trigger matches_fresh_id before insert on public.matches
  for each row execute function seven_private.fresh_match_id();

-- ---------------------------------------------------------------------------
-- Clients read, the referee writes
-- ---------------------------------------------------------------------------

create or replace function seven_private.is_match_participant(m_id text)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.matches m where m.id = m_id and auth.uid() in (m.host_player, m.guest_player));
$$;
revoke all on function seven_private.is_match_participant(text) from public;
do $$ begin
  if exists (select from pg_roles where rolname = 'anon') then
    execute 'grant execute on function seven_private.is_match_participant(text) to anon, authenticated, service_role';
  end if;
end $$;

drop policy if exists matches_insert on public.matches;
drop policy if exists matches_update on public.matches;
drop policy if exists matches_select on public.matches;
-- Only the two players. Invites are joined through the referee, so open
-- matches are no longer listed to everyone.
create policy matches_select on public.matches
  for select using (auth.uid() in (host_player, guest_player));

drop policy if exists turns_insert on public.turns;
drop policy if exists turns_update on public.turns;
drop policy if exists turns_select on public.turns;
create policy turns_select on public.turns
  for select using (seven_private.is_match_participant(match_id));

do $$ begin
  if exists (select from pg_roles where rolname = 'anon') then
    execute 'revoke insert, update, delete, truncate on public.matches, public.turns from anon, authenticated';
  end if;
end $$;

drop function if exists public.is_match_participant(text);
drop function if exists public.team_for_player(text, uuid);

-- Notifications are sent by the referee now; the dashboard webhook that sent
-- them on every commit would duplicate them.
drop trigger if exists notify_turn_on_commit on public.turns;

-- Fixed search paths (security advisor), and trigger functions that no API
-- role needs to call.
alter function public.touch_updated_at() set search_path = public;
alter function public.touch_match_activity() set search_path = public;
revoke all on function public.touch_updated_at(), public.touch_match_activity() from public;
do $$ begin
  if exists (select from pg_roles where rolname = 'anon') then
    execute 'revoke all on function public.touch_updated_at(), public.touch_match_activity() from anon, authenticated';
  end if;
end $$;

create or replace function public.matches_guard()
returns trigger language plpgsql set search_path = public as $$
begin
  if new.id is distinct from old.id or new.host_player is distinct from old.host_player
    or new.initial_state is distinct from old.initial_state or new.rules is distinct from old.rules
    or new.ranked is distinct from old.ranked or new.matchmaking is distinct from old.matchmaking
    or new.created_at is distinct from old.created_at then
    raise exception 'match identity is immutable';
  end if;
  if old.guest_player is not null and new.guest_player is distinct from old.guest_player then
    raise exception 'guest_player is set-once';
  end if;
  if old.seed is not null and new.seed is distinct from old.seed then
    raise exception 'seed is write-once';
  end if;
  if old.status not in ('open','active') and new.status is distinct from old.status then
    raise exception 'a finished match stays finished';
  end if;
  return new;
end;
$$;
revoke all on function public.matches_guard() from public;

-- ---------------------------------------------------------------------------
-- Matches made under the old protocol end here
-- ---------------------------------------------------------------------------

update public.matches set status = 'abandoned', finish_reason = 'version', finished_at = now()
  where status in ('open','active') and rules <> 2;

-- ---------------------------------------------------------------------------
-- Ratings
-- ---------------------------------------------------------------------------

-- Elo. New commanders (fewer than 10 rated games) move faster, so they reach
-- their level sooner. Each side uses its own K.
create or replace function public.seven_elo_delta(rating integer, opponent integer, games integer, score integer)
returns integer language sql immutable set search_path = public as $$
  select round((case when games < 10 then 40 else 32 end) * (score - 1 / (1 + power(10::numeric, (opponent - rating)::numeric / 400))))::integer
$$;

-- End a match in play. `winner` is 'blue', 'red' or null (nobody wins: a
-- draw when reason is 'battle', both armies fell together). A ranked match
-- with a winner is rated exactly once; AI commanders keep their fixed rating
-- (their side records 0), so nobody can pump or sink one.
create or replace function public.seven_finish(m_id text, winner text, reason text)
returns public.matches language plpgsql set search_path = public as $$
declare m public.matches; h public.ranked_profiles; g public.ranked_profiles; hd integer; gd integer;
begin
  select * into m from public.matches where id = m_id for update;
  if not found or m.status not in ('open','active') then return m; end if;
  update public.matches set
    status = case winner when 'blue' then 'host_won' when 'red' then 'guest_won' else 'abandoned' end,
    finish_reason = reason, finished_at = now()
  where id = m_id returning * into m;
  -- Plans of a round that will never be played.
  delete from public.match_plans where match_id = m_id;
  if m.ranked and winner is not null and m.guest_player is not null then
    -- Stable locking order: two matches between the same players may finish together.
    perform 1 from public.ranked_profiles where player in (m.host_player, m.guest_player) order by player for update;
    select * into h from public.ranked_profiles where player = m.host_player;
    select * into g from public.ranked_profiles where player = m.guest_player;
    if h.player is null or g.player is null then return m; end if;
    hd := case when exists (select 1 from public.match_bots b where b.player = h.player) then 0
      else public.seven_elo_delta(h.rating, g.rating, h.games, (winner = 'blue')::integer) end;
    gd := case when exists (select 1 from public.match_bots b where b.player = g.player) then 0
      else public.seven_elo_delta(g.rating, h.rating, g.games, (winner = 'red')::integer) end;
    insert into public.ranked_results(match_id, host_player, guest_player, winner, host_delta, guest_delta, reason, rounds)
      values (m.id, m.host_player, m.guest_player, winner, hd, gd, reason, m.current_round)
      on conflict do nothing;
    if not found then return m; end if;
    update public.ranked_profiles set rating = rating + hd, peak_rating = greatest(peak_rating, rating + hd), games = games + 1,
      wins = wins + (winner = 'blue')::integer, losses = losses + (winner = 'red')::integer where player = m.host_player;
    update public.ranked_profiles set rating = rating + gd, peak_rating = greatest(peak_rating, rating + gd), games = games + 1,
      wins = wins + (winner = 'red')::integer, losses = losses + (winner = 'blue')::integer where player = m.guest_player;
  end if;
  return m;
end;
$$;

-- A match past its idle limit: an invite nobody joined is abandoned; a match
-- waiting on one side's plan is won by the side that submitted; a match
-- nobody played on is abandoned. An AI commander plans only during a referee
-- request, so a commander seated by the background job may never have had
-- the chance: a match waiting on its plan is abandoned, never a free win.
create or replace function public.seven_expire_match(m_id text)
returns public.matches language plpgsql set search_path = public as $$
declare m public.matches; blue_in boolean; red_in boolean;
begin
  select * into m from public.matches where id = m_id for update;
  if not found or m.status not in ('open','active') or m.last_move_at >= now() - m.abandon_after then return m; end if;
  if m.status = 'open' then return public.seven_finish(m_id, null, 'abandoned'); end if;
  blue_in := exists (select 1 from public.match_plans p where p.match_id = m_id and p.round = m.current_round and p.team = 'blue');
  red_in := exists (select 1 from public.match_plans p where p.match_id = m_id and p.round = m.current_round and p.team = 'red');
  if blue_in and not red_in and not m.guest_bot then return public.seven_finish(m_id, 'blue', 'timeout'); end if;
  if red_in and not blue_in then return public.seven_finish(m_id, 'red', 'timeout'); end if;
  return public.seven_finish(m_id, null, 'abandoned');
end;
$$;

create or replace function public.expire_abandoned_matches()
returns integer language plpgsql security definer set search_path = public as $$
declare id_ text; expired integer := 0;
begin
  for id_ in select id from public.matches where status in ('open','active') and last_move_at < now() - abandon_after order by id loop
    perform public.seven_expire_match(id_);
    expired := expired + 1;
  end loop;
  return expired;
end;
$$;

-- ---------------------------------------------------------------------------
-- Match lifecycle (called by the referee with the service role)
-- ---------------------------------------------------------------------------

create or replace function public.seven_live_count(actor uuid, is_ranked boolean)
returns integer language sql stable set search_path = public as $$
  select count(*)::integer from public.matches
  where ranked = is_ranked and status in ('open','active') and actor in (host_player, guest_player)
$$;

-- A friend invite. The referee generates the board, so nobody can hand
-- themselves a stronger army.
create or replace function public.seven_create(actor uuid, m_id text, p_rules integer, initial jsonb, p_name text)
returns public.matches language plpgsql set search_path = public as $$
declare m public.matches;
begin
  if public.seven_live_count(actor, false) >= 5 then
    raise exception 'You have 5 unfinished matches. Finish or forfeit one before starting another.';
  end if;
  insert into public.matches(id, host_player, host_name, initial_state, latest_state, rules, status, abandon_after)
    values (m_id, actor, p_name, initial, initial, p_rules, 'open', interval '7 days') returning * into m;
  return m;
end;
$$;

-- Take the free seat of a friend's invite. Rejoining your own match is fine.
create or replace function public.seven_join(actor uuid, m_id text, p_name text)
returns public.matches language plpgsql set search_path = public as $$
declare m public.matches;
begin
  select * into m from public.matches where id = m_id for update;
  if not found then raise exception 'Match not found'; end if;
  if actor in (m.host_player, m.guest_player) then return m; end if;
  if m.ranked or m.matchmaking then raise exception 'Match not found'; end if;
  if m.status <> 'open' or m.guest_player is not null then raise exception 'This match already has two players'; end if;
  -- Expired: settle it and return it as it now stands (the referee reports it).
  if m.last_move_at < now() - m.abandon_after then return public.seven_expire_match(m_id); end if;
  if public.seven_live_count(actor, false) >= 5 then
    raise exception 'You have 5 unfinished matches. Finish or forfeit one before starting another.';
  end if;
  update public.matches set guest_player = actor, guest_name = p_name, status = 'active', last_move_at = now()
    where id = m_id returning * into m;
  return m;
end;
$$;

-- Pair the caller with a random player waiting in the same pool (casual or
-- ranked) and rules version, or open a waiting match of their own that the
-- next searcher joins (or an AI commander, see seven_seat_bot). Retries are
-- safe: a caller still waiting, or paired in the last two minutes without
-- having planned yet, gets that match back.
-- Returns {match, paired}: paired is true only for the call that just joined
-- someone's search (so they are alerted once, not on every retry).
create or replace function public.seven_matchmake(actor uuid, m_id text, is_ranked boolean, p_rules integer, initial jsonb, p_name text)
returns jsonb language plpgsql set search_path = public as $$
declare m public.matches; lim integer := case when is_ranked then 10 else 5 end; nm text := p_name;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor::text, 7));
  if is_ranked then
    select display_name into nm from public.ranked_profiles where player = actor;
    if not found then raise exception 'Play Games profile required'; end if;
  end if;
  -- One searcher at a time, so two players searching together pair up instead of both waiting.
  perform pg_advisory_xact_lock(hashtextextended('seven_matchmaking', 0));
  select * into m from public.matches where matchmaking and ranked = is_ranked and rules = p_rules
    and host_player = actor and status = 'open' and last_move_at >= now() - abandon_after
    order by created_at desc limit 1 for update;
  if found then return jsonb_build_object('match', to_jsonb(m), 'paired', false); end if;
  select * into m from public.matches mm where matchmaking and ranked = is_ranked and rules = p_rules
    and actor in (host_player, guest_player) and status = 'active' and current_round = 1
    and last_move_at >= now() - interval '2 minutes'
    and not exists (select 1 from public.match_plans p where p.match_id = mm.id
      and p.team = case when mm.host_player = actor then 'blue' else 'red' end)
    order by last_move_at desc limit 1 for update;
  if found then return jsonb_build_object('match', to_jsonb(m), 'paired', false); end if;
  if public.seven_live_count(actor, is_ranked) >= lim then
    raise exception 'You have % unfinished % matches. Finish or forfeit one first.', lim, case when is_ranked then 'ranked' else 'online' end;
  end if;
  select * into m from public.matches where matchmaking and ranked = is_ranked and rules = p_rules
    and status = 'open' and guest_player is null and host_player <> actor and last_move_at >= now() - abandon_after
    order by random() limit 1 for update;
  if found then
    update public.matches set guest_player = actor, guest_name = nm, status = 'active', last_move_at = now()
      where id = m.id returning * into m;
    return jsonb_build_object('match', to_jsonb(m), 'paired', true);
  end if;
  insert into public.matches(id, host_player, host_name, initial_state, latest_state, rules, status, ranked, matchmaking, abandon_after)
    values (m_id, actor, nm, initial, initial, p_rules, 'open', is_ranked, true, interval '3 days') returning * into m;
  return jsonb_build_object('match', to_jsonb(m), 'paired', false);
end;
$$;

-- Seat an AI commander as guest in a matchmaking match that has waited at
-- least `min_wait` for a human. Ranked: the enabled commander rated closest
-- to the host, at most three unfinished commander matches per player (beyond
-- that the match keeps waiting for a human). Casual: any enabled commander,
-- or the requested difficulty. Returns the match, seated or not.
create or replace function public.seven_seat_bot(m_id text, min_wait interval, p_difficulty text default null)
returns public.matches language plpgsql set search_path = public as $$
declare m public.matches; bot public.match_bots; host_rating integer;
begin
  perform pg_advisory_xact_lock(hashtextextended('seven_matchmaking', 0));
  select * into m from public.matches where id = m_id for update;
  if not found or not m.matchmaking or m.status <> 'open' or m.guest_player is not null
    or m.created_at > now() - min_wait or m.last_move_at < now() - m.abandon_after then return m; end if;
  if m.ranked then
    if (select count(*) from public.matches o where o.ranked and o.status in ('open','active') and o.guest_bot
        and m.host_player in (o.host_player, o.guest_player)) >= 3 then return m; end if;
    select rating into host_rating from public.ranked_profiles where player = m.host_player;
    select b.* into bot from public.match_bots b where b.enabled
      order by abs(b.rating - coalesce(host_rating, 1200)), random() limit 1;
  else
    select b.* into bot from public.match_bots b where b.enabled and (p_difficulty is null or b.difficulty = p_difficulty)
      order by random() limit 1;
  end if;
  if bot.player is null then return m; end if;
  update public.matches set guest_player = bot.player, guest_name = bot.name, guest_bot = true,
    status = 'active', last_move_at = now() where id = m_id returning * into m;
  return m;
end;
$$;

-- For players who left the search screen: seat commanders in every
-- matchmaking match that has waited `wait`. Returns how many were seated.
create or replace function public.seven_assign_bots(wait interval default interval '2 minutes')
returns integer language plpgsql set search_path = public as $$
declare id_ text; seated integer := 0; m public.matches;
begin
  for id_ in select id from public.matches where matchmaking and status = 'open' and guest_player is null
      and created_at <= now() - wait and last_move_at >= now() - abandon_after order by created_at loop
    m := public.seven_seat_bot(id_, wait);
    if m.guest_bot then seated := seated + 1; end if;
  end loop;
  return seated;
end;
$$;

-- Store a team's plan for the current round. The host may plan round 1 while
-- the match still waits for a guest. Repeating the same plan is a no-op; a
-- different one is refused. Returns {match, both, inserted}: both plans are
-- in, so the referee resolves the round; inserted, this call stored the plan
-- (a repeat is not news to the opponent). A repeat that arrives after the
-- round was already played returns the match too. {expired: true}: the match
-- passed its idle limit and has just been settled.
create or replace function public.seven_submit_plan(actor uuid, m_id text, p_round integer, p_paths jsonb, p_name text default null)
returns jsonb language plpgsql set search_path = public as $$
declare m public.matches; t text; existing jsonb; inserted boolean;
begin
  select * into m from public.matches where id = m_id for update;
  if not found then raise exception 'Match not found'; end if;
  t := case actor when m.host_player then 'blue' when m.guest_player then 'red' end;
  if t is null then raise exception 'Not your match'; end if;
  -- A retry whose first attempt was played (its response was lost).
  if p_round < m.current_round and exists (select 1 from public.turns where match_id = m_id and round = p_round
      and team = t and paths = p_paths) then
    return jsonb_build_object('match', to_jsonb(m), 'both', false, 'inserted', false);
  end if;
  if m.status not in ('open','active') then raise exception 'This match has finished'; end if;
  if m.last_move_at < now() - m.abandon_after then
    m := public.seven_expire_match(m_id);
    return jsonb_build_object('match', to_jsonb(m), 'both', false, 'expired', true);
  end if;
  if p_round <> m.current_round then raise exception 'The round has changed. Reload the match.'; end if;
  select paths into existing from public.match_plans where match_id = m_id and round = p_round and team = t;
  if found then
    if existing <> p_paths then raise exception 'Your orders for this round are already in'; end if;
    inserted := false;
  else
    inserted := true;
    insert into public.match_plans(match_id, round, team, paths) values (m_id, p_round, t, p_paths);
    insert into public.turns(match_id, round, team, player) values (m_id, p_round, t, actor)
      on conflict (match_id, round, team) do nothing;
  end if;
  -- The player's current name ('' when they cleared it).
  if p_name is not null and not m.ranked then
    if t = 'blue' then update public.matches set host_name = nullif(p_name, '') where id = m_id and host_name is distinct from nullif(p_name, '');
    else update public.matches set guest_name = nullif(p_name, '') where id = m_id and guest_name is distinct from nullif(p_name, ''); end if;
  end if;
  select * into m from public.matches where id = m_id;
  return jsonb_build_object('match', to_jsonb(m), 'inserted', inserted,
    'both', (select count(*) from public.match_plans where match_id = m_id and round = p_round) = 2);
end;
$$;

-- Record a resolved round: publish both plans on `turns`, keep the round's
-- start state and seed for replays, advance the board, and finish the match
-- when a side has been eliminated (p_winner 'blue' or 'red', or 'draw' when
-- both fell together). Only lands while the match is still on p_round, so a
-- duplicate resolution is a no-op (returns false).
create or replace function public.seven_apply_round(m_id text, p_round integer, p_end jsonb, p_seed bigint, p_winner text)
returns boolean language plpgsql set search_path = public as $$
declare m public.matches;
begin
  select * into m from public.matches where id = m_id for update;
  if not found or m.status <> 'active' or m.current_round <> p_round then return false; end if;
  if (select count(*) from public.match_plans where match_id = m_id and round = p_round) <> 2 then return false; end if;
  update public.turns t set paths = p.paths, revealed_at = now()
    from public.match_plans p
    where t.match_id = m_id and t.round = p_round and p.match_id = m_id and p.round = p_round and p.team = t.team;
  update public.matches set prev_state = latest_state, prev_seed = p_seed, latest_state = p_end,
    current_round = p_round + 1, seed = coalesce(seed, p_seed), last_move_at = now()
    where id = m_id;
  delete from public.match_plans where match_id = m_id and round = p_round;
  if p_winner is not null then perform public.seven_finish(m_id, nullif(p_winner, 'draw'), 'battle'); end if;
  return true;
end;
$$;

-- Concede: the opponent wins. An invite or search nobody joined is withdrawn.
create or replace function public.seven_forfeit(actor uuid, m_id text)
returns public.matches language plpgsql set search_path = public as $$
declare m public.matches;
begin
  select * into m from public.matches where id = m_id for update;
  if not found then raise exception 'Match not found'; end if;
  if actor not in (m.host_player, coalesce(m.guest_player, m.host_player)) then raise exception 'Not your match'; end if;
  if m.status not in ('open','active') then return m; end if;
  if m.status = 'open' then return public.seven_finish(m_id, null, 'cancelled'); end if;
  return public.seven_finish(m_id, case when actor = m.host_player then 'red' else 'blue' end, 'forfeit');
end;
$$;

-- Withdraw a search or invite, but never a match someone joined meanwhile:
-- that would be a rated concession. Returns the current row either way.
create or replace function public.seven_cancel(actor uuid, m_id text)
returns public.matches language plpgsql set search_path = public as $$
declare m public.matches;
begin
  select * into m from public.matches where id = m_id for update;
  if not found or m.host_player <> actor then raise exception 'Not your match'; end if;
  if m.status = 'open' and m.guest_player is null then return public.seven_finish(m_id, null, 'cancelled'); end if;
  return m;
end;
$$;

-- ---------------------------------------------------------------------------
-- Ranked profiles and read models (no player UUIDs leave these)
-- ---------------------------------------------------------------------------

-- Bind the caller's Google account to a verified Play Games player, or
-- refresh its name and picture. Neither can be rebound to another.
create or replace function public.seven_ranked_profile(actor uuid, pgs_id text, pgs_name text, pgs_avatar text)
returns public.ranked_profiles language plpgsql set search_path = public as $$
declare p public.ranked_profiles;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor::text, 7));
  select * into p from public.ranked_profiles where player = actor for update;
  if found and p.pgs_player_id <> pgs_id then raise exception 'This account is bound to another Play Games profile'; end if;
  insert into public.ranked_profiles(player, pgs_player_id, display_name, avatar_url) values (actor, pgs_id, pgs_name, pgs_avatar)
    on conflict (player) do update set display_name = excluded.display_name, avatar_url = excluded.avatar_url
    returning * into p;
  return p;
end;
$$;

create or replace function public.seven_ranked_card(p public.ranked_profiles, viewer uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object('display_name', p.display_name, 'avatar_url', p.avatar_url, 'rating', p.rating,
    'games', p.games, 'wins', p.wins, 'losses', p.losses, 'peak_rating', p.peak_rating,
    'provisional', p.games < 10, 'you', p.player = viewer,
    'bot', exists (select 1 from public.match_bots b where b.player = p.player),
    'rank', case when p.games > 0 and not exists (select 1 from public.match_bots b where b.player = p.player)
      then 1 + (select count(*) from public.ranked_profiles o where o.games > 0 and o.rating > p.rating
                and not exists (select 1 from public.match_bots b where b.player = o.player)) end)
$$;

-- One ranked match from the actor's side: whose move it is, the opponent's
-- card, and the actor's rating change once rated.
create or replace function public.seven_ranked_battle(m public.matches, actor uuid)
returns jsonb language plpgsql stable set search_path = public as $$
declare me text; opp public.ranked_profiles; r public.ranked_results; state text;
  expired boolean := m.status in ('open','active') and m.last_move_at < now() - m.abandon_after;
begin
  me := case actor when m.host_player then 'blue' when m.guest_player then 'red' end;
  select * into opp from public.ranked_profiles where player = case me when 'blue' then m.guest_player else m.host_player end;
  select * into r from public.ranked_results where match_id = m.id;
  if m.status = 'open' and not expired then state := 'searching';
  elsif m.status = 'abandoned' then state := 'abandoned';
  elsif m.status in ('host_won','guest_won') then state := case when (m.status = 'host_won') = (me = 'blue') then 'won' else 'lost' end;
  elsif expired then state := 'expired';
  elsif exists (select 1 from public.turns t where t.match_id = m.id and t.round = m.current_round and t.team = me) then state := 'their_turn';
  else state := 'your_turn';
  end if;
  return jsonb_build_object('id', m.id, 'status', m.status, 'team', me, 'state', state, 'round', m.current_round,
    'updated_at', m.updated_at, 'matchmaking', m.matchmaking,
    'opponent', case when opp.player is not null then public.seven_ranked_card(opp, actor) end,
    'delta', case when r.match_id is null then null when me = 'blue' then r.host_delta else r.guest_delta end);
end;
$$;

create or replace function public.seven_ranked_overview(actor uuid)
returns jsonb language sql stable set search_path = public as $$
  select jsonb_build_object(
    'profile', (select public.seven_ranked_card(p, actor) from public.ranked_profiles p where p.player = actor),
    -- The player's own moves first.
    'matches', coalesce((select jsonb_agg(b order by b->>'state' <> 'your_turn', updated_at desc)
      from (select public.seven_ranked_battle(m, actor) b, m.updated_at from public.matches m
            where m.ranked and m.status in ('open','active') and actor in (m.host_player, m.guest_player)) battles), '[]'::jsonb),
    'history', coalesce((select jsonb_agg(h order by finished_at desc) from (
      select jsonb_build_object('match_id', r.match_id, 'reason', r.reason, 'finished_at', r.finished_at, 'rounds', r.rounds,
        'won', r.winner = case when r.host_player = actor then 'blue' else 'red' end,
        'delta', case when r.host_player = actor then r.host_delta else r.guest_delta end,
        'opponent', (select o.display_name from public.ranked_profiles o
                     where o.player = case when r.host_player = actor then r.guest_player else r.host_player end)) h, r.finished_at
      from public.ranked_results r where actor in (r.host_player, r.guest_player)
      order by r.finished_at desc limit 20) recent), '[]'::jsonb))
$$;

create or replace function public.seven_ranked_leaderboard(actor uuid)
returns jsonb language sql stable set search_path = public as $$
  with ladder as (
    select p, row_number() over (order by p.rating desc, p.wins desc, p.display_name, p.player) pos
    from public.ranked_profiles p
    where p.games > 0 and not exists (select 1 from public.match_bots b where b.player = p.player))
  select jsonb_build_object(
    'players', coalesce((select jsonb_agg(public.seven_ranked_card(p, actor) order by pos) from ladder where pos <= 100), '[]'::jsonb),
    -- The viewer's own card, so players outside the top 100 still see where they stand.
    'you', (select public.seven_ranked_card(p, actor) from public.ranked_profiles p where p.player = actor))
$$;

-- The in-match header: the opponent, what a win or loss would change, and
-- the result once rated.
create or replace function public.seven_ranked_view(actor uuid, m_id text)
returns jsonb language plpgsql stable set search_path = public as $$
declare m public.matches; me public.ranked_profiles; opp public.ranked_profiles; r public.ranked_results; team text;
begin
  select * into m from public.matches where id = m_id and ranked;
  team := case actor when m.host_player then 'blue' when m.guest_player then 'red' end;
  if team is null then return null; end if;
  select * into me from public.ranked_profiles where player = actor;
  select * into opp from public.ranked_profiles where player = case team when 'blue' then m.guest_player else m.host_player end;
  select * into r from public.ranked_results where match_id = m.id;
  return jsonb_build_object('team', team, 'status', m.status,
    'expired', m.status in ('open','active') and m.last_move_at < now() - m.abandon_after,
    'opponent', case when opp.player is not null then public.seven_ranked_card(opp, actor) end,
    'stakes', case when opp.player is not null and me.player is not null and m.status in ('open','active') then jsonb_build_object(
      'win', public.seven_elo_delta(me.rating, opp.rating, me.games, 1),
      'loss', public.seven_elo_delta(me.rating, opp.rating, me.games, 0)) end,
    'result', case when r.match_id is not null then jsonb_build_object(
      'won', r.winner = team, 'reason', r.reason, 'delta', case when team = 'blue' then r.host_delta else r.guest_delta end,
      'rating', me.rating, 'rank', (public.seven_ranked_card(me, actor))->'rank') end);
end;
$$;

-- Delete the caller's ranked profile: unfinished ranked matches count as
-- forfeits, their ranked matches go, and results keep only the opponent's id.
create or replace function public.seven_ranked_delete_profile(actor uuid)
returns void language plpgsql set search_path = public as $$
declare id_ text;
begin
  perform pg_advisory_xact_lock(hashtextextended(actor::text, 7));
  -- Every match row first, before any profile: a round finishing meanwhile
  -- takes its match row before profiles too, so the two can't deadlock.
  perform 1 from public.matches where ranked and actor in (host_player, guest_player) order by id for update;
  for id_ in select id from public.matches where ranked and status in ('open','active') and actor in (host_player, guest_player) order by id loop
    perform public.seven_forfeit(actor, id_);
  end loop;
  delete from public.matches where ranked and actor in (host_player, guest_player);
  update public.ranked_results set host_player = null where host_player = actor;
  update public.ranked_results set guest_player = null where guest_player = actor;
  delete from public.push_devices where player = actor;
  delete from public.ranked_profiles where player = actor;
end;
$$;

-- ---------------------------------------------------------------------------
-- Turn alert devices (clients register their own)
-- ---------------------------------------------------------------------------

create or replace function public.seven_push_register(p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare me uuid := auth.uid();
begin
  if me is null then raise exception 'sign-in required' using errcode = '42501'; end if;
  insert into public.push_devices(player, token) values (me, p_token)
    on conflict (player, token) do update set updated_at = now();
  -- The five most recent devices per player.
  delete from public.push_devices d where d.player = me and d.token not in (
    select k.token from public.push_devices k where k.player = me order by k.updated_at desc limit 5);
end $$;

create or replace function public.seven_push_unregister(p_token text)
returns void language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception 'sign-in required' using errcode = '42501'; end if;
  delete from public.push_devices where player = auth.uid() and token = p_token;
end $$;

-- Matches end within days of their last move; a device unused for 60 days has
-- nothing left to hear about.
create or replace function public.seven_prune_push_devices()
returns integer language sql set search_path = public as $$
  with gone as (delete from public.push_devices where updated_at < now() - interval '60 days' returning 1)
  select count(*)::integer from gone
$$;

-- ---------------------------------------------------------------------------
-- Privileges: the referee (service role) only, except device registration
-- ---------------------------------------------------------------------------

do $$
declare f text;
begin
  foreach f in array array[
    'public.seven_elo_delta(integer,integer,integer,integer)', 'public.seven_finish(text,text,text)',
    'public.seven_expire_match(text)', 'public.expire_abandoned_matches()', 'public.seven_live_count(uuid,boolean)',
    'public.seven_create(uuid,text,integer,jsonb,text)', 'public.seven_join(uuid,text,text)',
    'public.seven_matchmake(uuid,text,boolean,integer,jsonb,text)', 'public.seven_seat_bot(text,interval,text)',
    'public.seven_assign_bots(interval)', 'public.seven_submit_plan(uuid,text,integer,jsonb,text)',
    'public.seven_apply_round(text,integer,jsonb,bigint,text)', 'public.seven_forfeit(uuid,text)',
    'public.seven_cancel(uuid,text)', 'public.seven_ranked_profile(uuid,text,text,text)',
    'public.seven_ranked_card(public.ranked_profiles,uuid)', 'public.seven_ranked_battle(public.matches,uuid)',
    'public.seven_ranked_overview(uuid)', 'public.seven_ranked_leaderboard(uuid)', 'public.seven_ranked_view(uuid,text)',
    'public.seven_ranked_delete_profile(uuid)', 'public.seven_prune_push_devices()',
    'public.seven_push_register(text)', 'public.seven_push_unregister(text)'
  ] loop
    execute format('revoke all on function %s from public', f);
    if exists (select from pg_roles where rolname = 'anon') then
      execute format('revoke all on function %s from anon, authenticated', f);
      execute format('grant execute on function %s to service_role', f);
    end if;
  end loop;
  if exists (select from pg_roles where rolname = 'anon') then
    execute 'grant execute on function public.seven_push_register(text), public.seven_push_unregister(text) to authenticated';
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- Schedules (when pg_cron is enabled; otherwise run these from any scheduler)
-- ---------------------------------------------------------------------------

do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule(jobname) from cron.job
      where jobname in ('expire-abandoned-matches', 'seven-expire-matches', 'seven-assign-bots', 'seven-prune-push-devices');
    perform cron.schedule('seven-expire-matches', '23 * * * *', $cron$ select public.expire_abandoned_matches(); $cron$);
    perform cron.schedule('seven-assign-bots', '* * * * *', $cron$ select public.seven_assign_bots(); $cron$);
    perform cron.schedule('seven-prune-push-devices', '51 4 * * *', $cron$ select public.seven_prune_push_devices(); $cron$);
  end if;
end $$;
