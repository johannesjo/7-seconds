import { Obstacle, ElevationZone, CoverBlock } from './types';
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
    const h = randomInRange(40, 100);
    const x = randomInRange(50, MAP_WIDTH - 50 - w);
    const y = randomInRange(MAP_HEIGHT * 0.25, MAP_HEIGHT * 0.45 - h);

    obstacles.push({ x, y, w, h });
    obstacles.push({ x, y: MAP_HEIGHT - y - h, w, h });
  }

  if (hasCenter || obstacles.length < 3) {
    const w = randomInRange(60, 140);
    const h = randomInRange(40, 80);
    const x = randomInRange(50, MAP_WIDTH - 50 - w);
    const y = (MAP_HEIGHT - h) / 2;
    obstacles.push({ x, y, w, h });
  }

  return obstacles;
}

/** Generate 1-2 symmetric pairs of hill zones (2-4 total). */
export function generateElevationZones(): ElevationZone[] {
  const zones: ElevationZone[] = [];
  const pairCount = randomInRange(1, 3); // 1 or 2 pairs

  for (let i = 0; i < pairCount; i++) {
    const w = randomInRange(80, 160);
    const h = randomInRange(60, 120);
    const x = randomInRange(50, MAP_WIDTH - 50 - w);
    const y = randomInRange(MAP_HEIGHT * 0.25, MAP_HEIGHT * 0.45 - h);

    zones.push({ x, y, w, h });
    zones.push({ x, y: MAP_HEIGHT - y - h, w, h });
  }

  return zones;
}

/** Generate 1-2 symmetric pairs of narrow cover blocks (2-4 total). */
export function generateCoverBlocks(): CoverBlock[] {
  const covers: CoverBlock[] = [];
  const pairCount = randomInRange(1, 3); // 1 or 2 pairs

  for (let i = 0; i < pairCount; i++) {
    const horizontal = Math.random() > 0.5;
    const long = randomInRange(40, 80);
    const narrow = randomInRange(8, 12);
    const w = horizontal ? long : narrow;
    const h = horizontal ? narrow : long;
    const x = randomInRange(50, MAP_WIDTH - 50 - w);
    const y = randomInRange(MAP_HEIGHT * 0.25, MAP_HEIGHT * 0.45 - h);

    covers.push({ x, y, w, h });
    covers.push({ x, y: MAP_HEIGHT - y - h, w, h });
  }

  return covers;
}
