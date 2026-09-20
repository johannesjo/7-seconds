import { describe, expect, it } from 'vitest';
import { predictPath, splitPathAtDistance } from './path-preview';
import { createUnit, advanceWaypoint, moveUnit } from './units';
import type { Unit, Vec2 } from './types';

const route = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }];

describe('splitPathAtDistance', () => {
  it('places the round-end marker after a bend and preserves the rest of the route', () => {
    expect(splitPathAtDistance(route, 50)).toEqual({
      reached: [route[0], route[1], { x: 30, y: 20 }],
      remainder: [{ x: 30, y: 20 }, route[2]],
      position: { x: 30, y: 20 },
    });
  });

  it('uses the destination when the whole route is reachable', () => {
    expect(splitPathAtDistance(route, 70)).toEqual({
      reached: route,
      remainder: [],
      position: route[2],
    });
  });

  it('handles a cut exactly at a waypoint', () => {
    expect(splitPathAtDistance(route, 30)).toEqual({
      reached: [route[0], route[1]],
      remainder: [route[1], route[2]],
      position: route[1],
    });
  });
});

function runActualMovement(unit: Unit, points: Vec2[], seconds: number): { pos: Vec2; arrival: number | null } {
  const actual: Unit = {
    ...unit, pos: { ...unit.pos }, vel: { ...unit.vel },
    moveTarget: null, waypoints: points.slice(1),
  };
  let arrival: number | null = null;
  for (let step = 1; step <= seconds * 60; step++) {
    advanceWaypoint(actual, 1 / 60);
    moveUnit(actual, 1 / 60, []);
    if (actual.moveTarget === null && actual.waypoints.length === 0 && arrival === null) {
      arrival = step / 60;
    }
  }
  return { pos: actual.pos, arrival };
}

describe('predictPath', () => {
  it('keeps standard soldier distance and timing', () => {
    const soldier = createUnit('s', 'soldier', 'blue', route[0]);
    expect(predictPath(soldier, route)).toEqual({
      reached: route,
      remainder: [],
      position: route[2],
      travelTime: 0.7,
      tickDistances: [],
    });
  });

  it('matches straight blade arrival with current velocity and momentum without mutating the unit', () => {
    const blade = createUnit('b', 'blade', 'blue', { x: 100, y: 400 });
    blade.vel = { x: 120, y: 0 };
    blade.momentum = 120;
    const path = [blade.pos, { x: 900, y: 400 }];
    const before = structuredClone(blade);
    const predicted = predictPath(blade, path);
    const actual = runActualMovement(blade, path, 6);

    expect(predicted.position).toEqual(actual.pos);
    expect(predicted.travelTime).toBeCloseTo(actual.arrival!, 6);
    expect(predicted.travelTime).toBeLessThan(800 / blade.speed);
    expect(blade).toEqual(before);
  });

  it('follows acceleration and a sharp bend at the six-second cutoff', () => {
    const blade = createUnit('b', 'blade', 'blue', { x: 100, y: 300 });
    const path = [blade.pos, { x: 800, y: 300 }, { x: 800, y: 800 }, { x: 100, y: 800 }];
    const predicted = predictPath(blade, path);
    const actual = runActualMovement(blade, path, 6);

    expect(predicted.position.x).toBeCloseTo(actual.pos.x, 0);
    expect(predicted.position.y).toBeCloseTo(actual.pos.y, 0);
    expect(predicted.remainder.length).toBeGreaterThan(0);
    expect(predicted.travelTime).toBeGreaterThan(6);
    expect(predicted.tickDistances).toHaveLength(5);
  });

  it('handles a very short route and repeated zero-length waypoints', () => {
    const blade = createUnit('b', 'blade', 'blue', { x: 100, y: 100 });
    const short = [blade.pos, { x: 100.5, y: 100 }];
    const predicted = predictPath(blade, short);
    const actual = runActualMovement(blade, short, 6);
    expect(predicted.position).toEqual(actual.pos);
    expect(predicted.travelTime).toBeCloseTo(actual.arrival!, 6);
    expect(predictPath(blade, [blade.pos, blade.pos])).toMatchObject({
      position: blade.pos, travelTime: 0, remainder: [], tickDistances: [],
    });
  });

  it('reports arrival when movement stops within waypoint tolerance', () => {
    const blade = createUnit('b', 'blade', 'blue', { x: 100, y: 100 });
    blade.speed = 1;
    const path = [blade.pos, { x: 104.5, y: 100 }];
    const predicted = predictPath(blade, path);
    const actual = runActualMovement(blade, path, 6);
    expect(predicted.travelTime).toBeCloseTo(actual.arrival!, 6);
    expect(predicted.position).toEqual(actual.pos);
    expect(predicted.remainder).toEqual([]);
  });

  it('keeps zero-length bends and marks an unreachable route as unfinished', () => {
    const blade = createUnit('b', 'blade', 'blue', { x: 100, y: 100 });
    const path = [blade.pos, { ...blade.pos }, { x: 400, y: 100 }];
    const predicted = predictPath(blade, path);
    const actual = runActualMovement(blade, path, 6);
    expect(predicted.position).toEqual(actual.pos);
    expect(predicted.travelTime).toBeCloseTo(actual.arrival!, 6);

    blade.speed = 0;
    const stationary = predictPath(blade, [blade.pos, { x: 400, y: 100 }]);
    expect(stationary.position).toEqual(blade.pos);
    expect(stationary.travelTime).toBeNull();
    expect(stationary.tickDistances).toEqual([]);
  });
});
