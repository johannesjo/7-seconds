import { describe, it, expect } from 'vitest';
import { GameEngine } from './game';
import { hashPaths } from './online-async-core';
import type { PathList } from './online-async-core';
import type { OnlineGameState } from './online-types';
import type { Obstacle } from './types';
import { UNIT_STATS, ROCKET_MAX_PATH } from './constants';

type UnitSpec = Partial<OnlineGameState['units'][number]> & Pick<OnlineGameState['units'][number], 'id' | 'type' | 'team' | 'x' | 'y'>;

function state(units: UnitSpec[], obstacles: Obstacle[] = []): OnlineGameState {
  return {
    units: units.map(u => {
      const s = UNIT_STATS[u.type];
      return { hp: s.hp, maxHp: s.hp, radius: s.radius, speed: s.speed, range: s.range, gunAngle: u.team === 'blue' ? -Math.PI / 2 : Math.PI / 2, ...u };
    }),
    obstacles, elevationZones: [], mapWidth: 1000, mapHeight: 1000,
  };
}

const hp = (s: OnlineGameState, id: string) => s.units.find(u => u.id === id)!.hp;
const pos = (s: OnlineGameState, id: string) => s.units.find(u => u.id === id)!;
const run = (s: OnlineGameState, blue: PathList, ticks = 360, red: PathList = []) =>
  GameEngine.resolveRound(s, blue, red, 1, ticks).endState;

// A wall between the two sides blocks every straight shot.
const wall: Obstacle = { x: 300, y: 480, w: 400, h: 40 };

describe('mortar', () => {
  it('lobs shells over cover at a target it cannot see', () => {
    const s = state([
      { id: 'm', type: 'mortar', team: 'blue', x: 500, y: 750 },
      { id: 'r', type: 'soldier', team: 'red', x: 500, y: 500 - 50, speed: 0 },
    ], [wall]);
    expect(hp(run(s, []), 'r')).toBeLessThan(UNIT_STATS.soldier.hp);
  });

  it('cannot hit enemies inside its minimum range', () => {
    const s = state([
      { id: 'm', type: 'mortar', team: 'blue', x: 500, y: 600 },
      { id: 'r', type: 'shielder', team: 'red', x: 500, y: 520, speed: 0, range: 0 },
    ]);
    expect(hp(run(s, []), 'r')).toBe(UNIT_STATS.shielder.hp);
  });

  it('punishes standing still but misses a unit that keeps moving', () => {
    const spot = { id: 'r', type: 'soldier' as const, team: 'red' as const, x: 500, y: 450, range: 0 };
    const mortar = { id: 'm', type: 'mortar' as const, team: 'blue' as const, x: 500, y: 750 };
    const still = run(state([mortar, spot]), [], 120);
    // Red sprints sideways the whole time; shells land where it was.
    const moving = run(state([mortar, { ...spot, speed: 100 }]), [], 120,
      [{ unitId: 'r', waypoints: [{ x: 900, y: 450 }] }]);
    expect(hp(still, 'r')).toBeLessThan(UNIT_STATS.soldier.hp);
    expect(hp(moving, 'r')).toBe(UNIT_STATS.soldier.hp);
  });
});

