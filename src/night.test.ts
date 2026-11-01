import { describe, it, expect } from 'vitest';
import { createUnit, findTarget } from './units';
import { findMortarTarget } from './ordnance';
import { GameEngine } from './game';
import { NIGHT_SIGHT, MUZZLE_REVEAL_S, DAWN, NightVision, dawnScale, sightRadius, sightPolygon, teamVisibleEnemies, unitSees } from './night';
import type { Obstacle, Unit } from './types';

const wall: Obstacle = { x: 150, y: 290, w: 60, h: 20 };

describe('sight', () => {
  it('extends on hills like weapon range', () => {
    const sniper = createUnit('s', 'sniper', 'blue', { x: 50, y: 50 });
    expect(sightRadius(sniper)).toBe(NIGHT_SIGHT.sniper);
    expect(sightRadius(sniper, [{ x: 0, y: 0, w: 100, h: 100 }])).toBeGreaterThan(NIGHT_SIGHT.sniper);
  });

  it('needs range and a clear line', () => {
    const blue = createUnit('b', 'soldier', 'blue', { x: 180, y: 400 });
    const near = createUnit('r1', 'soldier', 'red', { x: 180, y: 300 + 0 });
    const far = createUnit('r2', 'soldier', 'red', { x: 180 + 200, y: 400 });
    expect(unitSees(blue, near, [])).toBe(true);
    expect(unitSees(blue, near, [wall])).toBe(false);
    expect(unitSees(blue, far, [])).toBe(false);
  });

  it('is shared by the whole team (spotting)', () => {
    const sniper = createUnit('b_sniper', 'sniper', 'blue', { x: 180, y: 600 });
    const scout = createUnit('b_scout', 'soldier', 'blue', { x: 180, y: 330 });
    const enemy = createUnit('r', 'soldier', 'red', { x: 180, y: 220 });
    expect(unitSees(sniper, enemy, [])).toBe(false);
    expect(teamVisibleEnemies('blue', [sniper, enemy], [])).toEqual(new Set());
    expect(teamVisibleEnemies('blue', [sniper, scout, enemy], [])).toEqual(new Set(['r']));
    scout.alive = false;
    expect(teamVisibleEnemies('blue', [sniper, scout, enemy], [])).toEqual(new Set());
  });

  it('ignores obstacles outside the sight circle', () => {
    const blue = createUnit('b', 'soldier', 'blue', { x: 180, y: 400 });
    expect(sightPolygon(blue, [{ x: 0, y: 0, w: 40, h: 40 }])).toEqual(sightPolygon(blue, []));
  });

  it('draws a sight polygon cut short by walls', () => {
    const blue = createUnit('b', 'soldier', 'blue', { x: 180, y: 400 });
    const open = sightPolygon(blue, []);
    const blocked = sightPolygon(blue, [wall]);
    const up = open.length * 3 / 4; // ray pointing straight up (−y)
    expect(400 - open[up].y).toBeCloseTo(NIGHT_SIGHT.soldier);
    expect(400 - blocked[up].y).toBeLessThan(NIGHT_SIGHT.soldier);
  });
});

describe('dawn', () => {
  it('widens sight in late rounds so stragglers find each other', () => {
    expect(dawnScale(1)).toBe(1);
    expect(dawnScale(DAWN.fromRound - 1)).toBe(1);
    expect(dawnScale(DAWN.fromRound)).toBeGreaterThan(1);
    expect(dawnScale(DAWN.fromRound + 3)).toBeGreaterThan(dawnScale(DAWN.fromRound));
    const blue = createUnit('b', 'soldier', 'blue', { x: 180, y: 600 });
    const red = createUnit('r', 'soldier', 'red', { x: 180, y: 420 });
    const night = new NightVision();
    night.update([blue, red], []);
    expect(night.canTarget('blue', red)).toBe(false);
    night.setRound(DAWN.fromRound + 2);
    night.update([blue, red], []);
    expect(night.canTarget('blue', red)).toBe(true);
  });
});

