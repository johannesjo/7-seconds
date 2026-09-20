import { describe, expect, it } from 'vitest';
import { splitPathAtDistance } from './path-preview';

const route = [{ x: 0, y: 0 }, { x: 30, y: 0 }, { x: 30, y: 40 }];

describe('splitPathAtDistance', () => {
  it('places the round-end marker after a bend and preserves the rest of the route', () => {
    expect(splitPathAtDistance(route, 50)).toEqual({
      reached: [route[0], route[1], { x: 30, y: 20 }],
      remainder: [{ x: 30, y: 20 }, route[2]],
      position: { x: 30, y: 20 },
    });
  });

  it('uses the destination when the whole route is reachable', () => {
    expect(splitPathAtDistance(route, 70)).toEqual({
      reached: route,
      remainder: [],
      position: route[2],
    });
  });

  it('handles a cut exactly at a waypoint', () => {
    expect(splitPathAtDistance(route, 30)).toEqual({
      reached: [route[0], route[1]],
      remainder: [route[1], route[2]],
      position: route[1],
    });
  });
});
