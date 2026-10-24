// Pure rules of an online match as a client sees it: who still has to plan
// this round, and what the match list shows. The referee (src/server) holds
// each plan until both are in and resolves the round; clients only submit
// their plan and animate the published result.
export type { PathList } from './online-plan';
export { blueAlive } from './online-plan';

export type AsyncTeam = 'blue' | 'red';

/** One row of the `turns` table, as the client cares about it: the team has
 *  submitted its plan, which is published (non-null) once the round is played. */
export interface TurnRecord {
  team: AsyncTeam;
  paths: import('./online-plan').PathList | null;
}

/** What the local player should do next for the current round.
 *  - `plan`   — I have not submitted my plan yet.
 *  - `await`  — I submitted; waiting for the opponent's plan.
 *  - `resolve` — both plans are in; the referee is playing the round (it
 *    normally does so the moment the second plan arrives). */
export type RoundAction = 'plan' | 'await' | 'resolve';

export function nextRoundAction(turns: TurnRecord[], myTeam: AsyncTeam): RoundAction {
  const mine = turns.some(t => t.team === myTeam);
  const theirs = turns.some(t => t.team !== myTeam);
  if (!mine) return 'plan';
  return theirs ? 'resolve' : 'await';
}

/** Match statuses as stored in the `matches` row. */
export type AsyncMatchStatus = 'open' | 'active' | 'host_won' | 'guest_won' | 'abandoned';

/** Why a finished match ended (`matches.finish_reason`). */
export type FinishReason = 'battle' | 'forfeit' | 'timeout' | 'cancelled' | 'abandoned' | 'version';

/** A player-facing one-line state for a match in the "my matches" list. */
export type MatchOutcome =
  | 'your-turn'           // you need to plan (incl. the host's first move)
  | 'their-turn'          // you've planned; waiting on the opponent
  | 'waiting-for-guest'   // your first move is in; nobody has joined yet
  | 'searching'           // a random-opponent search nobody has joined yet
  | 'resolving'           // both plans are in; the round is being played
  | 'you-won'
  | 'you-lost'
  | 'abandoned';

/** True for outcomes that want the player's attention (drives unread badges). */
export function outcomeNeedsYou(o: MatchOutcome): boolean {
  return o === 'your-turn';
}

/** Collapse a match (status + my role + the current round's turns) into a
 *  single player-facing outcome, for the list screen and the badge. */
export function summariseMatch(
  status: AsyncMatchStatus,
  iAmHost: boolean,
  currentRoundTurns: TurnRecord[],
  matchmaking = false,
): MatchOutcome {
  if (status === 'abandoned') return 'abandoned';
  if (status === 'host_won') return iAmHost ? 'you-won' : 'you-lost';
  if (status === 'guest_won') return iAmHost ? 'you-lost' : 'you-won';

  // Only the host can be on an 'open' match (no guest has joined yet).
  if (status === 'open') {
    if (matchmaking) return 'searching';
    return currentRoundTurns.some(t => t.team === 'blue') ? 'waiting-for-guest' : 'your-turn';
  }

  switch (nextRoundAction(currentRoundTurns, iAmHost ? 'blue' : 'red')) {
    case 'plan': return 'your-turn';
    case 'await': return 'their-turn';
    case 'resolve': return 'resolving';
  }
}
