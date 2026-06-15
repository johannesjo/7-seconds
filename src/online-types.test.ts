import { describe, it, expect } from 'vitest';
import type { OnlineGameState, OnlinePathData, OnlineConnectionState } from './online-types';
import { isPlausibleGameState, MAX_ONLINE_UNITS, MAX_ONLINE_OBSTACLES } from './online-types';

function makeState(over: Partial<OnlineGameState> = {}): OnlineGameState {
  return {
    units: [{ id: 'u1', type: 'soldier', team: 'blue', x: 1, y: 1, hp: 100, maxHp: 100, radius: 6, speed: 100, range: 120, gunAngle: 0 }],
    obstacles: [],
    elevationZones: [],
    mapWidth: 600,
    mapHeight: 400,
    ...over,
  };
}

describe('OnlineGameState', () => {
  it('has all required fields and serializes to JSON', () => {
    const state: OnlineGameState = {
      units: [
        { id: 'u1', type: 'soldier', team: 'blue', x: 10, y: 20, hp: 100, maxHp: 100, radius: 6, speed: 100, range: 120, gunAngle: -Math.PI / 2 },
      ],
      obstacles: [{ x: 50, y: 50, w: 30, h: 30 }],
      elevationZones: [{ x: 100, y: 100, w: 40, h: 40 }],
      mapWidth: 600,
      mapHeight: 400,
    };

    const json = JSON.parse(JSON.stringify(state));
    expect(json.units).toHaveLength(1);
    expect(json.units[0].id).toBe('u1');
    expect(json.obstacles).toHaveLength(1);
    expect(json.elevationZones).toHaveLength(1);
    expect(json.mapWidth).toBe(600);
    expect(json.mapHeight).toBe(400);
  });
});

describe('OnlinePathData', () => {
  it('serializes path data with waypoints correctly', () => {
    const pathData: OnlinePathData = {
      paths: [
        { unitId: 'u1', waypoints: [{ x: 0, y: 0 }, { x: 50, y: 50 }] },
        { unitId: 'u2', waypoints: [{ x: 10, y: 10 }] },
      ],
    };

    const json = JSON.parse(JSON.stringify(pathData));
    expect(json.paths).toHaveLength(2);
    expect(json.paths[0].waypoints).toEqual([{ x: 0, y: 0 }, { x: 50, y: 50 }]);
    expect(json.paths[1].unitId).toBe('u2');
  });
});

describe('isPlausibleGameState', () => {
  it('accepts a normal snapshot', () => {
    expect(isPlausibleGameState(makeState())).toBe(true);
  });

  it('rejects null/undefined', () => {
    expect(isPlausibleGameState(null)).toBe(false);
    expect(isPlausibleGameState(undefined)).toBe(false);
  });

  it('rejects oversized arrays from a malicious/buggy peer', () => {
    const hugeUnits = makeState({ units: new Array(MAX_ONLINE_UNITS + 1).fill(makeState().units[0]) });
    expect(isPlausibleGameState(hugeUnits)).toBe(false);
    const hugeObstacles = makeState({ obstacles: new Array(MAX_ONLINE_OBSTACLES + 1).fill({ x: 0, y: 0, w: 1, h: 1 }) });
    expect(isPlausibleGameState(hugeObstacles)).toBe(false);
  });

  it('rejects non-finite or non-positive map dimensions', () => {
    expect(isPlausibleGameState(makeState({ mapWidth: 0 }))).toBe(false);
    expect(isPlausibleGameState(makeState({ mapHeight: NaN }))).toBe(false);
    expect(isPlausibleGameState(makeState({ mapWidth: Infinity }))).toBe(false);
  });

  it('rejects missing arrays', () => {
    expect(isPlausibleGameState(makeState({ units: undefined as unknown as OnlineGameState['units'] }))).toBe(false);
  });
});

describe('OnlineConnectionState', () => {
  it('covers all expected connection states', () => {
    const states: OnlineConnectionState[] = [
      'idle', 'waiting', 'connecting', 'connected', 'reconnecting', 'disconnected', 'error',
    ];

    expect(states).toHaveLength(7);
    expect(new Set(states).size).toBe(7);
  });
});
