/**
 * Expedition: cross a large map to the extraction zone while the horde closes
 * in. Lurkers sleep along the way until you get near; pursuers spawn behind
 * the squad every round, and more of them when the squad stalls. Reaching the
 * zone calls the evac, which lands at the end of the next round: whoever is
 * inside then gets out.
 *
 * Pure logic only (no rendering), so it can be tested headlessly.
 */
import type { ElevationZone, Obstacle, Unit, UnitType, Vec2 } from './types';
import { createUnit, nudgeOutOfBlocks } from './units';
import { UNIT_STATS } from './constants';

/** Three times the standard map's width, and a phone-like 1:2 shape. A
 *  soldier covers ~600px in a round, a sniper ~420, so the trip takes several. */
export const EXPEDITION_MAP_WIDTH = 1080;
export const EXPEDITION_MAP_HEIGHT = 2160;

/** Where the squad starts (its centre). */
export const EXPEDITION_START: Vec2 = { x: EXPEDITION_MAP_WIDTH / 2, y: EXPEDITION_MAP_HEIGHT - 120 };

/** Lurkers wake when a blue unit comes this close, or when they're hurt. */
export const LURKER_WAKE_RADIUS = 200;
/** A waking lurker rouses the rest of its pack within this distance. */
const PACK_WAKE_RADIUS = 140;
/** Pursuers appear this far behind the squad's rearmost unit. */
const PURSUIT_DISTANCE = 380;
/** ...and never closer than this to any blue unit (e.g. near the bottom
 *  edge, where there's no room behind; they come from the sides instead). */
export const MIN_SPAWN_DISTANCE = 300;
/** The squad must gain this much ground per round or the horde grows faster. */
export const STALL_DISTANCE = 150;
/** Never let more enemies than this be alive at once. */
export const MAX_ALIVE_ENEMIES = 90;

export const EXPEDITION_SQUAD: { type: UnitType; count: number }[] = [
  { type: 'soldier', count: 3 },
  { type: 'sniper', count: 1 },
  { type: 'blade', count: 1 },
];

export interface ExpeditionMap {
  obstacles: Obstacle[];
  elevationZones: ElevationZone[];
  /** Reach it to call the evac; be inside when it lands to get out. */
  extraction: Obstacle;
}

export interface ExpeditionSetup extends ExpeditionMap {
  units: Unit[];
}

type Rng = () => number;

const range = (rng: Rng, min: number, max: number): number => min + rng() * (max - min);

function overlaps(a: Obstacle, b: Obstacle, gap: number): boolean {
  return a.x < b.x + b.w + gap && a.x + a.w + gap > b.x && a.y < b.y + b.h + gap && a.y + a.h + gap > b.y;
}

export function extractionZone(): Obstacle {
  const w = 300;
  const h = 150;
  return { x: (EXPEDITION_MAP_WIDTH - w) / 2, y: 50, w, h };
}

/** Area around the squad's start kept free of walls and lurkers. */
function startZone(): Obstacle {
  return { x: EXPEDITION_START.x - 260, y: EXPEDITION_START.y - 140, w: 520, h: 260 };
}

/** Scattered walls and hills over the whole map, leaving the start and the
 *  extraction zone open. */
export function generateExpeditionMap(rng: Rng = Math.random): ExpeditionMap {
  const W = EXPEDITION_MAP_WIDTH;
  const H = EXPEDITION_MAP_HEIGHT;
  const extraction = extractionZone();
  const keepClear = [extraction, startZone()];

  const obstacles: Obstacle[] = [];
  for (let attempt = 0; attempt < 500 && obstacles.length < 34; attempt++) {
    const horizontal = rng() < 0.5;
    const long = range(rng, 60, 150);
    const thick = range(rng, 22, 40);
    const w = Math.round(horizontal ? long : thick);
    const h = Math.round(horizontal ? thick : long);
    const rect = {
      x: Math.round(range(rng, 40, W - 40 - w)),
      y: Math.round(range(rng, 230, H - 180 - h)),
      w, h,
    };
    // Generous gaps keep lanes open between walls
    if (keepClear.some(z => overlaps(rect, z, 40))) continue;
    if (obstacles.some(o => overlaps(rect, o, 70))) continue;
    obstacles.push(rect);
  }

  const elevationZones: ElevationZone[] = [];
  for (let attempt = 0; attempt < 200 && elevationZones.length < 8; attempt++) {
    const w = Math.round(range(rng, 90, 160));
    const h = Math.round(range(rng, 80, 140));
    const zone = {
      x: Math.round(range(rng, 40, W - 40 - w)),
      y: Math.round(range(rng, 260, H - 260 - h)),
      w, h,
    };
    if (keepClear.some(z => overlaps(zone, z, 20))) continue;
    if (elevationZones.some(z => overlaps(zone, z, 120))) continue;
    elevationZones.push(zone);
  }

  return { obstacles, elevationZones, extraction };
}

