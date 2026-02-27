import { Obstacle, ElevationZone } from './types';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';

function randomInRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min)) + min;
}

/** Generate 2-3 symmetrical obstacles (smaller) in the middle zone of the map. */
export function generateObstacles(): Obstacle[] {
  const obstacles: Obstacle[] = [];

  const pairCount = randomInRange(1, 2); // 1 pair
  const hasCenter = Math.random() > 0.5;

  for (let i = 0; i < pairCount; i++) {
    const w = randomInRange(30, 60);
    const h = randomInRange(30, 60);
    const x = randomInRange(50, MAP_WIDTH - 50 - w);
    const y = randomInRange(MAP_HEIGHT * 0.25, MAP_HEIGHT * 0.45 - h);

    obstacles.push({ x, y, w, h });
    obstacles.push({ x, y: MAP_HEIGHT - y - h, w, h });
  }

  if (hasCenter || obstacles.length < 3) {
    const w = randomInRange(30, 60);
    const h = randomInRange(30, 60);
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

// --- Horde-specific generators (player-side terrain only) ---

/** Generate 2-4 obstacles in the player's half (y: 0.35–0.85). No mirroring. */
export function generateHordeObstacles(): Obstacle[] {
  const obstacles: Obstacle[] = [];
  const count = randomInRange(2, 5); // 2-4

  for (let i = 0; i < count; i++) {
    const w = randomInRange(30, 60);
    const h = randomInRange(30, 60);
    const x = randomInRange(50, MAP_WIDTH - 50 - w);
    const y = randomInRange(MAP_HEIGHT * 0.35, MAP_HEIGHT * 0.85 - h);
    obstacles.push({ x, y, w, h });
  }

  return obstacles;
}

/** Generate 2-4 elevation zones in the player's half (y: 0.30–0.80). No mirroring. */
export function generateHordeElevationZones(): ElevationZone[] {
  const zones: ElevationZone[] = [];
  const count = randomInRange(2, 5); // 2-4

  for (let i = 0; i < count; i++) {
    const w = randomInRange(80, 160);
    const h = randomInRange(60, 120);
    const x = randomInRange(50, MAP_WIDTH - 50 - w);
    const y = randomInRange(MAP_HEIGHT * 0.30, MAP_HEIGHT * 0.80 - h);
    zones.push({ x, y, w, h });
  }

  return zones;
}

