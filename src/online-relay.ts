import type { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabaseClient, localPeerId } from './online';
import { dlog } from './online-debug';
import type { PeerCallbacks, PeerHandle } from './online-peer';

/** Keepalive ping interval for relay connections (ms). */
const RELAY_KEEPALIVE_INTERVAL_MS = 5_000;
/** If no pong received within this time, consider relay peer dead (ms). */
const RELAY_KEEPALIVE_TIMEOUT_MS = 15_000;
/** Maximum number of reconnection attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;
/** How long to wait for peer to respond during reconnection (ms). */
const RECONNECT_TIMEOUT_MS = 15_000;
/** Delays (ms) at which each data message is re-broadcast. Supabase broadcast is
 *  best-effort and unordered, so a single drop would otherwise soft-lock the game
 *  (a lost `waypoints`/`result`/`paths` has no other recovery). Re-sending a few
 *  times sharply cuts the loss probability; the receiver dedupes by sequence
 *  number so duplicates are harmless. WebRTC's data channel is already reliable,
 *  so this only applies to the relay fallback. */
const RETRANSMIT_DELAYS_MS = [250, 700];

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
  let wasConnected = false;
  let reconnecting = false;
  let reconnectAttempts = 0;
  let announceInterval: ReturnType<typeof setInterval> | null = null;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let keepaliveCheckTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let lastPongTime = 0;
  /** Monotonic sequence number stamped on each outgoing data message. */
  let dataSeq = 0;
  /** Highest sequence seen per message type, for deduping retransmissions. */
  const lastSeqByType = new Map<string, number>();
  /** Pending retransmit timers, cleared on teardown. */
  const retransmitTimers = new Set<ReturnType<typeof setTimeout>>();

  /** Supabase broadcast can reject (e.g. socket mid-reconnect). Swallow the
   *  failure — the retransmit/announce loops are the recovery mechanism, and an
   *  unhandled rejection would otherwise surface as a console error. */
  const safeSend = (msg: Parameters<RealtimeChannel['send']>[0]) => {
    try {
      void Promise.resolve(channel.send(msg)).catch((e) => dlog(`relay send error: ${e}`));
    } catch (e) {
      dlog(`relay send threw: ${e}`);
    }
  };

  const clearAnnounceInterval = () => {
    if (announceInterval) { clearInterval(announceInterval); announceInterval = null; }
  };

  const clearReconnectTimer = () => {
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
  };

  const announceJoin = () => {
    safeSend({ type: 'broadcast', event: 'join', payload: { peerId: localPeerId } });
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
      safeSend({
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
        handleConnectionLost();
      }
    }, RELAY_KEEPALIVE_INTERVAL_MS / 2);
  };

  const handleConnectionLost = () => {
    if (destroyed || reconnecting) return;

    if (!wasConnected || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      dlog(`relay: connection lost, no reconnect (was=${wasConnected} attempts=${reconnectAttempts})`);
      if (!destroyed) callbacks.onClose(remotePeerId);
      return;
    }

    reconnecting = true;
    reconnectAttempts++;
    dlog(`relay: attempting reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

    if (reconnectAttempts === 1) {
      callbacks.onReconnecting?.(remotePeerId);
    }

    // Re-announce to rediscover the peer on the existing channel
    announceJoin();
    clearAnnounceInterval();
    announceInterval = setInterval(() => {
      if (destroyed || !reconnecting) {
        clearAnnounceInterval();
        return;
      }
      announceJoin();
    }, 2_000);

    // Timeout for this reconnect attempt
    clearReconnectTimer();
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      if (destroyed) return;
      if (!reconnecting) return; // reconnected successfully
      dlog('relay: reconnect attempt timed out');
      reconnecting = false;
      clearAnnounceInterval();
      handleConnectionLost();
    }, RECONNECT_TIMEOUT_MS);
  };

  const handlePeerRejoined = (peerId: string) => {
    if (!reconnecting || peerId !== remotePeerId) return;
    dlog(`relay: peer rejoined ${peerId.slice(0, 8)}`);
    reconnecting = false;
    reconnectAttempts = 0;
    clearAnnounceInterval();
    clearReconnectTimer();
    startKeepalive();
    callbacks.onOpen(peerId);
  };

  channel.on('broadcast', { event: 'join' }, ({ payload }) => {
    if (destroyed) return;
    const peerId = payload.peerId as string;
    if (peerId === localPeerId) return;

    // During reconnection, accept rejoin from the same peer
    if (reconnecting && peerId === remotePeerId) {
      handlePeerRejoined(peerId);
      return;
    }

    if (remotePeerId) return; // already paired
    remotePeerId = peerId;
    wasConnected = true;
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

    // If we receive data during reconnection, the peer is back
    if (reconnecting && msg.from === remotePeerId) {
      handlePeerRejoined(msg.from);
    }

    // Drop retransmitted duplicates: each message type carries a monotonic
    // sequence, so anything at or below the last seen seq has already been
    // delivered (or is a stale reorder we don't want to re-apply).
    if (typeof msg.seq === 'number') {
      const last = lastSeqByType.get(msg.t);
      if (last !== undefined && msg.seq <= last) return;
      lastSeqByType.set(msg.t, msg.seq);
    }

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

    // Receiving a ping during reconnection means the peer is alive
    if (reconnecting) {
      handlePeerRejoined(peerId);
    }

    safeSend({
      type: 'broadcast',
      event: 'pong',
      payload: { peerId: localPeerId },
    });
  });

  channel.on('broadcast', { event: 'pong' }, ({ payload }) => {
    if (destroyed) return;
    const peerId = payload.peerId as string;
    if (peerId === localPeerId || peerId !== remotePeerId) return;

    // Receiving a pong during reconnection means the peer is alive
    if (reconnecting) {
      handlePeerRejoined(peerId);
    }

    lastPongTime = Date.now();
  });

  channel.on('broadcast', { event: 'bye' }, ({ payload }) => {
    if (destroyed) return;
    const peerId = payload.peerId as string;
    if (peerId === remotePeerId) {
      dlog(`relay: peer left ${peerId.slice(0, 8)}`);
      stopKeepalive();
      clearReconnectTimer();
      clearAnnounceInterval();
      reconnecting = false;
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
    const payload = { t: type, d: data, from: localPeerId, seq: ++dataSeq };
    const broadcast = () => {
      if (destroyed) return;
      safeSend({ type: 'broadcast', event: 'data', payload });
    };
    broadcast();
    // Re-send a few times so a dropped broadcast doesn't soft-lock the game.
    for (const delay of RETRANSMIT_DELAYS_MS) {
      const timer = setTimeout(() => {
        retransmitTimers.delete(timer);
        broadcast();
      }, delay);
      retransmitTimers.add(timer);
    }
  };

  const clearRetransmitTimers = () => {
    for (const timer of retransmitTimers) clearTimeout(timer);
    retransmitTimers.clear();
  };

  const leave = () => {
    destroyed = true;
    stopKeepalive();
    clearReconnectTimer();
    clearAnnounceInterval();
    clearRetransmitTimers();
    safeSend({ type: 'broadcast', event: 'bye', payload: { peerId: localPeerId } });
    client.removeChannel(channel);
  };

  const getPeers = (): Record<string, RTCPeerConnection> => ({});

  return { send, leave, getPeers };
}
