import { describe, it, expect } from 'vitest';
import { createUnit, getElevationLevel, isOnElevation, isInRange, tryFireProjectile } from './units';
import { ElevationZone } from './types';
import { ELEVATION_RANGE_BONUS } from './constants';

const hillZone: ElevationZone = { x: 50, y: 50, w: 100, h: 100 };

describe('getElevationLevel', () => {
  it('returns 1 when point is inside one zone', () => {
    expect(getElevationLevel({ x: 100, y: 100 }, [hillZone])).toBe(1);
  });

  it('returns 1 on zone boundary', () => {
    expect(getElevationLevel({ x: 50, y: 50 }, [hillZone])).toBe(1);
    expect(getElevationLevel({ x: 150, y: 150 }, [hillZone])).toBe(1);
  });

  it('returns 0 when point is outside zone', () => {
    expect(getElevationLevel({ x: 200, y: 200 }, [hillZone])).toBe(0);
  });

  it('returns 0 with empty zones', () => {
    expect(getElevationLevel({ x: 100, y: 100 }, [])).toBe(0);
  });

  it('returns 2 when point is in two overlapping zones', () => {
    const zone1: ElevationZone = { x: 0, y: 0, w: 100, h: 100 };
    const zone2: ElevationZone = { x: 50, y: 50, w: 100, h: 100 };
    expect(getElevationLevel({ x: 75, y: 75 }, [zone1, zone2])).toBe(2);
  });
});

describe('isOnElevation (backward compat)', () => {
  it('returns true when point is inside zone', () => {
    expect(isOnElevation({ x: 100, y: 100 }, [hillZone])).toBe(true);
  });

  it('returns false when point is outside zone', () => {
    expect(isOnElevation({ x: 200, y: 200 }, [hillZone])).toBe(false);
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

  it('applies stacking bonus with two overlapping zones', () => {
    const zone1: ElevationZone = { x: 0, y: 0, w: 50, h: 50 };
    const zone2: ElevationZone = { x: 0, y: 0, w: 50, h: 50 };
    const attacker = createUnit('a1', 'soldier', 'blue', { x: 25, y: 25 });
    // Double bonus: range * (1 + 0.2 * 2) = range * 1.4
    const stackedMax = attacker.range * (1 + ELEVATION_RANGE_BONUS * 2) + attacker.radius + 10;
    const singleMax = attacker.range * (1 + ELEVATION_RANGE_BONUS) + attacker.radius + 10;
    const dist = (singleMax + stackedMax) / 2; // between single and stacked max
    const target = createUnit('t1', 'soldier', 'red', { x: 25 + dist, y: 25 });

    // Out of range with single zone, in range with two
    expect(isInRange(attacker, target, [zone1])).toBe(false);
    expect(isInRange(attacker, target, [zone1, zone2])).toBe(true);
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

  it('stacks maxRange with two overlapping zones', () => {
    const zone1: ElevationZone = { x: 0, y: 0, w: 200, h: 200 };
    const zone2: ElevationZone = { x: 0, y: 0, w: 200, h: 200 };
    const attacker = createUnit('a1', 'soldier', 'blue', { x: 100, y: 100 });
    const target = createUnit('t1', 'soldier', 'red', { x: 200, y: 100 });
    attacker.fireTimer = 0;

    const projSingle = tryFireProjectile(attacker, target, 0.016, [zone1]);
    attacker.fireTimer = 0;
    const projDouble = tryFireProjectile(attacker, target, 0.016, [zone1, zone2]);

    expect(projSingle).not.toBeNull();
    expect(projDouble).not.toBeNull();
    expect(projDouble!.maxRange).toBeGreaterThan(projSingle!.maxRange);
  });
});
