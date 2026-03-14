import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import type { OnlineGameState, OnlinePhase, OnlinePathData, OnlineFrameData, OnlineRoundResult, OnlineSignal, OnlineWaypointData, OnlineSyncHash } from './online-types';
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

const LOCAL_ID_KEY = '7s-player-id';

/** Get or create a persistent local player ID. */
export function getLocalPlayerId(): string {
  let id = localStorage.getItem(LOCAL_ID_KEY);
  if (!id) {
    id = crypto.randomUUID();
    localStorage.setItem(LOCAL_ID_KEY, id);
  }
  return id;
}

/** Characters excluding ambiguous ones (l, 1, o, 0, I, O). */
const ROOM_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Generate a 6-character alphanumeric room ID without ambiguous characters. */
export function generateRoomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += ROOM_CHARS[bytes[i] % ROOM_CHARS.length];
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
  frame: ActionPair<OnlineFrameData>;
  result: ActionPair<OnlineRoundResult>;
  signal: ActionPair<OnlineSignal>;
  waypoints: ActionPair<OnlineWaypointData>;
  sync: ActionPair<OnlineSyncHash>;
  getPeers: () => Record<string, RTCPeerConnection>;
  leave: () => void;
}

const forceRelay = typeof window !== 'undefined'
  && new URLSearchParams(window.location.search).has('relay');

/** WebRTC connection timeout before falling back to relay (ms). */
const WEBRTC_TIMEOUT_MS = 15_000;

/** Try WebRTC first; if it fails to open within timeout, fall back to Supabase relay. */
async function connectTransport(
  roomId: string,
  role: 'host' | 'guest',
  callbacks: PeerCallbacks,
): Promise<PeerHandle> {
  if (forceRelay) {
    dlog('transport: forced relay via ?relay=1');
    return createRelayConnection(roomId, role, callbacks);
  }

  try {
    let resolveOpen: () => void;
    const openPromise = new Promise<void>((r) => { resolveOpen = r; });

    const handle = await createPeerConnection(roomId, role, {
      ...callbacks,
      onOpen: (peerId) => { resolveOpen(); callbacks.onOpen(peerId); },
    });

    // Wait for data channel to open within timeout
    let timeoutId: ReturnType<typeof setTimeout>;
    const opened = await Promise.race([
      openPromise.then(() => true as const),
      new Promise<false>((r) => { timeoutId = setTimeout(() => r(false), WEBRTC_TIMEOUT_MS); }),
    ]);
    clearTimeout(timeoutId!);

    if (opened) {
      dlog('transport: webrtc');
      return handle;
    }

    dlog('transport: webrtc timeout, falling back to relay');
    handle.leave();
  } catch (e) {
    dlog(`transport: webrtc failed (${e}), falling back to relay`);
  }

  return createRelayConnection(roomId, role, callbacks);
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

  const handle = await connectTransport(roomId, role, {
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
      receivers.set(type, cb as (data: unknown, peerId: string) => void);
    };
    return [send, receive];
  }

  return {
    state: makeAction<OnlineGameState>('state'),
    phase: makeAction<OnlinePhase>('phase'),
    paths: makeAction<OnlinePathData>('paths'),
    frame: makeAction<OnlineFrameData>('frame'),
    result: makeAction<OnlineRoundResult>('result'),
    signal: makeAction<OnlineSignal>('signal'),
    waypoints: makeAction<OnlineWaypointData>('waypoints'),
    sync: makeAction<OnlineSyncHash>('sync'),
    getPeers: () => handle.getPeers(),
    leave: () => handle.leave(),
  };
}
