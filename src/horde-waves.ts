/** Horde wave building: wave modifiers, boss waves, endless waves and pacts. */
import type { ElevationZone, Obstacle, Unit, UnitType } from './types';
import { HORDE_MAX_WAVES, MAP_HEIGHT, MAP_WIDTH } from './constants';
import { HORDE_WAVES } from './horde';
import { createMissionArmy, createUnit, nudgeOutOfBlocks } from './units';

type Composition = { type: UnitType; count: number }[];

export type WaveModifierId = 'frenzy' | 'armored' | 'swarm' | 'bomber_rush' | 'sniper_nest' | 'flank' | 'ambush';

export interface WaveModifier {
  id: WaveModifierId;
  label: string;
  description: string;
  /** Earliest wave the modifier rolls on its own (a pact can bring it sooner). */
  minWave: number;
  /** Changes where enemies spawn — a wave has at most one of these. */
  spawn?: boolean;
}

export const WAVE_MODIFIERS: Record<WaveModifierId, WaveModifier> = {
  frenzy: { id: 'frenzy', label: 'Frenzy', description: 'Enemies move 30% faster', minWave: 3 },
  swarm: { id: 'swarm', label: 'Swarm', description: '60% more zombies, but frailer', minWave: 3 },
  armored: { id: 'armored', label: 'Armored', description: 'Enemies have 50% more HP', minWave: 4 },
  flank: { id: 'flank', label: 'Flank Attack', description: 'Enemies come in from the sides', minWave: 4, spawn: true },
  bomber_rush: { id: 'bomber_rush', label: 'Bomber Rush', description: 'A quarter of the zombies are bombers', minWave: 5 },
  sniper_nest: { id: 'sniper_nest', label: 'Sniper Nest', description: 'Extra enemy snipers dug in on high ground', minWave: 6 },
  ambush: { id: 'ambush', label: 'Ambush', description: 'Half the horde spawns close on your flanks', minWave: 7, spawn: true },
};

const MODIFIER_IDS = Object.keys(WAVE_MODIFIERS) as WaveModifierId[];

export type BossId = 'brute' | 'juggernaut' | 'abomination';

interface BossDef {
  name: string;
  description: string;
  base: UnitType;
  hp: number;
  radius: number;
  damage: number;
  speed: number;
  damageReduction: number;
}

export const BOSSES: Record<BossId, BossDef> = {
  brute: {
    name: 'The Brute',
    description: 'A hulking zombie. Slow, but it hits like a truck — focus fire or keep your distance.',
    base: 'zombie', hp: 260, radius: 16, damage: 28, speed: 48, damageReduction: 0,
  },
  juggernaut: {
    name: 'The Juggernaut',
    description: 'An armoured shielder that soaks damage. Its shield blocks frontal fire — get behind it.',
    base: 'shielder', hp: 420, radius: 17, damage: 26, speed: 40, damageReduction: 0.25,
  },
  abomination: {
    name: 'The Abomination',
    description: 'A towering mass of the dead. Tough, hard-hitting and relentless.',
    base: 'zombie', hp: 800, radius: 21, damage: 45, speed: 46, damageReduction: 0.15,
  },
};

const BOSS_ORDER: BossId[] = ['brute', 'juggernaut', 'abomination'];
const BOSS_INTERVAL = 5;

export interface HordeWavePlan {
  wave: number;
  /** Base enemies, before modifiers and the boss trim are applied. */
  enemies: Composition;
  modifiers: WaveModifierId[];
  /** Modifier added by an accepted pact (also listed in `modifiers`). */
  curse?: WaveModifierId;
  boss?: BossId;
}

export interface Pact {
  curse: WaveModifierId;
}

/** Share of upgrade screens (from wave 3 on) that offer a pact. */
const PACT_CHANCE = 0.5;

export function bossForWave(wave: number): BossId | undefined {
  if (wave % BOSS_INTERVAL !== 0) return undefined;
  return BOSS_ORDER[(wave / BOSS_INTERVAL - 1) % BOSS_ORDER.length];
}

/** Types an endless wave can feature with extra numbers. */
const ENDLESS_FEATURED: UnitType[] = ['blade', 'sniper', 'soldier', 'shielder', 'bomber'];

/** Waves past the scripted ones: the final wave's mix, growing slowly and
 *  featuring one random type. Toughness grows via endlessStatScale instead
 *  of ever more units. */
export function endlessEnemies(wave: number, random: () => number = Math.random): Composition {
  const extra = Math.max(0, wave - HORDE_MAX_WAVES);
  const scale = Math.min(1.5, 1 + extra * 0.04);
  const featured = ENDLESS_FEATURED[Math.floor(random() * ENDLESS_FEATURED.length)];
  return HORDE_WAVES[HORDE_WAVES.length - 1].enemies.map(e => ({
    type: e.type,
    count: Math.round(e.count * scale * (e.type === featured ? 1.5 : 1)),
  }));
}

