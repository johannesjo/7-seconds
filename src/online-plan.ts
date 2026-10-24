// A team's orders for one online round, as the client submits them and the
// referee stores them. Kept free of Supabase and the DOM: the referee Edge
// Function bundles this module (via engine-entry.ts) and runs the same checks.
import type { Vec2, Team } from './types';
import type { OnlineGameState } from './online-types';
import { validPoints } from './path-orders';

/** A team's planned orders for one round: waypoints per unit, plus a
 *  rocketeer's drawn rocket flight. */
export type PathList = { unitId: string; waypoints: Vec2[]; rocketPath?: Vec2[] }[];

/** Version of the battle rules every online match is stamped with. Clients and
 *  the referee only play matches on their own version: the referee resolves
 *  each round, and the clients animate the same round locally, so a rules
 *  change would show players a different battle than the one recorded.
 *  Bump it when `rules-version.test.ts` fails (see docs/online-play.md).
 *  1 = the client-resolved protocol before the referee existed. */
export const RULES_VERSION = 2;

/** Most waypoints (and rocket points) kept per unit; the engine keeps the same. */
export const MAX_PLAN_POINTS = 100;
/** Coordinates beyond this are junk, not a far corner of the map. */
const MAX_COORD = 10_000;

/** Round to the 0.01 grid plans are stored on. Submitting quantized points
 *  means the referee simulates exactly what the client animates. */
export function quantize(v: number): number {
  return Math.round(v * 100) / 100;
}

function cleanPoints(list: unknown): Vec2[] {
  return validPoints(list)
    .filter(p => Math.abs(p.x) <= MAX_COORD && Math.abs(p.y) <= MAX_COORD)
    .slice(0, MAX_PLAN_POINTS)
    .map(p => ({ x: quantize(p.x), y: quantize(p.y) }));
}

/** The orders `team` may give in `state`, from untrusted input: one entry per
 *  living unit of that team at most, sorted by unit id, with finite quantized
 *  points, and rocket paths only on rocketeers. Orders for anything else are
 *  dropped. Null when the input is not a list at all. */
export function sanitizePlan(paths: unknown, state: OnlineGameState, team: Team): PathList | null {
  if (!Array.isArray(paths)) return null;
  const units = new Map(state.units.filter(u => u.team === team && u.hp > 0).map(u => [u.id, u]));
  const seen = new Set<string>();
  const out: PathList = [];
  for (const entry of paths.slice(0, units.size * 4 + 8)) {
    if (!entry || typeof entry !== 'object') continue;
    const { unitId, waypoints, rocketPath } = entry as Record<string, unknown>;
    if (typeof unitId !== 'string' || seen.has(unitId)) continue;
    const unit = units.get(unitId);
    if (!unit) continue;
    seen.add(unitId);
    const rocket = unit.type === 'rocketeer' ? cleanPoints(rocketPath) : [];
    out.push({ unitId, waypoints: cleanPoints(waypoints), ...(rocket.length ? { rocketPath: rocket } : {}) });
  }
  return out.sort((a, b) => (a.unitId < b.unitId ? -1 : a.unitId > b.unitId ? 1 : 0));
}

/** True when blue still has a unit standing. Blue is the host, so this decides
 *  the winner. Shared by the client and the referee so the two can't drift. */
export function blueAlive(state: OnlineGameState): boolean {
  return state.units.some(u => u.team === 'blue' && u.hp > 0);
}

/** True when red still has a unit standing. */
export function redAlive(state: OnlineGameState): boolean {
  return state.units.some(u => u.team === 'red' && u.hp > 0);
}
