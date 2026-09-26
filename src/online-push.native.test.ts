import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  listeners: {} as Record<string, (event: any) => void>,
  permission: 'granted',
  saved: { notify_push: false, fcm_token: null } as Record<string, unknown>,
  upsert: vi.fn(),
  register: vi.fn(),
  configured: true,
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'android', isNativePlatform: () => true, isPluginAvailable: () => true },
  registerPlugin: () => ({ isConfigured: async () => ({ configured: mocks.configured }) }),
}));
vi.mock('@capacitor/push-notifications', () => ({
  PushNotifications: {
    addListener: vi.fn(async (name: string, callback: (event: any) => void) => { mocks.listeners[name] = callback; }),
    checkPermissions: vi.fn(async () => ({ receive: mocks.permission })),
    requestPermissions: vi.fn(async () => ({ receive: mocks.permission })),
    register: mocks.register,
  },
}));
vi.mock('./online-auth', () => ({ currentUserId: vi.fn(async () => 'player-1'), ensureAuth: vi.fn(async () => 'player-1') }));
vi.mock('./online', () => ({ getSupabaseClient: () => ({ from: () => ({
  select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.saved, error: null }) }) }),
  upsert: mocks.upsert,
}) }) }));
vi.mock('./online-debug', () => ({ dlog: vi.fn() }));

describe('Android turn notifications', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.listeners = {};
    mocks.permission = 'granted';
    mocks.configured = true;
    mocks.saved = { notify_push: false, fcm_token: null };
    mocks.upsert.mockReset().mockResolvedValue({ error: null });
    mocks.register.mockReset().mockImplementation(async () => {
      mocks.listeners.registration?.({ value: 'device-token' });
    });
  });

  it('does not persist opt-in if native permission is denied', async () => {
    mocks.permission = 'denied';
    const { setTurnNotifications } = await import('./online-push');
    expect(await setTurnNotifications(true)).toBe(false);
    expect(mocks.upsert).not.toHaveBeenCalled();
  });

  it('does not invoke Firebase registration when the Android binary has no Firebase config', async () => {
    mocks.configured = false;
    const { getTurnNotificationStatus, setTurnNotifications } = await import('./online-push');
    expect(await getTurnNotificationStatus()).toEqual({ enabled: false, available: false });
    expect(await setTurnNotifications(true)).toBe(false);
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('stores the token after registration and clears it on opt-out', async () => {
    const { setTurnNotifications } = await import('./online-push');
    expect(await setTurnNotifications(true)).toBe(true);
    expect(mocks.upsert).toHaveBeenCalledWith({ id: 'player-1', notify_push: true, fcm_token: 'device-token' });
    expect(await setTurnNotifications(false)).toBe(true);
    expect(mocks.upsert).toHaveBeenLastCalledWith({
      id: 'player-1', notify_push: false, fcm_token: null, web_push: null,
    });
  });

  it('routes a tapped notification to its match and ignores malformed ids', async () => {
    const openMatch = vi.fn();
    const { initializeTurnNotifications } = await import('./online-push');
    await initializeTurnNotifications(openMatch);
    mocks.listeners.pushNotificationActionPerformed({ notification: { data: { matchId: 'match-42' } } });
    mocks.listeners.pushNotificationActionPerformed({ notification: { data: { matchId: '../other' } } });
    expect(openMatch).toHaveBeenCalledOnce();
    expect(openMatch).toHaveBeenCalledWith('match-42');
    expect(mocks.register).not.toHaveBeenCalled();
  });

  it('reports a saved opt-out as disabled even when Android permission is granted', async () => {
    mocks.saved = { notify_push: false, fcm_token: 'old-token' };
    const { getTurnNotificationStatus } = await import('./online-push');
    expect(await getTurnNotificationStatus()).toEqual({ enabled: false, available: true });
  });
});
