import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

const handlers = new Map<string, (arg: { payload: unknown }) => void>();
let onSubscribe: ((status: string) => void) | null = null;

const mockChannelSend = vi.fn();
const mockRemoveChannel = vi.fn();

const mockChannel = {
  on: vi.fn((_type: string, filter: { event: string }, cb: (arg: { payload: unknown }) => void) => {
    handlers.set(filter.event, cb);
    return mockChannel;
  }),
  subscribe: vi.fn((cb: (status: string) => void) => {
    onSubscribe = cb;
    return mockChannel;
  }),
  send: mockChannelSend,
};

vi.mock('./online', () => ({
  getSupabaseClient: () => ({
    channel: () => mockChannel,
    removeChannel: mockRemoveChannel,
  }),
  localPeerId: 'local-peer',
}));

vi.mock('./online-debug', () => ({ dlog: () => {} }));

import { createRelayConnection } from './online-relay';
import type { PeerCallbacks, PeerHandle } from './online-peer';

function makeCallbacks(over: Partial<PeerCallbacks> = {}): PeerCallbacks {
  return {
    onOpen: vi.fn(),
    onClose: vi.fn(),
    onReconnecting: vi.fn(),
    onMessage: vi.fn(),
    ...over,
  };
}

/** Subscribe the channel and return the resolved handle. */
async function connect(callbacks: PeerCallbacks): Promise<PeerHandle> {
  const promise = createRelayConnection('room1', 'host', callbacks);
  onSubscribe?.('SUBSCRIBED');
  return promise;
}

/** Feed an inbound broadcast to the relay as if from the remote peer. */
function deliver(event: string, payload: unknown): void {
  handlers.get(event)?.({ payload });
}

/** All payloads sent on the 'data' broadcast event. */
function dataSends(): Record<string, unknown>[] {
  return mockChannelSend.mock.calls
    .map((c) => c[0] as { event: string; payload: Record<string, unknown> })
    .filter((m) => m.event === 'data')
    .map((m) => m.payload);
}

beforeEach(() => {
  vi.useFakeTimers();
  handlers.clear();
  onSubscribe = null;
  mockChannelSend.mockClear();
  mockRemoveChannel.mockClear();
  mockChannel.on.mockClear();
  mockChannel.subscribe.mockClear();
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
});

describe('relay outgoing reliability', () => {
  it('retransmits each data message with a stable sequence number', async () => {
    const handle = await connect(makeCallbacks());
    mockChannelSend.mockClear(); // ignore the initial join announce

    handle.send('waypoints', { foo: 1 });

    // Immediate send
    let sends = dataSends();
    expect(sends).toHaveLength(1);
    expect(sends[0].t).toBe('waypoints');
    expect(sends[0].seq).toBe(1);

    // Two retransmissions, same seq + payload
    await vi.advanceTimersByTimeAsync(800);
    sends = dataSends();
    expect(sends).toHaveLength(3);
    expect(sends.every((s) => s.seq === 1 && s.t === 'waypoints')).toBe(true);

    handle.leave();
  });

  it('assigns increasing sequence numbers to successive messages', async () => {
    const handle = await connect(makeCallbacks());
    mockChannelSend.mockClear();

    handle.send('state', {});
    handle.send('phase', {});

    const firstSeqs = dataSends().filter((s) => s.t === 'state').map((s) => s.seq);
    const secondSeqs = dataSends().filter((s) => s.t === 'phase').map((s) => s.seq);
    expect(firstSeqs[0]).toBe(1);
    expect(secondSeqs[0]).toBe(2);

    handle.leave();
  });

  it('stops retransmitting after leave()', async () => {
    const handle = await connect(makeCallbacks());
    handle.send('result', {});
    handle.leave();
    mockChannelSend.mockClear();

    await vi.advanceTimersByTimeAsync(800);
    expect(dataSends()).toHaveLength(0);
  });
});

describe('relay incoming dedup', () => {
  it('delivers a message once and drops duplicate retransmissions', async () => {
    const onMessage = vi.fn();
    await connect(makeCallbacks({ onMessage }));

    deliver('data', { t: 'state', d: { v: 1 }, from: 'remote', seq: 1 });
    deliver('data', { t: 'state', d: { v: 1 }, from: 'remote', seq: 1 }); // dup
    expect(onMessage).toHaveBeenCalledTimes(1);

    deliver('data', { t: 'state', d: { v: 2 }, from: 'remote', seq: 2 });
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it('drops stale (reordered) messages below the last seen seq', async () => {
    const onMessage = vi.fn();
    await connect(makeCallbacks({ onMessage }));

    deliver('data', { t: 'phase', d: 'playing', from: 'remote', seq: 5 });
    deliver('data', { t: 'phase', d: 'blue-planning', from: 'remote', seq: 3 }); // late retransmit
    expect(onMessage).toHaveBeenCalledTimes(1);
    expect(onMessage).toHaveBeenCalledWith('phase', 'playing', 'remote');
  });

  it('tracks sequences independently per message type', async () => {
    const onMessage = vi.fn();
    await connect(makeCallbacks({ onMessage }));

    deliver('data', { t: 'state', d: {}, from: 'remote', seq: 10 });
    // A different type with a lower seq must still be delivered
    deliver('data', { t: 'paths', d: {}, from: 'remote', seq: 4 });
    expect(onMessage).toHaveBeenCalledTimes(2);
  });

  it('ignores our own echoed messages', async () => {
    const onMessage = vi.fn();
    await connect(makeCallbacks({ onMessage }));
    deliver('data', { t: 'state', d: {}, from: 'local-peer', seq: 1 });
    expect(onMessage).not.toHaveBeenCalled();
  });
});
