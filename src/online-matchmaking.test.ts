import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock Supabase channel and client before importing the module
const mockTrack = vi.fn().mockResolvedValue(undefined);
const mockPresenceState = vi.fn().mockReturnValue({});
let onPresenceSync: (() => void) | null = null;
let onSubscribe: ((status: string) => void) | null = null;

const mockChannel = {
  on: vi.fn((_event: string, _filter: unknown, cb: () => void) => {
    onPresenceSync = cb;
    return mockChannel;
  }),
  subscribe: vi.fn((cb: (status: string) => void) => {
    onSubscribe = cb;
    return mockChannel;
  }),
  track: mockTrack,
  presenceState: mockPresenceState,
};

const mockRemoveChannel = vi.fn();

vi.mock('./online', () => ({
  getSupabaseClient: () => ({
    channel: () => mockChannel,
    removeChannel: mockRemoveChannel,
  }),
  generateRoomId: () => 'abc123',
}));

vi.mock('./online-debug', () => ({
  dlog: () => {},
}));

import { findMatch } from './online-matchmaking';

const originalRandomUUID = crypto.randomUUID.bind(crypto);

beforeEach(() => {
  vi.useFakeTimers();
  onPresenceSync = null;
  onSubscribe = null;
  mockTrack.mockClear();
  mockPresenceState.mockReturnValue({});
  mockRemoveChannel.mockClear();
  mockChannel.on.mockClear();
  mockChannel.subscribe.mockClear();
  crypto.randomUUID = originalRandomUUID;
});

afterEach(async () => {
  // Drain any pending timers to avoid unhandled rejections leaking across tests
  await vi.runAllTimersAsync().catch(() => {});
  crypto.randomUUID = originalRandomUUID;
  vi.useRealTimers();
});

/** Flush microtasks without advancing fake timers. */
async function flushMicrotasks() {
  await vi.advanceTimersByTimeAsync(0);
}

