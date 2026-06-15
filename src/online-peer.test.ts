import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// ── Mocks ────────────────────────────────────────────────────────────

let signalHandler: ((payload: { payload: unknown }) => void) | null = null;
let onSubscribe: ((status: string) => void) | null = null;

const mockChannelSend = vi.fn();
const mockRemoveChannel = vi.fn();

const mockChannel = {
  on: vi.fn((_event: string, _filter: unknown, cb: (payload: { payload: unknown }) => void) => {
    signalHandler = cb;
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
  localPeerId: 'local-peer-id-1234',
}));

vi.mock('./online-debug', () => ({
  dlog: () => {},
}));

// ── RTCPeerConnection mock ───────────────────────────────────────────

interface MockDataChannel {
  label: string;
  binaryType: string;
  readyState: string;
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((e: { data: string }) => void) | null;
  send: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

interface MockPC {
  connectionState: string;
  iceConnectionState: string;
  signalingState: string;
  localDescription: { sdp: string } | null;
  remoteDescription: { type: string; sdp: string } | null;
  onicecandidate: ((e: { candidate: { type: string; protocol: string; toJSON: () => unknown } | null }) => void) | null;
  onconnectionstatechange: (() => void) | null;
  oniceconnectionstatechange: (() => void) | null;
  ondatachannel: ((e: { channel: MockDataChannel }) => void) | null;
  createDataChannel: ReturnType<typeof vi.fn>;
  createOffer: ReturnType<typeof vi.fn>;
  createAnswer: ReturnType<typeof vi.fn>;
  setLocalDescription: ReturnType<typeof vi.fn>;
  setRemoteDescription: ReturnType<typeof vi.fn>;
  addIceCandidate: ReturnType<typeof vi.fn>;
  restartIce: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

let lastCreatedPC: MockPC;
let lastCreatedDC: MockDataChannel;

function createMockDataChannel(label = 'data'): MockDataChannel {
  return {
    label,
    binaryType: '',
    readyState: 'connecting',
    onopen: null,
    onclose: null,
    onmessage: null,
    send: vi.fn(),
    close: vi.fn(),
  };
}

function createMockPC(): MockPC {
  const dc = createMockDataChannel();
  lastCreatedDC = dc;

  const pc: MockPC = {
    connectionState: 'new',
    iceConnectionState: 'new',
    signalingState: 'stable',
    localDescription: null,
    remoteDescription: null,
    onicecandidate: null,
    onconnectionstatechange: null,
    oniceconnectionstatechange: null,
    ondatachannel: null,
    createDataChannel: vi.fn(() => dc),
    createOffer: vi.fn(async () => ({ type: 'offer', sdp: 'mock-offer-sdp' })),
    createAnswer: vi.fn(async () => ({ type: 'answer', sdp: 'mock-answer-sdp' })),
    setLocalDescription: vi.fn(async (desc: { sdp: string }) => {
      pc.localDescription = { sdp: desc.sdp };
    }),
    setRemoteDescription: vi.fn(async (desc: { type: string; sdp: string }) => {
      pc.remoteDescription = desc;
    }),
    addIceCandidate: vi.fn(async () => {}),
    restartIce: vi.fn(),
    close: vi.fn(),
  };

  lastCreatedPC = pc;
  return pc;
}

// Install RTCPeerConnection globally
// Must use `function` (not arrow) so it can be called with `new`
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).RTCPeerConnection = function (_config?: unknown) {
  return createMockPC();
};

import { createPeerConnection, type PeerCallbacks } from './online-peer';

// ── Helpers ──────────────────────────────────────────────────────────

function makeCallbacks() {
  return {
    onOpen: vi.fn<(peerId: string) => void>(),
    onClose: vi.fn<(peerId: string) => void>(),
    onReconnecting: vi.fn<(peerId: string) => void>(),
    onMessage: vi.fn<(type: string, data: unknown, peerId: string) => void>(),
  };
}

/** Start createPeerConnection and immediately subscribe the channel. */
async function createAndSubscribe(role: 'host' | 'guest', callbacks: PeerCallbacks) {
  const handlePromise = createPeerConnection('test-room', role, callbacks);
  // Trigger subscription
  onSubscribe?.('SUBSCRIBED');
  return handlePromise;
}

/** Simulate a guest receiving an offer from a remote host. */
function sendOfferSignal(peerId = 'remote-peer-1234', sdp = 'remote-offer-sdp') {
  signalHandler?.({ payload: { type: 'offer', sdp, peerId } });
}

/** Simulate a host receiving an answer from a remote guest. */
function sendAnswerSignal(peerId = 'remote-peer-1234', sdp = 'remote-answer-sdp') {
  signalHandler?.({ payload: { type: 'answer', sdp, peerId } });
}

/** Simulate receiving an ICE candidate. */
function sendCandidateSignal(peerId = 'remote-peer-1234') {
  signalHandler?.({ payload: { type: 'candidate', candidate: { candidate: 'mock' }, peerId } });
}

/** Simulate receiving a bye signal. */
function sendByeSignal(peerId = 'remote-peer-1234') {
  signalHandler?.({ payload: { type: 'bye', peerId } });
}

/** Open the data channel (simulates WebRTC connection completing). */
function openDataChannel() {
  lastCreatedDC.readyState = 'open';
  lastCreatedDC.onopen?.();
}

/** Close the data channel. */
function closeDataChannel() {
  lastCreatedDC.readyState = 'closed';
  lastCreatedDC.onclose?.();
}

/** Simulate receiving a message on the data channel. */
function receiveMessage(type: string, data: unknown) {
  lastCreatedDC.onmessage?.({ data: JSON.stringify({ t: type, d: data }) });
}

// ── Setup / Teardown ─────────────────────────────────────────────────

beforeEach(() => {
  vi.useFakeTimers();
  signalHandler = null;
  onSubscribe = null;
  mockChannelSend.mockClear();
  mockRemoveChannel.mockClear();
  mockChannel.on.mockClear();
  mockChannel.subscribe.mockClear();
  // Must use `function` (not arrow) so it can be called with `new`
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  (globalThis as any).RTCPeerConnection = function (_config?: unknown) {
    return createMockPC();
  };
});

afterEach(async () => {
  await vi.runAllTimersAsync().catch(() => {});
  vi.useRealTimers();
});

// ── Tests ────────────────────────────────────────────────────────────

describe('createPeerConnection', () => {
  describe('host role', () => {
    it('subscribes to signaling channel and creates offer', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      // Should have created an offer
      expect(lastCreatedPC.createOffer).toHaveBeenCalled();
      expect(lastCreatedPC.setLocalDescription).toHaveBeenCalledWith(
        expect.objectContaining({ sdp: 'mock-offer-sdp' }),
      );

      // Should have sent the offer via signaling
      expect(mockChannelSend).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'broadcast',
          event: 'signal',
          payload: expect.objectContaining({
            type: 'offer',
            sdp: 'mock-offer-sdp',
            peerId: 'local-peer-id-1234',
          }),
        }),
      );

      handle.leave();
    });

