import { HordeWave, HordeUpgrade, Unit, UnitType, Obstacle } from './types';
import { MAP_WIDTH, MAP_HEIGHT, UNIT_STATS } from './constants';
import { createUnit, nudgeOutOfBlocks } from './units';

export const HORDE_WAVES: HordeWave[] = [
  { wave: 1, enemies: [{ type: 'zombie', count: 5 }] },
  { wave: 2, enemies: [{ type: 'zombie', count: 8 }] },
  { wave: 3, enemies: [{ type: 'zombie', count: 10 }] },
  { wave: 4, enemies: [{ type: 'zombie', count: 12 }] },
  { wave: 5, enemies: [{ type: 'soldier', count: 2 }, { type: 'zombie', count: 8 }] },
  { wave: 6, enemies: [{ type: 'soldier', count: 4 }, { type: 'zombie', count: 8 }, { type: 'sniper', count: 1 }] },
  { wave: 7, enemies: [{ type: 'soldier', count: 3 }, { type: 'zombie', count: 10 }, { type: 'sniper', count: 2 }] },
  { wave: 8, enemies: [{ type: 'soldier', count: 3 }, { type: 'zombie', count: 12 }] },
  { wave: 9, enemies: [{ type: 'soldier', count: 3 }, { type: 'zombie', count: 10 }, { type: 'sniper', count: 2 }] },
  { wave: 10, enemies: [{ type: 'blade', count: 3 }, { type: 'sniper', count: 3 }, { type: 'zombie', count: 12 }, { type: 'soldier', count: 3 }] },
  { wave: 11, enemies: [{ type: 'blade', count: 4 }, { type: 'soldier', count: 4 }, { type: 'zombie', count: 15 }] },
  { wave: 12, enemies: [{ type: 'blade', count: 5 }, { type: 'sniper', count: 4 }, { type: 'soldier', count: 5 }, { type: 'zombie', count: 18 }] },
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

export const ALL_STAT_UPGRADES: HordeUpgrade[] = [
  makeStatUpgrade('hp_15', '+15 HP', 'All units gain +15 max HP', u => {
    u.maxHp += 15;
    u.hp += 15;
  }),
  makeStatUpgrade('dmg_5', '+5 Damage', 'All units deal +5 damage', u => {
    u.damage += 5;
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
  makeStatUpgrade('piercing', 'Piercing Rounds', 'All projectiles pass through enemies', u => {
    u.piercing = true;
  }),
  makeStatUpgrade('quick_aim', 'Quick Aim', 'All units aim 50% faster', u => {
    u.turnSpeed *= 1.5;
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
];

/** Pick 3 random upgrades with constraints. */
export function pickUpgrades(blueUnits: Unit[], wave: number): HordeUpgrade[] {
  const picks: HordeUpgrade[] = [];
  const usedIds = new Set<string>();

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

  // Fill remaining slots from mixed pool
  const allPool: HordeUpgrade[] = [
    ...ALL_STAT_UPGRADES,
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
