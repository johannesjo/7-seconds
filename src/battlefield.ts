import { Obstacle } from './types';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';

function randomInRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min)) + min;
}

/** Generate 3-5 symmetrical obstacles in the middle zone of the map. */
export function generateObstacles(): Obstacle[] {
  const obstacles: Obstacle[] = [];

  const pairCount = randomInRange(1, 3); // 1 or 2 pairs
  const hasCenter = Math.random() > 0.5;

  for (let i = 0; i < pairCount; i++) {
    const w = randomInRange(40, 100);
    const h = randomInRange(60, 160);
    const x = randomInRange(MAP_WIDTH * 0.25, MAP_WIDTH * 0.45 - w);
    const y = randomInRange(50, MAP_HEIGHT - 50 - h);

    obstacles.push({ x, y, w, h });
    obstacles.push({ x: MAP_WIDTH - x - w, y, w, h });
  }

  if (hasCenter || obstacles.length < 3) {
    const w = randomInRange(40, 80);
    const h = randomInRange(60, 140);
    const x = (MAP_WIDTH - w) / 2;
    const y = randomInRange(50, MAP_HEIGHT - 50 - h);
    obstacles.push({ x, y, w, h });
  }

  return obstacles;
}
