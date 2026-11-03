// Soldier hunker: holding position after a completed move makes a soldier
// tougher from the front but slower to turn. No new controls — the drawn path's
// end is where it digs in.
import type { Unit } from './types';
import { HUNKER_SETUP_S } from './constants';

/** Float sums of the fixed timestep land a hair under the threshold. */
const EPSILON = 1e-6;

/** Advance or reset a soldier's setup after this tick's movement. Only its own
 *  movement resets it: knockback and crowd separation are involuntary nudges,
 *  and if a bullet's knockback broke the hunker it would never hold under fire. */
export function updateHunker(unit: Unit, dt: number): void {
  if (unit.type !== 'soldier' || !unit.alive) return;
  const moving = unit.moveTarget !== null || unit.waypoints.length > 0 || unit.pathBlocked === true;
  unit.hunkerSetup = moving ? 0 : Math.min(HUNKER_SETUP_S, (unit.hunkerSetup ?? 0) + dt);
}

/** Setup progress 0..1, for the frontal-arc visual. */
export function hunkerProgress(unit: Unit): number {
  return Math.min(1, (unit.hunkerSetup ?? 0) / HUNKER_SETUP_S);
}

export function isHunkered(unit: Unit): boolean {
  return unit.type === 'soldier' && (unit.hunkerSetup ?? 0) >= HUNKER_SETUP_S - EPSILON;
}
