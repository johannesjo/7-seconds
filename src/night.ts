// Night battles: a vs-AI map modifier that turns the full-information board
// into a fight over information. Each unit sees only a short way; a team may
// only target enemies that one of its units can see (or that just gave
// themselves away with a muzzle flash), mortars need a spotter, and in
// planning the player sees only what was in sight when the round ended, plus
// ghosts where other enemies were last seen.
//
// Pure and headless (no pixi): the engine runs these rules in its fixed-step
// simulation, so night battles stay deterministic. Night is never used online.
import type { ElevationZone, Obstacle, Team, Unit, Vec2 } from './types';
import { ELEVATION_RANGE_BONUS } from './constants';
import { getElevationLevel, hasLineOfSight } from './units';

/** How far each unit type sees at night (map pixels, centre to centre,
 *  before the target's radius). Soldiers see a little beyond their gun;
 *  snipers and mortars outrange their own eyes and need spotters. */
export const NIGHT_SIGHT: Record<Unit['type'], number> = {
  soldier: 140,
  sniper: 170,
  blade: 125,
  zombie: 120,
  shielder: 130,
  bomber: 110,
  mortar: 110,
  rocketeer: 140,
};

/** Seconds a unit stays visible to the enemy after firing. */
export const MUZZLE_REVEAL_S = 1;

/** Dawn: from this round on, sight grows each round so the last few units
 *  can't hide from each other forever. */
export const DAWN = { fromRound: 5, stepPerRound: 0.15 };

/** Sight multiplier for a round (1 until dawn starts breaking). */
export function dawnScale(round: number): number {
  return 1 + DAWN.stepPerRound * Math.max(0, round - DAWN.fromRound + 1);
}

/** Sight radius of a unit where it stands; hills extend sight like range. */
export function sightRadius(unit: Unit, zones: ElevationZone[] = [], scale = 1): number {
  const level = getElevationLevel(unit.pos, zones);
  return NIGHT_SIGHT[unit.type] * scale * (1 + ELEVATION_RANGE_BONUS * level);
}

/** Whether `viewer` itself sees `target`: within sight and with a clear line. */
export function unitSees(viewer: Unit, target: Unit, obstacles: Obstacle[], zones: ElevationZone[] = [], scale = 1): boolean {
  if (!viewer.alive || !target.alive) return false;
  const d = Math.hypot(target.pos.x - viewer.pos.x, target.pos.y - viewer.pos.y);
  if (d > sightRadius(viewer, zones, scale) + target.radius) return false;
  return hasLineOfSight(viewer.pos, target.pos, obstacles);
}

/** Ids of the enemies of `team` it can currently see: spotted by any living
 *  friendly unit, or revealed by a recent muzzle flash. */
export function teamVisibleEnemies(
  team: Team,
  units: Unit[],
  obstacles: Obstacle[],
  zones: ElevationZone[] = [],
  revealed: ReadonlyMap<string, number> = new Map(),
  scale = 1,
): Set<string> {
  const seen = new Set<string>();
  const friends = units.filter(u => u.alive && u.team === team);
  for (const enemy of units) {
    if (!enemy.alive || enemy.team === team) continue;
    if ((revealed.get(enemy.id) ?? 0) > 0 || friends.some(f => unitSees(f, enemy, obstacles, zones, scale))) {
      seen.add(enemy.id);
    }
  }
  return seen;
}

/** Per-battle night state: muzzle-flash reveals and what each team has seen. */
export class NightVision {
  /** Seconds of muzzle-flash reveal left, by unit id. */
  readonly revealed = new Map<string, number>();
  /** Enemies each team sees right now. */
  visible: Record<Team, Set<string>> = { blue: new Set(), red: new Set() };
  /** Where each team last saw each enemy (by enemy id). */
  readonly lastSeen: Record<Team, Map<string, Vec2>> = { blue: new Map(), red: new Map() };
  /** Sight multiplier for the current round (see dawnScale). */
  sightScale = 1;
  /** Per-team targeting filters (built once; the engine asks every tick). */
  readonly canSee: Record<Team, (enemy: Unit) => boolean> = {
    blue: (enemy) => this.visible.blue.has(enemy.id),
    red: (enemy) => this.visible.red.has(enemy.id),
  };

