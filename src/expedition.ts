/**
 * Expedition: cross a large map to the extraction zone while the horde closes
 * in. Lurkers sleep along the way until you get near; pursuers spawn behind
 * the squad every round, and more of them when the squad stalls. Stranded
 * survivors off the direct route join the squad when a unit reaches them, but
 * each has a sleeping guard that wakes on the way in. Once a unit stands in
 * the zone the player chooses when to call the evac: it lands at the end of
 * that round and takes whoever is inside. Waiting for stragglers counts as a
 * stall, so the horde grows meanwhile. The score is how many get out.
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
];

export interface ExpeditionMap {
  obstacles: Obstacle[];
  elevationZones: ElevationZone[];
  /** Reach it to call the evac; be inside when it lands to get out. */
  extraction: Obstacle;
}

/** A friendly unit waiting to be picked up; not part of the battle until rescued. */
export interface Survivor {
  id: string;
  type: UnitType;
  pos: Vec2;
}

export interface ExpeditionSetup extends ExpeditionMap {
  units: Unit[];
  survivors?: Survivor[];
}

/** A blue unit this close to a survivor picks it up. */
export const RESCUE_RADIUS = 60;
/** How many survivors each expedition strands. */
export const SURVIVOR_COUNT = 3;

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

/**
 * Stranded survivors, one per stretch of the trip (near the start, midway,
 * near the end), each against a side wall (alternating sides) so reaching
 * it is a detour. A small
 * sleeping guard stands close enough that a rescuer always wakes it; guards
 * further north are bigger and heavier.
 */
export function placeSurvivors(map: ExpeditionMap, rng: Rng = Math.random): { survivors: Survivor[]; guards: Unit[] } {
  const W = EXPEDITION_MAP_WIDTH;
  const survivors: Survivor[] = [];
  const guards: Unit[] = [];
  const top = 420;
  const bottom = EXPEDITION_START.y - 380;
  // Alternate sides so no one flank collects them all
  const firstLeft = rng() < 0.5;
  for (let i = 0; i < SURVIVOR_COUNT; i++) {
    // i = 0 is the stretch nearest the start
    const y = bottom - ((i + 0.25 + rng() * 0.5) / SURVIVOR_COUNT) * (bottom - top);
    const left = (i % 2 === 0) === firstLeft;
    const x = left ? range(rng, 70, 200) : range(rng, W - 200, W - 70);
    const type: UnitType = i === 1 ? 'sniper' : 'soldier';
    const pos = clampToMap(nudgeOutOfBlocks({ x, y }, map.obstacles, UNIT_STATS[type].radius + 4));
    survivors.push({ id: `blue_survivor_${i}`, type, pos });

    const size = 2 + i;
    for (let k = 0; k < size; k++) {
      const guardType: UnitType = i === SURVIVOR_COUNT - 1 && k === 0 ? 'shielder' : 'zombie';
      // Spread over the side facing the open map, between the survivor and the route
      const angle = (left ? 0 : Math.PI) + ((k + 0.5) / size - 0.5) * Math.PI * 0.9;
      const r = 80 + rng() * 25;
      const at = nudgeOutOfBlocks({ x: pos.x + Math.cos(angle) * r, y: pos.y + Math.sin(angle) * r }, map.obstacles, UNIT_STATS[guardType].radius + 4);
      const guard = createUnit(`red_guard_${i}_${k}`, guardType, 'red', clampToMap(at));
      guard.dormant = true;
      guards.push(guard);
    }
  }
  return { survivors, guards };
}

/**
 * Survivors a living blue unit has reached: removed from `survivors` and
 * returned as squad units, ready to fight.
 */
