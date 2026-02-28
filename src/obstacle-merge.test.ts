import { describe, it, expect } from 'vitest';
import { groupOverlapping, mergeObstacles } from './obstacle-merge';

describe('groupOverlapping', () => {
  it('returns each non-overlapping rect in its own group', () => {
    const rects = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 100, y: 100, w: 10, h: 10 },
    ];
    const groups = groupOverlapping(rects);
    expect(groups).toHaveLength(2);
    expect(groups[0]).toHaveLength(1);
    expect(groups[1]).toHaveLength(1);
  });

  it('groups two overlapping rects together', () => {
    const rects = [
      { x: 0, y: 0, w: 20, h: 20 },
      { x: 10, y: 10, w: 20, h: 20 },
    ];
    const groups = groupOverlapping(rects);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(2);
  });

  it('groups transitively overlapping rects (A overlaps B, B overlaps C)', () => {
    const rects = [
      { x: 0, y: 0, w: 20, h: 20 },
      { x: 15, y: 0, w: 20, h: 20 },
      { x: 30, y: 0, w: 20, h: 20 },
    ];
    const groups = groupOverlapping(rects);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(3);
  });

  it('returns empty array for empty input', () => {
    expect(groupOverlapping([])).toHaveLength(0);
  });

  it('handles single rect', () => {
    const groups = groupOverlapping([{ x: 0, y: 0, w: 10, h: 10 }]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveLength(1);
  });

  it('does not group rects that only share an edge (touching but not overlapping)', () => {
    const rects = [
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 10, y: 0, w: 10, h: 10 },
    ];
    const groups = groupOverlapping(rects);
    expect(groups).toHaveLength(2);
  });
});

describe('mergeObstacles', () => {
  it('returns 4 vertices for a single rect', () => {
    const result = mergeObstacles([{ x: 10, y: 20, w: 30, h: 40 }]);
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual([
      { x: 10, y: 20 },
      { x: 40, y: 20 },
      { x: 40, y: 60 },
      { x: 10, y: 60 },
    ]);
  });

  it('keeps non-overlapping rects as separate polygons', () => {
    const result = mergeObstacles([
      { x: 0, y: 0, w: 10, h: 10 },
      { x: 100, y: 100, w: 10, h: 10 },
    ]);
    expect(result).toHaveLength(2);
    expect(result[0]).toHaveLength(4);
    expect(result[1]).toHaveLength(4);
  });

  it('merges two diagonally overlapping rects into a notched shape (8 vertices)', () => {
    const result = mergeObstacles([
      { x: 0, y: 0, w: 20, h: 20 },
      { x: 10, y: 10, w: 20, h: 20 },
    ]);
    expect(result).toHaveLength(1);
    // Two rects overlapping at a diagonal create a shape with 2 concave corners
    expect(result[0]).toHaveLength(8);
    expect(result[0]).toEqual([
      { x: 0, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 30, y: 10 },
      { x: 30, y: 30 },
      { x: 10, y: 30 },
      { x: 10, y: 20 },
      { x: 0, y: 20 },
    ]);
  });

  it('merges two rects where one contains the other into 4 vertices', () => {
    const result = mergeObstacles([
      { x: 0, y: 0, w: 40, h: 40 },
      { x: 10, y: 10, w: 10, h: 10 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(4);
    expect(result[0]).toEqual([
      { x: 0, y: 0 },
      { x: 40, y: 0 },
      { x: 40, y: 40 },
      { x: 0, y: 40 },
    ]);
  });

  it('merges two side-by-side overlapping rects into a wider rect (4 vertices)', () => {
    const result = mergeObstacles([
      { x: 0, y: 0, w: 20, h: 10 },
      { x: 10, y: 0, w: 20, h: 10 },
    ]);
    expect(result).toHaveLength(1);
    expect(result[0]).toHaveLength(4);
    expect(result[0]).toEqual([
      { x: 0, y: 0 },
      { x: 30, y: 0 },
      { x: 30, y: 10 },
      { x: 0, y: 10 },
    ]);
  });

  it('returns empty array for empty input', () => {
    expect(mergeObstacles([])).toHaveLength(0);
  });
});
