import { describe, it, expect } from 'vitest';
import { HORDE_WAVES, ALL_STAT_UPGRADES, ALL_RECRUIT_UPGRADES, ALL_UNIT_UPGRADES, pickUpgrades, healAllBlue, repositionBlueUnits, randomHordeStartingArmy, applyUpgradesToUnit } from './horde';
import { createUnit } from './units';
import { MAP_HEIGHT, HORDE_MAX_WAVES } from './constants';
import { Unit } from './types';

describe('HORDE_WAVES', () => {
  it('has exactly 10 waves', () => {
    expect(HORDE_WAVES).toHaveLength(HORDE_MAX_WAVES);
  });

  it('waves are numbered sequentially 1-10', () => {
    for (let i = 0; i < HORDE_WAVES.length; i++) {
      expect(HORDE_WAVES[i].wave).toBe(i + 1);
    }
  });

  it('every wave has at least 1 enemy group', () => {
    for (const wave of HORDE_WAVES) {
      expect(wave.enemies.length).toBeGreaterThan(0);
      const total = wave.enemies.reduce((sum, e) => sum + e.count, 0);
      expect(total).toBeGreaterThan(0);
    }
  });
});

describe('pickUpgrades', () => {
  function makeBlueSquad(): Unit[] {
    return [
      createUnit('blue_soldier_0', 'soldier', 'blue', { x: 400, y: 600 }),
      createUnit('blue_soldier_1', 'soldier', 'blue', { x: 500, y: 600 }),
    ];
  }

  it('returns exactly 3 upgrades', () => {
    const picks = pickUpgrades(makeBlueSquad(), 1);
    expect(picks).toHaveLength(3);
  });

  it('returns no duplicate IDs', () => {
    for (let i = 0; i < 20; i++) {
      const picks = pickUpgrades(makeBlueSquad(), 2);
      const ids = picks.map(p => p.id);
      expect(new Set(ids).size).toBe(3);
    }
  });

  it('does not offer double_fire before wave 10', () => {
    for (let i = 0; i < 30; i++) {
      const picks = pickUpgrades(makeBlueSquad(), 9);
      expect(picks.some(p => p.id === 'double_fire')).toBe(false);
    }
  });

  it('can offer double_fire from wave 10 onwards', () => {
    let seen = false;
    for (let i = 0; i < 100; i++) {
      const picks = pickUpgrades(makeBlueSquad(), 10);
      if (picks.some(p => p.id === 'double_fire')) { seen = true; break; }
    }
    expect(seen).toBe(true);
  });

  it('guarantees at least 1 recruit in waves 1-3', () => {
    for (let wave = 1; wave <= 3; wave++) {
      for (let i = 0; i < 20; i++) {
        const picks = pickUpgrades(makeBlueSquad(), wave);
        const hasRecruit = picks.some(p => p.category === 'recruit');
        expect(hasRecruit).toBe(true);
      }
    }
  });
});

describe('healAllBlue', () => {
  it('restores blue units to max HP', () => {
    const units = [
      createUnit('blue_soldier_0', 'soldier', 'blue', { x: 400, y: 600 }),
      createUnit('red_soldier_0', 'soldier', 'red', { x: 400, y: 200 }),
    ];
    units[0].hp = 10;
    units[1].hp = 10;

    healAllBlue(units);

    expect(units[0].hp).toBe(units[0].maxHp);
    expect(units[1].hp).toBe(10); // red untouched
  });

  it('does not heal dead blue units', () => {
    const units = [
      createUnit('blue_soldier_0', 'soldier', 'blue', { x: 400, y: 600 }),
    ];
    units[0].hp = 0;
    units[0].alive = false;

    healAllBlue(units);

    expect(units[0].hp).toBe(0);
    expect(units[0].alive).toBe(false);
  });
});

