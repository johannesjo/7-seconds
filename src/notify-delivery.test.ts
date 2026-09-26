/// <reference types="vite/client" />
import { describe, expect, it, vi } from 'vitest';
import { sendFcm, sendFcmWithAuth } from '../supabase/functions/notify-turn/fcm';
import { isAuthorizedWebhook, shouldNotifyOpponent, TURN_NOTIFICATION_BODY } from '../supabase/functions/notify-turn/turn';
import workerSource from '../public/sw-notify.js?raw';

describe('FCM turn delivery', () => {
  it('sends an authenticated notification with the match id for Android taps', async () => {
    const fetcher = vi.fn(async () => new Response('{}', { status: 200 }));
    await sendFcmWithAuth('device-token', 'match-42', 'firebase-project',
      { getAccessToken: async () => ({ token: 'short-lived-oauth' }) }, fetcher);
    expect(fetcher).toHaveBeenCalledOnce();
    const [url, init] = fetcher.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://fcm.googleapis.com/v1/projects/firebase-project/messages:send');
    expect(init.headers).toMatchObject({ Authorization: 'Bearer short-lived-oauth' });
    expect(JSON.parse(init.body as string).message).toMatchObject({
      token: 'device-token', data: { matchId: 'match-42' },
      notification: { title: '7 Seconds', body: TURN_NOTIFICATION_BODY },
    });
  });

  it('rejects a failed FCM response', async () => {
    await expect(sendFcm('token', 'match', 'project', 'oauth',
      async () => new Response('denied', { status: 403 }))).rejects.toThrow('FCM send failed (403)');
  });

  it('does not send when OAuth returns no token', async () => {
    const fetcher = vi.fn();
    await expect(sendFcmWithAuth('token', 'match', 'project',
      { getAccessToken: async () => ({ token: null }) }, fetcher)).rejects.toThrow('access token is unavailable');
    expect(fetcher).not.toHaveBeenCalled();
  });
});

describe('turn webhook decision', () => {
  const match = {
    host_player: 'host', guest_player: 'guest', status: 'active', current_round: 3,
  };

  it('notifies a missing opponent commit and a committed opponent awaiting reveal', () => {
    expect(shouldNotifyOpponent(match, 'host', 3, null)).toBe(true);
    expect(shouldNotifyOpponent(match, 'guest', 3, { paths: null })).toBe(true);
    expect(shouldNotifyOpponent(match, 'guest', 3, { paths: [] })).toBe(false);
  });

  it('rejects stale, finished, and forged match events', () => {
    expect(shouldNotifyOpponent(match, 'stranger', 3, null)).toBe(false);
    expect(shouldNotifyOpponent(match, 'host', 2, null)).toBe(false);
    expect(shouldNotifyOpponent({ ...match, status: 'host_won' }, 'host', 3, null)).toBe(false);
    expect(isAuthorizedWebhook('Bearer anon-token', 'service-role-token')).toBe(false);
    expect(isAuthorizedWebhook('Bearer service-role-token', 'service-role-token')).toBe(true);
  });
});

describe('Web Push notification tap', () => {
  it('navigates an existing app tab to the match and focuses it', async () => {
    const listeners: Record<string, (event: any) => void> = {};
    const focus = vi.fn();
    const navigate = vi.fn(async () => ({ focus }));
    const client = { url: 'https://example.com/7-seconds/', navigate };
    const clients = { matchAll: vi.fn(async () => [client]), openWindow: vi.fn() };
    const self = {
      location: { origin: 'https://example.com' },
      registration: { scope: 'https://example.com/7-seconds/', showNotification: vi.fn() },
      addEventListener: (name: string, listener: (event: any) => void) => { listeners[name] = listener; },
    };
    new Function('self', 'clients', workerSource)(self, clients);
    let pending: Promise<unknown> = Promise.resolve();
    listeners.notificationclick({
      notification: { data: { url: 'https://example.com/7-seconds/?amatch=match-42' }, close: vi.fn() },
      waitUntil: (promise: Promise<unknown>) => { pending = promise; },
    });
    await pending;
    expect(navigate).toHaveBeenCalledWith('https://example.com/7-seconds/?amatch=match-42');
    expect(focus).toHaveBeenCalledOnce();
    expect(clients.openWindow).not.toHaveBeenCalled();
  });
});
