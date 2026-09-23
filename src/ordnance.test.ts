import { describe, it, expect } from 'vitest';
import { GameEngine } from './game';
import { hashPaths } from './online-async-core';
import type { PathList } from './online-async-core';
import type { OnlineGameState } from './online-types';
import type { Obstacle, Unit } from './types';
import { createUnit, segmentHitsRect } from './units';
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

  it('keeps a live round going while an unseen enemy is in its firing band', () => {
    // The visible enemy is out of the band; the reachable one hides behind a wall.
    const s = state([
      { id: 'm', type: 'mortar', team: 'blue', x: 500, y: 750 },
      { id: 'seen', type: 'soldier', team: 'red', x: 100, y: 750, speed: 0, range: 0 },
      { id: 'hidden', type: 'soldier', team: 'red', x: 500, y: 450, speed: 0, range: 0 },
    ], [{ x: 400, y: 580, w: 200, h: 40 }]);
    const e = new GameEngine(null, () => {}, { initialState: s, seed: 1 });
    e.startBattle();
    e.confirmPlan();
    e.skipCover();
    e.confirmPlan();
    for (let t = 0; t < 420 && e.phase === 'playing'; t++) e.externalTick(1000 / 60);
    expect(e.getUnits().find(u => u.id === 'hidden')!.alive).toBe(false);
    e.stop();
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

  it('fires the drawn rocket in a live round once the move is done', () => {
    let ended = false;
    const s = state([{ ...rocketeer, y: 700 }, { ...target, y: 400 }]);
    const e = new GameEngine(null, ev => { if (ev === 'end') ended = true; }, { initialState: s, seed: 1 });
    e.startBattle();
    e.setBluePaths([{ unitId: 'k', waypoints: [{ x: 500, y: 660 }], rocketPath: [{ x: 500, y: 400 }] }]);
    e.confirmPlan();
    e.skipCover();
    e.confirmPlan();
    for (let t = 0; t < 360 && !ended && e.phase === 'playing'; t++) e.externalTick(1000 / 60);
    // (rocketFired itself is reset when the next planning phase begins.)
    expect(e.getUnits().find(u => u.id === 'r')!.hp).toBe(UNIT_STATS.soldier.hp - UNIT_STATS.rocketeer.damage);
    e.stop();
  });

  it('caps an untrusted rocket path and ignores it on other unit types', () => {
    const launcher = { ...rocketeer, x: 100 };
    const far = { ...target, x: 100 + ROCKET_MAX_PATH + 100, y: 700 };
    const long: PathList = [{ unitId: 'k', waypoints: [], rocketPath: [{ x: far.x, y: far.y }] }];
    expect(hp(run(state([launcher, far]), long), 'r')).toBe(UNIT_STATS.soldier.hp);
    const e = new GameEngine(null, () => {}, {
      initialState: state([{ id: 'b', type: 'soldier', team: 'blue', x: 500, y: 950 }, target]),
    });
    e.startBattle();
    e.setBluePaths([{ unitId: 'b', waypoints: [], rocketPath: [{ x: 500, y: 400 }] }]);
    expect(e.getUnits().find(u => u.id === 'b')!.rocketPath).toEqual([]);
    e.stop();
  });

  it('skips path points on top of the launch spot instead of parking the rocket', () => {
    const plan: PathList = [{ unitId: 'k', waypoints: [], rocketPath: [{ x: 500, y: 700 }, { x: 500, y: 400 }] }];
    expect(hp(run(state([rocketeer, target]), plan), 'r')).toBe(UNIT_STATS.soldier.hp - UNIT_STATS.rocketeer.damage);
  });

  it('reloads a Horde survivor carried into the next wave', () => {
    const veteran = createUnit('blue_rocketeer_0', 'rocketeer', 'blue', { x: 500, y: 900 });
    veteran.rocketFired = true;
    veteran.rocketPath = [{ x: 500, y: 100 }];
    const e = new GameEngine(null, () => {}, {
      horde: true, hordeBlueUnits: [veteran], hordeRedArmy: [{ type: 'zombie', count: 1 }],
      hordeMap: { obstacles: [], elevationZones: [] },
    });
    e.startBattle();
    expect(veteran.rocketFired).toBe(false);
    expect(veteran.rocketPath).toEqual([]);
    e.stop();
  });

  it('AI rockets route around cover or pick another target', () => {
    // b1 is boxed in by walls, so only b2 can be reached.
    const box: Obstacle[] = [
      { x: 440, y: 740, w: 120, h: 10 }, { x: 440, y: 850, w: 120, h: 10 },
      { x: 440, y: 740, w: 10, h: 120 }, { x: 550, y: 740, w: 10, h: 120 },
    ];
    const s = state([
      { id: 'b1', type: 'soldier', team: 'blue', x: 500, y: 800 },
      { id: 'b2', type: 'soldier', team: 'blue', x: 880, y: 150 },
      { id: 'k', type: 'rocketeer', team: 'red', x: 500, y: 560 },
    ], box);
    const e = new GameEngine(null, () => {}, { aiMode: true, initialState: s, seed: 3 });
    e.startBattle();
    // Plan from a fixed launch point where the boxed-in b1 is the nearest enemy.
    const k = e.getUnits().find(u => u.id === 'k') as Unit;
    k.waypoints = [];
    (e as unknown as { planAiRocket(u: Unit, enemies: Unit[]): void })
      .planAiRocket(k, e.getUnits().filter(u => u.team === 'blue'));
    const path = k.rocketPath ?? [];
    expect(path.length).toBeGreaterThan(0);
    let prev = k.waypoints[k.waypoints.length - 1] ?? k.pos;
    for (const p of path) {
      expect(box.some(o => segmentHitsRect(prev, p, o, k.projectileRadius))).toBe(false);
      prev = p;
    }
    expect(Math.hypot(prev.x - 880, prev.y - 150)).toBeLessThan(1);
    e.stop();
  });

  it('hashes plain paths exactly as before rockets existed', () => {
    // Value computed with hashPaths at the commit before this feature.
    expect(hashPaths([{ unitId: 'b', waypoints: [{ x: 1.5, y: 2.25 }, { x: 100, y: 200 }] }, { unitId: 'a', waypoints: [] }]))
      .toBe(206322784);
  });

  it('hashes junk rocket paths without throwing, like the engine reads them', () => {
    const base: PathList = [{ unitId: 'k', waypoints: [] }];
    const junk = [{ ...base[0], rocketPath: [null, { x: null, y: 2 }] }] as unknown as PathList;
    expect(hashPaths(junk)).toBe(hashPaths(base));
    expect(() => hashPaths([{ ...base[0], rocketPath: { length: 2 } }] as unknown as PathList)).not.toThrow();
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
