import type { Vec2 } from './types';

/** A team's planned movement for one round: waypoints per unit. */
export type PathList = { unitId: string; waypoints: Vec2[] }[];

export type AsyncTeam = 'blue' | 'red';

/** One row of the `turns` table, as the client cares about it. */
export interface TurnRecord {
  team: AsyncTeam;
  commitHash: number;
  /** null until the owning player reveals. */
  paths: PathList | null;
}

// --- hashing -------------------------------------------------------------
// FNV-1a, matching the style of online-sync.ts so the two stay recognisable.

function fnv1a(hash: number, value: number): number {
  hash ^= value & 0xff;
  hash = Math.imul(hash, 0x01000193);
  hash ^= (value >>> 8) & 0xff;
  hash = Math.imul(hash, 0x01000193);
  hash ^= (value >>> 16) & 0xff;
  hash = Math.imul(hash, 0x01000193);
  hash ^= (value >>> 24) & 0xff;
  return Math.imul(hash, 0x01000193);
}

function fnv1aString(hash: number, s: string): number {
  for (let i = 0; i < s.length; i++) hash = fnv1a(hash, s.charCodeAt(i));
  return hash;
}

/** Canonicalise a path list so hashing is order-independent across clients:
 *  units sorted by id, waypoints kept in drawn order (order is significant). */
export function canonicalisePaths(paths: PathList): PathList {
  return [...paths]
    .map(p => ({ unitId: p.unitId, waypoints: p.waypoints }))
    .sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
}

/** Deterministic 32-bit hash of a path list — used as the commit value and to
 *  verify a reveal. Positions are rounded to 2 decimals to match the tolerance
 *  used by hashGameState (absorbs float noise without affecting gameplay). */
export function hashPaths(paths: PathList): number {
  let h = 0x811c9dc5; // FNV offset basis
  for (const p of canonicalisePaths(paths)) {
    h = fnv1aString(h, p.unitId);
    h = fnv1a(h, p.waypoints.length);
    for (const w of p.waypoints) {
      h = fnv1a(h, Math.round(w.x * 100));
      h = fnv1a(h, Math.round(w.y * 100));
    }
  }
  return h >>> 0; // unsigned 32-bit
}

/** Derive the match seed from both round-1 commit hashes. Because both commits
 *  are blind, neither player can grind for a favourable RNG outcome. Returns a
 *  positive 31-bit int matching the engine's seed range (`x & 0x7fffffff`). */
export function deriveMatchSeed(roomId: string, blueHash: number, redHash: number): number {
  let h = 0x811c9dc5;
  h = fnv1aString(h, roomId);
  h = fnv1a(h, blueHash);
  h = fnv1a(h, redHash);
  return (h >>> 0) & 0x7fffffff;
}

// --- round state machine -------------------------------------------------

/** What the local player should do next for a given round.
 *  - `commit`            — I have not committed my paths yet.
 *  - `await-commit`      — I committed; waiting for the opponent to commit.
 *  - `reveal`            — both committed; I should reveal my paths.
 *  - `await-reveal`      — I revealed; waiting for the opponent to reveal.
 *  - `resolve`           — both revealed; simulate the round and advance.
 */
export type RoundAction = 'commit' | 'await-commit' | 'reveal' | 'await-reveal' | 'resolve';

function byTeam(turns: TurnRecord[], team: AsyncTeam): TurnRecord | undefined {
  return turns.find(t => t.team === team);
}

/** Decide the local player's next step for a round given the turn rows so far.
 *  `myTeam` is the team this client controls. */
export function nextRoundAction(turns: TurnRecord[], myTeam: AsyncTeam): RoundAction {
  const opponent: AsyncTeam = myTeam === 'blue' ? 'red' : 'blue';
  const mine = byTeam(turns, myTeam);
  const theirs = byTeam(turns, opponent);

  if (!mine) return 'commit';
  const bothCommitted = !!theirs;
  if (!bothCommitted) return 'await-commit';

  // Both have committed — reveal phase.
  if (mine.paths == null) return 'reveal';
  if (theirs!.paths == null) return 'await-reveal';
  return 'resolve';
}

/** True once both sides have revealed and the round can be simulated. */
export function isRoundResolvable(turns: TurnRecord[]): boolean {
  const blue = byTeam(turns, 'blue');
  const red = byTeam(turns, 'red');
  return !!blue?.paths && !!red?.paths;
}

/** Verify a revealed turn matches its commitment. A mismatch means the peer
 *  tried to change their paths after committing — reject the reveal. */
export function verifyReveal(turn: TurnRecord): boolean {
  if (turn.paths == null) return false;
  return hashPaths(turn.paths) === turn.commitHash;
}

// --- match list summary --------------------------------------------------

/** Match statuses as stored in the `matches` row. Mirrors MatchStatus in
 *  online-async.ts; duplicated here so this pure module stays free of the
 *  Supabase-coupled layer (and importable in tests without it). */
export type AsyncMatchStatus = 'open' | 'active' | 'host_won' | 'guest_won' | 'abandoned';

/** A player-facing one-line state for a match in the "my matches" list. */
export type MatchOutcome =
  | 'your-turn'           // you need to plan/commit (incl. host's first move)
  | 'their-turn'          // you've acted; waiting on the opponent
  | 'waiting-for-guest'   // your first move is in; nobody has joined yet
  | 'resolving'           // both committed+revealed; the round is being played
  | 'you-won'
  | 'you-lost'
  | 'abandoned';

/** True for outcomes that want the player's attention (drives unread badges and
 *  the "needs you" filter). */
export function outcomeNeedsYou(o: MatchOutcome): boolean {
  return o === 'your-turn';
}

/** Collapse a match (status + my role + the current round's turns) into a single
 *  player-facing outcome. Pure and side-effect free so it can be unit-tested and
 *  reused by both the list screen and any badge counter. */
export function summariseMatch(
  status: AsyncMatchStatus,
  iAmHost: boolean,
  currentRoundTurns: TurnRecord[],
): MatchOutcome {
  if (status === 'abandoned') return 'abandoned';
  if (status === 'host_won') return iAmHost ? 'you-won' : 'you-lost';
  if (status === 'guest_won') return iAmHost ? 'you-lost' : 'you-won';

  // Only the host can be on an 'open' match (no guest has joined yet).
  if (status === 'open') {
    const blueCommitted = currentRoundTurns.some(t => t.team === 'blue');
    return blueCommitted ? 'waiting-for-guest' : 'your-turn';
  }

  // 'active': map the round state machine to a list outcome.
  const myTeam: AsyncTeam = iAmHost ? 'blue' : 'red';
  switch (nextRoundAction(currentRoundTurns, myTeam)) {
    case 'commit':
    case 'reveal':
      return 'your-turn';
    case 'await-commit':
    case 'await-reveal':
      return 'their-turn';
    case 'resolve':
      return 'resolving';
  }
}