  /** A new round starts: dawn may have pushed sight further. */
  setRound(round: number): void {
    this.sightScale = dawnScale(round);
  }

  /** Start of battle: scouts report the enemy's deployment, so round 1 can
   *  be planned against real (soon stale) positions. */
  seedDeployment(units: Unit[]): void {
    for (const u of units) {
      if (!u.alive) continue;
      const viewer: Team = u.team === 'blue' ? 'red' : 'blue';
      this.lastSeen[viewer].set(u.id, { x: u.pos.x, y: u.pos.y });
    }
  }

  /** A unit fired: it stands out for MUZZLE_REVEAL_S. */
  noteFire(unit: Unit): void {
    this.revealed.set(unit.id, MUZZLE_REVEAL_S);
  }

  /** Round over: muzzle flashes fade. Where the shooters stood is kept as
   *  their last-known position (call after a final update). */
  endRound(): void {
    this.revealed.clear();
  }

  /** Advance reveal timers by one fixed step. */
  tick(dt: number): void {
    for (const [id, t] of this.revealed) {
      if (t - dt <= 0) this.revealed.delete(id);
      else this.revealed.set(id, t - dt);
    }
  }

  /** Recompute what both teams see, and remember where seen enemies are. */
  update(units: Unit[], obstacles: Obstacle[], zones: ElevationZone[] = []): void {
    for (const team of ['blue', 'red'] as Team[]) {
      const seen = teamVisibleEnemies(team, units, obstacles, zones, this.revealed, this.sightScale);
      this.visible[team] = seen;
      const memory = this.lastSeen[team];
      for (const u of units) {
        if (u.team === team) continue;
        if (!u.alive) memory.delete(u.id);
        else if (seen.has(u.id)) memory.set(u.id, { x: u.pos.x, y: u.pos.y });
      }
    }
  }

  /** Whether `team` may target `enemy` right now. */
  canTarget(team: Team, enemy: Unit): boolean {
    return this.visible[team].has(enemy.id);
  }
}

/** Distance along a ray from `o` (unit direction dx, dy) to where it enters
 *  `r`, or Infinity (slab method, unrolled: it runs for every ray each frame). */
function rayRectDistance(o: Vec2, dx: number, dy: number, r: Obstacle): number {
  let tMin = 0;
  let tMax = Infinity;
  if (Math.abs(dx) < 1e-9) {
    if (o.x < r.x || o.x > r.x + r.w) return Infinity;
  } else {
    const t1 = (r.x - o.x) / dx;
    const t2 = (r.x + r.w - o.x) / dx;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return Infinity;
  }
  if (Math.abs(dy) < 1e-9) {
    if (o.y < r.y || o.y > r.y + r.h) return Infinity;
  } else {
    const t1 = (r.y - o.y) / dy;
    const t2 = (r.y + r.h - o.y) / dy;
    tMin = Math.max(tMin, Math.min(t1, t2));
    tMax = Math.min(tMax, Math.max(t1, t2));
    if (tMin > tMax) return Infinity;
  }
  return tMin;
}

/** The area a unit can see, as a polygon: a circle of its sight radius cut
 *  short where obstacles block the view. For drawing only. */
export function sightPolygon(unit: Unit, obstacles: Obstacle[], zones: ElevationZone[] = [], scale = 1, rays = 96): Vec2[] {
  const radius = sightRadius(unit, zones, scale);
  // Only obstacles that reach into the sight circle can block it.
  const { x, y } = unit.pos;
  const near = obstacles.filter(o =>
    o.x - radius <= x && x <= o.x + o.w + radius && o.y - radius <= y && y <= o.y + o.h + radius);
  const points: Vec2[] = [];
  for (let i = 0; i < rays; i++) {
    const a = (i / rays) * Math.PI * 2;
    const dx = Math.cos(a);
    const dy = Math.sin(a);
    let reach = radius;
    for (const o of near) reach = Math.min(reach, rayRectDistance(unit.pos, dx, dy, o));
    // Let the light spill a few pixels onto the wall face so cover reads.
    if (reach < radius) reach = Math.min(radius, reach + 4);
    points.push({ x: unit.pos.x + dx * reach, y: unit.pos.y + dy * reach });
  }
  return points;
}
