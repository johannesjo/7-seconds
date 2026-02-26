import { describe, it, expect } from 'vitest';
import { createUnit, createArmy, moveUnit, findTarget, applyDamage, tryFireProjectile, updateProjectiles, segmentHitsRect, detourWaypoints } from './units';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';


describe('createUnit', () => {
  it('creates a scout with correct stats', () => {
    const unit = createUnit('scout_1', 'scout', 'blue', { x: 100, y: 200 });
    expect(unit.type).toBe('scout');
    expect(unit.hp).toBe(30);
    expect(unit.maxHp).toBe(30);
    expect(unit.speed).toBe(180);
    expect(unit.damage).toBe(5);
    expect(unit.range).toBe(30);
    expect(unit.alive).toBe(true);
    expect(unit.pos).toEqual({ x: 100, y: 200 });
    expect(unit.team).toBe('blue');
  });

  it('creates a tank with correct stats', () => {
    const unit = createUnit('tank_1', 'tank', 'red', { x: 500, y: 300 });
    expect(unit.hp).toBe(120);
    expect(unit.speed).toBe(60);
    expect(unit.damage).toBe(20);
  });
});

describe('createArmy', () => {
  it('creates 4 units for blue team on the bottom side', () => {
    const units = createArmy('blue');
    expect(units).toHaveLength(4);
    expect(units.filter(u => u.type === 'soldier')).toHaveLength(3);
    expect(units.filter(u => u.type === 'sniper')).toHaveLength(1);
    units.forEach(u => {
      expect(u.team).toBe('blue');
      expect(u.pos.y).toBeGreaterThan(MAP_HEIGHT * 2 / 3);
    });
  });

  it('creates 4 units for red team on the top side', () => {
    const units = createArmy('red');
    expect(units).toHaveLength(4);
    units.forEach(u => {
      expect(u.team).toBe('red');
      expect(u.pos.y).toBeLessThan(MAP_HEIGHT / 3);
    });
  });
});

describe('moveUnit', () => {
  it('moves unit toward its target', () => {
    const unit = createUnit('s1', 'scout', 'blue', { x: 100, y: 100 });
    unit.moveTarget = { x: 300, y: 100 };
    moveUnit(unit, 1, []);
    expect(unit.pos.x).toBeGreaterThan(100);
    expect(unit.pos.y).toBeCloseTo(100, 1);
  });

  it('does not move past its target', () => {
    const unit = createUnit('s1', 'scout', 'blue', { x: 100, y: 100 });
    unit.moveTarget = { x: 110, y: 100 };
    moveUnit(unit, 1, []);
    expect(unit.pos.x).toBeCloseTo(110, 1);
  });

  it('does nothing without a target', () => {
    const unit = createUnit('s1', 'scout', 'blue', { x: 50, y: 50 });
    moveUnit(unit, 1, []);
    expect(unit.pos).toEqual({ x: 50, y: 50 });
  });
});

describe('findTarget', () => {
  it('returns nearest enemy of preferred type', () => {
    const attacker = createUnit('s1', 'scout', 'blue', { x: 100, y: 100 });
    const enemy1 = createUnit('e1', 'soldier', 'red', { x: 200, y: 100 });
    const enemy2 = createUnit('e2', 'soldier', 'red', { x: 300, y: 100 });
    const allUnits = [attacker, enemy1, enemy2];

    const target = findTarget(attacker, allUnits, 'e1');
    expect(target).toBe(enemy1);
  });

  it('falls back to nearest enemy if preferred target is dead', () => {
    const attacker = createUnit('s1', 'scout', 'blue', { x: 100, y: 100 });
    const enemy1 = createUnit('e1', 'soldier', 'red', { x: 200, y: 100 });
    enemy1.alive = false;
    const enemy2 = createUnit('e2', 'soldier', 'red', { x: 300, y: 100 });
    const allUnits = [attacker, enemy1, enemy2];

    const target = findTarget(attacker, allUnits, 'e1');
    expect(target).toBe(enemy2);
  });

  it('returns null when no enemies alive', () => {
    const attacker = createUnit('s1', 'scout', 'blue', { x: 100, y: 100 });
    const target = findTarget(attacker, [attacker], null);
    expect(target).toBeNull();
  });
});

describe('applyDamage', () => {
  it('reduces HP', () => {
    const unit = createUnit('s1', 'scout', 'blue', { x: 0, y: 0 });
    applyDamage(unit, 10);
    expect(unit.hp).toBe(20);
  });

  it('marks unit as dead when HP reaches 0', () => {
    const unit = createUnit('s1', 'scout', 'blue', { x: 0, y: 0 });
    applyDamage(unit, 30);
    expect(unit.hp).toBe(0);
    expect(unit.alive).toBe(false);
  });

  it('does not go below 0 HP', () => {
    const unit = createUnit('s1', 'scout', 'blue', { x: 0, y: 0 });
    applyDamage(unit, 999);
    expect(unit.hp).toBe(0);
  });
});