export function rescueSurvivors(units: Unit[], survivors: Survivor[]): Unit[] {
  const blue = units.filter(u => u.alive && u.team === 'blue');
  const rescued: Unit[] = [];
  for (let i = survivors.length - 1; i >= 0; i--) {
    const s = survivors[i];
    if (!blue.some(b => dist(b.pos, s.pos) < RESCUE_RADIUS)) continue;
    survivors.splice(i, 1);
    rescued.unshift(createUnit(s.id, s.type, 'blue', { x: s.pos.x, y: s.pos.y }));
  }
  return rescued;
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

/** Wake rings show once a planned path comes this much closer than the wake radius. */
const WAKE_RING_MARGIN = 120;

/**
 * Planning: the sleeping enemies a planned path passes near, so their wake
 * radius can be shown — `crossed` when the path enters it and would wake them.
 */
export function wakeRings(paths: Vec2[][], units: Unit[], radius: number): { pos: Vec2; crossed: boolean }[] {
  const rings: { pos: Vec2; crossed: boolean }[] = [];
  for (const u of units) {
    if (!u.dormant || !u.alive) continue;
    const closest = Math.min(...paths.map(p => distanceToPath(u.pos, p)));
    if (closest < radius + WAKE_RING_MARGIN) rings.push({ pos: u.pos, crossed: closest < radius });
  }
  return rings;
}

function distanceToPath(p: Vec2, path: Vec2[]): number {
  let best = Infinity;
  for (let i = 1; i < path.length; i++) best = Math.min(best, distanceToSegment(p, path[i - 1], path[i]));
  return best;
}

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return dist(p, { x: a.x + t * dx, y: a.y + t * dy });
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

/** Room kept between the squad and the view's edges when planning. The
 *  bottom is larger: the Done button sits over the map there. */
const FRAME_MARGIN = { top: 60, side: 70, bottom: 130 };
/** How far in planning zooms, as a share of the most it allows: in enough
 *  to draw, out enough to see the packs ahead. */
const FRAME_ZOOM_SHARE = 0.72;

/**
 * The planning view for the squad at `points`: its rearmost unit near the
 * bottom of the view so the way north (to the extraction) fills the rest,
 * and every unit in sight (zooming out if the squad is spread). The caller
 * clamps it to the map.
 */
export function planningFrame(points: Vec2[], maxZoom: number, mapW: number, mapH: number): { center: Vec2; zoom: number } {
  if (points.length === 0) return { center: { x: mapW / 2, y: mapH / 2 }, zoom: 1 };
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
  }
  const m = FRAME_MARGIN;
  const zoom = Math.max(1, Math.min(
    maxZoom * FRAME_ZOOM_SHARE,
    mapW / (maxX - minX + m.side * 2),
    mapH / (maxY - minY + m.top + m.bottom),
  ));
  const viewH = mapH / zoom;
  return {
    center: { x: (minX + maxX) / 2, y: maxY + m.bottom - viewH / 2 },
    zoom,
  };
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

/** The haul as stars: one for getting anyone out, a second for the whole
 *  starting squad's worth, a third for bringing out every survivor too. */
export function expeditionStars(out: number): string {
  const squad = EXPEDITION_SQUAD.reduce((n, c) => n + c.count, 0);
  const stars = out >= squad + SURVIVOR_COUNT ? 3 : out >= squad ? 2 : out > 0 ? 1 : 0;
  return '★'.repeat(stars) + '☆'.repeat(3 - stars);
}

/** Best extractions, kept on this device: the most units brought out, and
 *  the fewest rounds. */
const RECORD_KEY = 'expedition-record';

export interface ExpeditionRecord { extractions: number; bestRounds: number; bestOut: number }

export function getExpeditionRecord(): ExpeditionRecord {
  try {
    const raw = JSON.parse(localStorage.getItem(RECORD_KEY) ?? 'null');
    if (raw && Number.isFinite(raw.extractions) && Number.isFinite(raw.bestRounds)) {
      // Records from before scoring have no haul yet
      return { extractions: raw.extractions, bestRounds: raw.bestRounds, bestOut: Number.isFinite(raw.bestOut) ? raw.bestOut : 0 };
    }
  } catch { /* unavailable or corrupt */ }
  return { extractions: 0, bestRounds: 0, bestOut: 0 };
}

export function recordExtraction(rounds: number, out: number): ExpeditionRecord {
  const prev = getExpeditionRecord();
  const next = {
    extractions: prev.extractions + 1,
    bestRounds: prev.bestRounds === 0 ? rounds : Math.min(prev.bestRounds, rounds),
    bestOut: Math.max(prev.bestOut, out),
  };
  try { localStorage.setItem(RECORD_KEY, JSON.stringify(next)); } catch { /* unavailable */ }
  return next;
}
