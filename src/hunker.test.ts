import { describe, it, expect } from 'vitest';
import { GameEngine } from './game';
import { updateHunker, isHunkered } from './hunker';
import { createUnit, updateProjectiles, updateGunAngle, moveUnit, snapshotToUnit } from './units';
import { updateOrdnance } from './ordnance';
import { isPlausibleGameState, type OnlineGameState } from './online-types';
import type { PathList } from './online-plan';
import type { Obstacle, Projectile, Unit } from './types';
import { UNIT_STATS, HUNKER_SETUP_S, MORTAR_BLAST_RADIUS, MORTAR_FLIGHT_S } from './constants';

const DT = 1 / 60;
const SETUP_TICKS = Math.round(HUNKER_SETUP_S / DT);

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

const find = (s: OnlineGameState, id: string) => s.units.find(u => u.id === id)!;
const run = (s: OnlineGameState, blue: PathList, ticks: number) => GameEngine.resolveRound(s, blue, [], 1, ticks).endState;

/** A lone blue soldier with a red one far out of range, so nobody shoots. */
const quiet = (blue: Partial<UnitSpec> = {}, obstacles: Obstacle[] = []) => state([
  { id: 'b', type: 'soldier', team: 'blue', x: 500, y: 900, ...blue },
  { id: 'r', type: 'soldier', team: 'red', x: 500, y: 100 },
], obstacles);

function hunkered(type: Unit['type'] = 'soldier'): Unit {
  const u = createUnit('u', type, 'red', { x: 105, y: 100 });
  u.hunkerSetup = HUNKER_SETUP_S;
  return u;
}

function bullet(fromX: number, velX: number): Projectile {
  return { pos: { x: fromX, y: 100 }, vel: { x: velX, y: 0 }, target: { x: 105, y: 100 }, damage: 10, radius: 5, team: 'blue', maxRange: 200, distanceTraveled: 0 };
}

describe('hunker setup', () => {
  it('a soldier without orders hunkers after the setup time, not before', () => {
    const u = createUnit('s', 'soldier', 'blue', { x: 100, y: 100 });
    for (let i = 0; i < SETUP_TICKS - 1; i++) updateHunker(u, DT);
    expect(isHunkered(u)).toBe(false);
    updateHunker(u, DT);
    expect(isHunkered(u)).toBe(true);
  });

  it('only soldiers hunker', () => {
    const sniper = createUnit('s', 'sniper', 'blue', { x: 100, y: 100 });
    for (let i = 0; i < SETUP_TICKS * 2; i++) updateHunker(sniper, DT);
    expect(isHunkered(sniper)).toBe(false);
  });

  it('sets up after finishing its path, not while walking it', () => {
    // 50px at speed 100 is ~0.5s of walking.
    const path: PathList = [{ unitId: 'b', waypoints: [{ x: 500, y: 850 }] }];
    expect(find(run(quiet(), path, 60), 'b').hunkerSetup ?? 0).toBeLessThan(HUNKER_SETUP_S);
    expect(find(run(quiet(), path, 60), 'b').hunkerSetup ?? 0).toBeGreaterThan(0);
    const done = find(run(quiet(), path, 120), 'b');
    expect(Math.abs(done.y - 850)).toBeLessThan(2); // arrival counts within 2px
    expect(done.hunkerSetup).toBe(HUNKER_SETUP_S);
  });

  it('moving cancels it', () => {
    const path: PathList = [{ unitId: 'b', waypoints: [{ x: 500, y: 500 }] }];
    const end = find(run(quiet({ hunkerSetup: HUNKER_SETUP_S }), path, 30), 'b');
    expect(end.hunkerSetup).toBeUndefined();
  });

  it('a path that ends stuck against cover is not completed, until next round', () => {
    const wall: Obstacle = { x: 400, y: 790, w: 200, h: 40 };
    const path: PathList = [{ unitId: 'b', waypoints: [{ x: 500, y: 810 }] }];
    const stuck = run(quiet({}, [wall]), path, 360);
    expect(find(stuck, 'b').y).toBeGreaterThan(830);
    expect(find(stuck, 'b').hunkerSetup).toBeUndefined();
    // Next round without new orders it digs in where it stands.
    expect(find(run(stuck, [], 60), 'b').hunkerSetup).toBe(HUNKER_SETUP_S);
  });

  it('knockback from a hit does not cancel it', () => {
    const u = hunkered();
    u.gunAngle = Math.PI;
    updateProjectiles([bullet(100, 300)], [u], 0.016);
    const before = { ...u.pos };
    for (let i = 0; i < 30; i++) {
      moveUnit(u, DT, []);
      updateHunker(u, DT);
    }
    expect(u.pos.x).not.toBe(before.x);
    expect(isHunkered(u)).toBe(true);
  });
});

