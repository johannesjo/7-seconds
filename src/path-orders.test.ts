import { describe, it, expect } from 'vitest';
import { samplePath, clampPathLength } from './path-orders';

describe('samplePath', () => {
  it('drops points closer than the spacing but keeps the release point', () => {
    const raw = [{ x: 0, y: 0 }, { x: 5, y: 0 }, { x: 20, y: 0 }, { x: 25, y: 0 }];
    expect(samplePath(raw, 18)).toEqual([{ x: 0, y: 0 }, { x: 20, y: 0 }, { x: 25, y: 0 }]);
  });

  it('handles empty and single-point strokes', () => {
    expect(samplePath([], 18)).toEqual([]);
    expect(samplePath([{ x: 1, y: 1 }], 18)).toEqual([{ x: 1, y: 1 }]);
  });
});

describe('clampPathLength', () => {
  const start = { x: 0, y: 0 };

  it('keeps a path that fits', () => {
    const path = [{ x: 30, y: 0 }, { x: 30, y: 40 }];
    expect(clampPathLength(path, start, 70)).toEqual(path);
  });

  it('cuts mid-segment at exactly the maximum length', () => {
    expect(clampPathLength([{ x: 30, y: 0 }, { x: 30, y: 40 }], start, 50)).toEqual([{ x: 30, y: 0 }, { x: 30, y: 20 }]);
  });

  it('measures from the start point, not the first path point', () => {
    expect(clampPathLength([{ x: 100, y: 0 }], start, 60)).toEqual([{ x: 60, y: 0 }]);
  });
});
