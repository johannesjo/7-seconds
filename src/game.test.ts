import { describe, it, expect, vi } from 'vitest';
import { GameEngine, adjustForDifficulty, type Difficulty } from './game';
import type { OnlineGameState } from './online-types';
import type { Renderer } from './renderer';
import { createUnit } from './units';

// Regression: shielders (and other chase-type red units) must follow the paths a
// HUMAN player drew. The chase AI is for AI opponents only — when it ran in online
// / hotseat play it overwrote the human red team's waypoints, so their shield
// units appeared to "move on their own" toward the nearest enemy.

/** A red shielder far above a lone blue enemy. Chasing means moving DOWN (+y)
 *  toward the enemy; following the drawn path means moving RIGHT (+x). */
function snapshot(): OnlineGameState {
  return {
    units: [
      { id: 'red_shielder_0', type: 'shielder', team: 'red', x: 300, y: 100, hp: 40, maxHp: 40, radius: 11, speed: 45, range: 20, gunAngle: 0 },
      { id: 'blue_soldier_0', type: 'soldier', team: 'blue', x: 300, y: 700, hp: 100, maxHp: 100, radius: 6, speed: 80, range: 120, gunAngle: 0 },
    ],
    obstacles: [],
    elevationZones: [],
    mapWidth: 600,
    mapHeight: 800,
  };
}

describe('chase AI is AI-only', () => {
  it('a human-controlled (lockstep) red shielder follows its drawn path, not the enemy', () => {
    const eng = new GameEngine(null, () => {}, { seed: 1 }); // aiMode defaults false → guest/hotseat
    eng.loadOnlineGameState(snapshot());
    eng.setBluePaths([]);
    // Player draws a path sending the shielder RIGHT, away from the enemy below.
    eng.setRedPaths([{ unitId: 'red_shielder_0', waypoints: [{ x: 550, y: 100 }] }]);
    eng.startPlaying(1);
    for (let i = 0; i < 90; i++) eng.externalTick(1000 / 60);

    const shielder = eng.getUnits().find(u => u.id === 'red_shielder_0')!;
    expect(shielder.pos.x).toBeGreaterThan(330); // moved along the drawn path
    expect(shielder.pos.y).toBeLessThan(160);    // did NOT chase the enemy downward
  });

  it('an AI-controlled red shielder still chases the enemy (behavior preserved)', () => {
    const eng = new GameEngine(null, () => {}, { seed: 1, aiMode: true });
    eng.loadOnlineGameState(snapshot());
    eng.setBluePaths([]);
    eng.setRedPaths([]); // AI shielders have no drawn path — they chase
    eng.startPlaying(1);
    for (let i = 0; i < 90; i++) eng.externalTick(1000 / 60);

    const shielder = eng.getUnits().find(u => u.id === 'red_shielder_0')!;
    expect(shielder.pos.y).toBeGreaterThan(160); // chased the enemy downward
  });
});

describe('retry an AI encounter', () => {
  it('restores the original armies and terrain without mutating the saved encounter', () => {
    const original = GameEngine.generateInitialState();
    const saved = structuredClone(original);
    const first = new GameEngine(null, () => {}, { aiMode: true, seed: 42, initialState: saved });
    first.startBattle();
    expect(first.getOnlineGameState()).toEqual(original);
    const blue = first.getUnits().find(unit => unit.team === 'blue')!;
    first.setBluePaths([{ unitId: blue.id, waypoints: [{ x: blue.pos.x + 80, y: blue.pos.y - 80 }] }]);
    first.confirmPlan();
    for (let tick = 0; tick < 60; tick++) first.externalTick(1000 / 60);
    expect(first.getOnlineGameState()).not.toEqual(original);
    expect(saved).toEqual(original);
    first.stop();

    const retry = new GameEngine(null, () => {}, { aiMode: true, seed: 42, initialState: saved });
    retry.startBattle();
    expect(retry.phase).toBe('blue-planning');
    expect(retry.getOnlineGameState()).toEqual(original);
    expect(retry.getUnits().every(unit => unit.waypoints.length === 0)).toBe(true);
    expect(retry.getRoundSeed()).toBe(first.getRoundSeed());
    retry.stop();
  });

  it('repeats the same result for the same plan and seed', () => {
    const saved = GameEngine.generateInitialState();
    const play = () => {
      const engine = new GameEngine(null, () => {}, { aiMode: true, seed: 42, initialState: saved });
      engine.startBattle();
      engine.confirmPlan();
      for (let tick = 0; tick < 120; tick++) engine.externalTick(1000 / 60);
      const result = engine.getOnlineGameState();
      engine.stop();
      return result;
    };
    expect(play()).toEqual(play());
  });
});

