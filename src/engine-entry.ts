// Headless engine surface for server-side use (Supabase Edge Function).
//
// This is the single entry point bundled (by scripts/build-edge-engine.mjs)
// into supabase/functions/_shared/engine.mjs, so the server resolves rounds
// with the EXACT same deterministic code the clients run — no second
// implementation to drift. Everything reachable from here is DOM-free (see the
// game.ts headless refactor); importing it must never pull in pixi/Renderer.

import { GameEngine } from './game';
import type { OnlineGameState } from './online-types';
import type { PathList } from './online-async-core';

export {
  hashPaths,
  canonicalisePaths,
  deriveMatchSeed,
  verifyReveal,
  blueAlive,
  type PathList,
  type TurnRecord,
  type AsyncTeam,
} from './online-async-core';
export { ROUND_DURATION_S } from './constants';
export { isPlausibleGameState } from './online-types';
export type { OnlineGameState } from './online-types';

/** Authoritative, frame-rate-independent round resolution — a pure function of
 *  (startState, paths, seed, maxTicks). Mirrors the client's resolve path. */
export function resolveRound(
  startState: OnlineGameState,
  bluePaths: PathList,
  redPaths: PathList,
  seed: number,
  maxTicks: number,
): { endState: OnlineGameState; gameOver: boolean } {
  return GameEngine.resolveRound(startState, bluePaths, redPaths, seed, maxTicks);
}
