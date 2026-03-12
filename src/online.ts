import type { OnlineGameState, OnlinePhase, OnlinePathData, OnlineFrameData, OnlineRoundResult, OnlineSignal } from './online-types';
import { dlog } from './online-debug';
import { createPeerConnection } from './online-peer';

export const SUPABASE_URL = 'https://puoxmqovckvfoqyihasl.supabase.co';
// Full JWT form required — the short `sb_publishable_*` format causes
// Supabase Realtime subscription failures. Do not replace with short key.
export const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB1b3htcW92Y2t2Zm9xeWloYXNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MDM4NjksImV4cCI6MjA4ODQ3OTg2OX0.6rg48T_ddfzj_0-TKwluvxMpTQgSj9aqzyTRMFkHFT4';

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

/** Create a WebRTC peer connection and return typed action channels. */
export async function createOnlineRoom(
  roomId: string,
  role: 'host' | 'guest',
  onPeerJoin: (peerId: string) => void,
  onPeerLeave: (peerId: string) => void,
): Promise<OnlineConnection> {
  dlog(`createRoom role=${role} room=${roomId}`);

  const receivers = new Map<string, (data: unknown, peerId: string) => void>();

  const handle = await createPeerConnection(roomId, role, {
    onOpen: onPeerJoin,
    onClose: onPeerLeave,
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
    getPeers: () => handle.getPeers(),
    leave: () => handle.leave(),
  };
}
