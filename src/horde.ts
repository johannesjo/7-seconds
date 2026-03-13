import { HordeWave, HordeUpgrade, UpgradeRarity, Unit, UnitType, Obstacle } from './types';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';
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
  rarity: UpgradeRarity,
  modify: (u: Unit) => void,
): HordeUpgrade {
  return {
    id,
    label,
    description,
    category: 'stat',
    rarity,
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
  rarity: UpgradeRarity,
  modify: (u: Unit) => void,
  once = false,
  minWave?: number,
): HordeUpgrade {
  return {
    id,
    label,
    description,
    category: 'stat',
    rarity,
    forType,
    once: once || undefined,
    minWave,
    apply(units: Unit[]): Unit[] {
      for (const u of units) {
        if (u.team === 'blue' && u.type === forType) modify(u);
      }
      return units;
    },
  };
}

/** Returns true if the player owns at least one ranged (non-blade) blue unit. */
const hasRangedUnits = (units: Unit[]): boolean =>
  units.some(u => u.team === 'blue' && u.type !== 'blade');

export const ALL_STAT_UPGRADES: HordeUpgrade[] = [
  makeStatUpgrade('hp_15', '+15 HP', 'All units gain +15 max HP', 'common', u => {
    u.maxHp += 15;
    u.hp += 15;
  }),
  makeStatUpgrade('dmg_10', '+10 Damage', 'All units deal +10 damage', 'common', u => {
    u.damage += 10;
  }),
  { ...makeStatUpgrade('range_20', '+20 Range', 'All units gain +20 range', 'common', u => {
    if (u.type !== 'blade') u.range += 20;
  }), canApply: hasRangedUnits },
  { ...makeStatUpgrade('range_50', '+50 Range', 'All units gain +50 range', 'uncommon', u => {
    if (u.type !== 'blade') u.range += 50;
  }), canApply: hasRangedUnits },
  makeStatUpgrade('speed_15', '+15 Speed', 'All units gain +15 speed', 'common', u => {
    u.speed += 15;
  }),
  makeStatUpgrade('rapid_fire', 'Rapid Fire', 'All units fire 20% faster', 'uncommon', u => {
    u.fireCooldown *= 0.8;
  }),
  { ...makeStatUpgrade('piercing', 'Piercing Rounds', 'All projectiles pass through enemies', 'rare', u => {
    u.piercing = true;
  }), once: true, minWave: 10, canApply: hasRangedUnits },
  { ...makeStatUpgrade('double_fire', 'Double Time', 'All units fire twice as fast', 'epic', u => {
    u.fireCooldown *= 0.5;
  }), once: true, minWave: 10 },
  makeStatUpgrade('quick_aim', 'Quick Aim', 'All units aim 50% faster', 'uncommon', u => {
    u.turnSpeed *= 1.5;
  }),
];

export const ALL_UNIT_UPGRADES: HordeUpgrade[] = [
  // Soldier
  makeUnitUpgrade('soldier_hollow', 'Hollow Points', 'Soldiers deal +20 damage', 'soldier', 'uncommon', u => { u.damage += 20; }),
  makeUnitUpgrade('soldier_medic', 'Combat Medic', 'Soldiers gain +30 max HP', 'soldier', 'common', u => { u.maxHp += 30; u.hp += 30; }),
  // Sniper
  makeUnitUpgrade('sniper_barrel', 'Long Barrel', 'Snipers gain +100 range', 'sniper', 'uncommon', u => { u.range += 100; }),
  makeUnitUpgrade('sniper_rapid', 'Rapid Shot', 'Snipers reload 50% faster', 'sniper', 'rare', u => { u.fireCooldown *= 0.5; }, true, 10),
  // Shielder
  makeUnitUpgrade('shielder_iron', 'Iron Wall', 'Shielders gain +40 max HP', 'shielder', 'common', u => { u.maxHp += 40; u.hp += 40; }),
  makeUnitUpgrade('shielder_bulwark', 'Bulwark', 'Shielders take 20% less damage', 'shielder', 'rare', u => {
    u.damageReduction = (u.damageReduction ?? 0) + 0.2;
  }, true, 10),
];

function makeRecruitUpgrade(type: UnitType): HordeUpgrade {
  const label = type.charAt(0).toUpperCase() + type.slice(1);
  return {
    id: `recruit_${type}`,
    label: `Recruit ${label}`,
    description: `Add a ${label} to your squad`,
    category: 'recruit',
    rarity: 'common',
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
  makeRecruitUpgrade('sniper'),
  makeRecruitUpgrade('shielder'),
];

/** Rarity weights: higher = more likely to appear in the pool. */
const RARITY_WEIGHT: Record<UpgradeRarity, number> = {
  common: 4,
  uncommon: 3,
  rare: 2,
  epic: 1,
};

/**
 * Expand an upgrade into the pool multiple times according to its rarity weight.
 * This makes common upgrades appear more often and epic upgrades appear rarely.
 */
function weightedEntries(upgrade: HordeUpgrade): HordeUpgrade[] {
  return Array(RARITY_WEIGHT[upgrade.rarity]).fill(upgrade);
}

/** Pick 3 random upgrades with constraints. */
export function pickUpgrades(blueUnits: Unit[], wave: number, appliedCounts: Map<string, number> = new Map()): HordeUpgrade[] {
  const picks: HordeUpgrade[] = [];
  const usedIds = new Set<string>();

  // Exclude one-time upgrades that have already been applied
  const appliedIds = new Set(appliedCounts.keys());
  const excludedIds = new Set([...appliedIds].filter(id => {
    const upgrade = ALL_STAT_UPGRADES.find(u => u.id === id);
    return upgrade?.once;
  }));

  // Determine owned unit types for weighting recruits
  const ownedTypes = new Set(blueUnits.filter(u => u.team === 'blue').map(u => u.type));

  // Build weighted recruit pool: owned types appear twice (on top of rarity weight)
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

  // Unit-specific upgrades: only include if player owns that unit type and wave gate is met
  const unitUpgradePool = ALL_UNIT_UPGRADES.filter(u =>
    !excludedIds.has(u.id) &&
    u.forType !== undefined &&
    ownedTypes.has(u.forType) &&
    (!u.minWave || wave >= u.minWave),
  );

  // Fill remaining slots from mixed pool (excluding already-applied one-time upgrades and wave-gated ones)
  // Skip upgrades that would have no effect on the current unit roster
  // Each upgrade is expanded by its rarity weight so rarer upgrades appear less often
  const allPool: HordeUpgrade[] = [
    ...ALL_STAT_UPGRADES
      .filter(u =>
        !excludedIds.has(u.id) &&
        (!u.minWave || wave >= u.minWave) &&
        (!u.canApply || u.canApply(blueUnits)),
      )
      .flatMap(weightedEntries),
    ...unitUpgradePool.flatMap(weightedEntries),
    ...recruitPool,
  ];

  // Shuffle
  const shuffled = [...allPool].sort(() => Math.random() - 0.5);

  for (const upgrade of shuffled) {
    if (picks.length >= 3) break;
    if (usedIds.has(upgrade.id)) continue;
    // Annotate label with stack count when the upgrade has already been applied
    const count = appliedCounts.get(upgrade.id) ?? 0;
    if (count > 0) {
      picks.push({ ...upgrade, label: `${upgrade.label} (×${count + 1})` });
    } else {
      picks.push(upgrade);
    }
    usedIds.add(upgrade.id);
  }

  return picks;
}

const HORDE_STARTING_UNIT_POOL: UnitType[] = ['soldier', 'sniper', 'shielder'];

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
