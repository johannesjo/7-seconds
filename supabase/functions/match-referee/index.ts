// Supabase Edge Function: match-referee. Every write to an online match goes
// through here; clients only read their own matches (RLS) and follow them with
// Realtime. The protocol lives in src/server/referee.ts, bundled with the game
// engine into ./referee.mjs (npm run referee:bundle). This file supplies the
// platform: the caller's session, the database, randomness, Play Games
// verification and the senders for turn alerts. See docs/online-play.md.
//
// POST {action, rules, ...} with the caller's Supabase access token as the
// bearer. Casual play accepts anonymous sessions; ranked needs a Google one.
//
// Deno-targeted; outside ./src so the app's tsc and vite ignore it.
import { createClient } from 'npm:@supabase/supabase-js@2.98.0';
import webpush from 'npm:web-push@3.6.7';
// @ts-types="./referee.d.mts"
import {
  handleReferee, StoreError, verifyPlayGames, fcmMessage, webPushPayload, alertText,
  type Alert, type RefereeStore, type MatchRow,
} from './referee.mjs';

const env = (key: string) => Deno.env.get(key) ?? '';
const db = createClient(env('SUPABASE_URL'), env('SUPABASE_SERVICE_ROLE_KEY'), {
  auth: { persistSession: false, autoRefreshToken: false },
});

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { ...cors, 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
});

// --- database --------------------------------------------------------------

async function checked<T>(request: PromiseLike<{ data: T; error: { message: string; code?: string } | null }>): Promise<T> {
  let result;
  try { result = await request; } catch (error) { throw new StoreError(`Database unreachable: ${error}`); }
  if (result.error) throw new StoreError(result.error.message, result.error.code);
  return result.data;
}

const store: RefereeStore = {
  rpc: (fn, args) => checked(db.rpc(fn, args)),
  match: id => checked(db.from('matches').select('*').eq('id', id).maybeSingle()) as Promise<MatchRow | null>,
  plans: async (id, round) => (await checked(db.from('match_plans').select('team,paths').eq('match_id', id).eq('round', round))) ?? [],
  bot: player => checked(db.from('match_bots').select('difficulty').eq('player', player).maybeSingle()),
};

function random(): number {
  return crypto.getRandomValues(new Uint32Array(1))[0] / 0x1_0000_0000;
}

// Work after the response, so a move never waits on an alert.
const runtime = (globalThis as { EdgeRuntime?: { waitUntil(task: Promise<unknown>): void } }).EdgeRuntime;
function background(task: () => Promise<unknown>): void {
  const run = task().catch(error => console.error('match-referee background task failed', error));
  runtime?.waitUntil(run);
}

// --- Play Games (ranked) -----------------------------------------------------

const playGamesConfig = env('GOOGLE_WEB_CLIENT_ID') && env('GOOGLE_WEB_CLIENT_SECRET') && env('PGS_APP_ID')
  ? { webClientId: env('GOOGLE_WEB_CLIENT_ID'), webClientSecret: env('GOOGLE_WEB_CLIENT_SECRET'), appId: env('PGS_APP_ID') }
  : null;

// --- turn alerts -----------------------------------------------------------

const APP_URL = env('NOTIFY_APP_URL') || 'https://johannesjo.github.io/7-seconds/';
const VAPID = env('VAPID_PUBLIC_KEY') && env('VAPID_PRIVATE_KEY');
if (VAPID) webpush.setVapidDetails(env('VAPID_SUBJECT') || 'mailto:noreply@example.com', env('VAPID_PUBLIC_KEY'), env('VAPID_PRIVATE_KEY'));

// The endpoint comes from a player's own `players.web_push` row: only deliver to
// the browsers' push services, never to an arbitrary address.
const PUSH_HOSTS = ['fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com', 'push.apple.com'];
function allowedPushEndpoint(endpoint: unknown): boolean {
  if (typeof endpoint !== 'string') return false;
  try {
    const url = new URL(endpoint);
    return url.protocol === 'https:' && PUSH_HOSTS.some(h => url.hostname === h || url.hostname.endsWith(`.${h}`));
  } catch { return false; }
}

async function sendWebPush(subscription: { endpoint?: string } | null, alert: Alert): Promise<void> {
  if (!VAPID || !subscription || !allowedPushEndpoint(subscription.endpoint)) return;
  await webpush.sendNotification(subscription as webpush.PushSubscription, webPushPayload(APP_URL, alert), { TTL: 7 * 24 * 3600 });
}