describe('NightVision', () => {
  it('reveals a shooter for a moment after it fires', () => {
    const blue = createUnit('b', 'soldier', 'blue', { x: 180, y: 600 });
    const sniper = createUnit('r', 'sniper', 'red', { x: 180, y: 300 });
    const night = new NightVision();
    night.update([blue, sniper], []);
    expect(night.canTarget('blue', sniper)).toBe(false);
    night.noteFire(sniper);
    night.update([blue, sniper], []);
    expect(night.canTarget('blue', sniper)).toBe(true);
    for (let t = 0; t < MUZZLE_REVEAL_S + 0.05; t += 1 / 60) night.tick(1 / 60);
    night.update([blue, sniper], []);
    expect(night.canTarget('blue', sniper)).toBe(false);
  });

  it('remembers where enemies were last seen, and forgets the dead', () => {
    const blue = createUnit('b', 'soldier', 'blue', { x: 180, y: 400 });
    const red = createUnit('r', 'soldier', 'red', { x: 180, y: 300 });
    const night = new NightVision();
    night.update([blue, red], []);
    red.pos = { x: 180, y: 50 }; // walks off into the dark
    night.update([blue, red], []);
    expect(night.canTarget('blue', red)).toBe(false);
    expect(night.lastSeen.blue.get('r')).toEqual({ x: 180, y: 300 });
    red.alive = false;
    night.update([blue, red], []);
    expect(night.lastSeen.blue.has('r')).toBe(false);
  });

  it('lets muzzle flashes fade at round end but remembers where the shooter stood', () => {
    const blue = createUnit('b', 'soldier', 'blue', { x: 180, y: 600 });
    const sniper = createUnit('r', 'sniper', 'red', { x: 180, y: 300 });
    const night = new NightVision();
    night.noteFire(sniper);
    night.update([blue, sniper], []);
    night.endRound();
    night.update([blue, sniper], []);
    expect(night.canTarget('blue', sniper)).toBe(false);
    expect(night.lastSeen.blue.get('r')).toEqual({ x: 180, y: 300 });
  });

  it('exposes stable per-team targeting filters', () => {
    const blue = createUnit('b', 'soldier', 'blue', { x: 180, y: 400 });
    const red = createUnit('r', 'soldier', 'red', { x: 180, y: 330 });
    const night = new NightVision();
    const filter = night.canSee.blue;
    expect(filter(red)).toBe(false);
    night.update([blue, red], []);
    expect(night.canSee.blue).toBe(filter);
    expect(filter(red)).toBe(true);
    expect(night.canSee.red(blue)).toBe(true);
  });

  it('starts out knowing the enemy deployment', () => {
    const units = [createUnit('b', 'soldier', 'blue', { x: 100, y: 600 }), createUnit('r', 'soldier', 'red', { x: 100, y: 40 })];
    const night = new NightVision();
    night.seedDeployment(units);
    night.update(units, []);
    expect(night.visible.blue.size).toBe(0);
    expect(night.lastSeen.blue.get('r')).toEqual({ x: 100, y: 40 });
    expect(night.lastSeen.red.get('b')).toEqual({ x: 100, y: 600 });
  });
});

describe('targeting at night', () => {
  it('findTarget skips enemies the team cannot see', () => {
    const blue = createUnit('b', 'soldier', 'blue', { x: 180, y: 400 });
    const near = createUnit('near', 'soldier', 'red', { x: 180, y: 330 });
    const far = createUnit('far', 'soldier', 'red', { x: 260, y: 360 });
    const units = [blue, near, far];
    expect(findTarget(blue, units, null, [])!.id).toBe('near');
    expect(findTarget(blue, units, null, [], u => u.id === 'far')!.id).toBe('far');
    expect(findTarget(blue, units, null, [], () => false)).toBeNull();
  });

  it('mortars need a spotter', () => {
    const mortar = createUnit('m', 'mortar', 'blue', { x: 180, y: 600 });
    const enemy = createUnit('r', 'soldier', 'red', { x: 180, y: 350 });
    const night = new NightVision();
    night.update([mortar, enemy], []);
    const canSee = (u: Unit) => night.canTarget('blue', u);
    expect(findMortarTarget(mortar, [mortar, enemy], [])).toBe(enemy);
    expect(findMortarTarget(mortar, [mortar, enemy], [], canSee)).toBeNull();
    const spotter = createUnit('s', 'soldier', 'blue', { x: 180, y: 450 });
    night.update([mortar, spotter, enemy], []);
    expect(findMortarTarget(mortar, [mortar, spotter, enemy], [], canSee)).toBe(enemy);
  });
});

/** Blue sniper 250px from a red soldier: in gun range, out of sight. */
function sniperDuel(night: boolean, withSpotter: boolean) {
  const units = [
    createUnit('blue_sniper', 'sniper', 'blue', { x: 180, y: 560 }),
    createUnit('red_soldier', 'soldier', 'red', { x: 180, y: 310 }),
  ];
  if (withSpotter) units.push(createUnit('blue_scout', 'soldier', 'blue', { x: 100, y: 420 }));
  const engine = new GameEngine(null, () => {}, { practice: { units, elevationZones: [] }, seed: 7, night });
  engine.startBattle();
  engine.confirmPlan();
  for (let i = 0; i < 180; i++) engine.externalTick(1000 / 60);
  const red = engine.getUnits().find(u => u.id === 'red_soldier')!;
  const state = engine.getOnlineGameState();
  engine.stop();
  return { redHp: red.hp, state };
}

describe('night battle engine', () => {
  it('a sniper cannot hit what nobody sees', () => {
    expect(sniperDuel(false, false).redHp).toBeLessThan(60);
    expect(sniperDuel(true, false).redHp).toBe(60);
  });

  it('a spotter lets the sniper fire', () => {
    expect(sniperDuel(true, true).redHp).toBeLessThan(60);
  });

  it('stays deterministic', () => {
    expect(sniperDuel(true, true).state).toEqual(sniperDuel(true, true).state);
  });
});