it('records a shield break and the broken shield in the same replay frame', async () => {
  const { createUnit, snapshotToUnit } = await import('./units');
  const blue = createUnit('blue_soldier', 'soldier', 'blue', { x: 300, y: 360 });
  const shield = createUnit('red_shielder', 'shielder', 'red', { x: 300, y: 300 });
  shield.shieldHits = 6;
  const engine = new GameEngine(null, () => {}, {
    practice: { units: [blue, shield], elevationZones: [] }, seed: 1,
  });
  engine.startBattle();
  engine.confirmPlan();
  for (let tick = 0; tick < 30; tick++) engine.externalTick(1000 / 60);
  const replay = engine.getReplayData()!;
  const event = replay.events.find(event => event.type === 'shield-break')!;
  expect(event).toMatchObject({ targetId: shield.id, damage: 0, flanked: false, facingAngle: Math.PI / 2 });
  const frame = replay.frames[event.frame].units.find(unit => unit.id === shield.id)!;
  expect(frame.shieldHits).toBe(7);
  expect(frame.hp).toBe(shield.maxHp);
  expect(snapshotToUnit(frame).shieldHits).toBe(7);
  expect(replay.events.some(event => event.targetId === shield.id && event.type === 'hit')).toBe(false);
  engine.stop();
});

// Regression: the fixed-timestep loop kept simulating after a round/wave ended
// within the same frame, re-firing end events (several 'wave-clear's, round
// counter jumping) and moving units during the next planning phase.
describe('tick stops simulating once a round ends mid-frame', () => {
  it('ends a timed-out round only once per frame', () => {
    const phases: string[] = [];
    const eng = new GameEngine(null, (event, data) => {
      if (event === 'phase-change' && data && 'phase' in data) phases.push(data.phase);
    }, { aiMode: true, seed: 1 });
    eng.startBattle();
    eng.confirmPlan();
    expect(eng.phase).toBe('playing');
    (eng as unknown as { roundTimer: number }).roundTimer = 0.001;
    phases.length = 0;
    eng.externalTick(100); // ~6 fixed steps' worth of time

    expect(phases).toEqual(['blue-planning']);
  });

  it('emits wave-clear only once in horde mode', () => {
    let waveClears = 0;
    const eng = new GameEngine(null, (event) => { if (event === 'wave-clear') waveClears++; }, {
      aiMode: true, horde: true, seed: 1,
      hordeBlueUnits: [],
      hordeRedArmy: [{ type: 'zombie', count: 1 }],
      hordeMap: { obstacles: [], elevationZones: [] },
    });
    eng.startBattle();
    eng.loadOnlineGameState({ ...snapshot(), units: snapshot().units.map(u => ({ ...u, team: 'blue' as const })) });
    eng.confirmPlan();
    eng.externalTick(200);

    expect(waveClears).toBe(1);
  });
});

describe('horde pre-built enemies', () => {
  it('fields the given wave units, boss included', () => {
    const boss = createUnit('red_boss_5', 'zombie', 'red', { x: 300, y: 100 });
    boss.boss = 'The Brute';
    const eng = new GameEngine(null, () => {}, {
      aiMode: true, horde: true, seed: 1,
      hordeBlueUnits: [createUnit('blue_soldier_0', 'soldier', 'blue', { x: 300, y: 900 })],
      hordeRedUnits: [boss],
      hordeMap: { obstacles: [], elevationZones: [] },
    });
    eng.startBattle();
    const red = eng.getUnits().filter(u => u.team === 'red');
    expect(red).toHaveLength(1);
    expect(red[0].boss).toBe('The Brute');
  });
});