describe('segmentHitsRect', () => {
  const rect = { x: 100, y: 100, w: 50, h: 50 };

  it('returns true when segment passes through rect', () => {
    expect(segmentHitsRect({ x: 0, y: 125 }, { x: 200, y: 125 }, rect, 0)).toBe(true);
  });

  it('returns false when segment misses rect', () => {
    expect(segmentHitsRect({ x: 0, y: 50 }, { x: 200, y: 50 }, rect, 0)).toBe(false);
  });

  it('returns true when segment ends inside rect', () => {
    expect(segmentHitsRect({ x: 0, y: 125 }, { x: 120, y: 125 }, rect, 0)).toBe(true);
  });

  it('returns false when segment is too short to reach rect', () => {
    expect(segmentHitsRect({ x: 0, y: 125 }, { x: 50, y: 125 }, rect, 0)).toBe(false);
  });

  it('respects padding to expand hit area', () => {
    // Segment passes just outside the rect (y=95), but padding=10 extends rect to y=90
    expect(segmentHitsRect({ x: 0, y: 95 }, { x: 200, y: 95 }, rect, 0)).toBe(false);
    expect(segmentHitsRect({ x: 0, y: 95 }, { x: 200, y: 95 }, rect, 10)).toBe(true);
  });

  it('handles vertical segments', () => {
    expect(segmentHitsRect({ x: 125, y: 0 }, { x: 125, y: 200 }, rect, 0)).toBe(true);
    expect(segmentHitsRect({ x: 50, y: 0 }, { x: 50, y: 200 }, rect, 0)).toBe(false);
  });
});

describe('detourWaypoints', () => {
  const rect = { x: 100, y: 100, w: 50, h: 50 };

  it('returns empty array for clear path', () => {
    const result = detourWaypoints({ x: 0, y: 50 }, { x: 200, y: 50 }, [rect], 5);
    expect(result).toEqual([]);
  });

  it('returns detour point for blocked path', () => {
    const result = detourWaypoints({ x: 125, y: 0 }, { x: 125, y: 200 }, [rect], 5);
    expect(result.length).toBeGreaterThan(0);
    // Detour point should route around the obstacle (not inside it)
    for (const p of result) {
      const inside = p.x > rect.x && p.x < rect.x + rect.w && p.y > rect.y && p.y < rect.y + rect.h;
      expect(inside).toBe(false);
    }
  });

  it('handles multiple obstacles', () => {
    const obs1 = { x: 100, y: 100, w: 50, h: 50 };
    const obs2 = { x: 100, y: 200, w: 50, h: 50 };
    const result = detourWaypoints({ x: 125, y: 0 }, { x: 125, y: 300 }, [obs1, obs2], 5);
    expect(result.length).toBeGreaterThanOrEqual(2);
  });
});

describe('tryFireProjectile', () => {
  it('fires a projectile when cooldown is ready', () => {
    const attacker = createUnit('s1', 'soldier', 'blue', { x: 100, y: 100 });
    const target = createUnit('e1', 'scout', 'red', { x: 200, y: 100 });
    attacker.fireTimer = 0;
    const proj = tryFireProjectile(attacker, target, 0.016);
    expect(proj).not.toBeNull();
    expect(proj!.damage).toBe(10);
    expect(proj!.team).toBe('blue');
    expect(proj!.pos.x).toBeCloseTo(100);
    expect(proj!.pos.y).toBeCloseTo(100);
  });

  it('returns null when cooldown is not ready', () => {
    const attacker = createUnit('s1', 'soldier', 'blue', { x: 100, y: 100 });
    const target = createUnit('e1', 'scout', 'red', { x: 200, y: 100 });
    attacker.fireTimer = 0.5;
    const proj = tryFireProjectile(attacker, target, 0.016);
    expect(proj).toBeNull();
  });

  it('aims at predicted position based on target velocity', () => {
    const attacker = createUnit('s1', 'soldier', 'blue', { x: 100, y: 100 });
    const target = createUnit('e1', 'scout', 'red', { x: 200, y: 100 });
    target.vel = { x: 0, y: 180 }; // moving down fast
    attacker.fireTimer = 0;
    const proj = tryFireProjectile(attacker, target, 0.016);
    expect(proj).not.toBeNull();
    // Projectile should aim below the target's current position
    expect(proj!.vel.y).toBeGreaterThan(0);
  });
});

describe('updateProjectiles', () => {
  it('moves projectiles and removes those past max range', () => {
    const proj = {
      pos: { x: 100, y: 100 },
      vel: { x: 300, y: 0 },
      target: { x: 200, y: 100 },
      damage: 10,
      radius: 5,
      team: 'blue' as const,
      maxRange: 50,
      distanceTraveled: 40,
    };
    // This tick should push it past max range
    const { alive } = updateProjectiles([proj], [], 0.1);
    expect(alive).toHaveLength(0);
  });

  it('applies damage on hit and removes the projectile', () => {
    const target = createUnit('e1', 'scout', 'red', { x: 105, y: 100 });
    const proj = {
      pos: { x: 100, y: 100 },
      vel: { x: 300, y: 0 },
      target: { x: 105, y: 100 },
      damage: 10,
      radius: 5,
      team: 'blue' as const,
      maxRange: 200,
      distanceTraveled: 0,
    };
    const { alive, hits } = updateProjectiles([proj], [target], 0.016);
    expect(alive).toHaveLength(0);
    expect(target.hp).toBe(20); // 30 - 10
    expect(hits).toHaveLength(1);
    expect(hits[0].targetId).toBe('e1');
    expect(hits[0].killed).toBe(false);
  });
});
