import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import type { PeerCallbacks } from './online-peer';

// ── Mocks ────────────────────────────────────────────────────────────
// Each call to a transport factory registers a controllable fake so the
// test can drive onOpen/onClose/onReconnecting and resolve/reject setup.

interface FakeTransport {
  kind: 'webrtc' | 'relay';
  callbacks: PeerCallbacks;
  handle: { send: ReturnType<typeof vi.fn>; leave: ReturnType<typeof vi.fn>; getPeers: ReturnType<typeof vi.fn> };
  resolve: () => void;
  reject: (e?: unknown) => void;
}

const reg = vi.hoisted(() => ({ transports: [] as unknown[] }));

function makeFactory(kind: 'webrtc' | 'relay') {
  return vi.fn((_room: string, _role: string, callbacks: PeerCallbacks) => {
    const handle = { send: vi.fn(), leave: vi.fn(), getPeers: vi.fn(() => ({})) };
    let resolveFn!: () => void;
    let rejectFn!: (e?: unknown) => void;
    const promise = new Promise((res, rej) => {
      resolveFn = () => res(handle);
      rejectFn = (e?: unknown) => rej(e);
    });
    reg.transports.push({ kind, callbacks, handle, resolve: resolveFn, reject: rejectFn } satisfies FakeTransport);
    return promise;
  });
}

vi.mock('./online-debug', () => ({ dlog: () => {} }));
vi.mock('./online-peer', () => ({ createPeerConnection: makeFactory('webrtc') }));
vi.mock('./online-relay', () => ({ createRelayConnection: makeFactory('relay') }));

import { connectTransport } from './online';

// ── Helpers ──────────────────────────────────────────────────────────

const transports = () => reg.transports as FakeTransport[];
const byKind = (kind: 'webrtc' | 'relay') => transports().filter((t) => t.kind === kind);
const last = (kind: 'webrtc' | 'relay') => byKind(kind).at(-1)!;

function makeCallbacks() {
  return {
    onOpen: vi.fn<(peerId: string) => void>(),
    onClose: vi.fn<(peerId: string) => void>(),
    onReconnecting: vi.fn<(peerId: string) => void>(),
    onMessage: vi.fn<(type: string, data: unknown, peerId: string) => void>(),
  };
}

/** Resolve a fake transport's setup promise and flush microtasks so the
 *  internal `.then` assigns the handle. */
async function ready(t: FakeTransport) {
  t.resolve();
  await vi.advanceTimersByTimeAsync(0);
}

const HEADSTART_MS = 4_000;

beforeEach(() => {
  vi.useFakeTimers();
  reg.transports.length = 0;
});

