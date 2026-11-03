import { describe, expect, it } from 'vitest';
import { createRng } from './rng';
import { createUnit, findCombatTarget } from './units';
import { GameEngine } from './game';
import {
  EXPEDITION_MAP_HEIGHT, EXPEDITION_MAP_WIDTH, LURKER_WAKE_RADIUS, MAX_ALIVE_ENEMIES, MIN_SPAWN_DISTANCE,
  createExpeditionSquad, distanceToExtraction, extractionZone, generateExpeditionMap, pursuitComposition,
  planningFrame, spawnLurkers, spawnPursuers, unitsInZone, wakeLurkers, wakeRings,
  EXPEDITION_START, RESCUE_RADIUS, SURVIVOR_COUNT, expeditionStars, placeSurvivors, rescueSurvivors,
  type ExpeditionSetup,
} from './expedition';
import type { Obstacle, Vec2 } from './types';

const inRect = (p: Vec2, r: Obstacle) => p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
const overlap = (a: Obstacle, b: Obstacle) => a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;

describe('generateExpeditionMap', () => {
  it('keeps walls inside the map and off the extraction zone', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const map = generateExpeditionMap(createRng(seed));
      expect(map.obstacles.length).toBeGreaterThan(10);
      for (const o of map.obstacles) {
        expect(o.x).toBeGreaterThanOrEqual(0);
        expect(o.y).toBeGreaterThanOrEqual(0);
        expect(o.x + o.w).toBeLessThanOrEqual(EXPEDITION_MAP_WIDTH);
        expect(o.y + o.h).toBeLessThanOrEqual(EXPEDITION_MAP_HEIGHT);
        expect(overlap(o, map.extraction)).toBe(false);
      }
    }
  });

  it('starts the squad clear of walls, far from extraction', () => {
    const map = generateExpeditionMap(createRng(7));
    const squad = createExpeditionSquad(map.obstacles);
    expect(squad).toHaveLength(4);
    for (const u of squad) {
      expect(map.obstacles.some(o => inRect(u.pos, o))).toBe(false);
    }
    expect(distanceToExtraction(squad, map.extraction)).toBeGreaterThan(1400);
  });
});

describe('lurkers', () => {
  it('spawn asleep, away from the start', () => {
    const map = generateExpeditionMap(createRng(3));
    const lurkers = spawnLurkers(map, createRng(4));
    expect(lurkers.length).toBeGreaterThan(20);
    const squad = createExpeditionSquad(map.obstacles);
    for (const l of lurkers) {
      expect(l.dormant).toBe(true);
      for (const b of squad) expect(Math.hypot(l.pos.x - b.pos.x, l.pos.y - b.pos.y)).toBeGreaterThan(LURKER_WAKE_RADIUS);
    }
  });

  it('wake when a blue unit comes near, with their pack', () => {
    const a = createUnit('red_a', 'zombie', 'red', { x: 500, y: 500 });
    const b = createUnit('red_b', 'zombie', 'red', { x: 560, y: 500 });
    const far = createUnit('red_far', 'zombie', 'red', { x: 500, y: 1200 });
    for (const u of [a, b, far]) u.dormant = true;
    const blue = createUnit('blue_s', 'soldier', 'blue', { x: 500 - LURKER_WAKE_RADIUS + 20, y: 500 });
    const units = [blue, a, b, far];
    expect(wakeLurkers(units)).toBe(1);
    expect(a.dormant).toBe(false);
    expect(b.dormant).toBe(false);
    expect(far.dormant).toBe(true);
  });

  it('wake when hurt', () => {
    const a = createUnit('red_a', 'zombie', 'red', { x: 500, y: 500 });
    a.dormant = true;
    a.hp -= 1;
    wakeLurkers([createUnit('blue_s', 'soldier', 'blue', { x: 0, y: 1900 }), a]);
    expect(a.dormant).toBe(false);
  });
});

