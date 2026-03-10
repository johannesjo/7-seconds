import { joinRoom } from 'trystero/supabase';
import type { OnlineGameState, OnlinePhase, OnlinePathData, OnlineFrameData, OnlineRoundResult, OnlineSignal } from './online-types';
import { dlog, debugEnabled, testSupabaseRealtime } from './online-debug';

// Metered.ca TURN credentials — these are free-tier static credentials.
// TODO: Replace with server-issued short-lived credentials (e.g. via Supabase
// Edge Function) to prevent quota abuse. Static credentials in the JS bundle
// can be extracted and used by third parties.
const TURN_USERNAME = 'e73585f28138d34a3b5e7db1';
const TURN_CREDENTIAL = 'kHunen+voMBpLMj/';

const TRYSTERO_CONFIG = {
  appId: 'https://puoxmqovckvfoqyihasl.supabase.co',
  // Full JWT form required — the short `sb_publishable_*` format causes
  // Supabase Realtime subscription failures. Do not replace with short key.
  supabaseKey: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB1b3htcW92Y2t2Zm9xeWloYXNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MDM4NjksImV4cCI6MjA4ODQ3OTg2OX0.6rg48T_ddfzj_0-TKwluvxMpTQgSj9aqzyTRMFkHFT4',
  // STUN + TURN servers for NAT traversal.
  // TURN relays are critical for mobile/cellular connections where carriers
  // use symmetric NAT (CGNAT) that STUN alone cannot traverse.
  rtcConfig: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      { urls: 'stun:stun.cloudflare.com:3478' },
      // Metered.ca free TURN relays — more reliable for symmetric NAT / mobile
      { urls: 'turn:a.relay.metered.ca:80', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
      { urls: 'turn:a.relay.metered.ca:80?transport=tcp', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
      { urls: 'turn:a.relay.metered.ca:443', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
      { urls: 'turns:a.relay.metered.ca:443', username: TURN_USERNAME, credential: TURN_CREDENTIAL },
      // Fallback free TURN relays (community-run, may be unreliable)
      { urls: 'turn:freestun.net:3478', username: 'free', credential: 'free' },
      { urls: 'turns:freestun.net:5350', username: 'free', credential: 'free' },
    ],
  },
};

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
export function createOnlineRoom(
  roomId: string,
  role: 'host' | 'guest',
  onPeerJoin: (peerId: string) => void,
  onPeerLeave: (peerId: string) => void,
): OnlineConnection {
  dlog(`createRoom role=${role} room=${roomId}`);

  // Run Supabase Realtime connectivity test in background (debug only)
  if (debugEnabled) {
    testSupabaseRealtime(TRYSTERO_CONFIG.appId, TRYSTERO_CONFIG.supabaseKey);
  }

  const room = joinRoom(TRYSTERO_CONFIG, roomId);

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