/** The squad, lined up at the bottom of the map. */
export function createExpeditionSquad(blocks: Obstacle[] = []): Unit[] {
  const units: Unit[] = [];
  const total = EXPEDITION_SQUAD.reduce((n, c) => n + c.count, 0);
  const spacing = 60;
  const startX = EXPEDITION_START.x - (spacing * (total - 1)) / 2;
  let i = 0;
  for (const { type, count } of EXPEDITION_SQUAD) {
    for (let k = 0; k < count; k++) {
      const pos = nudgeOutOfBlocks({ x: startX + spacing * i, y: EXPEDITION_START.y }, blocks);
      units.push(createUnit(`blue_${type}_${k}`, type, 'blue', pos));
      i++;
    }
  }
  return units;
}

/** Packs of sleeping enemies between the start and the extraction zone.
 *  Packs further north are bigger and bring heavier enemies. */
export function spawnLurkers(map: ExpeditionMap, rng: Rng = Math.random): Unit[] {
  const units: Unit[] = [];
  const W = EXPEDITION_MAP_WIDTH;
  const packs = 9;
  let n = 0;
  for (let p = 0; p < packs; p++) {
    // Spread packs top to bottom so every stretch of the trip has some
    const band = (p + rng()) / packs;
    const y = 280 + band * (EXPEDITION_START.y - 520 - 280);
    const center = { x: range(rng, 90, W - 90), y };
    // 0 at the start end, 1 at the extraction end
    const depth = 1 - band;
    const size = 2 + Math.floor(depth * 3 + rng() * 2);
    for (let k = 0; k < size; k++) {
      let type: UnitType = 'zombie';
      if (k === 0 && depth > 0.4 && rng() < 0.6) type = rng() < 0.5 ? 'bomber' : 'shielder';
      const angle = (k / size) * Math.PI * 2 + rng();
      const r = 18 + rng() * 34;
      const pos = nudgeOutOfBlocks({ x: center.x + Math.cos(angle) * r, y: center.y + Math.sin(angle) * r }, map.obstacles, UNIT_STATS[type].radius + 4);
      const unit = createUnit(`red_lurk_${n++}`, type, 'red', clampToMap(pos));
      unit.dormant = true;
      units.push(unit);
    }
  }
  return units;
}

/** What a round's pursuit group is made of. Grows each round, and by half
 *  again when the squad stalled. */
export function pursuitComposition(round: number, stalled: boolean): { type: UnitType; count: number }[] {
  const zombies = Math.round((3 + round * 1.3) * (stalled ? 1.5 : 1));
  const comp: { type: UnitType; count: number }[] = [{ type: 'zombie', count: zombies }];
  if (round >= 3 && round % 2 === 1) comp.push({ type: 'bomber', count: 1 + Math.floor(round / 6) });
  if (round >= 5) comp.push({ type: 'shielder', count: Math.floor((round - 3) / 2) });
  if (round >= 6 && round % 3 === 0) comp.push({ type: 'blade', count: 1 });
  return comp.filter(c => c.count > 0);
}

/**
 * Enemies arriving at the start of `round` (2 and up): behind the squad, and
 * from round 4 also from the sides, never within MIN_SPAWN_DISTANCE of a blue
 * unit. Capped so the alive total stays under MAX_ALIVE_ENEMIES. `units` may
 * hold both teams; only living blue units count as the squad.
 */