describe('pursuers', () => {
  it('grow with the round, and when the squad stalls', () => {
    const count = (round: number, stalled: boolean) => pursuitComposition(round, stalled).reduce((n, c) => n + c.count, 0);
    expect(count(6, false)).toBeGreaterThan(count(2, false));
    expect(count(4, true)).toBeGreaterThan(count(4, false));
  });

  it('arrive behind the squad and respect the enemy cap', () => {
    const squad = [createUnit('blue_s', 'soldier', 'blue', { x: 540, y: 900 })];
    const arrivals = spawnPursuers(2, squad, 0, false, [], createRng(1));
    expect(arrivals.length).toBeGreaterThan(0);
    for (const u of arrivals) {
      expect(u.team).toBe('red');
      expect(u.pos.y).toBeGreaterThan(1200);
    }
    expect(spawnPursuers(10, squad, MAX_ALIVE_ENEMIES - 2, true, [], createRng(1))).toHaveLength(2);
  });

  it('never land on top of a squad with no room behind it', () => {
    const squad = [420, 480, 540, 600, 660].map((x, i) => createUnit(`blue_${i}`, 'soldier', 'blue', { x, y: EXPEDITION_MAP_HEIGHT - 60 }));
    for (let seed = 1; seed <= 20; seed++) {
      for (const p of spawnPursuers(6, squad, 0, true, [], createRng(seed))) {
        for (const b of squad) expect(Math.hypot(p.pos.x - b.pos.x, p.pos.y - b.pos.y)).toBeGreaterThanOrEqual(MIN_SPAWN_DISTANCE);
      }
    }
  });

  it('measure the squad from blue units only', () => {
    const squad = [createUnit('blue_s', 'soldier', 'blue', { x: 540, y: 900 })];
    // A red straggler at the bottom must not drag the spawn line down there
    const red = createUnit('red_x', 'zombie', 'red', { x: 540, y: 2100 });
    for (const u of spawnPursuers(2, [...squad, red], 1, false, [], createRng(2))) {
      expect(u.pos.y).toBeLessThan(1500);
    }
  });

  it('use ids no other round shares', () => {
    const squad = [createUnit('blue_s', 'soldier', 'blue', { x: 540, y: 900 })];
    const ids = [2, 3, 4].flatMap(r => spawnPursuers(r, squad, 0, false, [], createRng(r)).map(u => u.id));
    expect(new Set(ids).size).toBe(ids.length);
  });
});

describe('extraction', () => {
  const zone = extractionZone();
  const inside = { x: zone.x + 20, y: zone.y + 20 };

  it('counts only living blue units inside', () => {
    const a = createUnit('blue_a', 'soldier', 'blue', inside);
    const b = createUnit('blue_b', 'soldier', 'blue', { x: inside.x, y: zone.y + zone.h + 50 });
    const dead = createUnit('blue_c', 'soldier', 'blue', inside);
    dead.alive = false;
    const red = createUnit('red_z', 'zombie', 'red', inside);
    expect(unitsInZone([a, b, dead, red], zone)).toEqual([a]);
  });
});

describe('planningFrame', () => {
  const W = EXPEDITION_MAP_WIDTH;
  const H = EXPEDITION_MAP_HEIGHT;
  const squad = (y: number, xs = [480, 540, 600]): Vec2[] => xs.map(x => ({ x, y }));

  it('zooms in to its share of the limit and keeps the squad low in the view', () => {
    const { center, zoom } = planningFrame(squad(1200), 2.8, W, H);
    expect(zoom).toBeCloseTo(2.8 * 0.72);
    const viewH = H / zoom;
    const squadAt = (1200 - (center.y - viewH / 2)) / viewH;
    // Most of the view is the way ahead (north)
    expect(squadAt).toBeGreaterThan(0.8);
    expect(squadAt).toBeLessThan(1);
    expect(center.x).toBe(540);
  });

  it('zooms out so a spread squad stays in sight', () => {
    const points = [{ x: 100, y: 900 }, { x: 980, y: 1500 }];
    const { center, zoom } = planningFrame(points, 2.8, W, H);
    const viewW = W / zoom;
    const viewH = H / zoom;
    for (const p of points) {
      expect(Math.abs(p.x - center.x)).toBeLessThan(viewW / 2);
      expect(Math.abs(p.y - center.y)).toBeLessThan(viewH / 2);
    }
  });

  it('never zooms below the whole map', () => {
    expect(planningFrame([{ x: 0, y: 0 }, { x: W, y: H }], 2.8, W, H).zoom).toBe(1);
    expect(planningFrame(squad(1200), 1, W, H).zoom).toBe(1);
  });
});

