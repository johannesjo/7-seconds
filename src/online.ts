import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { OnlineGameState, OnlinePhase, OnlinePathData, OnlineRoundResult, OnlineSignal, OnlineWaypointData, OnlineSyncHash } from './online-types';
import { dlog } from './online-debug';
import { createPeerConnection, type PeerHandle, type PeerCallbacks } from './online-peer';
import { createRelayConnection } from './online-relay';

export const SUPABASE_URL = 'https://puoxmqovckvfoqyihasl.supabase.co';
// Full JWT form required — the short `sb_publishable_*` format causes
// Supabase Realtime subscription failures. Do not replace with short key.
export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB1b3htcW92Y2t2Zm9xeWloYXNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MDM4NjksImV4cCI6MjA4ODQ3OTg2OX0.6rg48T_ddfzj_0-TKwluvxMpTQgSj9aqzyTRMFkHFT4';

let sharedClient: SupabaseClient | null = null;

/** Shared Supabase client — avoids duplicate WebSocket connections. */
export function getSupabaseClient(): SupabaseClient {
  if (!sharedClient) {
    sharedClient = createClient(SUPABASE_URL, SUPABASE_KEY);
  }
  return sharedClient;
}

/** Unique peer ID for this browser tab — shared across WebRTC and relay transports
 *  so fallback doesn't present a different identity to the remote peer. */
export const localPeerId = crypto.randomUUID();

const LOCAL_ID_KEY = '7s-player-id';

/** Get or create a persistent local player ID. */
export function getLocalPlayerId(): string {
  try {
    let id = localStorage.getItem(LOCAL_ID_KEY);
    if (!id) {
      id = crypto.randomUUID();
      localStorage.setItem(LOCAL_ID_KEY, id);
    }
    return id;
  } catch {
    // localStorage unavailable (private browsing, cookies disabled)
    return crypto.randomUUID();
  }
}

/** Characters excluding ambiguous ones (l, 1, o, 0, I, O). */
const ROOM_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Generate a 6-character alphanumeric room ID without ambiguous characters. */
export function generateRoomId(): string {
  // Rejection sampling avoids modulo bias (256 % 30 !== 0)
  const limit = 256 - (256 % ROOM_CHARS.length); // 240 — largest multiple of 30 ≤ 256
  let id = '';
  while (id.length < 6) {
    const bytes = crypto.getRandomValues(new Uint8Array(6 - id.length));
    for (const b of bytes) {
      if (b < limit && id.length < 6) {
        id += ROOM_CHARS[b % ROOM_CHARS.length];
      }
    }
  }
  return id;
}

/** Build a shareable URL with the join param for the given room. */
export function getShareUrl(roomId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('join', roomId);
  url.searchParams.delete('relay');
  url.searchParams.delete('debug');
  return url.toString();
}

/** Read the join room ID from the current URL search params, or null if absent. */
export function getJoinRoomId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('join');
}

type ActionPair<T> = [send: (data: T) => void, receive: (cb: (data: T, peerId: string) => void) => void];

export interface OnlineConnection {
  state: ActionPair<OnlineGameState>;
  phase: ActionPair<OnlinePhase>;
  paths: ActionPair<OnlinePathData>;
  result: ActionPair<OnlineRoundResult>;
  signal: ActionPair<OnlineSignal>;
  waypoints: ActionPair<OnlineWaypointData>;
  sync: ActionPair<OnlineSyncHash>;
  getPeers: () => Record<string, RTCPeerConnection>;
  leave: () => void;
}

const forceRelay = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('relay');

/** How long to let WebRTC (lower latency) connect on its own before the
 *  Supabase relay starts racing it. The relay still wins the moment it opens
 *  if WebRTC hasn't — nobody waits the full period. Short, because the peers
 *  that can't do direct WebRTC (symmetric NAT / CGNAT) need the relay fast. */
const RELAY_HEADSTART_MS = 4_000;

type TransportKind = 'webrtc' | 'relay';

/** Race WebRTC against the Supabase relay, preferring WebRTC when it connects
 *  quickly. Returns immediately (non-blocking) with a stable proxy handle whose
 *  underlying transport is swapped in transparently.
 *
 *  - Initial connect: start WebRTC, then start the relay after a short head
 *    start (or immediately if WebRTC fails first). Whichever opens first wins;
 *    the loser is torn down.
 *  - Mid-session: if the committed WebRTC link dies, fail over to the relay
 *    (the reliable transport). If the relay itself gives up, the connection is
 *    over. The app sees this as a normal reconnecting → connected/disconnected
 *    cycle. */
