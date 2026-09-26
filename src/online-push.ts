import { Capacitor } from '@capacitor/core';
import { initializeLocalTurnNotifications, getLocalTurnNotificationStatus, setLocalTurnNotifications } from './notify';
import { getSupabaseClient } from './online';
import { currentUserId, ensureAuth } from './online-auth';
import { dlog } from './online-debug';

/** Public VAPID key; its private half belongs only in Supabase secrets. */
export const VAPID_PUBLIC_KEY = 'BOGFapbC8n1znzd3Pdo8-HN--IiKKJO8lDxkiUJcIT4GOKC7lwbmaUO86-y766Q-vE9ulgTLY1NJ1zkk82X2AZs';

const webAvailable = () => !Capacitor.isNativePlatform()
  && typeof window !== 'undefined' && 'PushManager' in window
  && typeof navigator !== 'undefined' && 'serviceWorker' in navigator
  && typeof Notification !== 'undefined' && !!VAPID_PUBLIC_KEY;

/** Restore an existing opt-in without creating an account or prompting. */
export async function initializeTurnNotifications(openMatch: (matchId: string) => void): Promise<void> {
  if (Capacitor.isNativePlatform()) {
    await initializeLocalTurnNotifications(openMatch);
    return;
  }
  try {
    if (!webAvailable() || Notification.permission !== 'granted') return;
    const uid = await currentUserId();
    if (!uid) return;
    const { data } = await getSupabaseClient().from('players').select('notify_push, web_push').eq('id', uid).maybeSingle();
    if (data?.notify_push && data.web_push) {
      const webPush = await getWebPushSubscription();
      if (webPush && webPush.endpoint !== data.web_push.endpoint) {
        await getSupabaseClient().from('players').upsert({ id: uid, web_push: webPush });
      }
    }
  } catch (error) {
    dlog(`push: startup registration failed ${error}`);
  }
}

export interface TurnNotificationStatus { enabled: boolean; available: boolean }

/** Saved preference plus a usable channel; suitable for the lobby checkbox. */
export async function getTurnNotificationStatus(): Promise<TurnNotificationStatus> {
  if (Capacitor.isNativePlatform()) return getLocalTurnNotificationStatus();
  const available = webAvailable();
  if (!available) return { enabled: false, available: false };
  const uid = await currentUserId();
  if (!uid) return { enabled: false, available: true };
  try {
    const { data, error } = await getSupabaseClient().from('players')
      .select('notify_push, web_push').eq('id', uid).maybeSingle();
    if (error || !data?.notify_push) return { enabled: false, available: true };
    const worker = await navigator.serviceWorker.getRegistration(new URL('/sw-notify.js', import.meta.url).href);
    const subscription = await worker?.pushManager.getSubscription();
    return { enabled: Notification.permission === 'granted'
      && !!subscription?.endpoint && subscription.endpoint === data.web_push?.endpoint, available: true };
  } catch {
    return { enabled: false, available: true };
  }
}

export function urlBase64ToUint8Array(base64String: string): Uint8Array<ArrayBuffer> {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const raw = atob((base64String + padding).replace(/-/g, '+').replace(/_/g, '/'));
  const output = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) output[i] = raw.charCodeAt(i);
  return output;
}

async function getWebPushSubscription(): Promise<PushSubscriptionJSON | null> {
  if (!webAvailable() || Notification.permission !== 'granted') return null;
  try {
    await navigator.serviceWorker.register(new URL('/sw-notify.js', import.meta.url).href);
    const ready = await navigator.serviceWorker.ready;
    const existing = await ready.pushManager.getSubscription();
    const sub = existing ?? await ready.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(VAPID_PUBLIC_KEY),
    });
    return sub.toJSON();
  } catch (error) {
    dlog(`push: web subscription failed ${error}`);
    return null;
  }
}

export function isValidEmail(email: string): boolean {
  return email.length <= 254 && /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email);
}

/** Silent row setup; never changes an existing opt-out or asks for permission. */
export async function registerTurnNotifications(opts: { email?: string } = {}): Promise<boolean> {
  const uid = await ensureAuth();
  if (!uid) return false;
  const row: Record<string, unknown> = { id: uid };
  if (opts.email !== undefined) {
    const email = opts.email.trim();
    if (email && !isValidEmail(email)) return false;
    row.email = email || null;
    row.notify_email = !!email;
  }
  const { data: saved } = await getSupabaseClient().from('players')
    .select('notify_push, web_push').eq('id', uid).maybeSingle();
  if (saved?.notify_push && saved.web_push) {
    const webPush = await getWebPushSubscription();
    if (webPush) row.web_push = webPush;
  }
  const { error } = await getSupabaseClient().from('players').upsert(row);
  if (error) {
    dlog(`push: upsert players failed ${error.message}`);
    return false;
  }
  return true;
}

/** Opt in after permission and a usable local/browser notification channel. */
export async function setTurnNotifications(enabled: boolean): Promise<boolean> {
  if (Capacitor.isNativePlatform()) return setLocalTurnNotifications(enabled);
  const uid = await ensureAuth();
  if (!uid) return false;
  const row: Record<string, unknown> = { id: uid, notify_push: enabled };
  if (enabled) {
    if (!webAvailable()) return false;
    if (Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') return false;
    const webPush = await getWebPushSubscription();
    if (!webPush) return false;
    row.web_push = webPush;
  } else {
    row.web_push = null;
  }
  const { error } = await getSupabaseClient().from('players').upsert(row);
  if (error) {
    dlog(`push: set notifications failed ${error.message}`);
    return false;
  }
  return true;
}
