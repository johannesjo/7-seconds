// AI commanders for online matches: they take a seat when nobody else is
// searching, and the referee asks them for their orders each round. Same
// position-scoring AI as vs-AI, planning every unit (online games have no
// real-time chase AI) from the public match state.
import type { Team, Vec2 } from './types';
import type { OnlineGameState } from './online-types';
import { createUnitFromState } from './units';
import { planTeamOrders } from './ai-planner';
import { sanitizePlan, type PathList } from './online-plan';
import { clampPathLength } from './path-orders';

export type BotDifficulty = 'recruit' | 'veteran';

/** How often a recruit's unit stops halfway. */
const HESITATE = 0.4;

/** The first half (by length) of a route from `start`. */
function halfway(start: Vec2, waypoints: Vec2[]): Vec2[] {
  let total = 0;
  let prev = start;
  for (const p of waypoints) { total += Math.hypot(p.x - prev.x, p.y - prev.y); prev = p; }
  const out = clampPathLength(waypoints, start, total / 2);
  return out.length > 0 ? out : waypoints;
}

/** Orders for `team` this round. `rng` adds the commander's variety: a recruit
 *  picks loosely among its better moves, sometimes stops halfway and sometimes
 *  forgets its rocket (a veteran wins about 60% against it); a veteran usually
 *  takes the best move, now and then the second best, so a line that beat it
 *  once doesn't simply win again. */
export function planBotPaths(state: OnlineGameState, team: Team, difficulty: BotDifficulty, rng: () => number): PathList {
  const units = state.units.map(u => createUnitFromState(u));
  const recruit = difficulty === 'recruit';
  const plans = planTeamOrders(units, state.obstacles, state.elevationZones, team, {
    perUnitCandidates: true,
    planChasers: true,
    choose: n => recruit ? Math.floor(rng() * n) : (rng() < 0.2 ? 1 : 0),
    fireRocket: () => !recruit || rng() < 0.6,
  });
  const paths: PathList = [...plans].map(([unitId, plan]) => ({
    unitId,
    // A recruit sometimes hesitates and stops halfway along its route.
    waypoints: recruit && rng() < HESITATE ? halfway(units.find(u => u.id === unitId)!.pos, plan.waypoints) : plan.waypoints,
    ...(plan.rocketPath.length ? { rocketPath: plan.rocketPath } : {}),
  }));
  return sanitizePlan(paths, state, team) ?? [];
}
