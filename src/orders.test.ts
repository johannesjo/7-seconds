import { describe, it, expect } from 'vitest';
import { GameEngine } from './game';
import { createUnit, advanceWaypoint, moveUnit } from './units';
import { hashPaths, verifyReveal } from './online-async-core';
import type { PathList } from './online-async-core';
import type { OnlineGameState } from './online-types';
import { holdSecondsFor, samplePath, toWaypoints, HOLD_DELAY_MS } from './path-orders';
import { predictPath } from './path-preview';
import { MAX_HOLD_S } from './constants';

const DT = 1 / 60;

function state(units: Partial<OnlineGameState['units'][number]>[]): OnlineGameState {
  return {
    units: units.map(u => ({
      id: 'x', type: 'soldier', team: 'blue', x: 0, y: 0, hp: 60, maxHp: 60,
      radius: 10, speed: 100, range: 120, gunAngle: 0, ...u,
    })) as OnlineGameState['units'],
    obstacles: [], elevationZones: [], mapWidth: 1000, mapHeight: 1000,
  };
}

function unitIn(s: OnlineGameState, id: string) {
  return s.units.find(u => u.id === id)!;
}

describe('hold order', () => {
  it('parks the unit at the point for the wait, then continues', () => {
    const u = createUnit('b', 'soldier', 'blue', { x: 0, y: 0 });
    u.waypoints = [{ x: 50, y: 0, wait: 1 }, { x: 100, y: 0 }];
    const posAt = (seconds: number) => {
      for (let i = 0; i < Math.round(seconds / DT); i++) {
        advanceWaypoint(u, DT);
        moveUnit(u, DT, []);
      }
      return u.pos.x;
    };
    expect(posAt(0.7)).toBeCloseTo(50, 0); // arrived at 0.5s, holding
    expect(posAt(0.6)).toBeCloseTo(50, 0); // still holding at 1.3s
    expect(posAt(1.0)).toBeCloseTo(100, 0); // released at ~1.5s, done by 2s
  });

  it('delays arrival in the authoritative resolver', () => {
    const start = state([
      { id: 'b', x: 100, y: 900 },
      { id: 'r', team: 'red', x: 900, y: 100 },
    ]);
    const go = (wait?: number): PathList => [{ unitId: 'b', waypoints: [{ x: 100, y: 800, ...(wait ? { wait } : {}) }, { x: 100, y: 600 }] }];
    const plain = GameEngine.resolveRound(start, go(), [], 1, 120).endState;
    const held = GameEngine.resolveRound(start, go(2), [], 1, 120).endState;
    expect(unitIn(plain, 'b').y).toBeCloseTo(700, 0); // 2s at 100px/s
    // Parked at the hold (within the engine's 2px arrival tolerance).
    expect(Math.abs(unitIn(held, 'b').y - 800)).toBeLessThan(2);
  });

  it('caps and sanitises untrusted wait values', () => {
    const start = state([
      { id: 'b', x: 100, y: 900 },
      { id: 'r', team: 'red', x: 900, y: 100 },
    ]);
    const path = (wait: number): PathList => [{ unitId: 'b', waypoints: [{ x: 100, y: 890, wait }, { x: 100, y: 500 }] }];
    const ticks = Math.round((MAX_HOLD_S + 1) * 60);
    const huge = GameEngine.resolveRound(start, path(1e9), [], 1, ticks).endState;
    expect(unitIn(huge, 'b').y).toBeLessThan(890); // moved on after MAX_HOLD_S
    const bad = GameEngine.resolveRound(start, path(Number.NaN), [], 1, ticks).endState;
    expect(unitIn(bad, 'b').y).toBeLessThan(510); // NaN ignored, no hold
  });
});

