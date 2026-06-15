import { RealtimeChannel } from '@supabase/supabase-js';
import { getSupabaseClient, localPeerId } from './online';
import { dlog } from './online-debug';

/** Messages sent over Supabase Realtime for WebRTC signaling. */
type SignalMessage =
  | { type: 'offer'; sdp: string; peerId: string }
  | { type: 'answer'; sdp: string; peerId: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit; peerId: string }
  | { type: 'bye'; peerId: string };

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

/** Keepalive ping interval — keeps NAT bindings alive and detects dead channels. */
const KEEPALIVE_INTERVAL_MS = 5_000;
/** If no pong received within this time, consider the connection dead. */
const KEEPALIVE_TIMEOUT_MS = 15_000;
/** Delay before attempting reconnection after a failure. */
const RECONNECT_DELAY_MS = 2_000;
/** Maximum number of reconnection attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 3;
/** How long to wait for a full reconnect attempt to succeed before retrying or giving up. */
const RECONNECT_ATTEMPT_TIMEOUT_MS = 15_000;

export interface PeerCallbacks {
  onOpen: (peerId: string) => void;
  onClose: (peerId: string) => void;
  onReconnecting?: (peerId: string) => void;
  onMessage: (type: string, data: unknown, peerId: string) => void;
}

export interface PeerHandle {
  send: (type: string, data: unknown) => void;
  leave: () => void;
  getPeers: () => Record<string, RTCPeerConnection>;
}

