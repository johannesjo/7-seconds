import { HordeWave, HordeUpgrade, Unit, UnitType, Obstacle } from './types';
import { MAP_WIDTH, MAP_HEIGHT, UNIT_STATS } from './constants';
import { createUnit, nudgeOutOfBlocks } from './units';

export const HORDE_WAVES: HordeWave[] = [
  { wave: 1, enemies: [{ type: 'zombie', count: 5 }] },
  { wave: 2, enemies: [{ type: 'zombie', count: 8 }] },
  { wave: 3, enemies: [{ type: 'zombie', count: 10 }] },
  { wave: 4, enemies: [{ type: 'zombie', count: 12 }] },
  { wave: 5, enemies: [{ type: 'zombie', count: 10 }, { type: 'soldier', count: 2 }] },
  { wave: 6, enemies: [{ type: 'zombie', count: 12 }, { type: 'soldier', count: 3 }, { type: 'shielder', count: 1 }] },
  { wave: 7, enemies: [{ type: 'zombie', count: 14 }, { type: 'soldier', count: 3 }, { type: 'shielder', count: 1 }, { type: 'bomber', count: 1 }] },
  { wave: 8, enemies: [{ type: 'zombie', count: 15 }, { type: 'soldier', count: 3 }, { type: 'sniper', count: 1 }, { type: 'shielder', count: 1 }] },
  { wave: 9, enemies: [{ type: 'zombie', count: 16 }, { type: 'soldier', count: 3 }, { type: 'sniper', count: 1 }, { type: 'shielder', count: 1 }, { type: 'bomber', count: 1 }] },
  { wave: 10, enemies: [{ type: 'zombie', count: 18 }, { type: 'soldier', count: 3 }, { type: 'sniper', count: 2 }, { type: 'shielder', count: 2 }, { type: 'bomber', count: 1 }] },
  { wave: 11, enemies: [{ type: 'zombie', count: 20 }, { type: 'blade', count: 2 }, { type: 'sniper', count: 2 }, { type: 'soldier', count: 3 }, { type: 'shielder', count: 2 }, { type: 'bomber', count: 1 }] },
  { wave: 12, enemies: [{ type: 'zombie', count: 22 }, { type: 'blade', count: 3 }, { type: 'sniper', count: 2 }, { type: 'soldier', count: 4 }, { type: 'shielder', count: 2 }, { type: 'bomber', count: 2 }] },
  { wave: 13, enemies: [{ type: 'zombie', count: 28 }, { type: 'blade', count: 4 }, { type: 'sniper', count: 3 }, { type: 'soldier', count: 5 }, { type: 'shielder', count: 4 }, { type: 'bomber', count: 3 }] },
  { wave: 14, enemies: [{ type: 'zombie', count: 30 }, { type: 'blade', count: 5 }, { type: 'sniper', count: 4 }, { type: 'soldier', count: 5 }, { type: 'shielder', count: 4 }, { type: 'bomber', count: 3 }] },
  { wave: 15, enemies: [{ type: 'zombie', count: 35 }, { type: 'blade', count: 6 }, { type: 'sniper', count: 5 }, { type: 'soldier', count: 6 }, { type: 'shielder', count: 5 }, { type: 'bomber', count: 4 }] },
];

function makeStatUpgrade(
  id: string,
  label: string,
  description: string,
  modify: (u: Unit) => void,
): HordeUpgrade {
  return {
    id,
    label,
    description,
    category: 'stat',
    apply(units: Unit[]): Unit[] {
      for (const u of units) {
        if (u.team === 'blue') modify(u);
      }
      return units;
    },
  };
}

function makeUnitUpgrade(
  id: string,
  label: string,
  description: string,
  forType: UnitType,
  modify: (u: Unit) => void,
  once = false,
): HordeUpgrade {
  return {
    id,
    label,
    description,
    category: 'stat',
    forType,
    once: once || undefined,
    apply(units: Unit[]): Unit[] {
      for (const u of units) {
        if (u.team === 'blue' && u.type === forType) modify(u);
      }
      return units;
    },
  };
}

