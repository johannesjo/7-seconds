import { Obstacle, Vec2 } from './types';

function rectsOverlap(a: Obstacle, b: Obstacle): boolean {
  return a.x < b.x + b.w && a.x + a.w > b.x &&
         a.y < b.y + b.h && a.y + a.h > b.y;
}

/** Group overlapping obstacles using union-find. */
export function groupOverlapping(obstacles: Obstacle[]): Obstacle[][] {
  if (obstacles.length === 0) return [];

  const parent = obstacles.map((_, i) => i);

  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  }

  function union(a: number, b: number): void {
    parent[find(a)] = find(b);
  }

  for (let i = 0; i < obstacles.length; i++) {
    for (let j = i + 1; j < obstacles.length; j++) {
      if (rectsOverlap(obstacles[i], obstacles[j])) {
        union(i, j);
      }
    }
  }

  const groups = new Map<number, Obstacle[]>();
  for (let i = 0; i < obstacles.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(obstacles[i]);
  }

  return [...groups.values()];
}

/** Compute union polygons for overlapping obstacle groups. */
export function mergeObstacles(obstacles: Obstacle[]): Vec2[][] {
  if (obstacles.length === 0) return [];

  const groups = groupOverlapping(obstacles);
  return groups.map(group => computeUnionPolygon(group));
}

function computeUnionPolygon(rects: Obstacle[]): Vec2[] {
  const xs = [...new Set(rects.flatMap(r => [r.x, r.x + r.w]))].sort((a, b) => a - b);
  const ys = [...new Set(rects.flatMap(r => [r.y, r.y + r.h]))].sort((a, b) => a - b);

  const W = xs.length - 1;
  const H = ys.length - 1;

  const grid: boolean[][] = [];
  for (let i = 0; i < W; i++) {
    grid[i] = [];
    for (let j = 0; j < H; j++) {
      const cx = (xs[i] + xs[i + 1]) / 2;
      const cy = (ys[j] + ys[j + 1]) / 2;
      grid[i][j] = rects.some(r =>
        cx >= r.x && cx < r.x + r.w && cy >= r.y && cy < r.y + r.h
      );
    }
  }

  return traceBoundary(grid, xs, ys);
}

function traceBoundary(grid: boolean[][], xs: number[], ys: number[]): Vec2[] {
  const W = xs.length - 1;
  const H = ys.length - 1;

  const isFilled = (i: number, j: number): boolean =>
    i >= 0 && i < W && j >= 0 && j < H && grid[i][j];

  const edgeMap = new Map<string, Vec2>();
  const key = (x: number, y: number) => `${x},${y}`;

  for (let i = 0; i < W; i++) {
    for (let j = 0; j < H; j++) {
      if (!grid[i][j]) continue;

      // Top edge: filled cell with nothing above
      if (!isFilled(i, j - 1)) {
        edgeMap.set(key(xs[i], ys[j]), { x: xs[i + 1], y: ys[j] });
      }
      // Right edge: filled cell with nothing to the right
      if (!isFilled(i + 1, j)) {
        edgeMap.set(key(xs[i + 1], ys[j]), { x: xs[i + 1], y: ys[j + 1] });
      }
      // Bottom edge: filled cell with nothing below
      if (!isFilled(i, j + 1)) {
        edgeMap.set(key(xs[i + 1], ys[j + 1]), { x: xs[i], y: ys[j + 1] });
      }
      // Left edge: filled cell with nothing to the left
      if (!isFilled(i - 1, j)) {
        edgeMap.set(key(xs[i], ys[j + 1]), { x: xs[i], y: ys[j] });
      }
    }
  }

  const startKey = edgeMap.keys().next().value!;
  const [sx, sy] = startKey.split(',').map(Number);
  const polygon: Vec2[] = [{ x: sx, y: sy }];
  let current = edgeMap.get(startKey)!;

  while (key(current.x, current.y) !== startKey) {
    polygon.push({ x: current.x, y: current.y });
    current = edgeMap.get(key(current.x, current.y))!;
  }

  return simplifyPolygon(polygon);
}

function simplifyPolygon(points: Vec2[]): Vec2[] {
  const n = points.length;
  const result: Vec2[] = [];
  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];
    const collinear =
      (prev.x === curr.x && curr.x === next.x) ||
      (prev.y === curr.y && curr.y === next.y);
    if (!collinear) result.push(curr);
  }
  return result;
}