describe('hunkered combat', () => {
  it('takes 30% less from frontal bullets', () => {
    const u = hunkered();
    u.gunAngle = Math.PI; // facing the shot from the left
    const { hits } = updateProjectiles([bullet(100, 300)], [u], 0.016);
    expect(hits[0]).toMatchObject({ flanked: false });
    expect(hits[0].damage).toBeCloseTo(7);
    expect(u.hp).toBeCloseTo(53);
  });

  it('keeps full flank damage from the side or rear', () => {
    const u = hunkered();
    u.gunAngle = Math.PI; // the shot comes from behind, on the right
    const { hits } = updateProjectiles([bullet(110, -300)], [u], 0.016);
    expect(hits[0]).toMatchObject({ flanked: true, damage: 15 });
  });

  it('gets no reduction against explosions', () => {
    const dug = hunkered();
    const open = createUnit('o', 'soldier', 'red', { x: 105, y: 100 });
    const shell = (): Projectile => ({
      kind: 'shell', pos: { x: 105, y: 400 }, origin: { x: 105, y: 400 }, target: { x: 105, y: 100 },
      vel: { x: 0, y: 0 }, age: MORTAR_FLIGHT_S, flightTime: MORTAR_FLIGHT_S, damage: 30, radius: 4,
      blastRadius: MORTAR_BLAST_RADIUS, team: 'blue', maxRange: Infinity, distanceTraveled: 0,
    });
    updateOrdnance([shell()], [dug], 0, []);
    updateOrdnance([shell()], [open], 0, []);
    expect(dug.hp).toBe(open.hp);
    expect(dug.hp).toBeLessThan(dug.maxHp);
  });

  it('turns at half speed', () => {
    const open = createUnit('o', 'soldier', 'red', { x: 0, y: 0 });
    const dug = hunkered();
    open.gunAngle = dug.gunAngle = 0;
    updateGunAngle(open, Math.PI / 2, 0.1);
    updateGunAngle(dug, Math.PI / 2, 0.1);
    expect(open.gunAngle).toBeCloseTo(UNIT_STATS.soldier.turnSpeed * 0.1);
    expect(dug.gunAngle).toBeCloseTo(open.gunAngle / 2);
  });
});

describe('hunker across online rounds and replays', () => {
  // Facing soldiers 100px apart: red's first bullet lands before blue could
  // set up from scratch, so only a carried-over hunker blunts it.
  const duel = (blueSetup?: number) => state([
    { id: 'b', type: 'soldier', team: 'blue', x: 500, y: 600, ...(blueSetup ? { hunkerSetup: blueSetup } : {}) },
    { id: 'r', type: 'soldier', team: 'red', x: 500, y: 500 },
  ]);

  it('a hunker carried in the round state protects from the first tick', () => {
    expect(find(run(duel(HUNKER_SETUP_S), [], 30), 'b').hp).toBeCloseTo(53);
    expect(find(run(duel(), [], 30), 'b').hp).toBe(50);
  });

  it('the referee result round-trips through the persisted state', () => {
    const end = run(quiet(), [], 60);
    expect(find(end, 'b').hunkerSetup).toBe(HUNKER_SETUP_S);
    const persisted = JSON.parse(JSON.stringify(end)) as OnlineGameState;
    expect(isPlausibleGameState(persisted)).toBe(true);
    expect(run(persisted, [], 60)).toEqual(run(end, [], 60));
  });

  it('rejects a malformed hunker in a remote state', () => {
    const bad = (v: number) => state([{ id: 'b', type: 'soldier', team: 'blue', x: 1, y: 1, hunkerSetup: v }]);
    expect(isPlausibleGameState(bad(-1))).toBe(false);
    expect(isPlausibleGameState(bad(NaN))).toBe(false);
  });

  it('replay frames carry setup progress for the arc', () => {
    const blue = createUnit('b', 'soldier', 'blue', { x: 300, y: 600 });
    const red = createUnit('r', 'soldier', 'red', { x: 300, y: 50 });
    // Keep red walking so the practice round doesn't end early as idle.
    red.waypoints = [{ x: 900, y: 50 }];
    const engine = new GameEngine(null, () => {}, { practice: { units: [blue, red], elevationZones: [] }, seed: 1 });
    engine.startBattle();
    engine.confirmPlan();
    for (let tick = 0; tick < SETUP_TICKS + 5; tick++) engine.externalTick(1000 / 60);
    const frames = engine.getReplayData()!.frames;
    const at = (i: number) => frames[i].units.find(u => u.id === 'b')!;
    expect(at(0).hunkerSetup).toBeGreaterThan(0);
    expect(isHunkered(snapshotToUnit(at(0)))).toBe(false);
    expect(isHunkered(snapshotToUnit(at(frames.length - 1)))).toBe(true);
    engine.stop();
  });
});
