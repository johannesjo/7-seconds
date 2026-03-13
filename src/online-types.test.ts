import { describe, it, expect } from 'vitest';
import type { OnlineGameState, OnlinePathData, OnlineConnectionState } from './online-types';

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

describe('OnlineConnectionState', () => {
  it('covers all expected connection states', () => {
    const states: OnlineConnectionState[] = [
      'idle', 'waiting', 'connecting', 'connected', 'reconnecting', 'disconnected', 'error',
    ];

    expect(states).toHaveLength(7);
    expect(new Set(states).size).toBe(7);
  });
});
