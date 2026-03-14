import { getSupabaseClient } from './online';
import { dlog } from './online-debug';
import type { PeerCallbacks, PeerHandle } from './online-peer';

/** Unique ID for this browser tab — used for relay identity. */
const localPeerId = crypto.randomUUID();

/** Message types that are silently dropped in relay mode (guest ignores frame data in lockstep). */
const SUPPRESSED_TYPES = new Set(['frame']);

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

  channel.on('broadcast', { event: 'join' }, ({ payload }) => {
    if (destroyed) return;
    const peerId = payload.peerId as string;
    if (peerId === localPeerId) return;
    if (remotePeerId) return; // already paired
    remotePeerId = peerId;
    dlog(`relay: peer joined ${peerId.slice(0, 8)}`);
    callbacks.onOpen(peerId);
  });

  channel.on('broadcast', { event: 'data' }, ({ payload }) => {
    if (destroyed) return;
    const { t, d, from } = payload as { t: string; d: unknown; from: string };
    if (from === localPeerId) return;
    callbacks.onMessage(t, d, from);
  });

  channel.on('broadcast', { event: 'bye' }, ({ payload }) => {
    if (destroyed) return;
    const peerId = payload.peerId as string;
    if (peerId === remotePeerId) {
      dlog(`relay: peer left ${peerId.slice(0, 8)}`);
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
  const announceJoin = () => {
    channel.send({ type: 'broadcast', event: 'join', payload: { peerId: localPeerId } });
  };
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
    if (announceInterval) { clearInterval(announceInterval); announceInterval = null; }
    channel.send({ type: 'broadcast', event: 'bye', payload: { peerId: localPeerId } });
    client.removeChannel(channel);
  };

  const getPeers = (): Record<string, RTCPeerConnection> => ({});

  return { send, leave, getPeers };
}