export function connectTransport(
  roomId: string,
  role: 'host' | 'guest',
  callbacks: PeerCallbacks,
): PeerHandle {
  if (forceRelay) {
    dlog('transport: forced relay via ?relay=1');
    let relayOnly: PeerHandle | null = null;
    let pendingLeave = false;
    createRelayConnection(roomId, role, callbacks)
      .then((h) => { if (pendingLeave) h.leave(); else relayOnly = h; })
      .catch((e) => { dlog(`transport: forced relay failed: ${e}`); callbacks.onClose(''); });
    return {
      send: (type, data) => relayOnly?.send(type, data),
      leave: () => { pendingLeave = true; relayOnly?.leave(); relayOnly = null; },
      getPeers: () => relayOnly?.getPeers() ?? {},
    };
  }

  let webrtc: PeerHandle | null = null;
  let relay: PeerHandle | null = null;
  let committed: TransportKind | null = null;
  let destroyed = false;
  let headstartTimer: ReturnType<typeof setTimeout> | null = null;

  const active = (): PeerHandle | null =>
    committed === 'webrtc' ? webrtc : committed === 'relay' ? relay : null;

  const clearHeadstartTimer = () => {
    if (headstartTimer) { clearTimeout(headstartTimer); headstartTimer = null; }
  };

  const startTransport = (kind: TransportKind) => {
    if (destroyed) return;
    const cbs: PeerCallbacks = {
      onOpen: (peerId) => onTransportOpen(kind, peerId),
      onClose: (peerId) => onTransportClose(kind, peerId),
      onReconnecting: (peerId) => {
        if (!destroyed && committed === kind) callbacks.onReconnecting?.(peerId);
      },
      onMessage: (type, data, peerId) => {
        if (!destroyed && committed === kind) callbacks.onMessage(type, data, peerId);
      },
    };
    const create = kind === 'webrtc' ? createPeerConnection : createRelayConnection;
    create(roomId, role, cbs)
      .then((h) => {
        // If we were torn down or the other transport already won the race
        // while this one was still setting up, discard this handle.
        if (destroyed || (committed !== null && committed !== kind)) { h.leave(); return; }
        if (kind === 'webrtc') webrtc = h; else relay = h;
      })
      .catch((e) => {
        dlog(`transport: ${kind} setup failed: ${e}`);
        onTransportClose(kind, '');
      });
  };

  const onTransportOpen = (kind: TransportKind, peerId: string) => {
    if (destroyed) return;
    // Reconnect within the already-committed transport — just forward.
    if (committed === kind) { callbacks.onOpen(peerId); return; }
    // The other transport already won the race — ignore the late opener.
    if (committed !== null) return;

    committed = kind;
    clearHeadstartTimer();
    dlog(`transport: committed to ${kind}`);
    // Tear down the loser.
    if (kind === 'webrtc' && relay) { relay.leave(); relay = null; }
    if (kind === 'relay' && webrtc) { webrtc.leave(); webrtc = null; }
    callbacks.onOpen(peerId);
  };

  const onTransportClose = (kind: TransportKind, peerId: string) => {
    if (destroyed) return;
    // The loser of a race tearing down — ignore.
    if (committed !== null && committed !== kind) return;

    if (committed === 'webrtc' && kind === 'webrtc') {
      // Our committed WebRTC link died mid-session — fail over to the relay.
      committed = null;
      webrtc?.leave();
      webrtc = null;
      clearHeadstartTimer();
      dlog('transport: webrtc lost, failing over to relay');
      callbacks.onReconnecting?.(peerId);
      if (!relay) startTransport('relay');
      return;
    }
    if (committed === 'relay') {
      // The relay was our reliable fallback and it has given up.
      dlog('transport: relay lost, giving up');
      relay?.leave();
      relay = null;
      callbacks.onClose(peerId);
      return;
    }

    // Pre-commit failure (committed === null).
    if (kind === 'webrtc') {
      webrtc?.leave();
      webrtc = null;
      clearHeadstartTimer();
      if (!relay) { dlog('transport: webrtc failed pre-connect, starting relay'); startTransport('relay'); }
      return;
    }
    relay?.leave();
    relay = null;
    if (!webrtc) { dlog('transport: both transports failed pre-connect'); callbacks.onClose(peerId); }
  };

  // Kick off WebRTC, then race the relay after a short head start.
  startTransport('webrtc');
  headstartTimer = setTimeout(() => {
    headstartTimer = null;
    if (destroyed || committed !== null || relay) return;
    dlog('transport: webrtc head start elapsed, racing relay');
    startTransport('relay');
  }, RELAY_HEADSTART_MS);

  return {
    send: (type, data) => active()?.send(type, data),
    leave: () => {
      destroyed = true;
      clearHeadstartTimer();
      webrtc?.leave(); webrtc = null;
      relay?.leave(); relay = null;
    },
    getPeers: () => active()?.getPeers() ?? {},
  };
}

/** Create a peer connection (WebRTC or relay fallback) and return typed action channels. */
export async function createOnlineRoom(
  roomId: string,
  role: 'host' | 'guest',
  onPeerJoin: (peerId: string) => void,
  onPeerLeave: (peerId: string) => void,
  onPeerReconnecting?: (peerId: string) => void,
): Promise<OnlineConnection> {
  dlog(`createRoom role=${role} room=${roomId}`);

  const receivers = new Map<string, (data: unknown, peerId: string) => void>();

  const handle = connectTransport(roomId, role, {
    onOpen: onPeerJoin,
    onClose: onPeerLeave,
    onReconnecting: onPeerReconnecting,
    onMessage: (type, data, peerId) => {
      receivers.get(type)?.(data, peerId);
    },
  });

  function makeAction<T>(type: string): ActionPair<T> {
    const send = (data: T) => handle.send(type, data);
    const receive = (cb: (data: T, peerId: string) => void) => {
      receivers.set(type, (data: unknown, peerId: string) => {
        if (data == null) {
          dlog(`dropped null ${type} message from ${peerId.slice(0, 8)}`);
          return;
        }
        cb(data as T, peerId);
      });
    };
    return [send, receive];
  }

  return {
    state: makeAction<OnlineGameState>('state'),
    phase: makeAction<OnlinePhase>('phase'),
    paths: makeAction<OnlinePathData>('paths'),
    result: makeAction<OnlineRoundResult>('result'),
    signal: makeAction<OnlineSignal>('signal'),
    waypoints: makeAction<OnlineWaypointData>('waypoints'),
    sync: makeAction<OnlineSyncHash>('sync'),
    getPeers: () => handle.getPeers(),
    leave: () => handle.leave(),
  };
}
