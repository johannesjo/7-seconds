import { Capacitor, registerPlugin } from '@capacitor/core';
import { PushNotifications } from '@capacitor/push-notifications';
import { getSupabaseClient } from './online';
import { currentUserId, ensureAuth } from './online-auth';
import { dlog } from './online-debug';

/** Public VAPID key; its private half belongs only in Supabase secrets. */
export const VAPID_PUBLIC_KEY = 'BOGFapbC8n1znzd3Pdo8-HN--IiKKJO8lDxkiUJcIT4GOKC7lwbmaUO86-y766Q-vE9ulgTLY1NJ1zkk82X2AZs';

const isAndroid = () => Capacitor.getPlatform() === 'android';
const PushSetup = registerPlugin<{ isConfigured(): Promise<{ configured: boolean }> }>('PushSetup');
let nativeConfig: Promise<boolean> | null = null;
const nativeAvailable = (): Promise<boolean> => {
  if (!isAndroid() || !Capacitor.isPluginAvailable('PushNotifications')
      || !Capacitor.isPluginAvailable('PushSetup')) return Promise.resolve(false);
  if (!nativeConfig) nativeConfig = PushSetup.isConfigured().then(result => result.configured, () => false);
  return nativeConfig;
};
const webAvailable = () => typeof window !== 'undefined' && 'PushManager' in window
  && typeof navigator !== 'undefined' && 'serviceWorker' in navigator
  && typeof Notification !== 'undefined' && !!VAPID_PUBLIC_KEY;

let onOpenMatch: ((matchId: string) => void) | null = null;
let nativeListeners: Promise<void> | null = null;
let nativeEnabled = false;
let waitingForToken: { resolve: (token: string) => void; reject: (error: Error) => void } | null = null;
let tokenRegistration: Promise<string | null> | null = null;

function matchIdFromNotification(data: Record<string, unknown> | undefined): string | null {
  const id = data?.matchId;
  return typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id) ? id : null;
}

async function setupNativeListeners(): Promise<void> {
  if (!await nativeAvailable()) throw new Error('Native push is unavailable in this app build');
  if (!nativeListeners) {
    nativeListeners = (async () => {
      // Install the action listener before registration: it must also catch
      // notifications that launched a previously closed Android app.
      await PushNotifications.addListener('pushNotificationActionPerformed', ({ notification }) => {
        const id = matchIdFromNotification(notification.data);
        if (id) onOpenMatch?.(id);
      });
      await PushNotifications.addListener('registration', ({ value }) => {
        if (!value) return;
        waitingForToken?.resolve(value);
        waitingForToken = null;
        if (nativeEnabled) void saveToken(value);
      });
      await PushNotifications.addListener('registrationError', ({ error }) => {
        waitingForToken?.reject(new Error(String(error)));
        waitingForToken = null;
      });
    })().catch((error) => {
      nativeListeners = null;
      throw error;
    });
  }
  await nativeListeners;
}

async function saveToken(token: string): Promise<void> {
  const uid = await currentUserId();
  if (!uid || !nativeEnabled) return;
  const { error } = await getSupabaseClient().from('players').upsert({ id: uid, fcm_token: token });
  if (error) dlog(`push: token refresh failed ${error.message}`);
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Push registration timed out')), ms);
    promise.then(value => { clearTimeout(timer); resolve(value); }, error => { clearTimeout(timer); reject(error); });
  });
}

async function nativeToken(prompt: boolean): Promise<string | null> {
  // One native register call at a time; concurrent startup/lobby calls share
  // its result instead of replacing the pending registration listener.
  if (!tokenRegistration) {
    tokenRegistration = doNativeToken(prompt).finally(() => { tokenRegistration = null; });
  }
  return tokenRegistration;
}

async function doNativeToken(prompt: boolean): Promise<string | null> {
  try {
    await setupNativeListeners();
    let permission = await PushNotifications.checkPermissions();
    if (permission.receive !== 'granted' && prompt) permission = await PushNotifications.requestPermissions();
    if (permission.receive !== 'granted') return null;
    const token = new Promise<string>((resolve, reject) => { waitingForToken = { resolve, reject }; });
    const [, value] = await withTimeout(Promise.all([PushNotifications.register(), token]), 10_000);
    return value;
  } catch (error) {
    dlog(`push: native registration failed ${error}`);
    return null;
  } finally {
    waitingForToken = null;
  }
}