export const ALL_STAT_UPGRADES: HordeUpgrade[] = [
  makeStatUpgrade('hp_15', '+15 HP', 'All units gain +15 max HP', u => {
    u.maxHp += 15;
    u.hp += 15;
  }),
  makeStatUpgrade('dmg_10', '+10 Damage', 'All units deal +10 damage', u => {
    u.damage += 10;
  }),
  makeStatUpgrade('range_20', '+20 Range', 'All units gain +20 range', u => {
    if (u.type !== 'blade') u.range += 20;
  }),
  makeStatUpgrade('range_50', '+50 Range', 'All units gain +50 range', u => {
    if (u.type !== 'blade') u.range += 50;
  }),
  makeStatUpgrade('speed_15', '+15 Speed', 'All units gain +15 speed', u => {
    u.speed += 15;
  }),
  makeStatUpgrade('rapid_fire', 'Rapid Fire', 'All units fire 20% faster', u => {
    u.fireCooldown *= 0.8;
  }),
  { ...makeStatUpgrade('piercing', 'Piercing Rounds', 'All projectiles pass through enemies', u => {
    u.piercing = true;
  }), once: true },
  { ...makeStatUpgrade('double_fire', 'Double Time', 'All units fire twice as fast', u => {
    u.fireCooldown *= 0.5;
  }), once: true, minWave: 8 },
  makeStatUpgrade('quick_aim', 'Quick Aim', 'All units aim 50% faster', u => {
    u.turnSpeed *= 1.5;
  }),
];

export const ALL_UNIT_UPGRADES: HordeUpgrade[] = [
  // Soldier
  makeUnitUpgrade('soldier_hollow', 'Hollow Points', 'Soldiers deal +20 damage', 'soldier', u => { u.damage += 20; }),
  makeUnitUpgrade('soldier_medic', 'Combat Medic', 'Soldiers gain +30 max HP', 'soldier', u => { u.maxHp += 30; u.hp += 30; }),
  // Sniper
  makeUnitUpgrade('sniper_barrel', 'Long Barrel', 'Snipers gain +100 range', 'sniper', u => { u.range += 100; }),
  makeUnitUpgrade('sniper_rapid', 'Rapid Shot', 'Snipers reload 50% faster', 'sniper', u => { u.fireCooldown *= 0.5; }),
  // Blade
  makeUnitUpgrade('blade_fury', 'Blade Fury', 'Blades attack 40% faster', 'blade', u => { u.fireCooldown *= 0.6; }),
  makeUnitUpgrade('blade_berserker', 'Berserker', 'Blades gain +30 speed', 'blade', u => { u.speed += 30; }),
  // Shielder
  makeUnitUpgrade('shielder_iron', 'Iron Wall', 'Shielders gain +40 max HP', 'shielder', u => { u.maxHp += 40; u.hp += 40; }),
  makeUnitUpgrade('shielder_bulwark', 'Bulwark', 'Shielders take 20% less damage', 'shielder', u => {
    u.damageReduction = (u.damageReduction ?? 0) + 0.2;
  }),
];

function makeRecruitUpgrade(type: UnitType): HordeUpgrade {
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  return {
    id: `recruit_${type}`,
    label: `Recruit ${label}`,
    description: `Add a ${label} to your squad`,
    category: 'recruit',
    apply(units: Unit[], blocks?: Obstacle[]): Unit[] {
      const tag = Date.now() % 100000;
      let pos = { x: MAP_WIDTH / 2, y: MAP_HEIGHT * 0.92 };
      if (blocks) pos = nudgeOutOfBlocks(pos, blocks);
      const newUnit = createUnit(`blue_${type}_r${tag}`, type, 'blue', pos);
      return [...units, newUnit];
    },
  };
}

export const ALL_RECRUIT_UPGRADES: HordeUpgrade[] = [
  makeRecruitUpgrade('soldier'),
  makeRecruitUpgrade('blade'),
  makeRecruitUpgrade('sniper'),
  makeRecruitUpgrade('shielder'),
];

