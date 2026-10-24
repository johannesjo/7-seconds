// Turn alerts in the Android app through Firebase Cloud Messaging: the match
// referee notifies a player's devices when a match needs them, even while the
// app is closed. The TurnAlerts plugin supplies the device token and reports
// taps. The token is registered for each Supabase user this device plays as:
// the casual guest and, when signed in, the ranked account.
// Builds without Firebase configured (no google-services.json) or phones
// without Google Play services can't use it; online-push.ts then falls back to
// local notifications from an open match. See docs/turn-alerts.md.
import { Capacitor, registerPlugin, type PluginListenerHandle } from '@capacitor/core';
import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from './online';
import { getRankedClient } from './ranked';

export type AlertPermission = 'granted' | 'denied' | 'prompt' | 'prompt-with-rationale';
export interface OpenedAlert { match: string; ranked: boolean }

interface TurnAlertsPlugin {
  isAvailable(): Promise<{ available: boolean }>;
  checkPermissions(): Promise<{ notifications: AlertPermission }>;
  requestPermissions(): Promise<{ notifications: AlertPermission }>;
  register(): Promise<{ token: string }>;
  unregister(): Promise<void>;
  openSettings(): Promise<void>;
  setOpenMatch(options: { match: string | null }): Promise<void>;
  /** alertOpened: an alert was tapped. alertReceived: one arrived while the app is open. */
  addListener(event: 'alertOpened' | 'alertReceived', listener: (alert: OpenedAlert) => void): Promise<PluginListenerHandle>;
}

/** The native side. Tests swap in their own. */
export const bridge = {
  plugin: registerPlugin<TurnAlertsPlugin>('TurnAlerts') as TurnAlertsPlugin,
  native: () => Capacitor.getPlatform() === 'android' && Capacitor.isPluginAvailable('TurnAlerts'),
};

const PREFERENCE_KEY = '7s-turn-alerts';
/** The token last registered, so it can still be withdrawn after Android stops handing it out. */
const TOKEN_KEY = '7s-turn-alerts-token';

function read(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}
function write(key: string, value: string | null): void {
  try { if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value); } catch { /* this session only */ }
}

export const alertsPreferred = () => read(PREFERENCE_KEY) === 'on';

let available: Promise<boolean> | null = null;
/** Whether this app can receive alerts: the Android app, built with Firebase configured. */
export function turnAlertsAvailable(): Promise<boolean> {
  available ??= (async () => {
    if (!bridge.native()) return false;
    try { return (await bridge.plugin.isAvailable()).available; } catch { return false; }
  })();
  return available;
}

async function permission(): Promise<AlertPermission> {
  try { return (await bridge.plugin.checkPermissions()).notifications; } catch { return 'denied'; }
}

/** On: chosen and allowed by Android. Blocked: chosen, but notifications are off in Android settings. */
export async function turnAlertsState(): Promise<'on' | 'off' | 'blocked' | 'unavailable'> {
  if (!await turnAlertsAvailable()) return 'unavailable';
  if (!alertsPreferred()) return 'off';
  return await permission() === 'granted' ? 'on' : 'blocked';
}

const clients = (): SupabaseClient[] => [getSupabaseClient(), getRankedClient()];
/** When this page last registered each `${user}|${token}` pair. The server
 *  forgets devices unused for 60 days; a daily refresh keeps them. */
const registered = new Map<string, number>();
const REFRESH_MS = 24 * 60 * 60_000;

async function registerWith(client: SupabaseClient, token: string): Promise<void> {
  const { data: { session } } = await client.auth.getSession();
  const key = session && `${session.user.id}|${token}`;
  if (!key || Date.now() - (registered.get(key) ?? -Infinity) < REFRESH_MS) return;
  const { error } = await client.rpc('seven_push_register', { p_token: token });
  if (error) console.warn('Could not register for turn alerts', error.message);
  else registered.set(key, Date.now());
}

async function unregisterWith(client: SupabaseClient, token: string): Promise<void> {
  const { data: { session } } = await client.auth.getSession();
  if (!session) return;
  const { error } = await client.rpc('seven_push_unregister', { p_token: token });
  if (error) console.warn('Could not withdraw turn alerts', error.message);
  registered.delete(`${session.user.id}|${token}`);
}

