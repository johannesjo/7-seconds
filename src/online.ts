import { joinRoom } from 'trystero/supabase';
import type { OnlineGameState, OnlinePhase, OnlinePathData, OnlineFrameData, OnlineRoundResult, OnlineSignal } from './online-types';
import { dlog } from './online-debug';

const METERED_API_KEY = 'c6d3fd98814ae0f5e636b38bdde327ef2eae';

export const SUPABASE_URL = 'https://puoxmqovckvfoqyihasl.supabase.co';
// Full JWT form required — the short `sb_publishable_*` format causes
// Supabase Realtime subscription failures. Do not replace with short key.
export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB1b3htcW92Y2t2Zm9xeWloYXNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MDM4NjksImV4cCI6MjA4ODQ3OTg2OX0.6rg48T_ddfzj_0-TKwluvxMpTQgSj9aqzyTRMFkHFT4';

const SUPABASE_CONFIG = {
  appId: SUPABASE_URL,
  supabaseKey: SUPABASE_KEY,
};

/** Fetch short-lived TURN credentials from Metered.ca REST API.
 *  Credentials are cached for 30 minutes (metered.ca issues ~12h TTL,
 *  but refreshing sooner avoids edge-case expiry during long sessions).
 *  We pick one UDP + one TCP/TLS server to keep ICE gathering fast. */
const TURN_CACHE_TTL_MS = 30 * 60 * 1000;
let cachedIceServers: RTCIceServer[] | null = null;
let cachedAt = 0;

export async function fetchIceServers(): Promise<RTCIceServer[]> {
  if (cachedIceServers && Date.now() - cachedAt < TURN_CACHE_TTL_MS) {
    return cachedIceServers;
  }
  try {
    const res = await fetch(
      `https://7seconds.metered.live/api/v1/turn/credentials?apiKey=${METERED_API_KEY}`,
    );
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const allServers: RTCIceServer[] = await res.json();
    const udpTurn = allServers.find(s => {
      const url = Array.isArray(s.urls) ? s.urls[0] : s.urls;
      return url?.startsWith('turn:') && !url.includes('transport=tcp');
    });
    const tcpTurn = allServers.find(s => {
      const url = Array.isArray(s.urls) ? s.urls[0] : s.urls;
      return url?.startsWith('turns:') || (url?.startsWith('turn:') && url.includes('transport=tcp'));
    });
    const turnServers = [udpTurn, tcpTurn].filter((s): s is RTCIceServer => !!s);
    dlog(`TURN: picked ${turnServers.length}/${allServers.length} servers`);
    cachedIceServers = turnServers;
    cachedAt = Date.now();
    return cachedIceServers;
  } catch (e) {
    dlog(`TURN: fetch failed — ${e}`);
    // Return stale cache if available, otherwise empty (relay-only will fail gracefully)
    return cachedIceServers ?? [];
  }
}

/** Pre-fetch TURN credentials so they're ready when creating/joining rooms. */
export function prefetchIceServers(): void {
  fetchIceServers().catch(() => {/* logged inside */});
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
  getPeers: () => Record<string, RTCPeerConnection>;
  leave: () => void;
}

/** Create a Trystero room and return typed action channels. */
export async function createOnlineRoom(
  roomId: string,
  role: 'host' | 'guest',
  onPeerJoin: (peerId: string) => void,
  onPeerLeave: (peerId: string) => void,
): Promise<OnlineConnection> {
  const iceServers = await fetchIceServers();
  if (iceServers.length === 0) {
    throw new Error('No TURN servers available — cannot connect in relay-only mode');
  }
  dlog(`createRoom role=${role} room=${roomId} ice=${iceServers.length}`);
  const room = joinRoom({
    ...SUPABASE_CONFIG,
    rtcConfig: {
      iceServers,
      // Force relay-only so ICE gathering is nearly instant (< 1s).
      // Without this, gathering takes 5s (iceTimeout in trystero),
      // and the host prunes the pending offer at 4.8s before the
      // guest's answer arrives.
      iceTransportPolicy: 'relay',
    },
  }, roomId);

  room.onPeerJoin((peerId) => {
    dlog(`peerJoin: ${peerId.slice(0, 8)}…`);
    onPeerJoin(peerId);
  });
  room.onPeerLeave((peerId) => {
    dlog(`peerLeave: ${peerId.slice(0, 8)}…`);
    onPeerLeave(peerId);
  });

  // Trystero's makeAction requires DataPayload (index-signature objects).
  // Our interfaces don't have index signatures, so we use `any` at the
  // boundary and keep the rest of the codebase fully typed via ActionPair.
  const state = room.makeAction('state') as unknown as ActionPair<OnlineGameState>;
  const phase = room.makeAction('phase') as unknown as ActionPair<OnlinePhase>;
  const paths = room.makeAction('paths') as unknown as ActionPair<OnlinePathData>;
  const frame = room.makeAction('frame') as unknown as ActionPair<OnlineFrameData>;
  const result = room.makeAction('result') as unknown as ActionPair<OnlineRoundResult>;
  const signal = room.makeAction('signal') as unknown as ActionPair<OnlineSignal>;

  return {
    state,
    phase,
    paths,
    frame,
    result,
    signal,
    getPeers: () => room.getPeers(),
    leave: () => room.leave(),
  };
}
