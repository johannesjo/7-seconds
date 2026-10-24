import type { Unit, Obstacle, ElevationZone, Team, CtfState, Vec2 } from './types';
import { ROCKET_MAX_PATH } from './constants';
import { scorePosition, generateCandidates } from './ai-scoring';
import { detourWaypoints, segmentHitsRect } from './units';
import { clampPathLength } from './path-orders';

export interface UnitPlan {
  waypoints: Vec2[];
  rocketPath: Vec2[];
}

export interface PlanOptions {
  ctfState?: CtfState;
  /** Score each unit's own reachable area. Off for vs-AI, which scores every
   *  unit against the first unit's candidates (its long-standing behaviour). */
  perUnitCandidates?: boolean;
  /** Also plan zombies, shielders and bombers. vs-AI leaves them to its
   *  real-time chase AI; online games have none, so their bots plan them. */
  planChasers?: boolean;
  /** Which of the clear candidates, best first, to take (0 = the best). A
   *  weaker commander picks loosely; the default always takes the best. */
  choose?: (clearCount: number) => number;
  /** False skips the rocket (a weaker commander sometimes forgets it). */
  fireRocket?: (unit: Unit) => boolean;
}

const CHASERS = new Set<Unit['type']>(['zombie', 'shielder', 'bomber']);

/** Plan moves (and rockets) for every living unit of `team`, by scoring
 *  candidate positions. Pure: units are read, never changed. */
export function planTeamOrders(
  units: Unit[],
  obstacles: Obstacle[],
  elevationZones: ElevationZone[],
  team: Team,
  opts: PlanOptions = {},
): Map<string, UnitPlan> {
  const plans = new Map<string, UnitPlan>();
  const own = units.filter(u => u.alive && u.team === team);
  const enemies = units.filter(u => u.alive && u.team !== team);
  if (own.length === 0) return plans;

  const shared = opts.perUnitCandidates ? null : generateCandidates(own[0], obstacles, elevationZones);

  for (const unit of own) {
    if (!opts.planChasers && CHASERS.has(unit.type)) continue;
    const padding = unit.radius + 8;
    const candidates = shared ?? generateCandidates(unit, obstacles, elevationZones);

    const scored = candidates.map(candidate => ({
      pos: candidate,
      score: scorePosition({ candidate, unit, enemies, obstacles, elevationZones, ctfState: opts.ctfState }),
    }));
    scored.sort((a, b) => b.score - a.score);

    // Best candidates whose full waypoint chain is obstacle-free. Only the
    // first is needed unless a weaker commander picks among several.
    const clear: Vec2[][] = [];
    const wanted = opts.choose ? 5 : 1;
    for (const { pos: candidate, score } of scored) {
      if (score === -Infinity || clear.length >= wanted) break;
      const chain = [...detourWaypoints(unit.pos, candidate, obstacles, padding), candidate];
      let prev = unit.pos;
      const pathClear = chain.every(wp => {
        const ok = !obstacles.some(o => segmentHitsRect(prev, wp, o, padding));
        prev = wp;
        return ok;
      });
      if (pathClear) clear.push(chain);
    }

    const pick = clear.length > 0 ? Math.min(clear.length - 1, Math.max(0, opts.choose?.(clear.length) ?? 0)) : -1;
    const waypoints = pick >= 0 ? clear[pick] : [unit.pos];
    const fire = unit.type === 'rocketeer' && (opts.fireRocket?.(unit) ?? true);
    plans.set(unit.id, { waypoints, rocketPath: fire ? planRocket(unit, waypoints, enemies, obstacles) : [] });
  }
  return plans;
}

/** AI rocket: from where the rocketeer will stop, around cover, at the
 *  nearest enemy's current position. Empty when no route reaches one. */
export function planRocket(unit: Unit, waypoints: Vec2[], enemies: Unit[], obstacles: Obstacle[]): Vec2[] {
  const launch = waypoints[waypoints.length - 1] ?? unit.pos;
  const byDistance = [...enemies].sort((a, b) =>
    Math.hypot(a.pos.x - launch.x, a.pos.y - launch.y) - Math.hypot(b.pos.x - launch.x, b.pos.y - launch.y));
  // Nearest enemy whose detour route is within reach and clears cover.
  for (const target of byDistance) {
    const full = [...detourWaypoints(launch, target.pos, obstacles, unit.projectileRadius + 6), { ...target.pos }];
    const route = clampPathLength(full, launch, ROCKET_MAX_PATH);
    if (route.length !== full.length || route[route.length - 1] !== full[full.length - 1]) continue;
    let prev = launch;
    const clear = route.every(p => {
      const ok = !obstacles.some(o => segmentHitsRect(prev, p, o, unit.projectileRadius));
      prev = p;
      return ok;
    });
    if (clear) return route;
  }
  return [];
}
