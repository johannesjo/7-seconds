/// <reference types="vite/client" />
import { describe, expect, it, vi } from 'vitest';
import workerSource from '../public/sw-notify.js?raw';

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
