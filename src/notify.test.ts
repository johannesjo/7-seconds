import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  available: true,
  permission: 'granted',
  checkPermissions: vi.fn(), requestPermissions: vi.fn(), schedule: vi.fn(), addListener: vi.fn(),
}));
vi.mock('@capacitor/core', () => ({ Capacitor: {
  isNativePlatform: () => true, isPluginAvailable: () => mocks.available,
} }));
vi.mock('@capacitor/local-notifications', () => ({ LocalNotifications: mocks }));

describe('ordinary local turn notifications', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    mocks.available = true;
    mocks.permission = 'granted';
    mocks.checkPermissions.mockImplementation(async () => ({ display: mocks.permission }));
    mocks.requestPermissions.mockImplementation(async () => ({ display: mocks.permission }));
    mocks.schedule.mockResolvedValue({});
    mocks.addListener.mockResolvedValue({ remove: vi.fn() });
    const storage = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => { storage.set(key, value); },
    });
    vi.stubGlobal('document', { visibilityState: 'hidden' });
  });
  afterEach(() => { vi.unstubAllGlobals(); });

  it('persists native opt-in across reloads and rechecks OS permission', async () => {
    const first = await import('./notify');
    expect(await first.setLocalTurnNotifications(true)).toBe(true);
    vi.resetModules();
    const reopened = await import('./notify');
    expect(await reopened.getLocalTurnNotificationStatus()).toEqual({ enabled: true, available: true });
    mocks.permission = 'denied';
    expect(await reopened.getLocalTurnNotificationStatus()).toEqual({ enabled: false, available: true });
  });

  it('does not enable or schedule when native permission is denied', async () => {
    mocks.permission = 'denied';
    const notifications = await import('./notify');
    expect(await notifications.setLocalTurnNotifications(true)).toBe(false);
    expect(mocks.requestPermissions).toHaveBeenCalledOnce();
    await notifications.notifyLocalTurn('abc123', 2);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('uses a valid Android ID, links to the match, and avoids repeat/foreground alerts', async () => {
    const notifications = await import('./notify');
    await notifications.setLocalTurnNotifications(true);
    await notifications.notifyLocalTurn('abc123', 2);
    await notifications.notifyLocalTurn('abc123', 2);
    expect(mocks.schedule).toHaveBeenCalledOnce();
    const notice = mocks.schedule.mock.calls[0][0].notifications[0];
    expect(Number.isInteger(notice.id)).toBe(true);
    expect(notice.id).toBeGreaterThan(0);
    expect(notice.id).toBeLessThan(2 ** 31);
    expect(notice.extra).toEqual({ matchId: 'abc123' });
    vi.stubGlobal('document', { visibilityState: 'visible' });
    await notifications.notifyLocalTurn('abc123', 3);
    expect(mocks.schedule).toHaveBeenCalledOnce();
  });

  it('stops alerts when the player turns them off', async () => {
    const notifications = await import('./notify');
    await notifications.setLocalTurnNotifications(true);
    await notifications.setLocalTurnNotifications(false);
    await notifications.notifyLocalTurn('abc123', 2);
    expect(mocks.schedule).not.toHaveBeenCalled();
  });

  it('opens the match on tap without registering duplicate listeners', async () => {
    const notifications = await import('./notify');
    const open = vi.fn();
    await notifications.initializeLocalTurnNotifications(open);
    await notifications.initializeLocalTurnNotifications(open);
    expect(mocks.addListener).toHaveBeenCalledOnce();
    const action = mocks.addListener.mock.calls[0][1];
    action({ notification: { extra: { matchId: 'abc123' } } });
    expect(open).toHaveBeenCalledWith('abc123');
    action({ notification: { extra: { matchId: 'https://example.com' } } });
    expect(open).toHaveBeenCalledOnce();
  });

  it('handles builds without the local notification plugin', async () => {
    mocks.available = false;
    const notifications = await import('./notify');
    expect(await notifications.getLocalTurnNotificationStatus()).toEqual({ enabled: false, available: false });
    expect(await notifications.setLocalTurnNotifications(true)).toBe(false);
    expect(mocks.requestPermissions).not.toHaveBeenCalled();
  });
});
