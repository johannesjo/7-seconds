import { describe, it, expect } from 'vitest';
import { generateObstacles } from './battlefield';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';

describe('generateObstacles', () => {
  it('generates 3-5 obstacles', () => {
    const obstacles = generateObstacles();
    expect(obstacles.length).toBeGreaterThanOrEqual(3);
    expect(obstacles.length).toBeLessThanOrEqual(5);
  });

  it('obstacles are symmetrical (mirrored left-right)', () => {
    const obstacles = generateObstacles();
    for (const obs of obstacles) {
      const centerX = obs.x + obs.w / 2;
      const mirrorCenterX = MAP_WIDTH - centerX;
      const isCentered = Math.abs(centerX - MAP_WIDTH / 2) < 1;
      const hasMirror = obstacles.some(o => {
        const oCenterX = o.x + o.w / 2;
        return Math.abs(oCenterX - mirrorCenterX) < 1 && o !== obs;
      });
      expect(isCentered || hasMirror).toBe(true);
    }
  });

  it('obstacles are within the middle zone of the map', () => {
    const obstacles = generateObstacles();
    for (const obs of obstacles) {
      expect(obs.x).toBeGreaterThanOrEqual(MAP_WIDTH * 0.25);
      expect(obs.x + obs.w).toBeLessThanOrEqual(MAP_WIDTH * 0.75);
      expect(obs.y).toBeGreaterThanOrEqual(50);
      expect(obs.y + obs.h).toBeLessThanOrEqual(MAP_HEIGHT - 50);
    }
  });
});