export async function createPeerConnection(
  roomId: string,
  role: 'host' | 'guest',
  callbacks: PeerCallbacks,
): Promise<PeerHandle> {
  const client = getSupabaseClient();
  let channel: RealtimeChannel;

  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let remotePeerId = '';
  let destroyed = false;
  let wasConnected = false;
  let reconnectAttempts = 0;
  let keepaliveTimer: ReturnType<typeof setInterval> | null = null;
  let lastPongTime = 0;
  let keepaliveCheckTimer: ReturnType<typeof setInterval> | null = null;
  let reconnectAttemptTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnecting = false;
  /** Guest only: set when the host's fresh reconnect offer has already rebuilt
   *  our PC during the current reconnect cycle, so the delayed proactive
   *  teardown doesn't destroy a connection that's mid-negotiation (glare). */
  let guestRebuiltThisCycle = false;
  /** SDP of the offer the guest has most recently applied — used to ignore the
   *  host's periodic re-announcements of the same offer (a duplicate offer
   *  applied to a live PC would needlessly renegotiate and can break it). */
  let appliedOfferSdp = '';
  /** SDP of the answer the guest last sent — re-sent (not regenerated) if the
   *  host re-announces the same offer before connecting, in case it was lost. */
  let lastAnswerSdp = '';
  /** Set during intentional teardown to suppress dc.onclose triggering reconnect. */
  let tearingDown = false;
  let announceInterval: ReturnType<typeof setInterval> | null = null;

  const clearAnnounceInterval = () => {
    if (announceInterval) { clearInterval(announceInterval); announceInterval = null; }
  };

  const signal = (msg: SignalMessage) => {
    try {
      channel.send({ type: 'broadcast', event: 'signal', payload: msg });
    } catch (e) {
      dlog(`signal send error: ${e}`);
    }
  };

  // ── Keepalive ──────────────────────────────────────────────────────

  const stopKeepalive = () => {
    if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
    if (keepaliveCheckTimer) { clearInterval(keepaliveCheckTimer); keepaliveCheckTimer = null; }
  };

  const startKeepalive = () => {
    stopKeepalive();
    lastPongTime = Date.now();

    // Send ping every KEEPALIVE_INTERVAL_MS
    keepaliveTimer = setInterval(() => {
      if (dc?.readyState === 'open') {
        try { dc.send(JSON.stringify({ t: '_ping', d: null })); } catch { /* ignore */ }
      }
    }, KEEPALIVE_INTERVAL_MS);

    // Check for pong timeout — run at half interval for faster detection
    keepaliveCheckTimer = setInterval(() => {
      if (dc?.readyState !== 'open') return;
      const elapsed = Date.now() - lastPongTime;
      if (elapsed > KEEPALIVE_TIMEOUT_MS) {
        dlog(`keepalive timeout (${elapsed}ms since last pong)`);
        stopKeepalive();
        handleConnectionLost();
      }
    }, KEEPALIVE_INTERVAL_MS / 2);
  };

  // ── Connection loss & reconnection ─────────────────────────────────

  const handleConnectionLost = () => {
    if (destroyed || reconnecting || tearingDown) return;

    // Only attempt reconnect if we were previously connected
    if (!wasConnected || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      dlog(`connection lost, no reconnect (was=${wasConnected} attempts=${reconnectAttempts})`);
      if (!destroyed) callbacks.onClose(remotePeerId);
      return;
    }

    reconnecting = true;
    reconnectAttempts++;
    dlog(`connection lost, attempting reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

    // Notify higher layers so UI can show "Reconnecting..." immediately
    if (reconnectAttempts === 1) {
      callbacks.onReconnecting?.(remotePeerId);
    }

    // Reconnection is symmetric: both sides tear down their PC and build a
    // fresh one, so DTLS state matches on both ends. (An ICE restart keeps the
    // old DTLS session on one side while the peer creates a new PC, causing a
    // fingerprint mismatch that never completes the handshake.) The host drives
    // it by immediately re-offering from a new PC; the guest tears down and
    // waits for that fresh offer.
    if (role === 'host') {
      doFullReconnect();
    } else {
      scheduleFullReconnect();
    }
  };

  const scheduleFullReconnect = () => {
    // Start of a guest reconnect cycle — clear any prior rebuild marker.
    guestRebuiltThisCycle = false;
    setTimeout(() => {
      if (destroyed) return;
      doFullReconnect();
    }, RECONNECT_DELAY_MS);
  };

  const clearReconnectAttemptTimer = () => {
    if (reconnectAttemptTimer) { clearTimeout(reconnectAttemptTimer); reconnectAttemptTimer = null; }
  };

  /** Arm the safety-net timer that bounds a single reconnect attempt. When it
   *  fires, reset `reconnecting` and let handleConnectionLost retry or give up. */
  const armReconnectAttemptTimer = () => {
    clearReconnectAttemptTimer();
    reconnectAttemptTimer = setTimeout(() => {
      reconnectAttemptTimer = null;
      if (destroyed || dc?.readyState === 'open') return;
      dlog('reconnect attempt timed out');
      reconnecting = false;
      handleConnectionLost();
    }, RECONNECT_ATTEMPT_TIMEOUT_MS);
  };

  const doFullReconnect = () => {
    if (destroyed) return;

    // Glare: the host's fresh offer already rebuilt our PC during this cycle.
    // Don't tear that PC back down — let it finish negotiating; just keep the
    // safety-net timer running to bound the new handshake.
    if (role === 'guest' && guestRebuiltThisCycle) {
      dlog('reconnect: guest already rebuilt from host offer, not tearing down');
      armReconnectAttemptTimer();
      return;
    }

    dlog('full reconnect: tearing down old PC');

    // Set tearingDown to prevent dc.onclose from re-triggering handleConnectionLost
    tearingDown = true;

    // Clean up old connection
    stopKeepalive();
    clearReconnectAttemptTimer();
    clearAnnounceInterval();
    dc?.close();
    pc?.close();
    dc = null;
    pc = null;
    pendingCandidates = [];

    tearingDown = false;

    // Bound this reconnect attempt so it doesn't hang forever.
    armReconnectAttemptTimer();

    if (role === 'host') {
      // Host: create new PC and send fresh offer
      pc = createPC();
      pc.createOffer().then(async (offer) => {
        if (destroyed || !pc) return;
        await pc.setLocalDescription(offer);
        dlog('reconnect: sending new offer');
        signal({ type: 'offer', sdp: offer.sdp!, peerId: localPeerId });

        // Re-announce until the guest answers (remoteDescription set) or we
        // connect. Stopping once answered avoids re-applying a stale offer to a
        // guest that is already negotiating.
        clearAnnounceInterval();
        announceInterval = setInterval(() => {
          if (destroyed || dc?.readyState === 'open' || pc?.remoteDescription) {
            clearAnnounceInterval();
            return;
          }
          dlog('reconnect: re-announcing offer');
          signal({ type: 'offer', sdp: pc?.localDescription?.sdp ?? offer.sdp!, peerId: localPeerId });
        }, 3_000);
      }).catch((e) => {
        dlog(`reconnect offer error: ${e}`);
        clearReconnectAttemptTimer();
        reconnecting = false;
        if (!destroyed) callbacks.onClose(remotePeerId);
      });
    } else {
      // Guest: clear existing PC so next offer from host will be accepted
      dlog('reconnect: guest waiting for host offer');
    }
  };

  // ── Data channel setup ─────────────────────────────────────────────

  const setupDataChannel = (chan: RTCDataChannel) => {
    chan.binaryType = 'arraybuffer';
    chan.onopen = () => {
      dlog(`dc open with ${remotePeerId.slice(0, 8)}`);
      wasConnected = true;
      reconnecting = false;
      tearingDown = false;
      reconnectAttempts = 0;
      guestRebuiltThisCycle = false;
      clearAnnounceInterval();
      clearReconnectAttemptTimer();
      startKeepalive();
      if (!destroyed) callbacks.onOpen(remotePeerId);
    };
    chan.onclose = () => {
      dlog(`dc close with ${remotePeerId.slice(0, 8)}`);
      stopKeepalive();
      // Don't trigger reconnect if we're intentionally tearing down
      if (!tearingDown) handleConnectionLost();
    };
    chan.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data as string);
        const t = msg?.t;
        if (typeof t !== 'string') return;
        // Handle keepalive internally
        if (t === '_ping') {
          if (dc?.readyState === 'open') {
            try { dc.send(JSON.stringify({ t: '_pong', d: null })); } catch { /* ignore */ }
          }
          return;
        }
        if (t === '_pong') {
          lastPongTime = Date.now();
          return;
        }
        callbacks.onMessage(t, msg.d, remotePeerId);
      } catch {
        dlog(`dc parse error`);
      }
    };
  };

  // ── RTCPeerConnection setup ────────────────────────────────────────

  const createPC = (): RTCPeerConnection => {
    const conn = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    conn.onicecandidate = (e) => {
      if (e.candidate) {
        dlog(`ice candidate: ${e.candidate.type ?? 'null'} ${e.candidate.protocol ?? ''}`);
        signal({ type: 'candidate', candidate: e.candidate.toJSON(), peerId: localPeerId });
      }
    };

    conn.onconnectionstatechange = () => {
      dlog(`connState: ${conn.connectionState}`);
      if (conn.connectionState === 'failed') {
        stopKeepalive();
        handleConnectionLost();
      } else if (conn.connectionState === 'closed') {
        if (!destroyed && !reconnecting && !tearingDown) callbacks.onClose(remotePeerId);
      }
    };

    conn.oniceconnectionstatechange = () => {
      dlog(`iceState: ${conn.iceConnectionState}`);
    };

    if (role === 'host') {
      dc = conn.createDataChannel('data');
      setupDataChannel(dc);
    } else {
      conn.ondatachannel = (e) => {
        dc = e.channel;
        setupDataChannel(dc);
      };
    }

    return conn;
  };

  // Buffer candidates that arrive before the PC is ready
  let pendingCandidates: RTCIceCandidateInit[] = [];

  const flushCandidates = async () => {
    if (!pc) return;
    for (const c of pendingCandidates) {
      try { await pc.addIceCandidate(c); } catch (e) { dlog(`addIceCandidate error: ${e}`); }
    }
    pendingCandidates = [];
  };

  const handleSignal = async (msg: SignalMessage) => {
    if (destroyed) return;
    if (msg.peerId === localPeerId) return;

    if (msg.type === 'offer' && role === 'guest') {
      // Host re-announced an offer we've already applied. Don't re-apply it to a
      // live PC (needless renegotiation); but if we haven't connected yet our
      // answer may have been lost, so re-send it.
      if (pc && msg.sdp === appliedOfferSdp) {
        if (dc?.readyState !== 'open' && lastAnswerSdp) {
          signal({ type: 'answer', sdp: lastAnswerSdp, peerId: localPeerId });
        }
        return;
      }

      // Already paired with a different peer — ignore foreign offers.
      if (pc && remotePeerId && remotePeerId !== msg.peerId) return;

      // New offer (initial connect) or a fresh offer from our host (reconnect).
      // Always tear down any existing PC and build a new one so our DTLS state
      // matches the host's brand-new PC.
      if (pc) {
        tearingDown = true;
        dc?.close();
        pc.close();
        dc = null;
        pc = null;
        pendingCandidates = [];
        tearingDown = false;
      }

      // If we're mid-reconnect, this fresh offer is the host driving recovery —
      // mark it so the delayed proactive teardown doesn't undo this rebuild.
      if (reconnecting) guestRebuiltThisCycle = true;

      remotePeerId = msg.peerId;
      appliedOfferSdp = msg.sdp;
      pc = createPC();
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      lastAnswerSdp = answer.sdp!;
      dlog(`sending answer to ${msg.peerId.slice(0, 8)}`);
      signal({ type: 'answer', sdp: lastAnswerSdp, peerId: localPeerId });

    } else if (msg.type === 'answer' && role === 'host' && pc) {
      // Bind to the first guest that answers. Once paired, ignore answers from
      // other peers (a second guest or a duplicate/late answer) so they can't
      // hijack remotePeerId. During reconnection the same peer re-answers, so
      // matching peerIds are still accepted.
      if (remotePeerId && remotePeerId !== msg.peerId && !reconnecting) {
        dlog(`ignoring answer from unexpected peer ${msg.peerId.slice(0, 8)}`);
        return;
      }
      remotePeerId = msg.peerId;
      try {
        await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
        await flushCandidates();
        dlog(`got answer from ${msg.peerId.slice(0, 8)}`);
      } catch (e) {
        dlog(`setRemoteDescription(answer) error: ${e}`);
      }

    } else if (msg.type === 'candidate') {
      if (pc && pc.remoteDescription) {
        try { await pc.addIceCandidate(msg.candidate); } catch (e) { dlog(`addIceCandidate error: ${e}`); }
      } else {
        pendingCandidates.push(msg.candidate);
      }

    } else if (msg.type === 'bye') {
      if (!destroyed) callbacks.onClose(msg.peerId);
    }
  };

  // ── Subscribe to signaling channel ─────────────────────────────────

  channel = client.channel(`rtc-${roomId}`, {
    config: { broadcast: { self: false } },
  });

  await new Promise<void>((resolve, reject) => {
    channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
      handleSignal(payload as SignalMessage);
    });

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        dlog(`signaling subscribed (${role})`);
        resolve();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        reject(new Error(`Signaling channel failed: ${status}`));
      }
    });
  });

  // Host: create offer immediately, re-announce periodically
  if (role === 'host') {
    pc = createPC();
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    dlog('sending offer');
    signal({ type: 'offer', sdp: offer.sdp!, peerId: localPeerId });

    // Re-announce until the guest answers (remoteDescription set) or we
    // connect — see reconnect path for rationale.
    announceInterval = setInterval(() => {
      if (destroyed || dc?.readyState === 'open' || pc?.remoteDescription) {
        clearAnnounceInterval();
        return;
      }
      dlog('re-announcing offer');
      signal({ type: 'offer', sdp: offer.sdp!, peerId: localPeerId });
    }, 3_000);
  }

  const send = (type: string, data: unknown) => {
    if (dc?.readyState === 'open') {
      dc.send(JSON.stringify({ t: type, d: data }));
    }
  };

  const leave = () => {
    destroyed = true;
    tearingDown = true;
    stopKeepalive();
    clearReconnectAttemptTimer();
    clearAnnounceInterval();
    signal({ type: 'bye', peerId: localPeerId });
    dc?.close();
    pc?.close();
    pc = null;
    dc = null;
    client.removeChannel(channel);
  };

  const getPeers = (): Record<string, RTCPeerConnection> => {
    if (pc && remotePeerId) return { [remotePeerId]: pc };
    return {};
  };

  return { send, leave, getPeers };
}