/** Pick 3 random upgrades with constraints. */
export function pickUpgrades(blueUnits: Unit[], wave: number, appliedIds: Set<string> = new Set()): HordeUpgrade[] {
  const picks: HordeUpgrade[] = [];
  const usedIds = new Set<string>();

  // Exclude one-time upgrades that have already been applied
  const excludedIds = new Set([...appliedIds].filter(id => {
    const upgrade = ALL_STAT_UPGRADES.find(u => u.id === id);
    return upgrade?.once;
  }));

  // Determine owned unit types for weighting recruits
  const ownedTypes = new Set(blueUnits.filter(u => u.team === 'blue').map(u => u.type));

  // Build weighted recruit pool: owned types appear twice
  const recruitPool: HordeUpgrade[] = [];
  for (const r of ALL_RECRUIT_UPGRADES) {
    const type = r.id.replace('recruit_', '') as UnitType;
    recruitPool.push(r);
    if (ownedTypes.has(type)) recruitPool.push(r);
  }

  // Guarantee at least 1 recruit in waves 1-3
  if (wave <= 3) {
    const shuffled = [...recruitPool].sort(() => Math.random() - 0.5);
    const recruit = shuffled.find(r => !usedIds.has(r.id));
    if (recruit) {
      picks.push(recruit);
      usedIds.add(recruit.id);
    }
  }

  // Extend excluded set to cover once-only unit upgrades already applied
  for (const id of appliedIds) {
    const unitUpgrade = ALL_UNIT_UPGRADES.find(u => u.id === id);
    if (unitUpgrade?.once) excludedIds.add(id);
  }

  // Unit-specific upgrades: only include if player owns that unit type
  const unitUpgradePool = ALL_UNIT_UPGRADES.filter(u =>
    !excludedIds.has(u.id) &&
    u.forType !== undefined &&
    ownedTypes.has(u.forType),
  );

  // Fill remaining slots from mixed pool (excluding already-applied one-time upgrades and wave-gated ones)
  const allPool: HordeUpgrade[] = [
    ...ALL_STAT_UPGRADES.filter(u => !excludedIds.has(u.id) && (!u.minWave || wave >= u.minWave)),
    ...unitUpgradePool,
    ...recruitPool,
  ];

  // Shuffle
  const shuffled = [...allPool].sort(() => Math.random() - 0.5);

  for (const upgrade of shuffled) {
    if (picks.length >= 3) break;
    if (usedIds.has(upgrade.id)) continue;
    picks.push(upgrade);
    usedIds.add(upgrade.id);
  }

  return picks;
}

const HORDE_STARTING_UNIT_POOL: UnitType[] = ['soldier', 'blade', 'sniper', 'shielder'];

/** Pick 2 random units from the playable pool for the starting army. */
export function randomHordeStartingArmy(): { type: UnitType; count: number }[] {
  const pool = [...HORDE_STARTING_UNIT_POOL].sort(() => Math.random() - 0.5);
  const a = pool[0];
  const b = pool[1];
  // Merge if same type (rare but possible if pool shrinks in future)
  if (a === b) return [{ type: a, count: 2 }];
  return [{ type: a, count: 1 }, { type: b, count: 1 }];
}

/** Restore all blue units to max HP. */
export function healAllBlue(units: Unit[]): void {
  for (const u of units) {
    if (u.team === 'blue' && u.alive) {
      u.hp = u.maxHp;
    }
  }
}

/** Reposition blue units in spawn zone, clear movement state. */
export function repositionBlueUnits(units: Unit[], blocks?: Obstacle[]): void {
  const blueAlive = units.filter(u => u.team === 'blue' && u.alive);
  const spacing = 60;
  const groupWidth = spacing * (blueAlive.length - 1);
  const startX = (MAP_WIDTH - groupWidth) / 2;
  const baseY = MAP_HEIGHT * 0.92;

  for (let i = 0; i < blueAlive.length; i++) {
    const u = blueAlive[i];
    let pos = { x: startX + spacing * i, y: baseY };
    if (blocks) pos = nudgeOutOfBlocks(pos, blocks);
    u.pos = pos;
    u.waypoints = [];
    u.moveTarget = null;
    u.vel = { x: 0, y: 0 };
    u.fireTimer = 0;
    u.gunAngle = -Math.PI / 2;
  }
}
