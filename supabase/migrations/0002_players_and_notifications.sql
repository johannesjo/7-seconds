-- Phase 2: "your turn" notifications for absent players.
-- See docs/async-play.md. Apply after 0001_async_matches.sql.
--
-- A `players` row stores how to reach a player when the app is closed: an
-- optional email and/or a Web Push subscription. The notify-turn Edge Function
-- (supabase/functions/notify-turn) reads these with the service role and nudges
-- the player whose turn it is.

create table if not exists public.players (
  id           uuid primary key,            -- = auth.uid()
  email        text,
  web_push     jsonb,                        -- browser PushSubscription JSON
  fcm_token    text,                         -- reserved for native Android (FCM)
  notify_email boolean not null default false,
  notify_push  boolean not null default true,
  updated_at   timestamptz not null default now()
);

alter table public.players enable row level security;

-- A player can see and edit only their own contact row.
drop policy if exists players_select on public.players;
create policy players_select on public.players
  for select using (id = auth.uid());
drop policy if exists players_upsert on public.players;
create policy players_upsert on public.players
  for insert with check (id = auth.uid());
drop policy if exists players_update on public.players;
create policy players_update on public.players
  for update using (id = auth.uid()) with check (id = auth.uid());

drop trigger if exists players_touch on public.players;
create trigger players_touch before update on public.players
  for each row execute function public.touch_updated_at();

-- ---------------------------------------------------------------------------
-- Wiring the notifier (dashboard step, not SQL):
--
-- 1. Deploy the Edge Function:
--      supabase functions deploy notify-turn
--
-- 2. Set its secrets:
--      supabase secrets set RESEND_API_KEY=...        # email (optional)
--      supabase secrets set NOTIFY_FROM_EMAIL=...      # e.g. 7s@yourdomain
--      supabase secrets set VAPID_PUBLIC_KEY=...       # web push (optional)
--      supabase secrets set VAPID_PRIVATE_KEY=...
--      supabase secrets set VAPID_SUBJECT=mailto:you@example.com
--    (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are injected automatically.)
--
-- 3. Create a Database Webhook (Database -> Webhooks):
--      table:  public.turns
--      events: INSERT
--      type:   Supabase Edge Function -> notify-turn
--
--    On each commit the function notifies the opponent if they have not yet
--    submitted the current round.
-- ---------------------------------------------------------------------------
