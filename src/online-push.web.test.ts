import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  saved: { notify_push: true, web_push: { endpoint: 'https://push.example/old' } },
  subscription: { endpoint: 'https://push.example/new', toJSON: () => ({ endpoint: 'https://push.example/new' }) },
  upsert: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: { getPlatform: () => 'web', isNativePlatform: () => false, isPluginAvailable: () => false },
  registerPlugin: () => ({}),
}));
vi.mock('./online-auth', () => ({ currentUserId: vi.fn(async () => 'player-1'), ensureAuth: vi.fn(async () => 'player-1') }));
vi.mock('./online', () => ({ getSupabaseClient: () => ({ from: () => ({
  select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: mocks.saved, error: null }) }) }),
  upsert: mocks.upsert,
}) }) }));
vi.mock('./online-debug', () => ({ dlog: vi.fn() }));

describe('saved Web Push opt-in', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.upsert.mockReset().mockResolvedValue({ error: null });
    vi.stubGlobal('window', { PushManager: class {} });
    vi.stubGlobal('Notification', { permission: 'granted' });
    vi.stubGlobal('navigator', { serviceWorker: {
      register: vi.fn(async () => ({})),
      ready: { pushManager: { getSubscription: async () => mocks.subscription } },
      getRegistration: async () => ({ pushManager: { getSubscription: async () => mocks.subscription } }),
    } });
  });

  it('passively replaces an outdated endpoint and reports the current subscription', async () => {
    const { initializeTurnNotifications, getTurnNotificationStatus } = await import('./online-push');
    expect(await getTurnNotificationStatus()).toEqual({ enabled: false, available: true });
    await initializeTurnNotifications(() => {});
    expect(mocks.upsert).toHaveBeenCalledWith({ id: 'player-1', web_push: { endpoint: 'https://push.example/new' } });
    mocks.saved = { notify_push: true, web_push: { endpoint: 'https://push.example/new' } };
    expect(await getTurnNotificationStatus()).toEqual({ enabled: true, available: true });
    vi.unstubAllGlobals();
  });
});
