import { createClient, RealtimeChannel } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from './online';
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
/** How long to wait for ICE restart to succeed before full reconnect. */
const ICE_RESTART_TIMEOUT_MS = 10_000;

export interface PeerCallbacks {
  onOpen: (peerId: string) => void;
  onClose: (peerId: string) => void;
  onMessage: (type: string, data: unknown, peerId: string) => void;
}

export interface PeerHandle {
  send: (type: string, data: unknown) => void;
  leave: () => void;
  getPeers: () => Record<string, RTCPeerConnection>;
}

/** Unique ID for this browser tab — used for signaling identity. */
const localPeerId = crypto.randomUUID();

export async function createPeerConnection(
  roomId: string,
  role: 'host' | 'guest',
  callbacks: PeerCallbacks,
): Promise<PeerHandle> {
  const client = createClient(SUPABASE_URL, SUPABASE_KEY);
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
  let iceRestartTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnecting = false;
  let announceInterval: ReturnType<typeof setInterval> | null = null;

  const signal = (msg: SignalMessage) => {
    channel.send({ type: 'broadcast', event: 'signal', payload: msg });
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

    // Check for pong timeout
    keepaliveCheckTimer = setInterval(() => {
      if (dc?.readyState !== 'open') return;
      const elapsed = Date.now() - lastPongTime;
      if (elapsed > KEEPALIVE_TIMEOUT_MS) {
        dlog(`keepalive timeout (${elapsed}ms since last pong)`);
        stopKeepalive();
        handleConnectionLost();
      }
    }, KEEPALIVE_INTERVAL_MS);
  };

  // ── Connection loss & reconnection ─────────────────────────────────

  const handleConnectionLost = () => {
    if (destroyed || reconnecting) return;

    // Only attempt reconnect if we were previously connected
    if (!wasConnected || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
      dlog(`connection lost, no reconnect (was=${wasConnected} attempts=${reconnectAttempts})`);
      if (!destroyed) callbacks.onClose(remotePeerId);
      return;
    }

    reconnecting = true;
    reconnectAttempts++;
    dlog(`connection lost, attempting reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS}`);

    // Try ICE restart first (faster than full reconnect)
    if (pc && role === 'host') {
      attemptIceRestart();
    } else {
      // Guest waits for host to initiate ICE restart
      scheduleFullReconnect();
    }
  };

  const attemptIceRestart = async () => {
    if (destroyed || !pc) return;

    dlog('attempting ICE restart');
    try {
      pc.restartIce();
      const offer = await pc.createOffer({ iceRestart: true });
      await pc.setLocalDescription(offer);
      signal({ type: 'offer', sdp: offer.sdp!, peerId: localPeerId });

      // Give ICE restart a chance to work, otherwise do full reconnect
      iceRestartTimer = setTimeout(() => {
        iceRestartTimer = null;
        if (destroyed) return;
        if (dc?.readyState === 'open') {
          dlog('ICE restart succeeded');
          reconnecting = false;
          return;
        }
        dlog('ICE restart failed, doing full reconnect');
        doFullReconnect();
      }, ICE_RESTART_TIMEOUT_MS);
    } catch (e) {
      dlog(`ICE restart error: ${e}`);
      doFullReconnect();
    }
  };

  const scheduleFullReconnect = () => {
    setTimeout(() => {
      if (destroyed) return;
      doFullReconnect();
    }, RECONNECT_DELAY_MS);
  };

  const doFullReconnect = () => {
    if (destroyed) return;
    dlog('full reconnect: tearing down old PC');

    // Clean up old connection
    stopKeepalive();
    if (iceRestartTimer) { clearTimeout(iceRestartTimer); iceRestartTimer = null; }
    dc?.close();
    pc?.close();
    dc = null;
    pc = null;
    pendingCandidates = [];

    if (role === 'host') {
      // Host: create new PC and send fresh offer
      pc = createPC();
      pc.createOffer().then(async (offer) => {
        if (destroyed || !pc) return;
        await pc.setLocalDescription(offer);
        dlog('reconnect: sending new offer');
        signal({ type: 'offer', sdp: offer.sdp!, peerId: localPeerId });

        // Re-announce until connected
        if (announceInterval) clearInterval(announceInterval);
        announceInterval = setInterval(() => {
          if (destroyed || dc?.readyState === 'open') {
            if (announceInterval) { clearInterval(announceInterval); announceInterval = null; }
            return;
          }
          dlog('reconnect: re-announcing offer');
          signal({ type: 'offer', sdp: pc?.localDescription?.sdp ?? offer.sdp!, peerId: localPeerId });
        }, 3_000);
      }).catch((e) => {
        dlog(`reconnect offer error: ${e}`);
        reconnecting = false;
        if (!destroyed) callbacks.onClose(remotePeerId);
      });
    } else {
      // Guest: clear existing PC so next offer from host will be accepted
      dlog('reconnect: guest waiting for host offer');
      // The guest's handleSignal will accept the next offer since pc is now null
    }
  };

  // ── Data channel setup ─────────────────────────────────────────────

  const setupDataChannel = (chan: RTCDataChannel) => {
    chan.binaryType = 'arraybuffer';
    chan.onopen = () => {
      dlog(`dc open with ${remotePeerId.slice(0, 8)}`);
      wasConnected = true;
      reconnecting = false;
      reconnectAttempts = 0;
      startKeepalive();
      if (!destroyed) callbacks.onOpen(remotePeerId);
    };
    chan.onclose = () => {
      dlog(`dc close with ${remotePeerId.slice(0, 8)}`);
      stopKeepalive();
      handleConnectionLost();
    };
    chan.onmessage = (e) => {
      try {
        const { t, d } = JSON.parse(e.data as string);
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
        callbacks.onMessage(t, d, remotePeerId);
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
        if (!destroyed && !reconnecting) callbacks.onClose(remotePeerId);
      }
    };

    conn.oniceconnectionstatechange = () => {
      dlog(`iceState: ${conn.iceConnectionState}`);
      // ICE disconnected means connectivity check failed — try to recover
      if (conn.iceConnectionState === 'disconnected') {
        dlog('ICE disconnected, monitoring for recovery...');
        // Browser may auto-recover within a few seconds; if it goes to 'failed'
        // the connectionstatechange handler above will trigger reconnect.
      }
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
      // Accept offers during reconnection (pc will be null after teardown)
      // Also accept if this is a new ICE restart offer from the host
      if (pc && !reconnecting) {
        // Check if this is an ICE restart offer (we already have a connection)
        if (remotePeerId === msg.peerId && pc.signalingState !== 'closed') {
          dlog(`ICE restart offer from ${msg.peerId.slice(0, 8)}`);
          try {
            await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
            await flushCandidates();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            signal({ type: 'answer', sdp: answer.sdp!, peerId: localPeerId });
          } catch (e) {
            dlog(`ICE restart answer error: ${e}`);
          }
          return;
        }
        return; // already processing a different offer
      }

      // New connection or reconnection
      if (pc) {
        // Tear down old PC for reconnection
        dc?.close();
        pc.close();
        dc = null;
        pc = null;
      }

      remotePeerId = msg.peerId;
      pc = createPC();
      await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      await flushCandidates();
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      dlog(`sending answer to ${msg.peerId.slice(0, 8)}`);
      signal({ type: 'answer', sdp: answer.sdp!, peerId: localPeerId });

    } else if (msg.type === 'answer' && role === 'host' && pc) {
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
        if (!destroyed) {
          dlog(`signaling channel ${status}, attempting to resubscribe`);
          // Attempt to resubscribe after a delay
          setTimeout(() => {
            if (destroyed) return;
            channel.subscribe();
          }, RECONNECT_DELAY_MS);
        }
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

    announceInterval = setInterval(() => {
      if (destroyed || dc?.readyState === 'open') {
        if (announceInterval) { clearInterval(announceInterval); announceInterval = null; }
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
    stopKeepalive();
    if (iceRestartTimer) { clearTimeout(iceRestartTimer); iceRestartTimer = null; }
    if (announceInterval) { clearInterval(announceInterval); announceInterval = null; }
    signal({ type: 'bye', peerId: localPeerId });
    dc?.close();
    pc?.close();
    pc = null;
    dc = null;
    client.removeAllChannels();
  };

  const getPeers = (): Record<string, RTCPeerConnection> => {
    if (pc && remotePeerId) return { [remotePeerId]: pc };
    return {};
  };

  return { send, leave, getPeers };
}