describe('repositionBlueUnits', () => {
  it('centers blue units in spawn zone and clears waypoints', () => {
    const units = [
      createUnit('blue_soldier_0', 'soldier', 'blue', { x: 100, y: 100 }),
      createUnit('blue_soldier_1', 'soldier', 'blue', { x: 200, y: 200 }),
    ];
    units[0].waypoints = [{ x: 300, y: 300 }];
    units[0].vel = { x: 50, y: 50 };

    repositionBlueUnits(units);

    expect(units[0].pos.y).toBe(MAP_HEIGHT * 0.92);
    expect(units[1].pos.y).toBe(MAP_HEIGHT * 0.92);
    expect(units[0].waypoints).toEqual([]);
    expect(units[0].vel).toEqual({ x: 0, y: 0 });
    expect(units[0].moveTarget).toBeNull();
  });
});

describe('stat upgrade apply', () => {
  it('+15 HP increases maxHp and hp for blue units', () => {
    const hpUpgrade = ALL_STAT_UPGRADES.find(u => u.id === 'hp_15')!;
    const units = [
      createUnit('blue_soldier_0', 'soldier', 'blue', { x: 400, y: 600 }),
    ];
    const originalMaxHp = units[0].maxHp;

    hpUpgrade.apply(units);

    expect(units[0].maxHp).toBe(originalMaxHp + 15);
    expect(units[0].hp).toBe(originalMaxHp + 15);
  });

  it('+10 Damage increases damage for blue units', () => {
    const dmgUpgrade = ALL_STAT_UPGRADES.find(u => u.id === 'dmg_10')!;
    const units = [
      createUnit('blue_soldier_0', 'soldier', 'blue', { x: 400, y: 600 }),
    ];
    const originalDmg = units[0].damage;

    dmgUpgrade.apply(units);

    expect(units[0].damage).toBe(originalDmg + 10);
  });

  it('double_fire halves fireCooldown for blue units', () => {
    const doubleFireUpgrade = ALL_STAT_UPGRADES.find(u => u.id === 'double_fire')!;
    const units = [
      createUnit('blue_soldier_0', 'soldier', 'blue', { x: 400, y: 600 }),
    ];
    const originalCooldown = units[0].fireCooldown;

    doubleFireUpgrade.apply(units);

    expect(units[0].fireCooldown).toBeCloseTo(originalCooldown * 0.5);
  });
});

describe('unit-specific upgrades', () => {
  it('soldier_hollow only applies to soldiers', () => {
    const upgrade = ALL_UNIT_UPGRADES.find(u => u.id === 'soldier_hollow')!;
    const units = [
      createUnit('blue_soldier_0', 'soldier', 'blue', { x: 400, y: 600 }),
      createUnit('blue_sniper_0', 'sniper', 'blue', { x: 500, y: 600 }),
    ];
    const soldierDmg = units[0].damage;
    const sniperDmg = units[1].damage;

    upgrade.apply(units);

    expect(units[0].damage).toBe(soldierDmg + 20);
    expect(units[1].damage).toBe(sniperDmg); // sniper untouched
  });

  it('shielder_bulwark stacks damageReduction additively', () => {
    const upgrade = ALL_UNIT_UPGRADES.find(u => u.id === 'shielder_bulwark')!;
    const units = [
      createUnit('blue_shielder_0', 'shielder', 'blue', { x: 400, y: 600 }),
    ];

    upgrade.apply(units);
    expect(units[0].damageReduction).toBeCloseTo(0.2);

    upgrade.apply(units);
    expect(units[0].damageReduction).toBeCloseTo(0.4);
  });

  it('unit upgrades only appear in pickUpgrades when owning that type', () => {
    const soldierOnlySquad = [
      createUnit('blue_soldier_0', 'soldier', 'blue', { x: 400, y: 600 }),
    ];
    const sniperUpgradeIds = ALL_UNIT_UPGRADES.filter(u => u.forType === 'sniper').map(u => u.id);

    for (let i = 0; i < 30; i++) {
      const picks = pickUpgrades(soldierOnlySquad, 5);
      for (const id of sniperUpgradeIds) {
        expect(picks.some(p => p.id === id)).toBe(false);
      }
    }
  });

  it('unit upgrades appear when owning that type', () => {
    const squad = [
      createUnit('blue_sniper_0', 'sniper', 'blue', { x: 400, y: 600 }),
    ];
    const sniperUpgradeIds = new Set(ALL_UNIT_UPGRADES.filter(u => u.forType === 'sniper').map(u => u.id));

    let seen = false;
    for (let i = 0; i < 100; i++) {
      const picks = pickUpgrades(squad, 5);
      if (picks.some(p => sniperUpgradeIds.has(p.id))) { seen = true; break; }
    }
    expect(seen).toBe(true);
  });
});

