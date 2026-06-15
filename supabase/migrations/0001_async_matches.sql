-- Async ("play-by-mail") online matches.
-- See docs/async-play.md for the full design.
--
-- This project has no Supabase CLI wired up; apply this in the Supabase
-- dashboard SQL editor (or via `supabase db push` if the CLI is added later).
-- It is idempotent enough to re-run during development.

-- Requires anonymous auth to be enabled:
--   Dashboard -> Authentication -> Providers -> Anonymous sign-ins -> Enable

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------

create table if not exists public.matches (
  id            text primary key,
  host_player   uuid not null,
  guest_player  uuid,
  initial_state jsonb not null,
  latest_state  jsonb not null,
  seed          bigint,
  current_round int  not null default 1,
  status        text not null default 'open'
                  check (status in ('open','active','host_won','guest_won','abandoned')),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists public.turns (
  match_id     text not null references public.matches(id) on delete cascade,
  round        int  not null,
  team         text not null check (team in ('blue','red')),
  player       uuid not null,
  commit_hash  bigint not null,
  paths        jsonb,
  submitted_at timestamptz not null default now(),
  revealed_at  timestamptz,
  primary key (match_id, round, team)
);

create index if not exists turns_match_idx on public.turns(match_id);
create index if not exists matches_players_idx
  on public.matches(host_player, guest_player);

-- Realtime: clients subscribe to Postgres changes on both tables.
alter publication supabase_realtime add table public.matches;
alter publication supabase_realtime add table public.turns;

-- ---------------------------------------------------------------------------
-- Row Level Security
--
-- Anonymous auth gives every client a stable auth.uid(). A participant is the
-- host or the guest of a match. Blind fairness is enforced by commit-reveal at
-- the application layer (paths are NULL until both have committed), not by RLS.
-- ---------------------------------------------------------------------------

alter table public.matches enable row level security;
alter table public.turns   enable row level security;

create or replace function public.is_match_participant(m_id text)
returns boolean
language sql
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.matches m
    where m.id = m_id
      and auth.uid() in (m.host_player, m.guest_player)
  );
$$;

-- matches ----------------------------------------------------------------

-- Read: participants, plus open matches waiting for a guest (so a friend can
-- discover/join via the share link).
create policy matches_select on public.matches
  for select using (
    auth.uid() in (host_player, guest_player)
    or (status = 'open' and guest_player is null)
  );

-- Create: only as yourself, as the host.
create policy matches_insert on public.matches
  for insert with check (host_player = auth.uid());

-- Update: participants only. A guest may claim an open match; either
-- participant may advance the match (snapshot / round / status).
create policy matches_update on public.matches
  for update using (
    auth.uid() in (host_player, guest_player)
    or (status = 'open' and guest_player is null)
  ) with check (
    auth.uid() in (host_player, guest_player)
  );

-- turns ------------------------------------------------------------------

-- Read: any participant of the match (paths are NULL pre-reveal regardless).
create policy turns_select on public.turns
  for select using (public.is_match_participant(match_id));

-- Commit: insert your own row for a match you participate in.
create policy turns_insert on public.turns
  for insert with check (
    player = auth.uid() and public.is_match_participant(match_id)
  );

-- Reveal: update only your own row.
create policy turns_update on public.turns
  for update using (player = auth.uid())
  with check (player = auth.uid());

-- ---------------------------------------------------------------------------
-- updated_at maintenance
-- ---------------------------------------------------------------------------

create or replace function public.touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists matches_touch on public.matches;
create trigger matches_touch before update on public.matches
  for each row execute function public.touch_updated_at();
