import { Capacitor } from '@capacitor/core';
import { LocalNotifications } from '@capacitor/local-notifications';

const ENABLED_KEY = '7s-local-turn-notifications';
const available = () => Capacitor.isNativePlatform() && Capacitor.isPluginAvailable('LocalNotifications');
const appIsVisible = () => document.visibilityState === 'visible';
let actionListener: Promise<unknown> | null = null;
let openMatch: ((id: string) => void) | null = null;
const notifiedTurns = new Set<string>();

function enabledOnDevice(): boolean {
  try { return localStorage.getItem(ENABLED_KEY) === '1'; } catch { return false; }
}

/** Local notices can open the same match route as an invite. No push service. */
export async function initializeLocalTurnNotifications(onOpen: (id: string) => void): Promise<void> {
  openMatch = onOpen;
  if (!available()) return;
  if (!actionListener) {
    actionListener = LocalNotifications.addListener('localNotificationActionPerformed', ({ notification }) => {
      const id: unknown = notification.extra?.matchId;
      if (typeof id === 'string' && /^[a-zA-Z0-9-]{1,100}$/.test(id)) openMatch?.(id);
    }).catch(() => { actionListener = null; });
  }
  await actionListener;
}

export async function getLocalTurnNotificationStatus(): Promise<{ enabled: boolean; available: boolean }> {
  if (!available()) return { enabled: false, available: false };
  try {
    const permission = await LocalNotifications.checkPermissions();
    return { enabled: enabledOnDevice() && permission.display === 'granted', available: true };
  } catch {
    return { enabled: false, available: false };
  }
}

export async function setLocalTurnNotifications(enabled: boolean): Promise<boolean> {
  if (!available()) return false;
  try {
    if (enabled) {
      let permission = await LocalNotifications.checkPermissions();
      if (permission.display !== 'granted') permission = await LocalNotifications.requestPermissions();
      if (permission.display !== 'granted') return false;
    }
    localStorage.setItem(ENABLED_KEY, enabled ? '1' : '0');
    return true;
  } catch {
    return false;
  }
}

/** Best-effort alert when a running match detects a turn while backgrounded.
 * The foreground already shows a toast. This does not perform background fetch. */
export async function notifyLocalTurn(matchId: string, round: number): Promise<void> {
  if (!available() || appIsVisible()) return;
  const status = await getLocalTurnNotificationStatus();
  const key = `${matchId}:${round}`;
  if (!status.enabled || !enabledOnDevice() || appIsVisible() || notifiedTurns.has(key)) return;
  // Android requires a signed 32-bit ID. Reuse a match's ID to replace old alerts.
  let id = 0;
  for (const char of matchId) id = (Math.imul(id, 31) + char.charCodeAt(0)) | 0;
  id = (id & 0x7fffffff) || 1;
  notifiedTurns.add(key);
  try {
    await LocalNotifications.schedule({
      notifications: [{
        id, title: '7 Seconds — your turn',
        body: `Continue round ${round} in match ${matchId.toUpperCase()}.`,
        extra: { matchId },
      }],
    });
  } catch {
    notifiedTurns.delete(key);
  }
}