    it('creates a data channel labeled "data"', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      expect(lastCreatedPC.createDataChannel).toHaveBeenCalledWith('data');

      handle.leave();
    });

    it('re-announces offer every 3s until connected', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      const initialSendCount = mockChannelSend.mock.calls.length;

      await vi.advanceTimersByTimeAsync(3_000);
      expect(mockChannelSend.mock.calls.length).toBeGreaterThan(initialSendCount);

      handle.leave();
    });

    it('stops re-announcing after data channel opens', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      // Simulate connection completing
      sendAnswerSignal();
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      const sendCountAfterOpen = mockChannelSend.mock.calls.length;
      await vi.advanceTimersByTimeAsync(6_000);
      // No new announce signals (only keepalive pings on dc, not channel)
      const signalCalls = mockChannelSend.mock.calls.filter(
        (c) => c[0]?.event === 'signal' && c[0]?.payload?.type === 'offer',
      );
      const signalCountAfterOpen = signalCalls.length;

      // Advance more time, count shouldn't increase
      await vi.advanceTimersByTimeAsync(6_000);
      const signalCallsLater = mockChannelSend.mock.calls.filter(
        (c) => c[0]?.event === 'signal' && c[0]?.payload?.type === 'offer',
      );
      expect(signalCallsLater.length).toBe(signalCountAfterOpen);

      handle.leave();
    });

    it('sets remotePeerId from answer signal', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal('guest-peer-42');
      await vi.advanceTimersByTimeAsync(0);

      expect(lastCreatedPC.setRemoteDescription).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'answer', sdp: 'remote-answer-sdp' }),
      );

      handle.leave();
    });

    it('calls onOpen when data channel opens', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal('remote-peer-42');
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      expect(cb.onOpen).toHaveBeenCalledWith('remote-peer-42');

      handle.leave();
    });
  });

  describe('guest role', () => {
    it('subscribes without creating an offer', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('guest', cb);

      // Guest should not create an offer — no offer signal sent
      const offerCalls = mockChannelSend.mock.calls.filter(
        (c) => c[0]?.payload?.type === 'offer',
      );
      expect(offerCalls.length).toBe(0);

      handle.leave();
    });

    it('responds with answer when receiving offer', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('guest', cb);

      sendOfferSignal('host-peer-99');
      await vi.advanceTimersByTimeAsync(0);

      expect(lastCreatedPC.setRemoteDescription).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'offer', sdp: 'remote-offer-sdp' }),
      );
      expect(lastCreatedPC.createAnswer).toHaveBeenCalled();
      expect(mockChannelSend).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            type: 'answer',
            sdp: 'mock-answer-sdp',
            peerId: 'local-peer-id-1234',
          }),
        }),
      );

      handle.leave();
    });

    it('calls onOpen when data channel opens after offer', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('guest', cb);

      sendOfferSignal('host-peer-99');
      await vi.advanceTimersByTimeAsync(0);

      // Guest's PC sets ondatachannel, simulate host opening it
      const guestDC = createMockDataChannel();
      lastCreatedPC.ondatachannel?.({ channel: guestDC });
      guestDC.readyState = 'open';
      guestDC.onopen?.();

      expect(cb.onOpen).toHaveBeenCalledWith('host-peer-99');

      handle.leave();
    });

    it('ignores offers from own peerId', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('guest', cb);

      // Send offer with our own peerId — should be ignored
      signalHandler?.({ payload: { type: 'offer', sdp: 'sdp', peerId: 'local-peer-id-1234' } });
      await vi.advanceTimersByTimeAsync(0);

      expect(cb.onOpen).not.toHaveBeenCalled();

      handle.leave();
    });

    it('does not re-apply a duplicate re-announced offer to a live PC', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('guest', cb);

      sendOfferSignal('host-99', 'offer-sdp-1');
      await vi.advanceTimersByTimeAsync(0);
      const firstPC = lastCreatedPC;
      expect(firstPC.setRemoteDescription).toHaveBeenCalledTimes(1);

      // Host re-announces the SAME offer — must NOT renegotiate the live PC.
      sendOfferSignal('host-99', 'offer-sdp-1');
      await vi.advanceTimersByTimeAsync(0);
      expect(firstPC.setRemoteDescription).toHaveBeenCalledTimes(1);
      expect(lastCreatedPC).toBe(firstPC); // no new PC created

      handle.leave();
    });

    it('re-sends the answer (not a new one) when a duplicate offer arrives before connecting', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('guest', cb);

      sendOfferSignal('host-99', 'offer-sdp-1');
      await vi.advanceTimersByTimeAsync(0);

      const answerSendsBefore = mockChannelSend.mock.calls.filter(
        (c) => c[0]?.payload?.type === 'answer',
      ).length;
      expect(lastCreatedPC.createAnswer).toHaveBeenCalledTimes(1);

      // Duplicate offer while not yet connected → re-send existing answer.
      sendOfferSignal('host-99', 'offer-sdp-1');
      await vi.advanceTimersByTimeAsync(0);

      const answerSendsAfter = mockChannelSend.mock.calls.filter(
        (c) => c[0]?.payload?.type === 'answer',
      ).length;
      expect(answerSendsAfter).toBe(answerSendsBefore + 1);
      // But no fresh answer was generated.
      expect(lastCreatedPC.createAnswer).toHaveBeenCalledTimes(1);

      handle.leave();
    });

    it('rebuilds a fresh PC when the host sends a new offer (reconnect)', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('guest', cb);

      sendOfferSignal('host-99', 'offer-sdp-1');
      await vi.advanceTimersByTimeAsync(0);
      const firstPC = lastCreatedPC;

      // A genuinely new offer (different SDP) from the same host → fresh PC.
      sendOfferSignal('host-99', 'offer-sdp-2');
      await vi.advanceTimersByTimeAsync(0);

      expect(lastCreatedPC).not.toBe(firstPC);
      expect(firstPC.close).toHaveBeenCalled();
      expect(lastCreatedPC.setRemoteDescription).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'offer', sdp: 'offer-sdp-2' }),
      );

      handle.leave();
    });
  });

  describe('data channel messaging', () => {
    it('sends JSON messages through data channel', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal();
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      handle.send('test', { value: 42 });

      expect(lastCreatedDC.send).toHaveBeenCalledWith(
        JSON.stringify({ t: 'test', d: { value: 42 } }),
      );

      handle.leave();
    });

    it('does not send when data channel is not open', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      // DC not yet open
      handle.send('test', { value: 42 });
      expect(lastCreatedDC.send).not.toHaveBeenCalled();

      handle.leave();
    });

    it('dispatches received messages to onMessage callback', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal('remote-42');
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      receiveMessage('gameState', { units: [] });

      expect(cb.onMessage).toHaveBeenCalledWith('gameState', { units: [] }, 'remote-42');

      handle.leave();
    });

    it('ignores messages without a string type field', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal();
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      // Message with no 't' field
      lastCreatedDC.onmessage?.({ data: JSON.stringify({ d: 'no type' }) });
      expect(cb.onMessage).not.toHaveBeenCalled();

      handle.leave();
    });

    it('ignores unparseable messages', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal();
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      lastCreatedDC.onmessage?.({ data: 'not json{{{' });
      expect(cb.onMessage).not.toHaveBeenCalled();

      handle.leave();
    });
  });

  describe('keepalive', () => {
    it('sends ping messages periodically after connection', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal();
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      lastCreatedDC.send.mockClear();

      await vi.advanceTimersByTimeAsync(5_000);

      const pings = lastCreatedDC.send.mock.calls.filter((c) => {
        const msg = JSON.parse(c[0]);
        return msg.t === '_ping';
      });
      expect(pings.length).toBeGreaterThanOrEqual(1);

      handle.leave();
    });

    it('responds to ping with pong', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal();
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      lastCreatedDC.send.mockClear();
      receiveMessage('_ping', null);

      const pongs = lastCreatedDC.send.mock.calls.filter((c) => {
        const msg = JSON.parse(c[0]);
        return msg.t === '_pong';
      });
      expect(pongs.length).toBe(1);

      // _ping should not be forwarded to onMessage
      expect(cb.onMessage).not.toHaveBeenCalled();

      handle.leave();
    });

    it('does not forward _pong to onMessage', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal();
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      receiveMessage('_pong', null);
      expect(cb.onMessage).not.toHaveBeenCalled();

      handle.leave();
    });
  });

  describe('connection loss and reconnection', () => {
    it('calls onClose when data channel closes before ever connecting', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal('remote-42');
      await vi.advanceTimersByTimeAsync(0);

      // DC closes without ever having been open (wasConnected = false)
      closeDataChannel();

      expect(cb.onClose).toHaveBeenCalledWith('remote-42');

      handle.leave();
    });

    it('calls onReconnecting on first connection loss for host', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal('remote-42');
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      // Now close — should trigger reconnection (wasConnected = true)
      closeDataChannel();

      expect(cb.onReconnecting).toHaveBeenCalledWith('remote-42');

      handle.leave();
    });

    it('host does a full reconnect (fresh PC + plain offer) on connection loss', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal('remote-42');
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      mockChannelSend.mockClear();
      closeDataChannel();
      await vi.advanceTimersByTimeAsync(0);

      // Reconnection is symmetric: host rebuilds the PC (new data channel) and
      // re-offers with a plain offer — no ICE restart, which would mismatch the
      // guest's freshly-created PC.
      expect(lastCreatedPC.restartIce).not.toHaveBeenCalled();
      expect(lastCreatedPC.createOffer).toHaveBeenCalledWith();
      expect(lastCreatedPC.createDataChannel).toHaveBeenCalledWith('data');
      const offerSends = mockChannelSend.mock.calls.filter(
        (c) => c[0]?.event === 'signal' && c[0]?.payload?.type === 'offer',
      );
      expect(offerSends.length).toBeGreaterThanOrEqual(1);

      handle.leave();
    });

    it('calls onClose after max reconnect attempts exhausted', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal('remote-42');
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      // Simulate 3 failed reconnect attempts via connection state changes
      // Each ICE restart timeout (10s) + reconnect attempt timeout (15s) cycle
      for (let i = 0; i < 3; i++) {
        closeDataChannel();
        await vi.advanceTimersByTimeAsync(0);

        // Wait for ICE restart timeout
        await vi.advanceTimersByTimeAsync(10_000);

        // Wait for full reconnect attempt timeout
        await vi.advanceTimersByTimeAsync(15_000);
      }

      // After 3 attempts, onClose should have been called
      expect(cb.onClose).toHaveBeenCalled();

      handle.leave();
    });

    it('guest rebuilds a fresh PC and answers when the host re-offers after a loss', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('guest', cb);

      // Initial connect.
      sendOfferSignal('host-1', 'offer-1');
      await vi.advanceTimersByTimeAsync(0);
      const firstPC = lastCreatedPC;
      const guestDC = createMockDataChannel();
      firstPC.ondatachannel?.({ channel: guestDC });
      guestDC.readyState = 'open';
      guestDC.onopen?.();
      expect(cb.onOpen).toHaveBeenCalledWith('host-1');

      // Connection lost → guest schedules a reconnect and waits for a fresh offer.
      guestDC.readyState = 'closed';
      guestDC.onclose?.();
      expect(cb.onReconnecting).toHaveBeenCalledWith('host-1');

      // Host's fresh offer (new SDP) → guest builds a brand-new PC and answers.
      sendOfferSignal('host-1', 'offer-2');
      await vi.advanceTimersByTimeAsync(0);
      expect(lastCreatedPC).not.toBe(firstPC);
      expect(lastCreatedPC.setRemoteDescription).toHaveBeenCalledWith(
        expect.objectContaining({ type: 'offer', sdp: 'offer-2' }),
      );

      handle.leave();
    });

    it('does not tear down the rebuilt PC when the delayed reconnect fires (glare)', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('guest', cb);

      sendOfferSignal('host-1', 'offer-1');
      await vi.advanceTimersByTimeAsync(0);
      const firstPC = lastCreatedPC;
      const guestDC = createMockDataChannel();
      firstPC.ondatachannel?.({ channel: guestDC });
      guestDC.readyState = 'open';
      guestDC.onopen?.();

      // Loss detected; guest's proactive teardown is scheduled (RECONNECT_DELAY_MS).
      guestDC.readyState = 'closed';
      guestDC.onclose?.();

      // Host's fresh offer arrives BEFORE the delayed teardown → guest rebuilds.
      sendOfferSignal('host-1', 'offer-2');
      await vi.advanceTimersByTimeAsync(0);
      const rebuiltPC = lastCreatedPC;
      expect(rebuiltPC).not.toBe(firstPC);
      rebuiltPC.close.mockClear();

      // The delayed proactive teardown now fires — it must NOT close the rebuilt PC.
      await vi.advanceTimersByTimeAsync(2_000);
      expect(rebuiltPC.close).not.toHaveBeenCalled();
      expect(lastCreatedPC).toBe(rebuiltPC); // no further rebuild

      handle.leave();
    });

    it('does not reconnect during intentional teardown (leave)', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal('remote-42');
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      // Leave triggers tearingDown = true, so dc.onclose should not trigger reconnect
      handle.leave();

      expect(cb.onReconnecting).not.toHaveBeenCalled();
    });
  });

  describe('bye signal', () => {
    it('calls onClose when receiving bye from remote peer', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendByeSignal('remote-42');
      await vi.advanceTimersByTimeAsync(0);

      expect(cb.onClose).toHaveBeenCalledWith('remote-42');

      handle.leave();
    });
  });

  describe('ICE candidate buffering', () => {
    it('buffers candidates received before remote description is set', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('guest', cb);

      // Send candidate before any offer
      sendCandidateSignal('host-99');
      await vi.advanceTimersByTimeAsync(0);

      // Candidate should not have been added yet (no PC with remote desc)
      // Now send offer which creates the PC and sets remote desc
      sendOfferSignal('host-99');
      await vi.advanceTimersByTimeAsync(0);

      // After offer is processed, buffered candidates should be flushed
      expect(lastCreatedPC.addIceCandidate).toHaveBeenCalled();

      handle.leave();
    });

    it('adds candidates immediately when remote description exists', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      // Host has a PC. Set remote description via answer
      sendAnswerSignal('guest-42');
      await vi.advanceTimersByTimeAsync(0);

      // Now send candidate — should be added immediately
      lastCreatedPC.addIceCandidate.mockClear();
      sendCandidateSignal('guest-42');
      await vi.advanceTimersByTimeAsync(0);

      expect(lastCreatedPC.addIceCandidate).toHaveBeenCalled();

      handle.leave();
    });
  });

  describe('getPeers', () => {
    it('returns empty object before connection', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('guest', cb);

      expect(handle.getPeers()).toEqual({});

      handle.leave();
    });

    it('returns peer connection after connecting as host', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal('remote-42');
      await vi.advanceTimersByTimeAsync(0);

      const peers = handle.getPeers();
      expect(Object.keys(peers)).toEqual(['remote-42']);

      handle.leave();
    });
  });

  describe('leave', () => {
    it('sends bye signal and cleans up', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal();
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      handle.leave();

      expect(mockChannelSend).toHaveBeenCalledWith(
        expect.objectContaining({
          payload: expect.objectContaining({
            type: 'bye',
            peerId: 'local-peer-id-1234',
          }),
        }),
      );
      expect(lastCreatedDC.close).toHaveBeenCalled();
      expect(lastCreatedPC.close).toHaveBeenCalled();
      expect(mockRemoveChannel).toHaveBeenCalled();
    });

    it('does not fire callbacks after leave', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      handle.leave();

      // Signals after leave should be ignored
      sendOfferSignal('late-peer');
      await vi.advanceTimersByTimeAsync(0);
      sendByeSignal('late-peer');
      await vi.advanceTimersByTimeAsync(0);

      expect(cb.onOpen).not.toHaveBeenCalled();
      // onClose should not be called for late-peer (destroyed = true)
    });
  });

  describe('connection state change', () => {
    it('calls onClose when connection state becomes "closed"', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal('remote-42');
      await vi.advanceTimersByTimeAsync(0);

      // Simulate connection state going to 'closed'
      lastCreatedPC.connectionState = 'closed';
      lastCreatedPC.onconnectionstatechange?.();

      // Not destroyed, not reconnecting, not tearing down → should call onClose
      expect(cb.onClose).toHaveBeenCalledWith('remote-42');

      handle.leave();
    });

    it('triggers handleConnectionLost when connection state becomes "failed"', async () => {
      const cb = makeCallbacks();
      const handle = await createAndSubscribe('host', cb);

      sendAnswerSignal('remote-42');
      await vi.advanceTimersByTimeAsync(0);
      openDataChannel();

      // Simulate connection state going to 'failed'
      lastCreatedPC.connectionState = 'failed';
      lastCreatedPC.onconnectionstatechange?.();

      // wasConnected is true → should trigger reconnection
      expect(cb.onReconnecting).toHaveBeenCalledWith('remote-42');

      handle.leave();
    });
  });

  describe('channel subscription failure', () => {
    it('rejects when signaling channel fails', async () => {
      const cb = makeCallbacks();
      const promise = createPeerConnection('test-room', 'host', cb);

      // Trigger channel error
      onSubscribe?.('CHANNEL_ERROR');

      await expect(promise).rejects.toThrow('Signaling channel failed: CHANNEL_ERROR');
    });

    it('rejects on timeout', async () => {
      const cb = makeCallbacks();
      const promise = createPeerConnection('test-room', 'host', cb);

      onSubscribe?.('TIMED_OUT');

      await expect(promise).rejects.toThrow('Signaling channel failed: TIMED_OUT');
    });
  });
});
