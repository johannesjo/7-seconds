import type { Vec2 } from './types';

/** Split a drawn route at a travel distance, preserving the bend at the cut. */
export function splitPathAtDistance(points: Vec2[], distance: number): { reached: Vec2[]; remainder: Vec2[]; position: Vec2 } {
  const reached = [points[0]];
  let traveled = 0;

  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1];
    const to = points[i];
    const length = Math.hypot(to.x - from.x, to.y - from.y);
    if (traveled + length <= distance) {
      reached.push(to);
      traveled += length;
      continue;
    }

    const fraction = length > 0 ? Math.max(0, (distance - traveled) / length) : 0;
    const position = {
      x: from.x + (to.x - from.x) * fraction,
      y: from.y + (to.y - from.y) * fraction,
    };
    if (fraction > 0) reached.push(position);
    return { reached, remainder: [position, ...points.slice(i)], position };
  }

  return { reached, remainder: [], position: points[points.length - 1] };
}