describe('findMatch', () => {
  it('returns a promise and cancel function', () => {
    const { promise, cancel } = findMatch();
    expect(promise).toBeInstanceOf(Promise);
    expect(typeof cancel).toBe('function');
    cancel(); // clean up
    promise.catch(() => {}); // suppress unhandled rejection
  });

  it('tracks seeking status on subscribe', async () => {
    const { promise, cancel } = findMatch();
    onSubscribe?.('SUBSCRIBED');
    await flushMicrotasks();
    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'seeking' }),
    );
    cancel();
    promise.catch(() => {});
  });

  it('becomes host when seekerId < peerId', async () => {
    crypto.randomUUID = () => 'aaaa-0000' as `${string}-${string}-${string}-${string}-${string}`;

    const { promise } = findMatch();
    onSubscribe?.('SUBSCRIBED');
    await flushMicrotasks();

    mockPresenceState.mockReturnValue({
      'zzzz-9999': [{ seekerId: 'zzzz-9999', status: 'seeking' }],
    });
    onPresenceSync?.();

    const result = await promise;
    expect(result.role).toBe('host');
    expect(result.roomId).toBe('abc123');
  });

  it('becomes guest when a host selects us', async () => {
    crypto.randomUUID = () => 'zzzz-9999' as `${string}-${string}-${string}-${string}-${string}`;

    const { promise } = findMatch();
    onSubscribe?.('SUBSCRIBED');
    await flushMicrotasks();

    mockPresenceState.mockReturnValue({
      'aaaa-0000': [{ seekerId: 'aaaa-0000', status: 'hosting', roomId: 'room42', guestId: 'zzzz-9999' }],
    });
    onPresenceSync?.();

    const result = await promise;
    expect(result.role).toBe('guest');
    expect(result.roomId).toBe('room42');
  });

  it('does not match when seekerId > peerId (waits to be selected)', async () => {
    crypto.randomUUID = () => 'zzzz-9999' as `${string}-${string}-${string}-${string}-${string}`;

    const { promise, cancel } = findMatch();
    onSubscribe?.('SUBSCRIBED');
    await flushMicrotasks();

    // Peer with lower ID is seeking — we should NOT become host (lower ID hosts)
    mockPresenceState.mockReturnValue({
      'aaaa-0000': [{ seekerId: 'aaaa-0000', status: 'seeking' }],
    });
    onPresenceSync?.();

    // Promise should still be pending — verify by racing with a known value
    const pending = Symbol('pending');
    const raceResult = await Promise.race([
      promise.then(() => 'resolved' as const).catch(() => 'rejected' as const),
      Promise.resolve(pending),
    ]);
    expect(raceResult).toBe(pending);

    cancel();
    promise.catch(() => {});
  });

  it('ignores own seekerId in presence state', async () => {
    crypto.randomUUID = () => 'aaaa-0000' as `${string}-${string}-${string}-${string}-${string}`;

    const { promise, cancel } = findMatch();
    onSubscribe?.('SUBSCRIBED');
    await flushMicrotasks();

    // Only our own presence — should not match
    mockPresenceState.mockReturnValue({
      'aaaa-0000': [{ seekerId: 'aaaa-0000', status: 'seeking' }],
    });
    onPresenceSync?.();

    const pending = Symbol('pending');
    const raceResult = await Promise.race([
      promise.then(() => 'resolved' as const).catch(() => 'rejected' as const),
      Promise.resolve(pending),
    ]);
    expect(raceResult).toBe(pending);

    cancel();
    promise.catch(() => {});
  });

  it('rejects on timeout', async () => {
    const { promise } = findMatch();
    onSubscribe?.('SUBSCRIBED');

    // Attach rejection handler before advancing timers to avoid unhandled rejection
    const expectation = expect(promise).rejects.toThrow('No opponent found');
    await vi.advanceTimersByTimeAsync(60_000);
    await expectation;
  });

  it('rejects on cancel', async () => {
    const { promise, cancel } = findMatch();
    cancel();
    await expect(promise).rejects.toThrow('Matchmaking cancelled');
  });

  it('rejects on channel error', async () => {
    const { promise } = findMatch();
    onSubscribe?.('CHANNEL_ERROR');
    await expect(promise).rejects.toThrow('Matchmaking channel failed: CHANNEL_ERROR');
  });

  it('updates presence to hosting when becoming host', async () => {
    crypto.randomUUID = () => 'aaaa-0000' as `${string}-${string}-${string}-${string}-${string}`;

    const { promise } = findMatch();
    onSubscribe?.('SUBSCRIBED');
    await flushMicrotasks();

    mockPresenceState.mockReturnValue({
      'zzzz-9999': [{ seekerId: 'zzzz-9999', status: 'seeking' }],
    });
    onPresenceSync?.();

    await promise;

    expect(mockTrack).toHaveBeenCalledWith(
      expect.objectContaining({
        seekerId: 'aaaa-0000',
        status: 'hosting',
        roomId: 'abc123',
        guestId: 'zzzz-9999',
      }),
    );
  });

  it('does not match with a hosting peer meant for someone else', async () => {
    crypto.randomUUID = () => 'bbbb-1111' as `${string}-${string}-${string}-${string}-${string}`;

    const { promise, cancel } = findMatch();
    onSubscribe?.('SUBSCRIBED');
    await flushMicrotasks();

    // A host selected a different guest
    mockPresenceState.mockReturnValue({
      'aaaa-0000': [{ seekerId: 'aaaa-0000', status: 'hosting', roomId: 'room42', guestId: 'cccc-2222' }],
    });
    onPresenceSync?.();

    const pending = Symbol('pending');
    const raceResult = await Promise.race([
      promise.then(() => 'resolved' as const).catch(() => 'rejected' as const),
      Promise.resolve(pending),
    ]);
    expect(raceResult).toBe(pending);

    cancel();
    promise.catch(() => {});
  });
});