describe('stealth', () => {
  // A sniper outranges the wake radius: it could shoot a sleeper without waking it by walking up
  const sniperAndSleeper = () => {
    const sniper = createUnit('blue_sn', 'sniper', 'blue', { x: 540, y: 1000 });
    const sleeper = createUnit('red_lurk_0', 'zombie', 'red', { x: 540, y: 1000 - LURKER_WAKE_RADIUS - 50 });
    sleeper.dormant = true;
    return { sniper, sleeper };
  };

  it('units leave sleeping enemies alone unless told to shoot one', () => {
    const { sniper, sleeper } = sniperAndSleeper();
    expect(findCombatTarget(sniper, [sniper, sleeper], [], [])).toBeNull();
    sniper.attackTargetId = sleeper.id;
    expect(findCombatTarget(sniper, [sniper, sleeper], [], [])).toBe(sleeper);
  });

  it('units shoot sleepers once they wake', () => {
    const { sniper, sleeper } = sniperAndSleeper();
    sleeper.dormant = false;
    expect(findCombatTarget(sniper, [sniper, sleeper], [], [])).toBe(sleeper);
  });

  it('a squad standing in range of a sleeping pack does not wake it', () => {
    const { sniper, sleeper } = sniperAndSleeper();
    const engine = new GameEngine(null, () => {}, {
      aiMode: true, seed: 1,
      expedition: { obstacles: [], elevationZones: [], extraction: { x: 0, y: 0, w: 100, h: 100 }, units: [sniper, sleeper] },
    });
    engine.startBattle();
    engine.confirmPlan();
    for (let tick = 0; tick < 4 * 60; tick++) engine.externalTick(1000 / 60);
    expect(sleeper.dormant).toBe(true);
    expect(sleeper.hp).toBe(sleeper.maxHp);
    engine.stop();
  });
});

describe('wake rings', () => {
  const sleeper = (x: number, y: number, id = 'red_lurk_0') => {
    const u = createUnit(id, 'zombie', 'red', { x, y });
    u.dormant = true;
    return u;
  };
  const path: Vec2[] = [{ x: 100, y: 1000 }, { x: 100, y: 500 }];

  it('marks sleepers a path would wake, and shows those it passes near', () => {
    const crossed = sleeper(100 + LURKER_WAKE_RADIUS - 10, 750, 'a');
    const near = sleeper(100 + LURKER_WAKE_RADIUS + 50, 750, 'b');
    const far = sleeper(900, 750, 'c');
    const rings = wakeRings([path], [crossed, near, far], LURKER_WAKE_RADIUS);
    expect(rings).toEqual([{ pos: crossed.pos, crossed: true }, { pos: near.pos, crossed: false }]);
  });

  it('skips awake and dead enemies, and works without paths', () => {
    const awake = sleeper(100, 750, 'a');
    awake.dormant = false;
    const dead = sleeper(100, 760, 'b');
    dead.alive = false;
    expect(wakeRings([path], [awake, dead], LURKER_WAKE_RADIUS)).toEqual([]);
    expect(wakeRings([], [sleeper(100, 750)], LURKER_WAKE_RADIUS)).toEqual([]);
  });
});

describe('survivors', () => {
  it('strands one per stretch of the trip, off the straight route, inside the map', () => {
    for (let seed = 1; seed <= 20; seed++) {
      const map = generateExpeditionMap(createRng(seed));
      const { survivors } = placeSurvivors(map, createRng(seed));
      expect(survivors).toHaveLength(SURVIVOR_COUNT);
      for (const s of survivors) {
        expect(Math.abs(s.pos.x - EXPEDITION_START.x)).toBeGreaterThan(250);
        expect(s.pos.y).toBeGreaterThan(map.extraction.y + map.extraction.h);
        expect(s.pos.y).toBeLessThan(EXPEDITION_START.y - 300);
        for (const o of map.obstacles) expect(inRect(s.pos, o)).toBe(false);
      }
      // Spread from near the start to near the end
      const ys = survivors.map(s => s.pos.y);
      expect(ys[0]).toBeGreaterThan(ys[1]);
      expect(ys[1]).toBeGreaterThan(ys[2]);
      expect(new Set(survivors.map(s => s.id)).size).toBe(SURVIVOR_COUNT);
      // Sides alternate
      const left = survivors.map(s => s.pos.x < EXPEDITION_START.x);
      expect(left[0]).not.toBe(left[1]);
      expect(left[1]).not.toBe(left[2]);
    }
  });

  it('guards each one with a sleeping pack that a rescuer always wakes', () => {
    const map = generateExpeditionMap(createRng(3));
    const { survivors, guards } = placeSurvivors(map, createRng(3));
    expect(guards.length).toBeGreaterThanOrEqual(SURVIVOR_COUNT * 2);
    for (const g of guards) {
      expect(g.team).toBe('red');
      expect(g.dormant).toBe(true);
    }
    for (const s of survivors) {
      const near = guards.filter(g => Math.hypot(g.pos.x - s.pos.x, g.pos.y - s.pos.y) + RESCUE_RADIUS < LURKER_WAKE_RADIUS);
      expect(near.length).toBeGreaterThan(0);
    }
  });

  it('a unit that reaches a survivor brings it into the squad', () => {
    const survivors = [
      { id: 'blue_survivor_0', type: 'soldier' as const, pos: { x: 100, y: 1000 } },
      { id: 'blue_survivor_1', type: 'sniper' as const, pos: { x: 900, y: 600 } },
    ];
    const near = createUnit('blue_a', 'soldier', 'blue', { x: 100 + RESCUE_RADIUS - 5, y: 1000 });
    const dead = createUnit('blue_b', 'soldier', 'blue', { x: 900, y: 600 });
    dead.alive = false;
    const red = createUnit('red_z', 'zombie', 'red', { x: 900, y: 600 });
    const rescued = rescueSurvivors([near, dead, red], survivors);
    expect(rescued.map(u => [u.id, u.type, u.team])).toEqual([['blue_survivor_0', 'soldier', 'blue']]);
    expect(rescued[0].alive).toBe(true);
    expect(survivors.map(s => s.id)).toEqual(['blue_survivor_1']);
    expect(rescueSurvivors([near], survivors)).toEqual([]);
  });
});