describe('rocketeer', () => {
  const target = { id: 'r', type: 'soldier' as const, team: 'red' as const, x: 500, y: 400, speed: 0, range: 0 };
  const rocketeer = { id: 'k', type: 'rocketeer' as const, team: 'blue' as const, x: 500, y: 700 };

  it('flies its drawn path around cover and blasts the unit behind it', () => {
    const around: PathList = [{ unitId: 'k', waypoints: [], rocketPath: [{ x: 270, y: 560 }, { x: 270, y: 420 }, { x: 500, y: 420 }] }];
    expect(hp(run(state([{ ...rocketeer, y: 650 }, target], [wall]), around), 'r')).toBe(UNIT_STATS.soldier.hp - UNIT_STATS.rocketeer.damage);
  });

  it('bursts harmlessly on cover when flown straight into it', () => {
    const straight: PathList = [{ unitId: 'k', waypoints: [], rocketPath: [{ x: 500, y: 400 }] }];
    expect(hp(run(state([rocketeer, target], [wall]), straight), 'r')).toBe(UNIT_STATS.soldier.hp);
  });

  it('launches only once it reaches the end of its move path', () => {
    const plan: PathList = [{ unitId: 'k', waypoints: [{ x: 500, y: 600 }], rocketPath: [{ x: 500, y: 400 }] }];
    // 100px at 80px/s takes 1.25s; the rocket then needs ~0.7s more.
    const early = run(state([rocketeer, target]), plan, 60);
    const late = run(state([rocketeer, target]), plan, 180);
    expect(hp(early, 'r')).toBe(UNIT_STATS.soldier.hp);
    expect(hp(late, 'r')).toBeLessThan(UNIT_STATS.soldier.hp);
    expect(pos(late, 'k').y).toBeCloseTo(600, -1);
  });

  it('measures the rocket cap from the launch point, not the unit start', () => {
    // 300px walk + 450px rocket: the rocket alone is well under the cap.
    const walker = { ...rocketeer, y: 900 };
    const far = { ...target, y: 150 };
    const plan: PathList = [{ unitId: 'k', waypoints: [{ x: 500, y: 600 }], rocketPath: [{ x: 500, y: 150 }] }];
    expect(hp(run(state([walker, far]), plan), 'r')).toBe(UNIT_STATS.soldier.hp - UNIT_STATS.rocketeer.damage);
  });

  it('keeps a live round going while a rocketeer holds before launching', () => {
    let ended = false;
    const s = state([{ ...rocketeer, y: 700 }, { ...target, y: 400 }]);
    const e = new GameEngine(null, ev => { if (ev === 'end') ended = true; }, { initialState: s, seed: 1 });
    e.startBattle();
    e.setBluePaths([{ unitId: 'k', waypoints: [{ x: 500, y: 690, wait: 2 }], rocketPath: [{ x: 500, y: 400 }] }]);
    e.confirmPlan();
    e.skipCover();
    e.confirmPlan();
    for (let t = 0; t < 360 && !ended && e.phase === 'playing'; t++) e.externalTick(1000 / 60);
    expect(e.getUnits().find(u => u.id === 'k')!.rocketFired).toBe(true);
    e.stop();
  });

  it('caps an untrusted rocket path and ignores it on other unit types', () => {
    const launcher = { ...rocketeer, x: 100 };
    const far = { ...target, x: 100 + ROCKET_MAX_PATH + 100, y: 700 };
    const long: PathList = [{ unitId: 'k', waypoints: [], rocketPath: [{ x: far.x, y: far.y }] }];
    expect(hp(run(state([launcher, far]), long), 'r')).toBe(UNIT_STATS.soldier.hp);
    const soldierRocket: PathList = [{ unitId: 'b', waypoints: [], rocketPath: [{ x: 500, y: 400 }] }];
    const s = state([{ id: 'b', type: 'soldier', team: 'blue', x: 500, y: 950, range: 0 }, target]);
    expect(hp(run(s, soldierRocket), 'r')).toBe(UNIT_STATS.soldier.hp);
  });

  it('commits to the rocket path in the plan hash', () => {
    const base: PathList = [{ unitId: 'k', waypoints: [] }];
    const a = hashPaths([{ ...base[0], rocketPath: [{ x: 1, y: 2 }] }]);
    const b = hashPaths([{ ...base[0], rocketPath: [{ x: 1, y: 3 }] }]);
    expect(a).not.toBe(hashPaths(base));
    expect(a).not.toBe(b);
    expect(hashPaths([{ ...base[0], rocketPath: [] }])).toBe(hashPaths(base));
  });
});