// Regression: leaving a hotseat game during the cover screen left its timer
// running, so the dead engine later switched the UI into "Red Planning" over
// whatever game was started next.
describe('stop()', () => {
  it('cancels the pending cover-screen timer', () => {
    vi.useFakeTimers();
    try {
      const events: string[] = [];
      const eng = new GameEngine(null, (event) => events.push(event), { seed: 1 });
      eng.startBattle();
      eng.confirmPlan();
      expect(eng.phase).toBe('cover');
      eng.stop();
      events.length = 0;
      vi.runAllTimers();

      expect(eng.phase).toBe('cover');
      expect(events).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

// Regression: when the last blue and red units died in the same step (e.g. a
// bomber chain), horde counted it as a cleared wave and continued with no army.
describe('horde mutual wipe', () => {
  it('is a defeat, not a cleared wave', () => {
    const events: { event: string; data?: unknown }[] = [];
    const eng = new GameEngine(null, (event, data) => events.push({ event, data }), {
      aiMode: true, horde: true, seed: 1,
      hordeBlueUnits: [],
      hordeRedArmy: [{ type: 'zombie', count: 1 }],
      hordeMap: { obstacles: [], elevationZones: [] },
    });
    eng.startBattle();
    eng.loadOnlineGameState(snapshot());
    eng.confirmPlan();
    for (const u of eng.getUnits()) u.alive = false;
    for (let i = 0; i < 60; i++) eng.externalTick(1000 / 60);

    expect(events.some(e => e.event === 'wave-clear')).toBe(false);
    const end = events.find(e => e.event === 'end');
    expect(end?.data).toMatchObject({ winner: 'red' });
  });
});

describe('difficulty', () => {
  const comp = [{ type: 'soldier' as const, count: 2 }, { type: 'sniper' as const, count: 1 }];

  it('removes a unit from the largest group on easy and adds a soldier on hard', () => {
    expect(adjustForDifficulty(comp, 'easy')).toEqual([{ type: 'soldier', count: 1 }, { type: 'sniper', count: 1 }]);
    expect(adjustForDifficulty(comp, 'normal')).toEqual(comp);
    expect(adjustForDifficulty(comp, 'hard')).toEqual([{ type: 'soldier', count: 3 }, { type: 'sniper', count: 1 }]);
    expect(adjustForDifficulty([{ type: 'sniper', count: 3 }], 'hard'))
      .toEqual([{ type: 'sniper', count: 3 }, { type: 'soldier', count: 1 }]);
    expect(comp).toEqual([{ type: 'soldier', count: 2 }, { type: 'sniper', count: 1 }]); // not mutated
  });

  it('never shrinks an army below two units', () => {
    expect(adjustForDifficulty([{ type: 'soldier', count: 2 }], 'easy')).toEqual([{ type: 'soldier', count: 2 }]);
  });

  it('only changes the AI side, and only against the AI', () => {
    const count = (difficulty: Difficulty, aiMode: boolean) => {
      const eng = new GameEngine(null, () => {}, { aiMode, seed: 3, difficulty, composition: comp, layoutIndex: 0 });
      eng.startBattle();
      const units = eng.getUnits();
      eng.stop();
      return { blue: units.filter(u => u.team === 'blue').length, red: units.filter(u => u.team === 'red').length };
    };
    expect(count('easy', true)).toEqual({ blue: 3, red: 2 });
    expect(count('hard', true)).toEqual({ blue: 3, red: 4 });
    expect(count('hard', false)).toEqual({ blue: 3, red: 3 });
  });
});

describe('fixed encounters (daily challenge)', () => {
  it('builds the same armies and map from the same layout, composition and seed', () => {
    const comp = [{ type: 'soldier' as const, count: 4 }, { type: 'mortar' as const, count: 1 }];
    const build = () => {
      const eng = new GameEngine(null, () => {}, { aiMode: true, seed: 9, layoutIndex: 1, composition: comp });
      eng.startBattle();
      const state = eng.getOnlineGameState();
      eng.stop();
      return state;
    };
    expect(build()).toEqual(build());
  });

  // Regression: the result screen derived army sizes from the default
  // composition, showing e.g. "5/4" survivors for a five-unit army.
  it('reports each side’s starting army size with the result', () => {
    let result: unknown;
    const comp = [{ type: 'soldier' as const, count: 5 }];
    const eng = new GameEngine(null, (event, data) => { if (event === 'end') result = data; }, {
      aiMode: true, seed: 2, layoutIndex: 0, composition: comp, difficulty: 'easy',
    });
    eng.startBattle();
    eng.confirmPlan();
    for (const u of eng.getUnits()) if (u.team === 'red') u.alive = false;
    for (let i = 0; i < 60; i++) eng.externalTick(1000 / 60);
    expect(result).toMatchObject({ winner: 'blue', blueAlive: 5, blueTotal: 5, redAlive: 0, redTotal: 4 });
  });
});

/** Renderer stand-in: every property is a no-op function, and calls are logged. */
function stubRenderer(calls: string[]): Renderer {
  const make = (path: string): unknown => new Proxy(function () {}, {
    get: (_t, prop) => (prop === 'then' ? undefined : make(`${path}.${String(prop)}`)),
    apply: () => { calls.push(path); return make(`${path}()`); },
  });
  return make('renderer') as Renderer;
}

describe('cinematic final kill', () => {
  const endAfter = (cinematic: boolean) => {
    const calls: string[] = [];
    let endedAtFrame = -1;
    let winner: unknown;
    const eng = new GameEngine(stubRenderer(calls), (event, data) => {
      if (event === 'end') winner = (data as { winner: string }).winner;
    }, { aiMode: true, seed: 1, cinematic });
    eng.startBattle();
    eng.loadOnlineGameState(snapshot());
    eng.confirmPlan();
    const red = eng.getUnits().find(u => u.team === 'red')!;
    red.hp = 1;
    (eng as unknown as { noteKill(p: { x: number; y: number }): void }).noteKill(red.pos);
    red.alive = false;
    for (let frame = 0; frame < 200 && winner === undefined; frame++) {
      eng.externalTick(1000 / 60);
      if (winner !== undefined) endedAtFrame = frame;
    }
    return { calls, endedAtFrame, winner };
  };

  it('holds the last kill in slow motion with the camera pushed in, without changing the outcome', () => {
    const plain = endAfter(false);
    const cinematic = endAfter(true);
    expect(cinematic.winner).toBe(plain.winner);
    expect(cinematic.endedAtFrame).toBeGreaterThan(plain.endedAtFrame + 30);
    expect(cinematic.calls).toContain('renderer.focusCamera');
    expect(plain.calls).not.toContain('renderer.focusCamera');
    expect(cinematic.calls).toContain('renderer.resetCamera');
  });
});
