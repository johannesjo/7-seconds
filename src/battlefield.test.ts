import { describe, it, expect } from 'vitest';
import { generateObstacles, generateElevationZones, generateHordeObstacles, generateHordeElevationZones, generateCtfObstacles, generateCtfElevationZones } from './battlefield';
import { MAP_WIDTH, MAP_HEIGHT, CTF_BASE_ZONE_WIDTH } from './constants';

describe('generateObstacles', () => {
  it('generates 2-3 obstacles', () => {
    for (let i = 0; i < 20; i++) {
      const obstacles = generateObstacles();
      expect(obstacles.length).toBeGreaterThanOrEqual(2);
      expect(obstacles.length).toBeLessThanOrEqual(3);
    }
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

  it('obstacle sizes are in the 30-60 range', () => {
    for (let i = 0; i < 20; i++) {
      const obstacles = generateObstacles();
      for (const obs of obstacles) {
        expect(obs.w).toBeGreaterThanOrEqual(30);
        expect(obs.w).toBeLessThanOrEqual(60);
        expect(obs.h).toBeGreaterThanOrEqual(30);
        expect(obs.h).toBeLessThanOrEqual(60);
      }
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

// --- Horde-specific generators ---

describe('generateHordeObstacles', () => {
  it('generates 2-4 obstacles', () => {
    for (let i = 0; i < 20; i++) {
      const obstacles = generateHordeObstacles();
      expect(obstacles.length).toBeGreaterThanOrEqual(2);
      expect(obstacles.length).toBeLessThanOrEqual(4);
    }
  });

  it('obstacles are in the player half of the map (y >= MAP_HEIGHT * 0.35)', () => {
    for (let i = 0; i < 20; i++) {
      const obstacles = generateHordeObstacles();
      for (const obs of obstacles) {
        expect(obs.y).toBeGreaterThanOrEqual(MAP_HEIGHT * 0.35);
        expect(obs.y + obs.h).toBeLessThanOrEqual(MAP_HEIGHT * 0.92);
      }
    }
  });

  it('obstacles are within horizontal map bounds', () => {
    for (let i = 0; i < 20; i++) {
      const obstacles = generateHordeObstacles();
      for (const obs of obstacles) {
        expect(obs.x).toBeGreaterThanOrEqual(50);
        expect(obs.x + obs.w).toBeLessThanOrEqual(MAP_WIDTH - 50);
      }
    }
  });

  it('obstacle sizes are in the 30-60 range', () => {
    for (let i = 0; i < 20; i++) {
      const obstacles = generateHordeObstacles();
      for (const obs of obstacles) {
        expect(obs.w).toBeGreaterThanOrEqual(30);
        expect(obs.w).toBeLessThanOrEqual(60);
        expect(obs.h).toBeGreaterThanOrEqual(30);
        expect(obs.h).toBeLessThanOrEqual(60);
      }
    }
  });
});

describe('generateHordeElevationZones', () => {
  it('generates 2-4 zones', () => {
    for (let i = 0; i < 20; i++) {
      const zones = generateHordeElevationZones();
      expect(zones.length).toBeGreaterThanOrEqual(2);
      expect(zones.length).toBeLessThanOrEqual(4);
    }
  });

  it('always has at least one zone near spawn (y >= MAP_HEIGHT * 0.75)', () => {
    for (let i = 0; i < 20; i++) {
      const zones = generateHordeElevationZones();
      const nearSpawn = zones.some(z => z.y >= MAP_HEIGHT * 0.75);
      expect(nearSpawn).toBe(true);
    }
  });

  it('zones are within map bounds', () => {
    for (let i = 0; i < 20; i++) {
      const zones = generateHordeElevationZones();
      for (const z of zones) {
        expect(z.x).toBeGreaterThanOrEqual(50);
        expect(z.x + z.w).toBeLessThanOrEqual(MAP_WIDTH - 50);
        expect(z.y).toBeGreaterThanOrEqual(MAP_HEIGHT * 0.30);
        expect(z.y + z.h).toBeLessThanOrEqual(MAP_HEIGHT * 0.85);
      }
    }
  });
});

// --- CTF-specific generators ---

describe('generateCtfObstacles', () => {
  it('generates symmetrical obstacles', () => {
    const obstacles = generateCtfObstacles();
    expect(obstacles.length).toBeGreaterThanOrEqual(2);
    for (const obs of obstacles) {
      const mirrorX = MAP_WIDTH - obs.x - obs.w;
      const hasMirror = obstacles.some(o =>
        Math.abs(o.x - mirrorX) < 1 && Math.abs(o.y - obs.y) < 1 &&
        Math.abs(o.w - obs.w) < 1 && Math.abs(o.h - obs.h) < 1
      );
      const isCentered = Math.abs(obs.x + obs.w / 2 - MAP_WIDTH / 2) < 1;
      expect(hasMirror || isCentered).toBe(true);
    }
  });

  it('keeps obstacles out of base zones', () => {
    for (let i = 0; i < 10; i++) {
      const obstacles = generateCtfObstacles();
      for (const obs of obstacles) {
        expect(obs.x + obs.w).toBeGreaterThan(CTF_BASE_ZONE_WIDTH);
        expect(obs.x).toBeLessThan(MAP_WIDTH - CTF_BASE_ZONE_WIDTH);
      }
    }
  });
});

describe('generateCtfElevationZones', () => {
  it('generates symmetrical elevation zones', () => {
    const zones = generateCtfElevationZones();
    expect(zones.length).toBeGreaterThanOrEqual(2);
    for (const z of zones) {
      const mirrorX = MAP_WIDTH - z.x - z.w;
      const hasMirror = zones.some(o =>
        Math.abs(o.x - mirrorX) < 1 && Math.abs(o.y - z.y) < 1 &&
        Math.abs(o.w - z.w) < 1 && Math.abs(o.h - z.h) < 1
      );
      const isCentered = Math.abs(z.x + z.w / 2 - MAP_WIDTH / 2) < 1;
      expect(hasMirror || isCentered).toBe(true);
    }
  });
});

