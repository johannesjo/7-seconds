-- Reliability: inactivity timeout / abandon for async matches.
-- See docs/plans/2026-06-16-unified-online-reliability.md (Part 1.4b).
--
-- Apply in the Supabase dashboard SQL editor (this project has no Supabase CLI
-- wired up). Idempotent enough to re-run during development.
--
-- A match can otherwise wait forever on a player who never returns. This adds a
-- per-match inactivity clock and a job that flips long-idle matches to
-- 'abandoned', so the other player can move on (and the matches list isn't
-- cluttered with zombies). Pure SQL — no engine/Edge Function needed.

-- ---------------------------------------------------------------------------
-- Columns
-- ---------------------------------------------------------------------------

-- When either player last acted (created the match, or committed a turn). The
-- abandon clock measures from here. Backfilled from updated_at for live matches.
alter table public.matches
  add column if not exists last_move_at timestamptz not null default now();

update public.matches set last_move_at = updated_at
  where last_move_at is null or last_move_at < updated_at;

-- How long a match may sit idle before it's eligible for auto-abandon. Friend
-- matches want a long fuse (days); matchmade/stranger games set a short one
-- (a stranger won't come back for turn 2). Default suits friend play.
alter table public.matches
  add column if not exists abandon_after interval not null default interval '7 days';

create index if not exists matches_abandon_idx
  on public.matches(status, last_move_at);

-- ---------------------------------------------------------------------------
-- Keep last_move_at fresh on every player action (commit AND reveal)
--
-- A turn insert (commit) and a turn update (reveal) are both real "moves", so
-- touch the parent match's clock for both. Firing only on insert would let a
-- match that's slowly working through the reveal phase look idle — and once a
-- short abandon_after is set for stranger games, get wrongly auto-abandoned
-- mid-round. NEW.match_id is present and unchanged on insert and update alike.
-- SECURITY DEFINER so it runs regardless of the player's row-level update rights
-- (they are a participant, but this keeps the trigger robust to policy changes).
-- ---------------------------------------------------------------------------

create or replace function public.touch_match_activity()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  update public.matches set last_move_at = now() where id = NEW.match_id;
  return NEW;
end;
$$;

drop trigger if exists turns_touch_match on public.turns;
create trigger turns_touch_match after insert or update on public.turns
  for each row execute function public.touch_match_activity();

-- ---------------------------------------------------------------------------
-- The expiry job
--
-- Flip any in-play match that has been idle longer than its abandon_after to
-- 'abandoned'. Returns the number of matches expired (handy when run by hand).
-- Realtime then pushes the status change to any connected client, and the
-- controller's onGameOver('abandoned') fires.
-- ---------------------------------------------------------------------------

create or replace function public.expire_abandoned_matches()
returns integer language plpgsql security definer set search_path = public as $$
declare
  expired integer;
begin
  with done as (
    update public.matches
       set status = 'abandoned'
     where status in ('open','active')
       and last_move_at < now() - abandon_after
    returning 1
  )
  select count(*) into expired from done;
  return expired;
end;
$$;

-- This is SECURITY DEFINER and flips other players' matches to 'abandoned', so
-- it must not be callable by every signed-in user via RPC. Only the scheduler
-- (pg_cron / service role) should run it; the owner and service_role keep
-- execute rights, anon/authenticated lose theirs.
revoke execute on function public.expire_abandoned_matches() from public;

-- Schedule hourly via pg_cron when available. pg_cron must be enabled first
-- (Dashboard -> Database -> Extensions -> pg_cron). If it isn't enabled, this
-- block is skipped and the function can still be invoked by any external
-- scheduler (e.g. a GitHub Action) calling `select public.expire_abandoned_matches();`.
do $$
begin
  if exists (select 1 from pg_extension where extname = 'pg_cron') then
    perform cron.unschedule('expire-abandoned-matches')
      where exists (select 1 from cron.job where jobname = 'expire-abandoned-matches');
    perform cron.schedule(
      'expire-abandoned-matches', '0 * * * *',
      $cron$ select public.expire_abandoned_matches(); $cron$
    );
  end if;
end $$;