export function spawnPursuers(
  round: number,
  units: Unit[],
  aliveEnemies: number,
  stalled: boolean,
  blocks: Obstacle[],
  rng: Rng = Math.random,
): Unit[] {
  const squad = units.filter(u => u.alive && u.team === 'blue');
  if (squad.length === 0) return [];
  const center = centroid(squad.map(u => u.pos));
  const rearY = Math.max(...squad.map(u => u.pos.y));
  const budget = Math.max(0, MAX_ALIVE_ENEMIES - aliveEnemies);
  const tooClose = (p: Vec2) => squad.some(b => dist(b.pos, p) < MIN_SPAWN_DISTANCE);
  const behind = (): Vec2 => ({
    x: center.x + range(rng, -220, 220),
    y: rearY + PURSUIT_DISTANCE + range(rng, 0, 80),
  });
  const side = (): Vec2 => ({
    x: rng() < 0.5 ? 25 : EXPEDITION_MAP_WIDTH - 25,
    y: center.y + range(rng, -40, 220),
  });
  const arrivals: Unit[] = [];
  let n = 0;
  for (const { type, count } of pursuitComposition(round, stalled)) {
    for (let k = 0; k < count && arrivals.length < budget; k++) {
      const radius = UNIT_STATS[type].radius;
      const preferSide = round >= 4 && rng() < 0.35;
      // Try the preferred direction, then the other; a spot that lands too
      // close (no room behind, or the squad hugging a side) is skipped
      let pos: Vec2 | null = null;
      for (let attempt = 0; attempt < 4 && !pos; attempt++) {
        const fromSide = attempt % 2 === 0 ? preferSide : !preferSide;
        const p = nudgeOutOfBlocks(clampToMap(fromSide ? side() : behind()), blocks, radius + 4);
        if (!tooClose(p)) pos = p;
      }
      if (pos) arrivals.push(createUnit(`red_r${round}_${n++}`, type, 'red', pos));
    }
  }
  return arrivals;
}

/** Wake lurkers that a blue unit came near or that took damage, and their
 *  pack-mates. Returns how many woke. */
export function wakeLurkers(units: Unit[]): number {
  const blue = units.filter(u => u.alive && u.team === 'blue');
  const woken: Unit[] = [];
  for (const u of units) {
    if (!u.dormant || !u.alive) continue;
    const hurt = u.hp < u.maxHp;
    if (hurt || blue.some(b => dist(b.pos, u.pos) < LURKER_WAKE_RADIUS)) {
      u.dormant = false;
      woken.push(u);
    }
  }
  // Rouse the pack (one hop is enough: packs are tight)
  for (const w of woken) {
    for (const u of units) {
      if (u.dormant && u.alive && dist(u.pos, w.pos) < PACK_WAKE_RADIUS) u.dormant = false;
    }
  }
  // A dead lurker never needs waking again
  for (const u of units) if (u.dormant && !u.alive) u.dormant = false;
  return woken.length;
}

function inside(p: Vec2, r: Obstacle): boolean {
  return p.x >= r.x && p.x <= r.x + r.w && p.y >= r.y && p.y <= r.y + r.h;
}

/** Living blue units standing in the extraction zone. */
export function unitsInZone(units: Unit[], extraction: Obstacle): Unit[] {
  return units.filter(u => u.alive && u.team === 'blue' && inside(u.pos, extraction));
}

/** How far the squad still has to go: from its centre to the zone's edge. */
export function distanceToExtraction(units: Unit[], extraction: Obstacle): number {
  const blue = units.filter(u => u.alive && u.team === 'blue');
  if (blue.length === 0) return 0;
  const c = centroid(blue.map(u => u.pos));
  const dx = Math.max(extraction.x - c.x, 0, c.x - (extraction.x + extraction.w));
  const dy = Math.max(extraction.y - c.y, 0, c.y - (extraction.y + extraction.h));
  return Math.round(Math.hypot(dx, dy));
}

export function centroid(points: Vec2[]): Vec2 {
  if (points.length === 0) return { x: 0, y: 0 };
  let x = 0;
  let y = 0;
  for (const p of points) { x += p.x; y += p.y; }
  return { x: x / points.length, y: y / points.length };
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function clampToMap(p: Vec2): Vec2 {
  return {
    x: Math.max(15, Math.min(EXPEDITION_MAP_WIDTH - 15, p.x)),
    y: Math.max(15, Math.min(EXPEDITION_MAP_HEIGHT - 15, p.y)),
  };
}

/** Best (fewest rounds) extraction, kept on this device. */
const RECORD_KEY = 'expedition-record';

export interface ExpeditionRecord { extractions: number; bestRounds: number }

export function getExpeditionRecord(): ExpeditionRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(RECORD_KEY) ?? 'null');
    if (raw && Number.isFinite(raw.extractions) && Number.isFinite(raw.bestRounds)) return raw;
  } catch { /* unavailable or corrupt */ }
  return { extractions: 0, bestRounds: 0 };
}

export function recordExtraction(rounds: number): ExpeditionRecord {
  const prev = getExpeditionRecord();
  const next = {
    extractions: prev.extractions + 1,
    bestRounds: prev.bestRounds === 0 ? rounds : Math.min(prev.bestRounds, rounds),
  };
  try { localStorage.setItem(RECORD_KEY, JSON.stringify(next)); } catch { /* unavailable */ }
  return next;
}
