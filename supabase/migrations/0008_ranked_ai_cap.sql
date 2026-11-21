-- Ranked wins against an AI commander lift a player to at most 200 above
-- that commander's fixed rating. Without the cap, beating the same commander
-- over and over climbs the ladder forever (slowly, but at launch there are
-- few humans to outrank). Losses to a commander still count in full.

-- One side's rating change for a result. AI commanders keep their rating.
create or replace function public.seven_rating_delta(me public.ranked_profiles, opp public.ranked_profiles, score integer)
returns integer language sql stable set search_path = public as $$
  select case
    when exists (select 1 from public.match_bots b where b.player = me.player) then 0
    when score = 1 and exists (select 1 from public.match_bots b where b.player = opp.player)
      then least(public.seven_elo_delta(me.rating, opp.rating, me.games, 1), greatest(0, opp.rating + 200 - me.rating))
    else public.seven_elo_delta(me.rating, opp.rating, me.games, score)
  end
$$;

-- As in 0004, rated through seven_rating_delta.
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
    hd := public.seven_rating_delta(h, g, (winner = 'blue')::integer);
    gd := public.seven_rating_delta(g, h, (winner = 'red')::integer);
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

-- As in 0004; the stakes shown use seven_rating_delta too.
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
      'win', public.seven_rating_delta(me, opp, 1),
      'loss', public.seven_rating_delta(me, opp, 0)) end,
    'result', case when r.match_id is not null then jsonb_build_object(
      'won', r.winner = team, 'reason', r.reason, 'delta', case when team = 'blue' then r.host_delta else r.guest_delta end,
      'rating', me.rating, 'rank', (public.seven_ranked_card(me, actor))->'rank') end);
end;
$$;

do $$
begin
  revoke all on function public.seven_rating_delta(public.ranked_profiles, public.ranked_profiles, integer) from public;
  if exists (select from pg_roles where rolname = 'anon') then
    revoke all on function public.seven_rating_delta(public.ranked_profiles, public.ranked_profiles, integer) from anon, authenticated;
    grant execute on function public.seven_rating_delta(public.ranked_profiles, public.ranked_profiles, integer) to service_role;
  end if;
end $$;