async function sendEmail(to: string, alert: Alert): Promise<void> {
  const key = env('RESEND_API_KEY');
  if (!key) return;
  const { title, body } = alertText(alert);
  const link = new URL(APP_URL);
  link.searchParams.set('amatch', alert.match);
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: env('NOTIFY_FROM_EMAIL') || '7 Seconds <onboarding@resend.dev>',
      to, subject: `${title} — 7 Seconds`,
      html: `<p>${body.replace(/[<>&]/g, '')} <a href="${link}">Open the match</a>.</p>`,
    }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Email send failed (${res.status})`);
}

// Firebase Cloud Messaging (HTTP v1) for the Android app: a service-account JWT
// exchanged for an hour-long access token, cached across requests.
interface ServiceAccount { client_email: string; private_key: string; project_id: string }
function serviceAccount(): ServiceAccount | null {
  const raw = env('FCM_SERVICE_ACCOUNT');
  if (!raw) return null;
  const account = JSON.parse(raw);
  if (typeof account?.client_email !== 'string' || typeof account.private_key !== 'string' || typeof account.project_id !== 'string') {
    throw new Error('FCM_SERVICE_ACCOUNT must be the Firebase service account key file (JSON)');
  }
  return account;
}
const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const encodeJson = (value: unknown) => base64url(new TextEncoder().encode(JSON.stringify(value)));
let cachedToken: { value: Promise<string>; expires: number } | null = null;
function fcmAccessToken(account: ServiceAccount): Promise<string> {
  if (cachedToken && cachedToken.expires > Date.now()) return cachedToken.value;
  const value = (async () => {
    const now = Math.floor(Date.now() / 1000);
    const unsigned = `${encodeJson({ alg: 'RS256', typ: 'JWT' })}.${encodeJson({
      iss: account.client_email, scope: 'https://www.googleapis.com/auth/firebase.messaging',
      aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600,
    })}`;
    const der = Uint8Array.from(atob(account.private_key.replace(/-----[A-Z ]+-----|\s/g, '')), c => c.charCodeAt(0));
    const key = await crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
    const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', key, new TextEncoder().encode(unsigned)));
    const res = await fetch('https://oauth2.googleapis.com/token', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${base64url(signature)}` }),
      signal: AbortSignal.timeout(10_000),
    });
    const json = await res.json().catch(() => null);
    if (!res.ok || typeof json?.access_token !== 'string') throw new Error(`Google token exchange failed (${res.status})`);
    return json.access_token as string;
  })();
  const entry = cachedToken = { value, expires: Date.now() + 55 * 60_000 };
  value.catch(() => { if (cachedToken === entry) cachedToken = null; });
  return value;
}

/** UNREGISTERED: uninstalled or replaced; SENDER_ID_MISMATCH: another Firebase project. */
const GONE = new Set(['UNREGISTERED', 'SENDER_ID_MISMATCH']);
async function sendFcm(account: ServiceAccount, alert: Alert, token: string, retried = false): Promise<'sent' | 'gone' | 'failed'> {
  const res = await fetch(`https://fcm.googleapis.com/v1/projects/${encodeURIComponent(account.project_id)}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${await fcmAccessToken(account)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: fcmMessage(alert, token) }),
    signal: AbortSignal.timeout(10_000),
  });
  if (res.ok) return 'sent';
  if (res.status === 401 && !retried) { cachedToken = null; return sendFcm(account, alert, token, true); }
  const error = (await res.json().catch(() => null))?.error;
  const code = error?.details?.find((d: { errorCode?: string }) => d?.errorCode)?.errorCode;
  if (GONE.has(code)) return 'gone';
  console.error('FCM send failed', res.status, code ?? error?.status ?? '', error?.message ?? '');
  return 'failed';
}

async function sendAlert(alert: Alert): Promise<void> {
  const [contact, devices] = await Promise.all([
    checked(db.from('players').select('email, web_push, notify_email, notify_push').eq('id', alert.player).maybeSingle()),
    checked(db.from('push_devices').select('token').eq('player', alert.player)),
  ]);
  const jobs: Promise<unknown>[] = [];
  if (contact?.notify_push && contact.web_push) jobs.push(sendWebPush(contact.web_push, alert));
  if (contact?.notify_email && contact.email) jobs.push(sendEmail(contact.email, alert));
  const account = devices?.length ? serviceAccount() : null;
  if (account && devices) {
    jobs.push((async () => {
      const tokens = devices.map((d: { token: string }) => d.token);
      const outcomes = await Promise.all(tokens.map(token => sendFcm(account, alert, token).catch(() => 'failed' as const)));
      const gone = tokens.filter((_, i) => outcomes[i] === 'gone');
      // A dead token is dead for every player who registered it on that device.
      if (gone.length) await checked(db.from('push_devices').delete().in('token', gone));
    })());
  }
  for (const result of await Promise.allSettled(jobs)) {
    if (result.status === 'rejected') console.error('turn alert delivery failed', result.reason);
  }
}

// --- requests --------------------------------------------------------------

Deno.serve(async req => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: cors });
  if (req.method !== 'POST') return reply({ error: 'Use POST' }, 405);
  const bearer = req.headers.get('Authorization')?.match(/^Bearer (.+)$/i)?.[1];
  if (!bearer) return reply({ error: 'Sign-in required' }, 401);
  let auth;
  try { auth = await db.auth.getUser(bearer); } catch { return reply({ error: 'The online server is unavailable right now. Try again.' }, 503); }
  const { data: { user }, error } = auth;
  if (error && (error.status ?? 0) >= 500) return reply({ error: 'The online server is unavailable right now. Try again.' }, 503);
  if (error || !user) return reply({ error: 'Sign-in required' }, 401);
  const text = await req.text();
  if (text.length > 100_000) return reply({ error: 'Request too large' }, 413);
  let body: unknown;
  try { body = JSON.parse(text); } catch { return reply({ error: 'Invalid request' }, 400); }

  const google = !user.is_anonymous && (user.identities ?? []).some((i: { provider: string }) => i.provider === 'google');
  const result = await handleReferee({ id: user.id, google }, body, {
    store,
    random,
    background,
    notify: alert => background(() => sendAlert(alert)),
    playGames: playGamesConfig ? code => verifyPlayGames(code, playGamesConfig) : undefined,
  });
  return reply(result.body, result.status);
});
