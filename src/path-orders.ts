// Path helpers shared by the drawer and the engine, kept free of pixi so they
// can be unit tested: sampling a drawn line and capping a path's length.
import type { Vec2 } from './types';

/** Sample a polyline from raw pointer positions, keeping points >= minDist apart. */
export function samplePath(raw: Vec2[], minDist: number): Vec2[] {
  if (raw.length === 0) return [];
  const result: Vec2[] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const last = result[result.length - 1];
    const dx = raw[i].x - last.x;
    const dy = raw[i].y - last.y;
    if (dx * dx + dy * dy >= minDist * minDist) {
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