let syncing: Promise<void> | null = null;
/** Refresh this device's registration for every signed-in session. Never
 *  signs in by itself: a player who has never gone online has nobody to register. */
export function syncTurnAlerts(): Promise<void> {
  syncing ??= (async () => {
    if (await turnAlertsState() !== 'on') return;
    let token: string;
    try { token = (await bridge.plugin.register()).token; } catch (error) { console.warn('Turn alerts unavailable', error); return; }
    const previous = read(TOKEN_KEY);
    // Firebase replaced the token: the old one can no longer be reached, so withdraw it.
    if (previous && previous !== token) await Promise.all(clients().map(c => unregisterWith(c, previous).catch(() => {})));
    write(TOKEN_KEY, token);
    await Promise.all(clients().map(c => registerWith(c, token).catch(error => console.warn('Could not register for turn alerts', error))));
  })().finally(() => { syncing = null; });
  return syncing;
}

/** Ask Android for permission (a no-op before Android 13), then register.
 *  'blocked': notifications are off in Android settings; openTurnAlertSettings() helps. */
export async function enableTurnAlerts(): Promise<'on' | 'off' | 'blocked'> {
  if (await permission() === 'denied') {
    write(PREFERENCE_KEY, 'on');
    return 'blocked';
  }
  let answer: AlertPermission;
  try { answer = (await bridge.plugin.requestPermissions()).notifications; } catch { answer = 'denied'; }
  if (answer !== 'granted') {
    write(PREFERENCE_KEY, 'off');
    return 'off';
  }
  write(PREFERENCE_KEY, 'on');
  await syncTurnAlerts();
  return 'on';
}

/** Stop alerts on this device: the server forgets it for every session, and Firebase deletes the token. */
export async function disableTurnAlerts(): Promise<void> {
  write(PREFERENCE_KEY, 'off');
  const token = read(TOKEN_KEY);
  if (token) await Promise.all(clients().map(c => unregisterWith(c, token).catch(() => {})));
  write(TOKEN_KEY, null);
  try { await bridge.plugin.unregister(); } catch { /* the server has already forgotten the device */ }
}

export async function openTurnAlertSettings(): Promise<void> {
  try { await bridge.plugin.openSettings(); } catch { /* nothing more to offer */ }
}

/** Before ranked sign-out or profile deletion: this device should stop hearing about those matches. */
export async function forgetRankedDevice(): Promise<void> {
  const token = read(TOKEN_KEY);
  if (!token) return;
  await Promise.race([unregisterWith(getRankedClient(), token).catch(() => {}), new Promise(resolve => setTimeout(resolve, 5000))]);
}

/** The match on screen, or null. Its alerts stay quiet while the app is open: it updates live. */
export function showingMatch(match: string | null): void {
  void turnAlertsAvailable().then(ok => ok ? bridge.plugin.setOpenMatch({ match }) : undefined).catch(() => {});
}

const asAlert = (alert: OpenedAlert): OpenedAlert | null =>
  typeof alert?.match === 'string' && /^[a-z2-9]{6}$/.test(alert.match) ? { match: alert.match, ranked: alert.ranked === true } : null;

/** Keep registrations current and report alerts: `onOpened` when one is
 *  tapped, `onReceived` when one arrives while the app is open. */
export async function setupTurnAlerts(onOpened: (alert: OpenedAlert) => void, onReceived: (alert: OpenedAlert) => void): Promise<void> {
  if (!await turnAlertsAvailable()) return;
  await bridge.plugin.addListener('alertOpened', alert => { const opened = asAlert(alert); if (opened) onOpened(opened); });
  await bridge.plugin.addListener('alertReceived', alert => { const received = asAlert(alert); if (received) onReceived(received); });
  // A new session (going online for the first time, or ranked sign-in)
  // registers too. Supabase asks that its callback not call Supabase directly,
  // so the work runs a tick later.
  for (const c of clients()) {
    let user: string | undefined;
    c.auth.onAuthStateChange((event, session) => {
      if (event === 'SIGNED_IN' && session && session.user.id !== user) setTimeout(() => { void syncTurnAlerts(); }, 0);
      user = session?.user.id;
    });
  }
  // Coming back from Android settings is when permission is most likely to have changed.
  document.addEventListener('visibilitychange', () => { if (!document.hidden) void syncTurnAlerts(); });
  await syncTurnAlerts();
}
