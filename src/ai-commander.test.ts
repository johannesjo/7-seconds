import { describe, it, expect, vi } from 'vitest';

vi.mock('@mlc-ai/web-llm', () => ({
  CreateMLCEngine: vi.fn(),
}));

import { serializeState, parseAiResponse, fallbackOrders } from './ai-commander';
import { createUnit } from './units';
import { Obstacle } from './types';

describe('serializeState', () => {
  it('serializes units and obstacles for a team', () => {
    const units = [
      createUnit('blue_scout_0', 'scout', 'blue', { x: 100, y: 200 }),
      createUnit('red_soldier_0', 'soldier', 'red', { x: 800, y: 300 }),
    ];
    const obstacles: Obstacle[] = [{ x: 400, y: 200, w: 80, h: 120 }];

    const result = serializeState(units, obstacles, 'blue');
    const parsed = JSON.parse(result);

    expect(parsed.my_units).toHaveLength(1);
    expect(parsed.my_units[0].id).toBe('blue_scout_0');
    expect(parsed.enemy_units).toHaveLength(1);
    expect(parsed.enemy_units[0].id).toBe('red_soldier_0');
    // obstacles disabled: expect(parsed.obstacles).toHaveLength(1);
  });

  it('excludes dead units', () => {
    const units = [
      createUnit('blue_scout_0', 'scout', 'blue', { x: 100, y: 200 }),
      createUnit('red_soldier_0', 'soldier', 'red', { x: 800, y: 300 }),
    ];
    units[1].alive = false;

    const result = serializeState(units, [], 'blue');
    const parsed = JSON.parse(result);

    expect(parsed.enemy_units).toHaveLength(0);
  });
});

describe('parseAiResponse', () => {
  it('parses valid JSON response', () => {
    const json = JSON.stringify({
      orders: [
        { id: 'scout_1', move_to: [500, 100], attack: 'e_soldier_1' },
        { id: 'tank_1', move_to: [400, 400], attack: null },
      ],
    });

    const result = parseAiResponse(json);
    expect(result).not.toBeNull();
    expect(result!.orders).toHaveLength(2);
    expect(result!.orders[0].move_to).toEqual([500, 100]);
  });

  it('returns null for malformed JSON', () => {
    expect(parseAiResponse('not json')).toBeNull();
    expect(parseAiResponse('{"orders": "bad"}')).toBeNull();
    expect(parseAiResponse('{}')).toBeNull();
  });

  it('filters out orders with invalid structure', () => {
    const json = JSON.stringify({
      orders: [
        { id: 'scout_1', move_to: [500, 100], attack: null },
        { id: 'tank_1', move_to: 'bad' },
        { move_to: [100, 100] },
      ],
    });

    const result = parseAiResponse(json);
    expect(result).not.toBeNull();
    expect(result!.orders).toHaveLength(1);
  });
});

describe('fallbackOrders', () => {
  it('orders all units toward the center of the map', () => {
    const units = [
      createUnit('blue_scout_0', 'scout', 'blue', { x: 100, y: 200 }),
      createUnit('blue_tank_0', 'tank', 'blue', { x: 100, y: 400 }),
    ];

    const orders = fallbackOrders(units, 'blue');
    expect(orders.orders).toHaveLength(2);
    orders.orders.forEach(o => {
      expect(o.move_to[0]).toBeGreaterThan(100);
    });
  });
});
