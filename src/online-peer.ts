import { createClient } from '@supabase/supabase-js';
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
  const channel = client.channel(`rtc-${roomId}`, {
    config: { broadcast: { self: false } },
  });

  let pc: RTCPeerConnection | null = null;
  let dc: RTCDataChannel | null = null;
  let remotePeerId = '';
  let destroyed = false;

  const signal = (msg: SignalMessage) => {
    channel.send({ type: 'broadcast', event: 'signal', payload: msg });
  };

  const setupDataChannel = (channel: RTCDataChannel) => {
    channel.binaryType = 'arraybuffer';
    channel.onopen = () => {
      dlog(`dc open with ${remotePeerId.slice(0, 8)}`);
      if (!destroyed) callbacks.onOpen(remotePeerId);
    };
    channel.onclose = () => {
      dlog(`dc close with ${remotePeerId.slice(0, 8)}`);
      if (!destroyed) callbacks.onClose(remotePeerId);
    };
    channel.onmessage = (e) => {
      try {
        const { t, d } = JSON.parse(e.data as string);
        callbacks.onMessage(t, d, remotePeerId);
      } catch {
        dlog(`dc parse error`);
      }
    };
  };

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
      if (conn.connectionState === 'failed' || conn.connectionState === 'closed') {
        if (!destroyed) callbacks.onClose(remotePeerId);
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
      if (pc) return; // already processing an offer
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
      await pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      await flushCandidates();
      dlog(`got answer from ${msg.peerId.slice(0, 8)}`);

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

  // Subscribe to signaling channel
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

    const announceInterval = setInterval(() => {
      if (destroyed || dc?.readyState === 'open') {
        clearInterval(announceInterval);
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
