import { getSupabaseClient } from './online';
import { dlog } from './online-debug';
import type { PeerCallbacks, PeerHandle } from './online-peer';

/** Unique ID for this browser tab — used for relay identity. */
const localPeerId = crypto.randomUUID();

/** Message types that are silently dropped in relay mode (guest ignores frame data in lockstep). */
const SUPPRESSED_TYPES = new Set(['frame']);

/** Keepalive ping interval for relay connections (ms). */
const RELAY_KEEPALIVE_INTERVAL_MS = 5_000;
/** If no pong received within this time, consider relay peer dead (ms). */
const RELAY_KEEPALIVE_TIMEOUT_MS = 15_000;

/**
 * Create a relay connection via Supabase broadcast.
 * Returns the same PeerHandle interface as createPeerConnection,
 * so it's a drop-in replacement when WebRTC fails.
 */
export async function createRelayConnection(
  roomId: string,
  _role: 'host' | 'guest',
  callbacks: PeerCallbacks,
): Promise<PeerHandle> {
  const client = getSupabaseClient();
  const channel = client.channel(`relay-${roomId}`, {
    config: { broadcast: { self: false } },
  });

  let remotePeerId = '';
  let destroyed = false;
  let announceInterval: ReturnType<typeof setInterval> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let keepaliveCheckTimer: ReturnType<typeof setInterval> | null = null;
  let lastPongTime = 0;

  const announceJoin = () => {
    channel.send({ type: 'broadcast', event: 'join', payload: { peerId: localPeerId } });
  };

  const stopKeepalive = () => {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    if (keepaliveCheckTimer) { clearInterval(keepaliveCheckTimer); keepaliveCheckTimer = null; }
  };

  const startKeepalive = () => {
    stopKeepalive();
    lastPongTime = Date.now();

    keepaliveTimer = setInterval(() => {
      if (destroyed || !remotePeerId) return;
      channel.send({
        type: 'broadcast',
        event: 'ping',
        payload: { peerId: localPeerId },
      });
    }, RELAY_KEEPALIVE_INTERVAL_MS);

    keepaliveCheckTimer = setInterval(() => {
      if (destroyed || !remotePeerId) return;
      const elapsed = Date.now() - lastPongTime;
      if (elapsed > RELAY_KEEPALIVE_TIMEOUT_MS) {
        dlog(`relay: keepalive timeout (${elapsed}ms since last pong)`);
        stopKeepalive();
        callbacks.onClose(remotePeerId);
      }
    }, RELAY_KEEPALIVE_INTERVAL_MS / 2);
  };

  channel.on('broadcast', { event: 'join' }, ({ payload }) => {
    if (destroyed) return;
    const peerId = payload.peerId as string;
    if (peerId === localPeerId) return;
    if (remotePeerId) return; // already paired
    remotePeerId = peerId;
    dlog(`relay: peer joined ${peerId.slice(0, 8)}`);
    // Acknowledge so the other peer discovers us too (fixes race condition)
    announceJoin();
    startKeepalive();
    callbacks.onOpen(peerId);
  });

  channel.on('broadcast', { event: 'data' }, ({ payload }) => {
    if (destroyed) return;
    const msg = payload as Record<string, unknown>;
    if (typeof msg.t !== 'string' || typeof msg.from !== 'string') return;
    if (msg.from === localPeerId) return;
    try {
      callbacks.onMessage(msg.t, msg.d, msg.from);
    } catch (e) {
      dlog(`relay: message handler error: ${e}`);
    }
  });

  channel.on('broadcast', { event: 'ping' }, ({ payload }) => {
    if (destroyed) return;
    const peerId = payload.peerId as string;
    if (peerId === localPeerId || peerId !== remotePeerId) return;
    channel.send({
      type: 'broadcast',
      event: 'pong',
      payload: { peerId: localPeerId },
    });
  });

  channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
    if (destroyed) return;
    const peerId = payload.peerId as string;
    if (peerId === localPeerId || peerId !== remotePeerId) return;
    lastPongTime = Date.now();
  });

  channel.on('broadcast', { event: 'bye' }, ({ payload }) => {
    if (destroyed) return;
    const peerId = payload.peerId as string;
    if (peerId === remotePeerId) {
      dlog(`relay: peer left ${peerId.slice(0, 8)}`);
      stopKeepalive();
      callbacks.onClose(peerId);
    }
  });

  await new Promise<void>((resolve, reject) => {
    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        dlog(`relay: subscribed room=${roomId}`);
        resolve();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        reject(new Error(`Relay channel failed: ${status}`));
      }
    });
  });

  // Announce presence immediately and periodically until paired
  announceJoin();
  announceInterval = setInterval(() => {
    if (destroyed || remotePeerId) {
      if (announceInterval) { clearInterval(announceInterval); announceInterval = null; }
      return;
    }
    announceJoin();
  }, 2_000);

  const send = (type: string, data: unknown) => {
    if (destroyed) return;
    if (SUPPRESSED_TYPES.has(type)) return;
    channel.send({
      type: 'broadcast',
      event: 'data',
      payload: { t: type, d: data, from: localPeerId },
    });
  };

  const leave = () => {
    destroyed = true;
    stopKeepalive();
    if (announceInterval) { clearInterval(announceInterval); announceInterval = null; }
    channel.send({ type: 'broadcast', event: 'bye', payload: { peerId: localPeerId } });
    client.removeChannel(channel);
  };

  const getPeers = (): Record<string, RTCPeerConnection> => ({});

  return { send, leave, getPeers };
}