describe('expeditionStars', () => {
  it('rates the haul: anyone, the squad\'s worth, everyone including survivors', () => {
    expect(expeditionStars(0)).toBe('☆☆☆');
    expect(expeditionStars(1)).toBe('★☆☆');
    expect(expeditionStars(4)).toBe('★★☆');
    expect(expeditionStars(4 + SURVIVOR_COUNT)).toBe('★★★');
  });
});

describe('evac', () => {
  const zone = { x: 400, y: 50, w: 300, h: 150 };
  const setup = (units: ExpeditionSetup['units'], survivors: ExpeditionSetup['survivors'] = []): GameEngine => {
    const engine = new GameEngine(null, () => {}, {
      aiMode: true, seed: 1,
      expedition: { obstacles: [], elevationZones: [], extraction: zone, units, survivors },
    });
    engine.startBattle();
    return engine;
  };
  const playRound = (engine: GameEngine) => {
    engine.confirmPlan();
    for (let tick = 0; tick < 9 * 60 && engine.phase === 'playing'; tick++) engine.externalTick(1000 / 60);
  };

  it('is not called just by reaching the zone', () => {
    const engine = setup([createUnit('blue_a', 'soldier', 'blue', { x: 500, y: 100 })]);
    expect(engine.evacStatus).toBe('none');
    expect(engine.evacButton).toBe('ready');
    playRound(engine);
    expect(engine.wasExtracted).toBe(false);
    expect(engine.phase).toBe('blue-planning');
    engine.stop();
  });

  it('can only be called with a unit in the zone', () => {
    const engine = setup([createUnit('blue_a', 'soldier', 'blue', { x: 500, y: 900 })]);
    expect(engine.evacButton).toBe('hidden');
    expect(engine.callEvac(true)).toBe(false);
    engine.stop();
  });

  it('can be taken back while planning, then lands at the end of the round it was called for', () => {
    const inside = createUnit('blue_a', 'soldier', 'blue', { x: 500, y: 100 });
    const outside = createUnit('blue_b', 'soldier', 'blue', { x: 500, y: 1200 });
    const engine = setup([inside, outside]);
    expect(engine.callEvac(true)).toBe(true);
    expect(engine.evacButton).toBe('called');
    expect(engine.callEvac(false)).toBe(false);
    expect(engine.callEvac(true)).toBe(true);
    playRound(engine);
    // The battle is ending with the squad extracted; the straggler stays behind
    expect(engine.wasExtracted).toBe(true);
    expect(engine.extractedUnits).toBe(1);
    engine.stop();
  });

  it('waiting in the zone without calling it counts as a stall; holding for a called evac does not', () => {
    const waiting = setup([createUnit('blue_a', 'soldier', 'blue', { x: 500, y: 100 })]);
    playRound(waiting);
    expect(waiting.takePursuitNews()?.stalled).toBe(true);
    waiting.stop();

    // Nobody inside when it lands: the called evac waits, and holding isn't a stall
    const holding = setup([
      createUnit('blue_a', 'soldier', 'blue', { x: 500, y: 100 }),
    ]);
    holding.callEvac(true);
    holding.getUnits()[0].pos = { x: 500, y: 600 };
    playRound(holding);
    expect(holding.wasExtracted).toBe(false);
    expect(holding.evacStatus).toBe('landing');
    expect(holding.takePursuitNews()?.stalled).toBe(false);
    holding.stop();
  });

  it('picks up survivors during a round, and they count toward the haul', () => {
    const rescuer = createUnit('blue_a', 'soldier', 'blue', { x: 500, y: 100 });
    const engine = setup([rescuer], [{ id: 'blue_survivor_0', type: 'sniper', pos: { x: 520, y: 120 } }]);
    engine.callEvac(true);
    playRound(engine);
    expect(engine.survivorsRescued).toBe(1);
    expect(engine.survivorsWaiting).toBe(0);
    expect(engine.extractedUnits).toBe(2);
    engine.stop();
  });
});