export function endlessStatScale(wave: number): { hp: number; damage: number } {
  const extra = Math.max(0, wave - HORDE_MAX_WAVES);
  return { hp: 1 + extra * 0.08, damage: 1 + extra * 0.04 };
}

function modifierChance(wave: number): number {
  if (wave < 3) return 0;
  if (wave <= 6) return 0.35;
  if (wave <= HORDE_MAX_WAVES) return 0.5;
  return 1;
}

function compatible(id: WaveModifierId, chosen: WaveModifierId[]): boolean {
  if (chosen.includes(id)) return false;
  return !(WAVE_MODIFIERS[id].spawn && chosen.some(c => WAVE_MODIFIERS[c].spawn));
}

function pickOne<T>(items: T[], random: () => number): T {
  return items[Math.floor(random() * items.length)];
}

/** Boss waves stay unmodified; endless waves always get one, sometimes two. */
export function rollModifiers(wave: number, random: () => number = Math.random): WaveModifierId[] {
  if (bossForWave(wave)) return [];
  if (random() >= modifierChance(wave)) return [];
  const count = wave > HORDE_MAX_WAVES + 4 && random() < 0.4 ? 2 : 1;
  const chosen: WaveModifierId[] = [];
  for (let i = 0; i < count; i++) {
    const pool = MODIFIER_IDS.filter(id => WAVE_MODIFIERS[id].minWave <= wave && compatible(id, chosen));
    if (pool.length === 0) break;
    chosen.push(pickOne(pool, random));
  }
  return chosen;
}

export function buildWavePlan(wave: number, random: () => number = Math.random): HordeWavePlan {
  const enemies = wave <= HORDE_WAVES.length
    ? HORDE_WAVES[wave - 1].enemies.map(e => ({ ...e }))
    : endlessEnemies(wave, random);
  return { wave, enemies, modifiers: rollModifiers(wave, random), boss: bossForWave(wave) };
}

/** Maybe offer a pact for the upcoming wave: accept a curse, earn a bonus pick. */
export function rollPact(plan: HordeWavePlan, random: () => number = Math.random): Pact | null {
  if (plan.curse || plan.wave < 3 || random() >= PACT_CHANCE) return null;
  const pool = MODIFIER_IDS.filter(id => compatible(id, plan.modifiers));
  return pool.length > 0 ? { curse: pickOne(pool, random) } : null;
}

export function withCurse(plan: HordeWavePlan, curse: WaveModifierId): HordeWavePlan {
  return { ...plan, modifiers: [...plan.modifiers, curse], curse };
}

/** Points for clearing a wave: harder waves are worth more. */
export function waveScore(plan: HordeWavePlan): number {
  return 100 + 50 * plan.modifiers.length + (plan.boss ? 250 : 0);
}

/** Short summary for banners and the HUD, e.g. "The Brute" or "Frenzy · Flank Attack". */
export function describePlan(plan: HordeWavePlan): string {
  const parts = plan.modifiers.map(id => WAVE_MODIFIERS[id].label);
  if (plan.boss) parts.unshift(BOSSES[plan.boss].name);
  return parts.join(' · ');
}

/** Enemy composition after the plan's modifiers and the boss trim. */
export function waveComposition(plan: HordeWavePlan): Composition {
  const mods = new Set(plan.modifiers);
  const counts = new Map<UnitType, number>();
  const add = (type: UnitType, n: number) => counts.set(type, (counts.get(type) ?? 0) + n);
  for (const e of plan.enemies) add(e.type, e.count);

  // The boss stands in for a quarter of the zombies.
  if (plan.boss) counts.set('zombie', Math.round((counts.get('zombie') ?? 0) * 0.75));
  if (mods.has('swarm')) counts.set('zombie', Math.round((counts.get('zombie') ?? 0) * 1.6));
  if (mods.has('bomber_rush')) {
    const zombies = counts.get('zombie') ?? 0;
    const converted = Math.min(zombies, Math.max(2, Math.round(zombies * 0.25)));
    counts.set('zombie', zombies - converted);
    add('bomber', converted);
  }
  if (mods.has('sniper_nest')) add('sniper', sniperNestSize(plan.wave));

  return [...counts].filter(([, count]) => count > 0).map(([type, count]) => ({ type, count }));
}

function sniperNestSize(wave: number): number {
  return wave >= 12 ? 3 : 2;
}

const FLANK_MARGIN = 24;
const FLANK_COLUMN_GAP = 28;
const FLANK_MAX_ROWS = 12;
/** Flank columns stay within this share of the map width on each side. */
const FLANK_MAX_WIDTH = 0.3;

