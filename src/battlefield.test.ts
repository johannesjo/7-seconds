import { describe, it, expect } from 'vitest';
import { generateObstacles } from './battlefield';
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