describe('focus order', () => {
  // Blue soldier walks straight down the map; red decoy sits nearer the route
  // than the focus target does.
  const start = state([
    { id: 'b', x: 500, y: 900, hp: 1000, maxHp: 1000 },
    { id: 'near', team: 'red', x: 560, y: 700, speed: 0, range: 0 },
    { id: 'far', team: 'red', x: 400, y: 700, speed: 0, range: 0 },
  ]);
  const route = [{ x: 500, y: 850 }, { x: 500, y: 700 }, { x: 500, y: 300 }];

  it('stops on its path to shoot the focus target, and prefers it', () => {
    const focused = GameEngine.resolveRound(start, [{ unitId: 'b', waypoints: route, targetId: 'far' }], [], 1, 360).endState;
    const plain = GameEngine.resolveRound(start, [{ unitId: 'b', waypoints: route }], [], 1, 360).endState;
    // Without focus the unit runs the whole route; with focus it halts in range.
    expect(unitIn(plain, 'b').y).toBeLessThan(400);
    expect(unitIn(focused, 'b').y).toBeGreaterThan(700);
    expect(unitIn(focused, 'far').hp).toBeLessThan(unitIn(focused, 'near').hp);
  });

  it('resumes the path once the target is dead', () => {
    const fragile = state([
      { id: 'b', x: 500, y: 900, hp: 1000, maxHp: 1000 },
      { id: 'far', team: 'red', x: 400, y: 700, hp: 5, speed: 0, range: 0 },
      { id: 'decoy', team: 'red', x: 950, y: 50, speed: 0, range: 0 },
    ]);
    const end = GameEngine.resolveRound(fragile, [{ unitId: 'b', waypoints: route, targetId: 'far' }], [], 1, 360).endState;
    expect(unitIn(end, 'far').hp).toBe(0);
    expect(unitIn(end, 'b').y).toBeLessThan(400);
  });

  it('ignores a focus target on the unit\'s own team', () => {
    const own = state([
      { id: 'b', x: 500, y: 900 },
      { id: 'b2', x: 520, y: 880 },
      { id: 'r', team: 'red', x: 950, y: 50, speed: 0, range: 0 },
    ]);
    const a = GameEngine.resolveRound(own, [{ unitId: 'b', waypoints: route, targetId: 'b2' }], [], 1, 180).endState;
    const b = GameEngine.resolveRound(own, [{ unitId: 'b', waypoints: route }], [], 1, 180).endState;
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe('order hashing', () => {
  const plain: PathList = [{ unitId: 'b', waypoints: [{ x: 1, y: 2 }] }];

  it('keeps the hash of plain paths unchanged by the new fields', () => {
    expect(hashPaths([{ unitId: 'b', waypoints: [{ x: 1, y: 2, wait: 0 }] }])).toBe(hashPaths(plain));
  });

  it('commits to holds and focus targets', () => {
    const held: PathList = [{ unitId: 'b', waypoints: [{ x: 1, y: 2, wait: 1 }] }];
    const focused: PathList = [{ unitId: 'b', waypoints: [{ x: 1, y: 2 }], targetId: 'r' }];
    expect(hashPaths(held)).not.toBe(hashPaths(plain));
    expect(hashPaths(focused)).not.toBe(hashPaths(plain));
    // A reveal can't swap in a different hold or target after committing.
    expect(verifyReveal({ team: 'blue', commitHash: hashPaths(held), paths: [{ unitId: 'b', waypoints: [{ x: 1, y: 2, wait: 3 }] }] })).toBe(false);
    expect(verifyReveal({ team: 'blue', commitHash: hashPaths(focused), paths: [{ ...focused[0], targetId: 'r2' }] })).toBe(false);
  });
});

describe('drawing gestures', () => {
  it('starts a hold after a short rest and grows it in half-second steps', () => {
    expect(holdSecondsFor(HOLD_DELAY_MS - 1)).toBe(0);
    expect(holdSecondsFor(HOLD_DELAY_MS)).toBe(0.5);
    expect(holdSecondsFor(HOLD_DELAY_MS + 1200)).toBe(1.5);
    expect(holdSecondsFor(60_000)).toBe(MAX_HOLD_S);
  });

  it('keeps hold points even when closer than the sample spacing', () => {
    const raw = [{ x: 0, y: 0 }, { x: 3, y: 0, wait: 1 }, { x: 40, y: 0 }];
    expect(samplePath(raw, 18)).toEqual(raw);
  });

  it('turns a hold on the start point into a zero-length first leg', () => {
    expect(toWaypoints([{ x: 0, y: 0, wait: 2 }, { x: 40, y: 0 }])).toEqual([{ x: 0, y: 0, wait: 2 }, { x: 40, y: 0 }]);
    // A hold with nowhere to go afterwards is not an order.
    expect(toWaypoints([{ x: 0, y: 0, wait: 2 }])).toEqual([]);
  });

  it('adds hold time to the path preview', () => {
    const u = createUnit('b', 'soldier', 'blue', { x: 0, y: 0 });
    const plain = predictPath(u, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 200, y: 0 }]);
    const held = predictPath(u, [{ x: 0, y: 0 }, { x: 100, y: 0, wait: 1.5 }, { x: 200, y: 0 }]);
    expect(held.travelTime! - plain.travelTime!).toBeCloseTo(1.5);
    const blade = createUnit('k', 'blade', 'blue', { x: 0, y: 0 });
    const bladePlain = predictPath(blade, [{ x: 0, y: 0 }, { x: 100, y: 0 }, { x: 300, y: 0 }]);
    const bladeHeld = predictPath(blade, [{ x: 0, y: 0 }, { x: 100, y: 0, wait: 1 }, { x: 300, y: 0 }]);
    expect(bladeHeld.travelTime!).toBeGreaterThan(bladePlain.travelTime! + 0.9);
  });
});