afterEach(async () => {
  await vi.runAllTimersAsync().catch(() => {});
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('connectTransport racing', () => {
  it('starts WebRTC immediately and not the relay', () => {
    const cb = makeCallbacks();
    connectTransport('room', 'host', cb);
    expect(byKind('webrtc')).toHaveLength(1);
    expect(byKind('relay')).toHaveLength(0);
  });

  it('commits to WebRTC when it opens before the head start, never starting relay', async () => {
    const cb = makeCallbacks();
    connectTransport('room', 'host', cb);

    await ready(last('webrtc'));
    last('webrtc').callbacks.onOpen('peer-1');

    expect(cb.onOpen).toHaveBeenCalledWith('peer-1');

    // Head start elapses — relay must NOT start because WebRTC already won.
    await vi.advanceTimersByTimeAsync(HEADSTART_MS + 100);
    expect(byKind('relay')).toHaveLength(0);
  });

  it('starts the relay after the head start when WebRTC has not opened', async () => {
    const cb = makeCallbacks();
    connectTransport('room', 'host', cb);
    await ready(last('webrtc'));

    expect(byKind('relay')).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(HEADSTART_MS);
    expect(byKind('relay')).toHaveLength(1);
  });

  it('commits to the relay if it wins the race and tears down WebRTC', async () => {
    const cb = makeCallbacks();
    connectTransport('room', 'host', cb);
    const webrtc = last('webrtc');
    await ready(webrtc);

    await vi.advanceTimersByTimeAsync(HEADSTART_MS);
    const relay = last('relay');
    await ready(relay);
    relay.callbacks.onOpen('peer-2');

    expect(cb.onOpen).toHaveBeenCalledWith('peer-2');
    expect(webrtc.handle.leave).toHaveBeenCalled();

    // A late WebRTC open must be ignored (no duplicate onOpen).
    webrtc.callbacks.onOpen('peer-2');
    expect(cb.onOpen).toHaveBeenCalledTimes(1);
  });

  it('starts the relay immediately if WebRTC fails before the head start', async () => {
    const cb = makeCallbacks();
    connectTransport('room', 'host', cb);
    await ready(last('webrtc'));

    last('webrtc').callbacks.onClose('');
    await vi.advanceTimersByTimeAsync(0);

    // Relay started without waiting the full head start.
    expect(byKind('relay')).toHaveLength(1);
    expect(cb.onClose).not.toHaveBeenCalled();
  });

  it('tears down a losing transport whose setup resolves after the winner committed', async () => {
    const cb = makeCallbacks();
    connectTransport('room', 'host', cb);
    const webrtc = last('webrtc');
    await ready(webrtc);

    // Head start elapses → relay starts, but its setup promise is still pending.
    await vi.advanceTimersByTimeAsync(HEADSTART_MS);
    const relay = last('relay');

    // WebRTC opens and commits while the relay handle hasn't resolved yet.
    webrtc.callbacks.onOpen('peer-1');
    expect(cb.onOpen).toHaveBeenCalledTimes(1);

    // The relay setup now resolves — the orphan must be torn down, not adopted.
    await ready(relay);
    expect(relay.handle.leave).toHaveBeenCalled();

    // A late relay open must not produce a second onOpen.
    relay.callbacks.onOpen('peer-1');
    expect(cb.onOpen).toHaveBeenCalledTimes(1);
  });

  it('forwards onReconnecting only from the committed transport', async () => {
    const cb = makeCallbacks();
    connectTransport('room', 'host', cb);
    const webrtc = last('webrtc');
    await ready(webrtc);
    await vi.advanceTimersByTimeAsync(HEADSTART_MS);
    const relay = last('relay');
    await ready(relay);

    webrtc.callbacks.onOpen('peer-1'); // webrtc wins, relay torn down

    // The losing relay emitting onReconnecting must be ignored.
    relay.callbacks.onReconnecting?.('peer-1');
    expect(cb.onReconnecting).not.toHaveBeenCalled();

    // The committed transport's onReconnecting is forwarded.
    webrtc.callbacks.onReconnecting?.('peer-1');
    expect(cb.onReconnecting).toHaveBeenCalledWith('peer-1');
  });

  it('only forwards messages from the committed transport', async () => {
    const cb = makeCallbacks();
    connectTransport('room', 'host', cb);
    const webrtc = last('webrtc');
    await ready(webrtc);

    // Before commit, messages are dropped.
    webrtc.callbacks.onMessage('state', { a: 1 }, 'p');
    expect(cb.onMessage).not.toHaveBeenCalled();

    webrtc.callbacks.onOpen('p');
    webrtc.callbacks.onMessage('state', { a: 1 }, 'p');
    expect(cb.onMessage).toHaveBeenCalledWith('state', { a: 1 }, 'p');
  });
});

describe('connectTransport mid-session failover', () => {
  it('fails over to the relay when committed WebRTC dies, then reconnects', async () => {
    const cb = makeCallbacks();
    connectTransport('room', 'host', cb);
    const webrtc = last('webrtc');
    await ready(webrtc);
    webrtc.callbacks.onOpen('peer-1');
    expect(cb.onOpen).toHaveBeenCalledTimes(1);

    // WebRTC dies mid-session.
    webrtc.callbacks.onClose('peer-1');
    await vi.advanceTimersByTimeAsync(0);

    expect(cb.onReconnecting).toHaveBeenCalledWith('peer-1');
    expect(byKind('relay')).toHaveLength(1);

    // Relay comes up → app sees connected again.
    const relay = last('relay');
    await ready(relay);
    relay.callbacks.onOpen('peer-1');
    expect(cb.onOpen).toHaveBeenCalledTimes(2);
    expect(cb.onClose).not.toHaveBeenCalled();
  });

  it('gives up (onClose) when the relay itself dies', async () => {
    const cb = makeCallbacks();
    connectTransport('room', 'host', cb);
    await ready(last('webrtc'));
    await vi.advanceTimersByTimeAsync(HEADSTART_MS);
    const relay = last('relay');
    await ready(relay);
    relay.callbacks.onOpen('peer-1');

    relay.callbacks.onClose('peer-1');
    expect(cb.onClose).toHaveBeenCalledWith('peer-1');
  });

  it('forwards onClose only after both transports fail pre-connect', async () => {
    const cb = makeCallbacks();
    connectTransport('room', 'host', cb);
    await ready(last('webrtc'));

    // WebRTC fails → relay starts.
    last('webrtc').callbacks.onClose('');
    await vi.advanceTimersByTimeAsync(0);
    expect(cb.onClose).not.toHaveBeenCalled();

    // Relay also fails → now give up.
    await ready(last('relay'));
    last('relay').callbacks.onClose('');
    expect(cb.onClose).toHaveBeenCalled();
  });
});

describe('connectTransport handle', () => {
  it('leave() tears down both transports', async () => {
    const cb = makeCallbacks();
    const handle = connectTransport('room', 'host', cb);
    const webrtc = last('webrtc');
    await ready(webrtc);
    await vi.advanceTimersByTimeAsync(HEADSTART_MS);
    const relay = last('relay');
    await ready(relay);

    handle.leave();
    expect(webrtc.handle.leave).toHaveBeenCalled();
    expect(relay.handle.leave).toHaveBeenCalled();
  });

  it('send() delegates to the committed transport', async () => {
    const cb = makeCallbacks();
    const handle = connectTransport('room', 'host', cb);
    const webrtc = last('webrtc');
    await ready(webrtc);
    webrtc.callbacks.onOpen('peer-1');

    handle.send('state', { x: 1 });
    expect(webrtc.handle.send).toHaveBeenCalledWith('state', { x: 1 });
  });
});
