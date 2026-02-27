import { describe, it, expect } from 'vitest';
import { generateObstacles, generateElevationZones, generateCoverBlocks } from './battlefield';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';

describe('generateObstacles', () => {
  it('generates 3-5 obstacles', () => {
    const obstacles = generateObstacles();
    expect(obstacles.length).toBeGreaterThanOrEqual(3);
    expect(obstacles.length).toBeLessThanOrEqual(5);
  });

  it('obstacles are symmetrical (mirrored top-bottom)', () => {
    const obstacles = generateObstacles();
    for (const obs of obstacles) {
      const centerY = obs.y + obs.h / 2;
      const mirrorCenterY = MAP_HEIGHT - centerY;
      const isCentered = Math.abs(centerY - MAP_HEIGHT / 2) < 1;
      const hasMirror = obstacles.some(o => {
        const oCenterY = o.y + o.h / 2;
        return Math.abs(oCenterY - mirrorCenterY) < 1 && o !== obs;
      });
      expect(isCentered || hasMirror).toBe(true);
    }
  });

  it('obstacles are within the middle zone of the map', () => {
    const obstacles = generateObstacles();
    for (const obs of obstacles) {
      expect(obs.x).toBeGreaterThanOrEqual(50);
      expect(obs.x + obs.w).toBeLessThanOrEqual(MAP_WIDTH - 50);
      expect(obs.y).toBeGreaterThanOrEqual(MAP_HEIGHT * 0.25);
      expect(obs.y + obs.h).toBeLessThanOrEqual(MAP_HEIGHT * 0.75);
    }
  });
});

describe('generateElevationZones', () => {
  it('generates 2-4 zones (always even, mirrored pairs)', () => {
    for (let i = 0; i < 20; i++) {
      const zones = generateElevationZones();
      expect(zones.length).toBeGreaterThanOrEqual(2);
      expect(zones.length).toBeLessThanOrEqual(4);
      expect(zones.length % 2).toBe(0);
    }
  });

  it('zones are symmetrical (mirrored top-bottom)', () => {
    const zones = generateElevationZones();
    for (const z of zones) {
      const centerY = z.y + z.h / 2;
      const mirrorCenterY = MAP_HEIGHT - centerY;
      const hasMirror = zones.some(other => {
        const otherCenterY = other.y + other.h / 2;
        return Math.abs(otherCenterY - mirrorCenterY) < 1 && other !== z;
      });
      expect(hasMirror).toBe(true);
    }
  });

  it('zones are within map bounds', () => {
    for (let i = 0; i < 20; i++) {
      const zones = generateElevationZones();
      for (const z of zones) {
        expect(z.x).toBeGreaterThanOrEqual(50);
        expect(z.x + z.w).toBeLessThanOrEqual(MAP_WIDTH - 50);
        expect(z.y).toBeGreaterThanOrEqual(0);
        expect(z.y + z.h).toBeLessThanOrEqual(MAP_HEIGHT);
      }
    }
  });
});

describe('generateCoverBlocks', () => {
  it('generates 2-4 cover blocks (always even, mirrored pairs)', () => {
    for (let i = 0; i < 20; i++) {
      const covers = generateCoverBlocks();
      expect(covers.length).toBeGreaterThanOrEqual(2);
      expect(covers.length).toBeLessThanOrEqual(4);
      expect(covers.length % 2).toBe(0);
    }
  });

  it('cover blocks have a narrow dimension of at most 12', () => {
    for (let i = 0; i < 20; i++) {
      const covers = generateCoverBlocks();
      for (const c of covers) {
        const narrow = Math.min(c.w, c.h);
        expect(narrow).toBeLessThanOrEqual(12);
      }
    }
  });

  it('cover blocks are symmetrical (mirrored top-bottom)', () => {
    const covers = generateCoverBlocks();
    for (const c of covers) {
      const centerY = c.y + c.h / 2;
      const mirrorCenterY = MAP_HEIGHT - centerY;
      const hasMirror = covers.some(other => {
        const otherCenterY = other.y + other.h / 2;
        return Math.abs(otherCenterY - mirrorCenterY) < 1 && other !== c;
      });
      expect(hasMirror).toBe(true);
    }
  });

  it('cover blocks are within map bounds', () => {
    for (let i = 0; i < 20; i++) {
      const covers = generateCoverBlocks();
      for (const c of covers) {
        expect(c.x).toBeGreaterThanOrEqual(50);
        expect(c.x + c.w).toBeLessThanOrEqual(MAP_WIDTH - 50);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.y + c.h).toBeLessThanOrEqual(MAP_HEIGHT);
      }
    }
  });
});
