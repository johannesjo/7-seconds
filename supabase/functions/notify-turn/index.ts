// Supabase Edge Function: notify-turn
//
// Triggered by a Database Webhook on INSERT into public.turns (a "commit").
// Notifies the opponent via email and/or Web Push when they need to plan or
// reveal their turn. Runs on Deno with
// the service role, so it can read other players' contact rows.
//
// Deploy: supabase functions deploy notify-turn   (see migration 0002 for setup)
//
// Deno-targeted file; intentionally outside ./src so the app's tsc/vite ignore it.
// @ts-nocheck
import { createClient } from 'npm:@supabase/supabase-js@2';
import webpush from 'npm:web-push@3.6.7';
import { isAuthorizedWebhook, shouldNotifyOpponent, TURN_NOTIFICATION_BODY } from './turn.ts';

const APP_URL = Deno.env.get('NOTIFY_APP_URL') ?? 'https://johannesjo.github.io/7-seconds/';
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY');
const NOTIFY_FROM_EMAIL = Deno.env.get('NOTIFY_FROM_EMAIL') ?? '7 Seconds <onboarding@resend.dev>';
const VAPID_PUBLIC_KEY = Deno.env.get('VAPID_PUBLIC_KEY');
const VAPID_PRIVATE_KEY = Deno.env.get('VAPID_PRIVATE_KEY');
const VAPID_SUBJECT = Deno.env.get('VAPID_SUBJECT') ?? 'mailto:noreply@example.com';

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

if (VAPID_PUBLIC_KEY && VAPID_PRIVATE_KEY) {
  webpush.setVapidDetails(VAPID_SUBJECT, VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY);
}

async function sendEmail(to: string, link: string): Promise<void> {
  if (!RESEND_API_KEY) return;
  const response = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: NOTIFY_FROM_EMAIL,
      to,
      subject: 'Your match needs you — 7 Seconds',
      html: `<p>${TURN_NOTIFICATION_BODY} <a href="${link}">Open the match</a>.</p>`,
    }),
  });
  if (!response.ok) throw new Error(`Email send failed (${response.status})`);
}

// Only deliver to well-known push services — the endpoint comes from a
// user-controlled `players.web_push` row, so an unconstrained fetch would be an
// SSRF vector from the service-role context.
const PUSH_HOST_ALLOWLIST = [
  'fcm.googleapis.com',
  'push.services.mozilla.com',
  'notify.windows.com',
  'push.apple.com',
];

function isAllowedPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== 'string') return false;
  try {
    const u = new URL(endpoint);
    if (u.protocol !== 'https:') return false;
    return PUSH_HOST_ALLOWLIST.some((h) => u.hostname === h || u.hostname.endsWith('.' + h));
  } catch {
    return false;
  }
}

async function sendPush(subscription: { endpoint?: string } | null, link: string): Promise<void> {
  if (!VAPID_PUBLIC_KEY || !VAPID_PRIVATE_KEY) return;
  if (!subscription || !isAllowedPushEndpoint(subscription.endpoint)) return;
  await webpush.sendNotification(
    subscription as webpush.PushSubscription,
    JSON.stringify({ title: '7 Seconds', body: TURN_NOTIFICATION_BODY, url: link }),
  );
}

Deno.serve(async (req) => {
  try {
    if (!isAuthorizedWebhook(req.headers.get('Authorization'), Deno.env.get('SUPABASE_SERVICE_ROLE_KEY'))) {
      return new Response('unauthorized', { status: 401 });
    }
    const payload = await req.json();
    const record = payload.record ?? payload.new;
    if (!record?.match_id) return new Response('ignored', { status: 200 });

    const { match_id, round, player: committer } = record;

    const { data: match } = await admin
      .from('matches').select('host_player, guest_player, status, current_round').eq('id', match_id).single();
    if (!match) return new Response('no match', { status: 200 });
    if (match.status !== 'active' || match.current_round !== round) return new Response('stale match', { status: 200 });
    if (committer !== match.host_player && committer !== match.guest_player) return new Response('invalid committer', { status: 200 });

    const opponent = committer === match.host_player ? match.guest_player : match.host_player;
    if (!opponent) return new Response('no opponent', { status: 200 });

    // A committed opponent may still need to reopen the app to reveal their
    // plan once both commits exist. Skip only after they have revealed.
    const { data: oppTurn } = await admin
      .from('turns').select('paths')
      .eq('match_id', match_id).eq('round', round).eq('player', opponent).maybeSingle();
    if (!shouldNotifyOpponent(match, committer, round, oppTurn)) {
      return new Response('opponent already revealed', { status: 200 });
    }

    const { data: contact } = await admin
      .from('players').select('email, web_push, notify_email, notify_push')
      .eq('id', opponent).maybeSingle();
    if (!contact) return new Response('no contact', { status: 200 });

    const link = `${APP_URL}?amatch=${encodeURIComponent(match_id)}`;
    const jobs: Promise<void>[] = [];
    if (contact.notify_email && contact.email) jobs.push(sendEmail(contact.email, link));
    if (contact.notify_push && contact.web_push) jobs.push(sendPush(contact.web_push, link));
    const results = await Promise.allSettled(jobs);
    for (const result of results) {
      if (result.status === 'rejected') console.error('notify-turn delivery failed', result.reason);
    }

    return new Response('ok', { status: 200 });
  } catch (e) {
    console.error('notify-turn error', e);
    // Always 200 so the webhook does not retry-storm on malformed input.
    return new Response('error', { status: 200 });
  }
});
