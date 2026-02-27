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

function rectsOverlap(a: Obstacle, b: Obstacle, margin = 10): boolean {
  return a.x < b.x + b.w + margin && a.x + a.w + margin > b.x
    && a.y < b.y + b.h + margin && a.y + a.h + margin > b.y;
}

/** Generate 1-2 symmetric pairs of narrow cover blocks (2-4 total), avoiding obstacles. */
export function generateCoverBlocks(obstacles: Obstacle[] = []): CoverBlock[] {
  const covers: CoverBlock[] = [];
  const pairCount = randomInRange(1, 3);

  for (let i = 0; i < pairCount; i++) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const horizontal = Math.random() > 0.5;
      const long = randomInRange(40, 80);
      const narrow = randomInRange(8, 12);
      const w = horizontal ? long : narrow;
      const h = horizontal ? narrow : long;
      const x = randomInRange(50, MAP_WIDTH - 50 - w);
      const y = randomInRange(MAP_HEIGHT * 0.25, MAP_HEIGHT * 0.45 - h);

      const top = { x, y, w, h };
      const bottom = { x, y: MAP_HEIGHT - y - h, w, h };
      const blocked = [...obstacles, ...covers].some(
        obs => rectsOverlap(top, obs) || rectsOverlap(bottom, obs),
      );
      if (!blocked) {
        covers.push(top, bottom);
        break;
      }
    }
  }

  return covers;
}

// --- Horde-specific generators (player-side terrain only) ---

/** Generate 4-6 obstacles in the player's half (y: 0.40–0.80). No mirroring. */
export function generateHordeObstacles(): Obstacle[] {
  const obstacles: Obstacle[] = [];
  const count = randomInRange(4, 7); // 4-6

  for (let i = 0; i < count; i++) {
    const w = randomInRange(40, 100);
    const h = randomInRange(40, 100);
    const x = randomInRange(50, MAP_WIDTH - 50 - w);
    const y = randomInRange(MAP_HEIGHT * 0.40, MAP_HEIGHT * 0.80 - h);
    obstacles.push({ x, y, w, h });
  }

  return obstacles;
}

/** Generate 2-4 elevation zones in the player's half (y: 0.35–0.75). No mirroring. */
export function generateHordeElevationZones(): ElevationZone[] {
  const zones: ElevationZone[] = [];
  const count = randomInRange(2, 5); // 2-4

  for (let i = 0; i < count; i++) {
    const w = randomInRange(80, 160);
    const h = randomInRange(60, 120);
    const x = randomInRange(50, MAP_WIDTH - 50 - w);
    const y = randomInRange(MAP_HEIGHT * 0.35, MAP_HEIGHT * 0.75 - h);
    zones.push({ x, y, w, h });
  }

  return zones;
}

/** Generate 3-5 cover blocks in the player's half (y: 0.40–0.80), avoiding obstacles. */
export function generateHordeCoverBlocks(obstacles: Obstacle[] = []): CoverBlock[] {
  const covers: CoverBlock[] = [];
  const count = randomInRange(3, 6); // 3-5

  for (let i = 0; i < count; i++) {
    for (let attempt = 0; attempt < 10; attempt++) {
      const horizontal = Math.random() > 0.5;
      const long = randomInRange(40, 80);
      const narrow = randomInRange(8, 12);
      const w = horizontal ? long : narrow;
      const h = horizontal ? narrow : long;
      const x = randomInRange(50, MAP_WIDTH - 50 - w);
      const y = randomInRange(MAP_HEIGHT * 0.40, MAP_HEIGHT * 0.80 - h);

      const block = { x, y, w, h };
      const blocked = [...obstacles, ...covers].some(
        obs => rectsOverlap(block, obs),
      );
      if (!blocked) {
        covers.push(block);
        break;
      }
    }
  }

  return covers;
}
