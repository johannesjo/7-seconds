/// <reference types="vite/client" />
import { describe, expect, it, vi } from 'vitest';
import { isAuthorizedWebhook, shouldNotifyOpponent } from '../supabase/functions/notify-turn/turn';
import workerSource from '../public/sw-notify.js?raw';

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
