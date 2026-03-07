import { joinRoom } from 'trystero/supabase';
import type { OnlineGameState, OnlinePhase, OnlinePathData, OnlineFrameData, OnlineRoundResult } from './online-types';

const TRYSTERO_CONFIG = {
  appId: '7-seconds-pvp',
  supabaseUrl: '', // placeholder
  supabaseKey: '', // placeholder
};

/** Characters excluding ambiguous ones (l, 1, o, 0, I, O). */
const ROOM_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Generate a 6-character alphanumeric room ID without ambiguous characters. */
export function generateRoomId(): string {
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += ROOM_CHARS[Math.floor(Math.random() * ROOM_CHARS.length)];
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

type ActionPair<T> = [send: (data: T) => void, receive: (cb: (data: T) => void) => void];

export interface OnlineConnection {
  state: ActionPair<OnlineGameState>;
  phase: ActionPair<OnlinePhase>;
  paths: ActionPair<OnlinePathData>;
  frame: ActionPair<OnlineFrameData>;
  result: ActionPair<OnlineRoundResult>;
  leave: () => void;
}

/** Create a Trystero room and return typed action channels. */
export function createOnlineRoom(
  roomId: string,
  role: 'host' | 'guest',
  onPeerJoin: (peerId: string) => void,
  onPeerLeave: (peerId: string) => void,
): OnlineConnection {
  const room = joinRoom(TRYSTERO_CONFIG, roomId);

  room.onPeerJoin(onPeerJoin);
  room.onPeerLeave(onPeerLeave);

  // Trystero's makeAction requires DataPayload (index-signature objects).
  // Our interfaces don't have index signatures, so we use `any` at the
  // boundary and keep the rest of the codebase fully typed via ActionPair.
  const state = room.makeAction('state') as unknown as ActionPair<OnlineGameState>;
  const phase = room.makeAction('phase') as unknown as ActionPair<OnlinePhase>;
  const paths = room.makeAction('paths') as unknown as ActionPair<OnlinePathData>;
  const frame = room.makeAction('frame') as unknown as ActionPair<OnlineFrameData>;
  const result = room.makeAction('result') as unknown as ActionPair<OnlineRoundResult>;

  return {
    state,
    phase,
    paths,
    frame,
    result,
    leave: () => room.leave(),
  };
}
