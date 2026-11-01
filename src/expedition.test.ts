import { describe, expect, it } from 'vitest';
import { createRng } from './rng';
import { createUnit } from './units';
import {
  EXPEDITION_MAP_HEIGHT, EXPEDITION_MAP_WIDTH, LURKER_WAKE_RADIUS, MAX_ALIVE_ENEMIES,
  createExpeditionSquad, distanceToExtraction, extractionZone, generateExpeditionMap, pursuitComposition,
  spawnLurkers, spawnPursuers, unitsInZone, wakeLurkers,
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
    expect(squad).toHaveLength(5);
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
