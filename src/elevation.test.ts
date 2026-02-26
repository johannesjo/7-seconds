import { describe, it, expect } from 'vitest';
import { createUnit, isOnElevation, isInRange, tryFireProjectile } from './units';
import { ElevationZone } from './types';
import { ELEVATION_RANGE_BONUS } from './constants';

const hillZone: ElevationZone = { x: 50, y: 50, w: 100, h: 100 };

describe('isOnElevation', () => {
  it('returns true when point is inside zone', () => {
    expect(isOnElevation({ x: 100, y: 100 }, [hillZone])).toBe(true);
  });

  it('returns true on zone boundary', () => {
    expect(isOnElevation({ x: 50, y: 50 }, [hillZone])).toBe(true);
    expect(isOnElevation({ x: 150, y: 150 }, [hillZone])).toBe(true);
  });

  it('returns false when point is outside zone', () => {
    expect(isOnElevation({ x: 200, y: 200 }, [hillZone])).toBe(false);
  });

  it('returns false with empty zones', () => {
    expect(isOnElevation({ x: 100, y: 100 }, [])).toBe(false);
  });
});

describe('isInRange with elevation', () => {
  it('uses base range without elevation', () => {
    const attacker = createUnit('a1', 'soldier', 'blue', { x: 0, y: 0 });
    // soldier: range=100, radius=10. Distance must exceed range + both radii = 120
    const target = createUnit('t1', 'soldier', 'red', { x: 121, y: 0 });
    expect(isInRange(attacker, target)).toBe(false);
    expect(isInRange(attacker, target, [])).toBe(false);
  });

  it('applies elevation bonus when attacker is on hill', () => {
    const zone: ElevationZone = { x: 0, y: 0, w: 50, h: 50 };
    const attacker = createUnit('a1', 'soldier', 'blue', { x: 25, y: 25 });
    // Place target just outside base range but within elevated range
    const baseMax = attacker.range + attacker.radius + 10; // 10 = target radius
    const elevatedMax = attacker.range * (1 + ELEVATION_RANGE_BONUS) + attacker.radius + 10;
    const dist = (baseMax + elevatedMax) / 2; // between base and elevated max
    const target = createUnit('t1', 'soldier', 'red', { x: 25 + dist, y: 25 });

    expect(isInRange(attacker, target)).toBe(false);
    expect(isInRange(attacker, target, [zone])).toBe(true);
  });

  it('does not apply bonus when attacker is off hill', () => {
    const zone: ElevationZone = { x: 500, y: 500, w: 50, h: 50 };
    const attacker = createUnit('a1', 'soldier', 'blue', { x: 0, y: 0 });
    const target = createUnit('t1', 'soldier', 'red', { x: attacker.range + attacker.radius + 10 + 5, y: 0 });
    // Slightly beyond base range, zone is far away
    expect(isInRange(attacker, target, [zone])).toBe(false);
  });
});

describe('tryFireProjectile with elevation', () => {
  it('produces projectile with elevated maxRange when on hill', () => {
    const zone: ElevationZone = { x: 0, y: 0, w: 200, h: 200 };
    const attacker = createUnit('a1', 'soldier', 'blue', { x: 100, y: 100 });
    const target = createUnit('t1', 'soldier', 'red', { x: 200, y: 100 });
    attacker.fireTimer = 0;

    const projBase = tryFireProjectile(attacker, target, 0.016);
    attacker.fireTimer = 0;
    const projElevated = tryFireProjectile(attacker, target, 0.016, [zone]);

    expect(projBase).not.toBeNull();
    expect(projElevated).not.toBeNull();
    expect(projElevated!.maxRange).toBeGreaterThan(projBase!.maxRange);
  });

  it('uses base maxRange when off hill', () => {
    const zone: ElevationZone = { x: 500, y: 500, w: 50, h: 50 };
    const attacker = createUnit('a1', 'soldier', 'blue', { x: 100, y: 100 });
    const target = createUnit('t1', 'soldier', 'red', { x: 200, y: 100 });
    attacker.fireTimer = 0;

    const projBase = tryFireProjectile(attacker, target, 0.016);
    attacker.fireTimer = 0;
    const projFarZone = tryFireProjectile(attacker, target, 0.016, [zone]);

    expect(projBase!.maxRange).toBe(projFarZone!.maxRange);
  });
});