describe('randomHordeStartingArmy', () => {
  it('returns exactly 2 units total', () => {
    for (let i = 0; i < 20; i++) {
      const army = randomHordeStartingArmy();
      const total = army.reduce((sum, e) => sum + e.count, 0);
      expect(total).toBe(2);
    }
  });

  it('only uses playable unit types', () => {
    const playable = new Set(['soldier', 'blade', 'sniper', 'shielder']);
    for (let i = 0; i < 20; i++) {
      const army = randomHordeStartingArmy();
      for (const entry of army) {
        expect(playable.has(entry.type)).toBe(true);
      }
    }
  });
});

describe('recruit upgrade apply', () => {
  it('adds a new unit of the correct type', () => {
    const soldierRecruit = ALL_RECRUIT_UPGRADES.find(u => u.id === 'recruit_soldier')!;
    const units = [
      createUnit('blue_soldier_0', 'soldier', 'blue', { x: 400, y: 600 }),
    ];

    const result = soldierRecruit.apply(units);

    expect(result).toHaveLength(2);
    expect(result[1].type).toBe('soldier');
    expect(result[1].team).toBe('blue');
    expect(result[1].alive).toBe(true);
  });
});

describe('applyUpgradesToUnit', () => {
  it('applies previous stat upgrades to a recruited unit', () => {
    const recruit = createUnit('blue_soldier_r1', 'soldier', 'blue', { x: 400, y: 600 });
    const baseHp = recruit.maxHp;
    const baseDmg = recruit.damage;
    const applied = new Map([['hp_15', 1], ['dmg_10', 1]]);

    applyUpgradesToUnit(recruit, applied);

    expect(recruit.maxHp).toBe(baseHp + 15);
    expect(recruit.hp).toBe(baseHp + 15);
    expect(recruit.damage).toBe(baseDmg + 10);
  });

  it('applies stacked upgrades the correct number of times', () => {
    const recruit = createUnit('blue_soldier_r1', 'soldier', 'blue', { x: 400, y: 600 });
    const baseHp = recruit.maxHp;
    const applied = new Map([['hp_15', 3]]);

    applyUpgradesToUnit(recruit, applied);

    expect(recruit.maxHp).toBe(baseHp + 45);
  });

  it('applies matching unit-type upgrades to a recruited unit', () => {
    const recruit = createUnit('blue_soldier_r1', 'soldier', 'blue', { x: 400, y: 600 });
    const baseDmg = recruit.damage;
    const applied = new Map([['soldier_hollow', 1]]);

    applyUpgradesToUnit(recruit, applied);

    expect(recruit.damage).toBe(baseDmg + 20);
  });

  it('does not apply non-matching unit-type upgrades', () => {
    const recruit = createUnit('blue_sniper_r1', 'sniper', 'blue', { x: 400, y: 600 });
    const baseDmg = recruit.damage;
    const applied = new Map([['soldier_hollow', 1]]);

    applyUpgradesToUnit(recruit, applied);

    expect(recruit.damage).toBe(baseDmg);
  });

  it('skips recruit upgrade IDs without error', () => {
    const recruit = createUnit('blue_soldier_r1', 'soldier', 'blue', { x: 400, y: 600 });
    const baseHp = recruit.maxHp;
    const applied = new Map([['recruit_soldier', 1], ['hp_15', 1]]);

    applyUpgradesToUnit(recruit, applied);

    expect(recruit.maxHp).toBe(baseHp + 15);
  });
});
