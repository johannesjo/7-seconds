import { describe, it, expect, vi } from 'vitest';
import { generateBattlefield, generateHordeObstacles, generateHordeElevationZones, generateCtfObstacles, generateCtfElevationZones } from './battlefield';
import { MAP_WIDTH, MAP_HEIGHT, CTF_BASE_ZONE_WIDTH, setMapSize, UNIT_STATS } from './constants';
import { advanceWaypoint, createUnit, moveUnit } from './units';

describe('generateBattlefield', () => {
  it('selects one of three distinct standard layouts', () => {
    const random = vi.spyOn(Math, 'random');
    try {
      const layouts = [0, 0.4, 0.8].map(value => {
        random.mockReturnValue(value);
        return generateBattlefield();
      });
      expect(new Set(layouts.map(layout => JSON.stringify(layout))).size).toBe(3);
      for (let index = 0; index < 3; index++) expect(layouts[index]).toEqual(generateBattlefield(index));
    } finally {
      random.mockRestore();
    }
  });

  it('keeps terrain fair, clear of spawns, and reachable by the largest unit at both map sizes', () => {
    const originalSize = [MAP_WIDTH, MAP_HEIGHT] as const;
    const radius = Math.max(...Object.values(UNIT_STATS).map(stats => stats.radius));
    const step = 10;
    try {
      for (const [width, height] of [[360, 620], [1000, 1000]] as const) {
        setMapSize(width, height);
        for (let index = 0; index < 3; index++) {
          const { obstacles, elevationZones } = generateBattlefield(index);
          for (const rects of [obstacles, elevationZones]) {
            for (const rect of rects) {
              expect(rect.x).toBeGreaterThanOrEqual(0);
              expect(rect.x + rect.w).toBeLessThanOrEqual(width);
              expect(rect.y).toBeGreaterThanOrEqual(height * 0.16);
              expect(rect.y + rect.h).toBeLessThanOrEqual(height * 0.84);
              expect(rects.some(other => other.x === rect.x && other.w === rect.w &&
                other.h === rect.h && Math.abs(other.y - (height - rect.y - rect.h)) < 0.001)).toBe(true);
            }
          }
          for (const [hillIndex, hill] of elevationZones.entries()) {
            expect(obstacles.some(block => block.x < hill.x + hill.w && block.x + block.w > hill.x &&
              block.y < hill.y + hill.h && block.y + block.h > hill.y)).toBe(false);
            expect(elevationZones.some((other, otherIndex) => otherIndex !== hillIndex &&
              other.x < hill.x + hill.w && other.x + other.w > hill.x &&
              other.y < hill.y + hill.h && other.y + other.h > hill.y)).toBe(false);
          }

          const cols = Math.floor((width - 2 * radius) / step) + 1;
          const rows = Math.floor((height - 2 * radius) / step) + 1;
          const cell = (x: number, y: number) => {
            const col = Math.round((x - radius) / step);
            const row = Math.round((y - radius) / step);
            return row * cols + col;
          };
          const open = (at: number) => {
            const x = radius + (at % cols) * step;
            const y = radius + Math.floor(at / cols) * step;
            return !obstacles.some(o => x > o.x - radius && x < o.x + o.w + radius &&
              y > o.y - radius && y < o.y + o.h + radius);
          };
          const reachable = (start: number) => {
            const seen = new Uint8Array(cols * rows);
            const queue = [start];
            seen[start] = 1;
            for (let head = 0; head < queue.length; head++) {
              const at = queue[head];
              const col = at % cols;
              const row = Math.floor(at / cols);
              for (const next of [col > 0 ? at - 1 : -1, col < cols - 1 ? at + 1 : -1,
                row > 0 ? at - cols : -1, row < rows - 1 ? at + cols : -1]) {
                if (next >= 0 && !seen[next] && open(next)) {
                  seen[next] = 1;
                  queue.push(next);
                }
              }
            }
            return seen;
          };
          const destinations = [cell(radius + step, height / 2),
            cell(width - radius - step, height / 2),
            ...elevationZones.map(hill => cell(hill.x + hill.w / 2, hill.y + hill.h / 2))];
          for (const spawnY of [height * 0.08, height * 0.92]) {
            const spawn = cell(width / 2, spawnY);
            expect(open(spawn)).toBe(true);
            const seen = reachable(spawn);
            for (const destination of destinations) expect(seen[destination]).toBe(1);
            expect(seen[cell(width / 2, height - spawnY)]).toBe(1);
          }
        }
      }
    } finally {
      setMapSize(...originalSize);
    }
  });

  it('lets a blade follow both outer lanes with actual movement and edge steering', () => {
    const originalSize = [MAP_WIDTH, MAP_HEIGHT] as const;
    try {
      for (const [width, height] of [[360, 620], [1000, 1000]] as const) {
        setMapSize(width, height);
        for (let layout = 0; layout < 3; layout++) {
          const { obstacles } = generateBattlefield(layout);
          for (const x of [27, width - 27]) {
            for (const fromBottom of [true, false]) {
              const startY = height * (fromBottom ? 0.82 : 0.18);
              const targetY = height * (fromBottom ? 0.18 : 0.82);
              const blade = createUnit('flanker', 'blade', fromBottom ? 'blue' : 'red', { x, y: startY });
              blade.waypoints = [{ x, y: targetY }];
              for (let tick = 0; tick < 1200; tick++) {
                advanceWaypoint(blade, 1 / 60);
                moveUnit(blade, 1 / 60, obstacles);
                if (Math.abs(blade.pos.y - targetY) < 4) break;
              }
              expect(Math.abs(blade.pos.y - targetY)).toBeLessThan(4);
            }
          }
        }
      }
    } finally {
      setMapSize(...originalSize);
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
  it('generates symmetrical obstacles (mirrored top-bottom)', () => {
    const obstacles = generateCtfObstacles();
    expect(obstacles.length).toBeGreaterThanOrEqual(2);
    for (const obs of obstacles) {
      const mirrorY = MAP_HEIGHT - obs.y - obs.h;
      const hasMirror = obstacles.some(o =>
        Math.abs(o.x - obs.x) < 1 && Math.abs(o.y - mirrorY) < 1 &&
        Math.abs(o.w - obs.w) < 1 && Math.abs(o.h - obs.h) < 1
      );
      const isCentered = Math.abs(obs.y + obs.h / 2 - MAP_HEIGHT / 2) < 1;
      expect(hasMirror || isCentered).toBe(true);
    }
  });

  it('keeps obstacles out of base zones', () => {
    for (let i = 0; i < 10; i++) {
      const obstacles = generateCtfObstacles();
      for (const obs of obstacles) {
        expect(obs.y + obs.h).toBeGreaterThan(CTF_BASE_ZONE_WIDTH);
        expect(obs.y).toBeLessThan(MAP_HEIGHT - CTF_BASE_ZONE_WIDTH);
      }
    }
  });
});

describe('generateCtfElevationZones', () => {
  it('generates symmetrical elevation zones (mirrored top-bottom)', () => {
    const zones = generateCtfElevationZones();
    expect(zones.length).toBeGreaterThanOrEqual(2);
    for (const z of zones) {
      const mirrorY = MAP_HEIGHT - z.y - z.h;
      const hasMirror = zones.some(o =>
        Math.abs(o.x - z.x) < 1 && Math.abs(o.y - mirrorY) < 1 &&
        Math.abs(o.w - z.w) < 1 && Math.abs(o.h - z.h) < 1
      );
      const isCentered = Math.abs(z.y + z.h / 2 - MAP_HEIGHT / 2) < 1;
      expect(hasMirror || isCentered).toBe(true);
    }
  });
});
