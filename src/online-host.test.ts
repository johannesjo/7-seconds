import { describe, it, expect, vi, beforeEach } from 'vitest';

// Capture the callbacks OnlineHost passes into createOnlineRoom so we can drive
// the peer lifecycle directly.
let onPeerJoin: ((peerId: string) => void) | null = null;
let onPeerLeave: ((peerId: string) => void) | null = null;

const fakeConnection = {
  state: [vi.fn(), vi.fn()],
  phase: [vi.fn(), vi.fn()],
  paths: [vi.fn(), vi.fn()],
  result: [vi.fn(), vi.fn()],
  signal: [vi.fn(), vi.fn()],
  waypoints: [vi.fn(), vi.fn()],
  sync: [vi.fn(), vi.fn()],
  getPeers: () => ({}),
  leave: vi.fn(),
};

vi.mock('./online', () => ({
  createOnlineRoom: vi.fn(async (_roomId: string, _role: string, join: (p: string) => void, leave: (p: string) => void) => {
    onPeerJoin = join;
    onPeerLeave = leave;
    return fakeConnection;
  }),
  generateRoomId: () => 'room01',
  getShareUrl: (id: string) => `https://x/?join=${id}`,
  getLocalPlayerId: () => '00000000-0000-4000-8000-000000000000',
}));

vi.mock('./online-debug', () => ({ dlog: () => {}, startPeerMonitor: () => () => {} }));

import { OnlineHost } from './online-host';
import type { OnlineConnectionState } from './online-types';

function makeHost(onState: (s: OnlineConnectionState) => void): OnlineHost {
  return new OnlineHost({
    onConnectionStateChange: onState,
    onShareUrl: () => {},
    onGuestPathsReceived: () => {},
    onGuestRematchRequested: () => {},
    onGuestIdentity: () => {},
  });
}

beforeEach(() => {
  onPeerJoin = null;
  onPeerLeave = null;
});

describe('OnlineHost transport-failure handling', () => {
  it('fails fast to error when the transport dies before any guest connects', async () => {
    const onState = vi.fn();
    const host = makeHost(onState);
    await host.createRoomWithId('room01');
    onState.mockClear();

    // Empty peerId = transport itself failed (e.g. relay fallback creation threw)
    onPeerLeave?.('');
    expect(onState).toHaveBeenCalledWith('error');

    host.destroy();
  });

  it('does NOT force error on an empty-peer leave once a guest has connected', async () => {
    const onState = vi.fn();
    const host = makeHost(onState);
    await host.createRoomWithId('room01');

    onPeerJoin?.('guest-1'); // guest bound → connected
    onState.mockClear();

    onPeerLeave?.(''); // stray empty leave must be ignored now
    expect(onState).not.toHaveBeenCalledWith('error');

    host.destroy();
  });

  it('reports disconnected when the actual guest peer leaves', async () => {
    const onState = vi.fn();
    const host = makeHost(onState);
    await host.createRoomWithId('room01');

    onPeerJoin?.('guest-1');
    onState.mockClear();

    onPeerLeave?.('guest-1');
    expect(onState).toHaveBeenCalledWith('disconnected');

    host.destroy();
  });
});