/** Line units up in columns along the left and right edges within a band of the map. */
function placeOnFlanks(units: Unit[], yMinFrac: number, yMaxFrac: number, blocks: Obstacle[]): void {
  const sides: Unit[][] = [[], []];
  units.forEach((u, i) => sides[i % 2].push(u));
  const yMin = MAP_HEIGHT * yMinFrac;
  const yMax = MAP_HEIGHT * yMaxFrac;
  sides.forEach((side, s) => {
    // Big waves on narrow maps add rows rather than columns, so the sides
    // never close into a wall across the middle.
    const maxCols = Math.max(1, Math.floor((MAP_WIDTH * FLANK_MAX_WIDTH - FLANK_MARGIN) / FLANK_COLUMN_GAP) + 1);
    const cols = Math.min(maxCols, Math.max(1, Math.ceil(side.length / FLANK_MAX_ROWS)));
    const rows = Math.max(1, Math.ceil(side.length / cols));
    side.forEach((u, k) => {
      const offset = FLANK_MARGIN + (k % cols) * FLANK_COLUMN_GAP;
      const x = s === 0 ? offset : MAP_WIDTH - offset;
      const y = yMin + (Math.floor(k / cols) + 0.5) * (yMax - yMin) / rows;
      u.pos = nudgeOutOfBlocks({ x, y }, blocks);
    });
  });
}

/** Put snipers on the hill furthest from the player's spawn, if there is one up the map. */
function placeSniperNest(snipers: Unit[], zones: ElevationZone[], blocks: Obstacle[]): void {
  const hill = zones
    .filter(z => z.y + z.h / 2 < MAP_HEIGHT * 0.7)
    .sort((a, b) => a.y - b.y)[0];
  if (!hill) return;
  snipers.forEach((u, i) => {
    const x = hill.x + hill.w * (i + 1) / (snipers.length + 1);
    u.pos = nudgeOutOfBlocks({ x, y: hill.y + hill.h / 2 }, blocks);
  });
}

function createBoss(id: BossId, wave: number, blocks: Obstacle[]): Unit {
  const def = BOSSES[id];
  // Each full cycle through the bosses (endless) brings them back tougher.
  const cycle = Math.floor((wave / BOSS_INTERVAL - 1) / BOSS_ORDER.length);
  const pos = nudgeOutOfBlocks({ x: MAP_WIDTH / 2, y: MAP_HEIGHT * 0.1 }, blocks);
  const boss = createUnit(`red_boss_${wave}`, def.base, 'red', pos);
  boss.boss = def.name;
  boss.maxHp = Math.round(def.hp * (1 + 0.5 * cycle));
  boss.hp = boss.maxHp;
  boss.radius = def.radius;
  boss.damage = def.damage;
  boss.speed = def.speed;
  boss.damageReduction = def.damageReduction || undefined;
  return boss;
}

function applyEnemyStats(units: Unit[], plan: HordeWavePlan): void {
  const mods = new Set(plan.modifiers);
  const scale = endlessStatScale(plan.wave);
  for (const u of units) {
    let hp = scale.hp;
    if (mods.has('armored')) hp *= 1.5;
    if (mods.has('swarm') && u.type === 'zombie' && !u.boss) hp *= 0.6;
    u.maxHp = Math.max(1, Math.round(u.maxHp * hp));
    u.hp = u.maxHp;
    u.damage = Math.round(u.damage * scale.damage);
    if (mods.has('frenzy')) u.speed *= 1.3;
  }
}

/** Create a wave's enemies — and its boss — with the plan's modifiers applied. */
export function spawnHordeWave(plan: HordeWavePlan, blocks: Obstacle[], elevationZones: ElevationZone[]): Unit[] {
  const mods = new Set(plan.modifiers);
  const units = createMissionArmy('red', waveComposition(plan), blocks);

  // The nest's snipers are the last ones created (the composition adds them on top).
  const nest = mods.has('sniper_nest')
    ? units.filter(u => u.type === 'sniper').slice(-sniperNestSize(plan.wave))
    : [];
  placeSniperNest(nest, elevationZones, blocks);
  const movable = units.filter(u => !nest.includes(u));
  if (mods.has('flank')) placeOnFlanks(movable, 0.2, 0.65, blocks);
  // Close, but out of gun range of the spawn line on round 1.
  if (mods.has('ambush')) placeOnFlanks(movable.filter((_, i) => i % 2 === 1), 0.45, 0.65, blocks);

  if (plan.boss) units.push(createBoss(plan.boss, plan.wave, blocks));
  applyEnemyStats(units, plan);
  return units;
}
