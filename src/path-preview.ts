import { ROUND_DURATION_S } from './constants';
import type { Unit, Vec2, Waypoint } from './types';
import { advanceWaypoint, moveUnit } from './units';

export interface PathPrediction {
  reached: Vec2[];
  remainder: Vec2[];
  position: Vec2;
  /** Null means the destination was not reached within the simulation limit. */
  travelTime: number | null;
  tickDistances: number[];
}

const PREDICTION_DT = 1 / 60; // Matches Game's fixed simulation step.
export const MAX_PREDICTION_TIME_S = 30;

function pathLength(points: Vec2[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) {
    length += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return length;
}

function totalWait(points: Waypoint[]): number {
  return points.reduce((sum, p) => sum + (p.wait ?? 0), 0);
}

/** Distance travelled along a constant-speed route after `t` seconds,
 *  pausing at each point for its hold time. */
function distanceAtTime(points: Waypoint[], speed: number): (t: number) => number {
  return (t: number) => {
    let clock = points[0].wait ?? 0;
    let traveled = 0;
    if (t <= clock) return 0;
    for (let i = 1; i < points.length; i++) {
      const seg = Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
      const segTime = seg / speed;
      if (t < clock + segTime) return traveled + (t - clock) * speed;
      clock += segTime + (points[i].wait ?? 0);
      traveled += seg;
      if (t <= clock) return traveled;
    }
    return traveled;
  };
}

/** Estimate a route in open space, using the same blade acceleration and waypoint motion as play. */
export function predictPath(unit: Unit, path: Waypoint[]): PathPrediction {
  const points = path.length > 0 ? path : [unit.pos];
  const length = pathLength(points);
  if (length === 0) {
    return { ...splitPathAtDistance(points, 0), travelTime: 0, tickDistances: [] };
  }

  if (unit.type !== 'blade') {
    const speed = unit.speed;
    if (speed <= 0) {
      return { ...splitPathAtDistance(points, 0), travelTime: null, tickDistances: [] };
    }
    const at = distanceAtTime(points, speed);
    const tickDistances: number[] = [];
    for (let second = 1; second < ROUND_DURATION_S; second++) {
      const d = at(second);
      // Holds park the unit, so several seconds can land on the same spot.
      if (d < length && d > (tickDistances[tickDistances.length - 1] ?? 0)) tickDistances.push(d);
    }
    return {
      ...splitPathAtDistance(points, at(ROUND_DURATION_S)),
      travelTime: length / speed + totalWait(points),
      tickDistances,
    };
  }

  // Only movement state is copied. The preview never changes the live unit or its route.
  const ghost: Unit = {
    ...unit,
    pos: { ...points[0] },
    vel: { ...unit.vel },
    knockbackVel: unit.knockbackVel ? { ...unit.knockbackVel } : undefined,
    moveTarget: null,
    holdTimer: 0,
    waypoints: points.slice(1),
  };
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }

  let progress = 0;
  let roundDistance = length;
  let roundPosition: Vec2 = { ...points[points.length - 1] };
  let travelTime: number | null = null;
  const tickDistances: number[] = [];
  const roundSteps = Math.round(ROUND_DURATION_S / PREDICTION_DT);
  const maxSteps = Math.round(MAX_PREDICTION_TIME_S / PREDICTION_DT);
  for (let step = 1; step <= maxSteps; step++) {
    advanceWaypoint(ghost, PREDICTION_DT);
    moveUnit(ghost, PREDICTION_DT, []);

    if ((ghost.holdTimer ?? 0) > 0) {
      // Holding at the point just reached (it has left the waypoint queue).
      progress = Math.max(progress, cumulative[points.length - ghost.waypoints.length - 1]);
    } else if (ghost.moveTarget) {
      const index = points.length - ghost.waypoints.length - 1;
      const from = points[index - 1];
      const to = points[index];
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      const segmentLength2 = dx * dx + dy * dy;
      const fraction = segmentLength2 > 0
        ? Math.max(0, Math.min(1, ((ghost.pos.x - from.x) * dx + (ghost.pos.y - from.y) * dy) / segmentLength2))
        : 1;
      progress = Math.max(progress, cumulative[index - 1] + (cumulative[index] - cumulative[index - 1]) * fraction);
    } else {
      progress = length;
    }

    if (step % Math.round(1 / PREDICTION_DT) === 0 && step < roundSteps && progress < length &&
      progress > (tickDistances[tickDistances.length - 1] ?? 0)) {
      tickDistances.push(progress);
    }
    if (step === roundSteps) {
      roundDistance = progress;
      roundPosition = { ...ghost.pos };
    }
    if (ghost.moveTarget === null && ghost.waypoints.length === 0 && !((ghost.holdTimer ?? 0) > 0)) {
      travelTime = step * PREDICTION_DT;
      if (step < roundSteps) {
        roundDistance = length;
        roundPosition = { ...ghost.pos };
      }
      break;
    }
  }

  const split = splitPathAtDistance(points, roundDistance);
  if (split.reached.length === 1 &&
    (split.reached[0].x !== roundPosition.x || split.reached[0].y !== roundPosition.y)) {
    split.reached.push(roundPosition);
  } else {
    split.reached[split.reached.length - 1] = roundPosition;
  }
  if (split.remainder.length > 0) split.remainder[0] = roundPosition;
  return { ...split, position: roundPosition, travelTime, tickDistances };
}

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
