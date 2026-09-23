// Drawing-gesture rules for movement orders, kept free of pixi so they can be
// unit tested: sampling a drawn line into waypoints and turning a resting
// pointer into a hold ("wait here") order.
import type { Vec2, Waypoint } from './types';
import { PATH_SAMPLE_DISTANCE, MAX_HOLD_S } from './constants';

/** Pointer must rest this long (within HOLD_JITTER_PX) before a hold starts. */
export const HOLD_DELAY_MS = 400;
export const HOLD_JITTER_PX = 8;
const HOLD_STEP_S = 0.5;

/** Hold length for a pointer that has rested `stillMs`: starts at one step and
 *  grows in real time, snapped to steps and capped at MAX_HOLD_S. */
export function holdSecondsFor(stillMs: number): number {
  if (stillMs < HOLD_DELAY_MS) return 0;
  const raw = HOLD_STEP_S + (stillMs - HOLD_DELAY_MS) / 1000;
  return Math.min(MAX_HOLD_S, Math.floor(raw / HOLD_STEP_S) * HOLD_STEP_S);
}

/** Sample a polyline from raw pointer positions, keeping points >= minDist apart.
 *  Hold points are always kept. */
export function samplePath(raw: Waypoint[], minDist: number): Waypoint[] {
  if (raw.length === 0) return [];
  const result: Waypoint[] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const last = result[result.length - 1];
    const dx = raw[i].x - last.x;
    const dy = raw[i].y - last.y;
    if (raw[i].wait || dx * dx + dy * dy >= minDist * minDist) {
      result.push(raw[i]);
    }
  }
  // Always include the actual endpoint (release position)
  if (raw.length > 1) {
    const end = raw[raw.length - 1];
    const last = result[result.length - 1];
    if (end.x !== last.x || end.y !== last.y) {
      result.push(end);
    }
  }
  return result;
}

/** Turn a drawn line into unit waypoints. The first point is the unit's own
 *  position, so it is dropped — unless it carries a hold ("wait, then go"),
 *  which becomes a zero-length first waypoint. */
export function toWaypoints(raw: Waypoint[]): Waypoint[] {
  const sampled = samplePath(raw, PATH_SAMPLE_DISTANCE);
  const waypoints = sampled.slice(1);
  if (waypoints.length === 0) return [];
  const start = sampled[0];
  return start.wait ? [{ x: start.x, y: start.y, wait: start.wait }, ...waypoints] : waypoints;
}

/** Trim a path (flown from `start`) to at most `max` length. */
export function clampPathLength(points: Vec2[], start: Vec2, max: number): Vec2[] {
  const out: Vec2[] = [];
  let prev = start;
  let left = max;
  for (const p of points) {
    const d = Math.hypot(p.x - prev.x, p.y - prev.y);
    if (d > left) {
      if (left > 0) out.push({ x: prev.x + ((p.x - prev.x) / d) * left, y: prev.y + ((p.y - prev.y) / d) * left });
      break;
    }
    out.push(p);
    left -= d;
    prev = p;
  }
  return out;
}
