import { getSupabaseClient } from './online';
import { ensureAuth } from './online-auth';
import { dlog } from './online-debug';

/** Web Push application server key. Leave empty to disable Web Push (email-only
 *  notifications still work). Set to your VAPID public key to enable it — the
 *  matching private key goes in the notify-turn function's secrets (migration
 *  0002). */
export const VAPID_PUBLIC_KEY = '';

/** Convert a base64url VAPID key to the Uint8Array the Push API expects.
 *  Backed by an explicit ArrayBuffer so it satisfies BufferSource. */
export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

/** Subscribe (or reuse a subscription) for Web Push, returning its JSON form,
 *  or null if Web Push is unavailable / not permitted / not configured. */
async function getWebPushSubscription(): Promise<PushSubscriptionJSON | null> {
  if (!VAPID_PUBLIC_KEY) return null;
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  if (typeof Notification === 'undefined' || Notification.permission !== 'granted') return null;
  try {
    await navigator.serviceWorker.register(new URL('/sw-notify.js', import.meta.url).href);
    const ready = await navigator.serviceWorker.ready;
    const existing = await ready.pushManager.getSubscription();
    const sub = existing ?? await ready.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    return sub.toJSON();
  } catch (e) {
    dlog(`push: subscribe failed ${e}`);
    return null;
  }
}

/** Register how this player wants to be nudged when it's their turn. Stores an
 *  optional email and/or a Web Push subscription in the `players` table. Safe to
 *  call repeatedly; degrades to a no-op if auth/DB is unavailable. */
export async function registerTurnNotifications(opts: { email?: string } = {}): Promise<boolean> {
  const uid = await ensureAuth();
  if (!uid) return false;

  const row: Record<string, unknown> = { id: uid, notify_push: true };
  if (opts.email !== undefined) {
    row.email = opts.email.trim() || null;
    row.notify_email = !!opts.email.trim();
  }
  const webPush = await getWebPushSubscription();
  if (webPush) row.web_push = webPush;

  const { error } = await getSupabaseClient().from('players').upsert(row);
  if (error) {
    dlog(`push: upsert players failed ${error.message}`);
    return false;
  }
  return true;
}
