import { Obstacle, ElevationZone } from './types';
import { MAP_WIDTH, MAP_HEIGHT, CTF_BASE_ZONE_WIDTH } from './constants';

function randomInRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min)) + min;
}

// [horizontal center, vertical center, width, height]. Sizes are tuned at 360x620;
// the capped scale keeps cover useful without filling a wide battlefield.
type LayoutRect = readonly [number, number, number, number];
const STANDARD_LAYOUTS: ReadonlyArray<{ obstacles: readonly LayoutRect[]; elevationZones: readonly LayoutRect[] }> = [
  // Central barricade: advance behind cover or take either exposed side hill.
  {
    obstacles: [[0.5, 0.5, 70, 52], [0.5, 0.32, 54, 40]],
    elevationZones: [[0.22, 0.36, 100, 70], [0.78, 0.36, 100, 70]],
  },
  // Split gates: the middle hill is valuable, but both outer lanes bypass it.
  {
    obstacles: [[0.31, 0.5, 40, 86], [0.69, 0.5, 40, 86], [0.5, 0.28, 52, 40]],
    elevationZones: [[0.5, 0.5, 90, 72]],
  },
  // Offset positions: side cover protects approaches to hills; the center stays open.
  {
    obstacles: [[0.31, 0.43, 45, 42], [0.69, 0.31, 45, 42]],
    elevationZones: [[0.22, 0.32, 100, 65], [0.78, 0.42, 100, 65]],
  },
];

/** A coherent standard battlefield, mirrored so each team has the same routes. */
export function generateBattlefield(layoutIndex = Math.floor(Math.random() * STANDARD_LAYOUTS.length)):
  { obstacles: Obstacle[]; elevationZones: ElevationZone[] } {
  const layout = STANDARD_LAYOUTS[layoutIndex];
  if (!layout) throw new RangeError(`Unknown battlefield layout: ${layoutIndex}`);

  const scale = Math.min(MAP_WIDTH / 360, MAP_HEIGHT / 620);
  const expand = (rects: readonly LayoutRect[]): Obstacle[] => rects.flatMap(([cx, cy, baseW, baseH]) => {
    const w = baseW * scale;
    const h = baseH * scale;
    const x = cx * MAP_WIDTH - w / 2;
    const y = cy * MAP_HEIGHT - h / 2;
    const rect = { x, y, w, h };
    return cy === 0.5 ? [rect] : [rect, { ...rect, y: MAP_HEIGHT - y - h }];
  });
  return { obstacles: expand(layout.obstacles), elevationZones: expand(layout.elevationZones) };
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

/** Generate 2-4 elevation zones in the player's half. Always one near spawn. */
export function generateHordeElevationZones(): ElevationZone[] {
  const zones: ElevationZone[] = [];

  // Guaranteed zone near player spawn (bottom area, y: 0.75–0.85)
  const spawnW = randomInRange(100, 180);
  const spawnH = randomInRange(60, 80);
  const spawnX = randomInRange(50, MAP_WIDTH - 50 - spawnW);
  const spawnYMin = Math.round(MAP_HEIGHT * 0.75);
  const spawnYMax = Math.round(MAP_HEIGHT * 0.85) - spawnH;
  const spawnY = randomInRange(spawnYMin, Math.max(spawnYMin + 1, spawnYMax));
  zones.push({ x: spawnX, y: spawnY, w: spawnW, h: spawnH });

  // 1-3 additional zones further up (y: 0.30–0.70)
  const extra = randomInRange(1, 4); // 1-3
  for (let i = 0; i < extra; i++) {
    const w = randomInRange(80, 160);
    const h = randomInRange(60, 120);
    const x = randomInRange(50, MAP_WIDTH - 50 - w);
    const y = randomInRange(MAP_HEIGHT * 0.30, MAP_HEIGHT * 0.70 - h);
    zones.push({ x, y, w, h });
  }

  return zones;
}

// --- CTF-specific generators (top-bottom symmetry) ---

/** Generate symmetrical obstacles for CTF mode (mirrored top-bottom). */
export function generateCtfObstacles(): Obstacle[] {
  const obstacles: Obstacle[] = [];
  const pairCount = randomInRange(2, 4); // 2-3 pairs
  const safeZone = CTF_BASE_ZONE_WIDTH + 20;

  for (let i = 0; i < pairCount; i++) {
    const w = randomInRange(30, 60);
    const h = randomInRange(30, 60);
    const x = randomInRange(MAP_WIDTH * 0.15, MAP_WIDTH * 0.85 - w);
    const y = randomInRange(safeZone, MAP_HEIGHT / 2 - h / 2);

    obstacles.push({ x, y, w, h });
    obstacles.push({ x, y: MAP_HEIGHT - y - h, w, h });
  }

  return obstacles;
}

/** Generate symmetrical elevation zones for CTF mode (mirrored top-bottom). */
export function generateCtfElevationZones(): ElevationZone[] {
  const zones: ElevationZone[] = [];
  const pairCount = randomInRange(1, 3); // 1-2 pairs
  const safeZone = CTF_BASE_ZONE_WIDTH + 10;

  for (let i = 0; i < pairCount; i++) {
    const w = randomInRange(80, 160);
    const h = randomInRange(60, 120);
    const x = randomInRange(MAP_WIDTH * 0.15, MAP_WIDTH * 0.85 - w);
    const y = randomInRange(safeZone, MAP_HEIGHT / 2 - h / 2);

    zones.push({ x, y, w, h });
    zones.push({ x, y: MAP_HEIGHT - y - h, w, h });
  }

  return zones;
}
