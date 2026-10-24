import { describe, it, expect } from 'vitest';
import { sanitizePlan, quantize, MAX_PLAN_POINTS, blueAlive, redAlive } from './online-plan';
import { planBotPaths } from './bot';
import { GameEngine } from './game';
import { createRng } from './rng';
import { UNIT_STATS, ROUND_DURATION_S } from './constants';
import type { OnlineGameState } from './online-types';
import type { Team, UnitType } from './types';

function unit(id: string, type: UnitType, team: Team, x: number, y: number, hp = UNIT_STATS[type].hp) {
  const s = UNIT_STATS[type];
  return { id, type, team, x, y, hp, maxHp: s.hp, radius: s.radius, speed: s.speed, range: s.range, gunAngle: 0 };
}

const state: OnlineGameState = {
  units: [
    unit('b1', 'soldier', 'blue', 400, 900),
    unit('b2', 'rocketeer', 'blue', 500, 900),
    unit('b3', 'sniper', 'blue', 600, 900, 0),
    unit('r1', 'soldier', 'red', 400, 100),
    unit('r2', 'shielder', 'red', 500, 100),
    unit('r3', 'rocketeer', 'red', 600, 100),
  ],
  obstacles: [{ x: 450, y: 480, w: 100, h: 40 }],
  elevationZones: [{ x: 100, y: 450, w: 150, h: 100 }],
  mapWidth: 1000,
  mapHeight: 1000,
};

describe('sanitizePlan', () => {
  it('keeps only living units of the team, sorted, with quantized points', () => {
    const plan = sanitizePlan([
      { unitId: 'b2', waypoints: [{ x: 1.23456, y: 2.005 }], rocketPath: [{ x: 3, y: 4 }] },
      { unitId: 'b1', waypoints: [{ x: 10, y: 20 }], rocketPath: [{ x: 1, y: 1 }] },
      { unitId: 'b3', waypoints: [{ x: 1, y: 1 }] }, // dead
      { unitId: 'r1', waypoints: [{ x: 1, y: 1 }] }, // the other team's
      { unitId: 'b1', waypoints: [{ x: 99, y: 99 }] }, // duplicate
    ], state, 'blue');
    expect(plan).toEqual([
      { unitId: 'b1', waypoints: [{ x: 10, y: 20 }] },
      { unitId: 'b2', waypoints: [{ x: 1.23, y: quantize(2.005) }], rocketPath: [{ x: 3, y: 4 }] },
    ]);
  });

  it('drops junk points and caps their number', () => {
    const many = Array.from({ length: 500 }, (_, i) => ({ x: i, y: i }));
    const plan = sanitizePlan([{ unitId: 'b1', waypoints: [{ x: NaN, y: 1 }, { x: 1e9, y: 1 }, 'x', null, ...many] }], state, 'blue');
    expect(plan![0].waypoints).toHaveLength(MAX_PLAN_POINTS);
    expect(plan![0].waypoints[0]).toEqual({ x: 0, y: 0 });
  });

  it('refuses input that is not a list', () => {
    expect(sanitizePlan({ unitId: 'b1' }, state, 'blue')).toBeNull();
    expect(sanitizePlan(null, state, 'blue')).toBeNull();
    expect(sanitizePlan([], state, 'blue')).toEqual([]);
  });

  it('is idempotent, so a stored plan sanitizes to itself', () => {
    const once = sanitizePlan([{ unitId: 'b1', waypoints: [{ x: 0.123456, y: 7.891 }] }], state, 'blue');
    expect(sanitizePlan(JSON.parse(JSON.stringify(once)), state, 'blue')).toEqual(once);
  });
});

describe('alive helpers', () => {
  it('report each side', () => {
    expect(blueAlive(state)).toBe(true);
    expect(redAlive({ ...state, units: state.units.filter(u => u.team === 'blue') })).toBe(false);
  });
});

describe('planBotPaths', () => {
  for (const difficulty of ['recruit', 'veteran'] as const) {
    it(`gives every living ${difficulty} unit orders that pass the sanitizer`, () => {
      const plan = planBotPaths(state, 'red', difficulty, createRng(7));
      expect(plan.map(p => p.unitId)).toEqual(['r1', 'r2', 'r3']);
      expect(sanitizePlan(plan, state, 'red')).toEqual(plan);
      for (const p of plan) expect(p.waypoints.length).toBeGreaterThan(0);
    });
  }

  it('is reproducible for the same random sequence', () => {
    expect(planBotPaths(state, 'red', 'recruit', createRng(3))).toEqual(planBotPaths(state, 'red', 'recruit', createRng(3)));
  });

  it('plays a whole match to the end against itself', () => {
    let current = GameEngine.generateInitialState();
    let over = false;
    for (let round = 1; round <= 30 && !over; round++) {
      const result = GameEngine.resolveRound(
        current,
        planBotPaths(current, 'blue', 'veteran', createRng(round)),
        planBotPaths(current, 'red', 'recruit', createRng(round + 100)),
        round, Math.round(ROUND_DURATION_S * 60),
      );
      current = result.endState;
      over = result.gameOver;
    }
    // The bots engage: someone has lost units, even if 30 rounds can still end level.
    expect(current.units.some(u => u.hp < u.maxHp)).toBe(true);
  });
});
