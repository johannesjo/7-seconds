import { describe, it, expect } from 'vitest';
import { scorePosition, generateCandidates } from './ai-scoring';
import { createUnit } from './units';
import { Obstacle, ElevationZone } from './types';
import { createCtfState } from './ctf';

describe('scorePosition', () => {
  const enemies = [
    createUnit('e1', 'soldier', 'blue', { x: 600, y: 600 }),
  ];
  const obstacles: Obstacle[] = [];
  const elevationZones: ElevationZone[] = [];

  it('snipers prefer far positions over close ones', () => {
    const sniper = createUnit('s1', 'sniper', 'red', { x: 600, y: 100 });

    const farScore = scorePosition({
      candidate: { x: 600, y: 350 },
      unit: sniper,
      enemies,
      obstacles,
      elevationZones,
    });

    const closeScore = scorePosition({
      candidate: { x: 600, y: 560 },
      unit: sniper,
      enemies,
      obstacles,
      elevationZones,
    });

    expect(farScore).toBeGreaterThan(closeScore);
  });

  it('blades prefer close positions', () => {
    const blade = createUnit('b1', 'blade', 'red', { x: 600, y: 300 });

    const closeScore = scorePosition({
      candidate: { x: 600, y: 560 },
      unit: blade,
      enemies,
      obstacles,
      elevationZones,
    });

    const farScore = scorePosition({
      candidate: { x: 600, y: 350 },
      unit: blade,
      enemies,
      obstacles,
      elevationZones,
    });

    expect(closeScore).toBeGreaterThan(farScore);
  });

  it('soldiers value flanking positions', () => {
    const unit = createUnit('sc1', 'soldier', 'red', { x: 400, y: 400 });
    // Enemy facing right (gunAngle = 0), so approaching from behind (left) is a flank
    const enemy = createUnit('e1', 'soldier', 'blue', { x: 500, y: 500 });
    enemy.gunAngle = 0;

    const flankScore = scorePosition({
      candidate: { x: 460, y: 500 }, // behind enemy (left of it)
      unit: unit,
      enemies: [enemy],
      obstacles,
      elevationZones,
    });

    const frontalScore = scorePosition({
      candidate: { x: 540, y: 500 }, // in front of enemy (right of it)
      unit: unit,
      enemies: [enemy],
      obstacles,
      elevationZones,
    });

    expect(flankScore).toBeGreaterThan(frontalScore);
  });

  it('unreachable positions score -Infinity', () => {
    const unit = createUnit('sc1', 'soldier', 'red', { x: 100, y: 100 });
    // Scout speed 180, ROUND_DURATION_S 7 = max 1260px. Position 2000px away
    const score = scorePosition({
      candidate: { x: 2500, y: 2500 },
      unit: unit,
      enemies,
      obstacles,
      elevationZones,
    });

    expect(score).toBe(-Infinity);
  });

  it('elevated positions score higher for snipers', () => {
    const sniper = createUnit('s1', 'sniper', 'red', { x: 600, y: 100 });
    const zone: ElevationZone = { x: 550, y: 280, w: 100, h: 100 };

    const elevatedScore = scorePosition({
      candidate: { x: 600, y: 330 },
      unit: sniper,
      enemies,
      obstacles,
      elevationZones: [zone],
    });

    const flatScore = scorePosition({
      candidate: { x: 600, y: 200 },
      unit: sniper,
      enemies,
      obstacles,
      elevationZones: [zone],
    });

    expect(elevatedScore).toBeGreaterThan(flatScore);
  });
});

describe('generateCandidates', () => {
  it('excludes positions inside obstacles', () => {
    const unit = createUnit('u1', 'soldier', 'red', { x: 600, y: 400 });
    const obstacle: Obstacle = { x: 580, y: 380, w: 40, h: 40 };

    const candidates = generateCandidates(unit, [obstacle], []);

    // No candidate should be inside the obstacle
    for (const c of candidates) {
      const cx = Math.max(obstacle.x, Math.min(obstacle.x + obstacle.w, c.x));
      const cy = Math.max(obstacle.y, Math.min(obstacle.y + obstacle.h, c.y));
      const dx = c.x - cx;
      const dy = c.y - cy;
      const padding = unit.radius + 4;
      expect(dx * dx + dy * dy).toBeGreaterThanOrEqual(padding * padding);
    }
  });

  it('includes elevation zone centers', () => {
    const unit = createUnit('u1', 'soldier', 'red', { x: 600, y: 400 });
    const zone: ElevationZone = { x: 550, y: 350, w: 100, h: 100 };

    const candidates = generateCandidates(unit, [], [zone]);

    const hasCenter = candidates.some(c =>
      Math.abs(c.x - 600) < 1 && Math.abs(c.y - 400) < 1,
    );
    expect(hasCenter).toBe(true);
  });
});

describe('CTF scoring', () => {
  const obstacles: Obstacle[] = [];
  const elevationZones: ElevationZone[] = [];

  it('scores positions closer to enemy flag higher when no carrier', () => {
    const ctfState = createCtfState();
    const unit = createUnit('r1', 'soldier', 'red', { x: 600, y: 400 });
    const enemies = [createUnit('e1', 'soldier', 'blue', { x: 200, y: 400 })];

    const nearFlag = scorePosition({
      candidate: { x: 200, y: 400 },
      unit, enemies, obstacles, elevationZones, ctfState,
    });

    const farFromFlag = scorePosition({
      candidate: { x: 800, y: 400 },
      unit, enemies, obstacles, elevationZones, ctfState,
    });

    expect(nearFlag).toBeGreaterThan(farFromFlag);
  });

  it('scores intercept positions higher when enemy carries flag', () => {
    const ctfState = createCtfState();
    ctfState.redFlag.carrierId = 'e1';
    ctfState.redFlag.pos = { x: 400, y: 400 };

    const unit = createUnit('r1', 'soldier', 'red', { x: 600, y: 400 });
    const carrier = createUnit('e1', 'soldier', 'blue', { x: 400, y: 400 });

    const nearCarrier = scorePosition({
      candidate: { x: 450, y: 400 },
      unit, enemies: [carrier], obstacles, elevationZones, ctfState,
    });

    const farFromCarrier = scorePosition({
      candidate: { x: 800, y: 400 },
      unit, enemies: [carrier], obstacles, elevationZones, ctfState,
    });

    expect(nearCarrier).toBeGreaterThan(farFromCarrier);
  });
});