/** Set this up during startup so notification taps can open a match, including
 * cold starts. It never creates an account or prompts for permission. */
export async function initializeTurnNotifications(openMatch: (matchId: string) => void): Promise<void> {
  onOpenMatch = openMatch;
  try {
    const native = await nativeAvailable();
    if (native) await setupNativeListeners();
    const uid = await currentUserId();
    if (!uid) return;
    if (native) {
      const { data } = await getSupabaseClient().from('players').select('notify_push, fcm_token').eq('id', uid).maybeSingle();
      nativeEnabled = data?.notify_push === true && !!data.fcm_token;
      if (nativeEnabled) {
        const token = await nativeToken(false);
        if (token) await saveToken(token);
      }
    } else if (!Capacitor.isNativePlatform() && webAvailable() && Notification.permission === 'granted') {
      const { data } = await getSupabaseClient().from('players').select('notify_push, web_push').eq('id', uid).maybeSingle();
      if (data?.notify_push && data.web_push) {
        const webPush = await getWebPushSubscription();
        if (webPush && webPush.endpoint !== data.web_push.endpoint) {
          await getSupabaseClient().from('players').upsert({ id: uid, web_push: webPush });
        }
      }
    }
  } catch (error) {
    dlog(`push: startup registration failed ${error}`);
  }
}

export interface TurnNotificationStatus { enabled: boolean; available: boolean }

/** Saved preference plus a usable channel; suitable for the lobby checkbox. */
export async function getTurnNotificationStatus(): Promise<TurnNotificationStatus> {
  const native = await nativeAvailable();
  const available = native || (!Capacitor.isNativePlatform() && webAvailable());
  if (!available) return { enabled: false, available: false };
  const uid = await currentUserId();
  if (!uid) return { enabled: false, available: true };
  try {
    const { data, error } = await getSupabaseClient().from('players')
      .select('notify_push, fcm_token, web_push').eq('id', uid).maybeSingle();
    if (error || !data?.notify_push) return { enabled: false, available: true };
    if (native) {
      const permission = await PushNotifications.checkPermissions();
      return { enabled: permission.receive === 'granted' && !!data.fcm_token, available: true };
    }
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
    .select('notify_push, fcm_token, web_push').eq('id', uid).maybeSingle();
  if (saved?.notify_push) {
    if (await nativeAvailable()) {
      nativeEnabled = !!saved.fcm_token;
      if (nativeEnabled) {
        const token = await nativeToken(false);
        if (token) row.fcm_token = token;
      }
    } else if (!Capacitor.isNativePlatform() && saved.web_push) {
      const webPush = await getWebPushSubscription();
      if (webPush) row.web_push = webPush;
    }
  }
  const { error } = await getSupabaseClient().from('players').upsert(row);
  if (error) {
    dlog(`push: upsert players failed ${error.message}`);
    return false;
  }
  return true;
}

/** Opt in only after a real push channel is available; opt-out clears both
 * delivery addresses so a delayed webhook cannot use a stale token. */
export async function setTurnNotifications(enabled: boolean): Promise<boolean> {
  const uid = await ensureAuth();
  if (!uid) return false;
  const wasNativeEnabled = nativeEnabled;
  if (!enabled) nativeEnabled = false;
  const row: Record<string, unknown> = { id: uid, notify_push: enabled };
  if (enabled) {
    if (await nativeAvailable()) {
      const token = await nativeToken(true);
      if (!token) return false;
      row.fcm_token = token;
    } else if (!Capacitor.isNativePlatform() && webAvailable()) {
      if (Notification.permission !== 'granted' && await Notification.requestPermission() !== 'granted') return false;
      const webPush = await getWebPushSubscription();
      if (!webPush) return false;
      row.web_push = webPush;
    } else return false;
  } else {
    row.fcm_token = null;
    row.web_push = null;
  }
  const { error } = await getSupabaseClient().from('players').upsert(row);
  if (error) {
    nativeEnabled = wasNativeEnabled;
    dlog(`push: set notifications failed ${error.message}`);
    return false;
  }
  nativeEnabled = enabled && await nativeAvailable();
  return true;
}
