// Area-damage ordnance: the mortar's arcing shells and the rocketeer's
// player-drawn rockets. Both burst in a blast that hurts every enemy inside it
// and ignores shields, so they counter units hiding behind cover or a shielder.
// Kept apart from the straight-flying bullets in units.ts, which have per-unit
// hit, shield and flank rules.
import type { ElevationZone, Obstacle, Projectile, Team, Unit, Vec2 } from './types';
import {
  MAP_WIDTH, MAP_HEIGHT, COLLISION_HITBOX_SCALE,
  MORTAR_BLAST_RADIUS, MORTAR_FLIGHT_S, ROCKET_BLAST_RADIUS, ROCKET_MAX_PATH,
} from './constants';
import { applyDamage, mortarCanReach, segmentHitsRect } from './units';

export interface OrdnanceHit {
  pos: Vec2;
  targetId: string;
  killed: boolean;
  team: Team;
  angle: number;
  damage: number;
  flanked: boolean;
}

export interface Explosion {
  pos: Vec2;
  radius: number;
  team: Team;
}

function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** The mortar's target: its focus target when reachable, else the nearest
 *  reachable enemy. */
export function findMortarTarget(mortar: Unit, allUnits: Unit[], elevationZones: ElevationZone[]): Unit | null {
  let best: Unit | null = null;
  let bestDist = Infinity;
  for (const u of allUnits) {
    if (!u.alive || u.team === mortar.team || !mortarCanReach(mortar, u, elevationZones)) continue;
    if (u.id === mortar.attackTargetId) return u;
    const d = dist(mortar.pos, u.pos);
    if (d < bestDist) {
      best = u;
      bestDist = d;
    }
  }
  return best;
}

/** Lob a shell at where the target stands *now*. No lead: moving targets can
 *  walk out of the blast, while units that stand or jitter in place get hit. */
export function fireMortar(mortar: Unit, target: Unit, dt: number): Projectile[] {
  mortar.fireTimer -= dt;
  if (mortar.fireTimer > 0) return [];
  const aim = Math.atan2(target.pos.y - mortar.pos.y, target.pos.x - mortar.pos.x);
  let diff = aim - mortar.gunAngle;
  diff = ((diff + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (diff < -Math.PI) diff += 2 * Math.PI;
  if (Math.abs(diff) > 0.3) return [];

  mortar.fireTimer = mortar.fireCooldown;
  const origin = { x: mortar.pos.x, y: mortar.pos.y };
  const landing = { x: target.pos.x, y: target.pos.y };
  return [{
    kind: 'shell',
    pos: { ...origin },
    origin,
    target: landing,
    vel: { x: (landing.x - origin.x) / MORTAR_FLIGHT_S, y: (landing.y - origin.y) / MORTAR_FLIGHT_S },
    age: 0,
    flightTime: MORTAR_FLIGHT_S,
    damage: mortar.damage,
    radius: mortar.projectileRadius,
    blastRadius: MORTAR_BLAST_RADIUS,
    team: mortar.team,
    maxRange: Infinity,
    distanceTraveled: 0,
  }];
}

/** True when a rocketeer should launch now: it has a drawn rocket left and
 *  has finished its move (including any hold). */
export function rocketReady(unit: Unit): boolean {
  return unit.type === 'rocketeer' && unit.alive && !unit.rocketFired
    && (unit.rocketPath?.length ?? 0) > 0
    && unit.moveTarget === null && unit.waypoints.length === 0 && !((unit.holdTimer ?? 0) > 0);
}

export function launchRocket(unit: Unit): Projectile {
  unit.rocketFired = true;
  const path = (unit.rocketPath ?? []).map(p => ({ x: p.x, y: p.y }));
  const first = path[0];
  const d = dist(unit.pos, first) || 1;
  unit.gunAngle = Math.atan2(first.y - unit.pos.y, first.x - unit.pos.x);
  return {
    kind: 'rocket',
    pos: { x: unit.pos.x, y: unit.pos.y },
    vel: { x: ((first.x - unit.pos.x) / d) * unit.projectileSpeed, y: ((first.y - unit.pos.y) / d) * unit.projectileSpeed },
    target: path[path.length - 1],
    path,
    damage: unit.damage,
    radius: unit.projectileRadius,
    blastRadius: ROCKET_BLAST_RADIUS,
    team: unit.team,
    // Slack for a launch point that drifted from where the path was drawn.
    maxRange: ROCKET_MAX_PATH + 100,
    distanceTraveled: 0,
  };
}

/** Damage and knock back every enemy of `team` within the blast. */
function explode(pos: Vec2, radius: number, damage: number, team: Team, units: Unit[], hits: OrdnanceHit[]): void {
  for (const u of units) {
    if (!u.alive || u.team === team) continue;
    const d = dist(pos, u.pos);
    if (d > radius + u.radius * COLLISION_HITBOX_SCALE) continue;
    const angle = Math.atan2(u.pos.y - pos.y, u.pos.x - pos.x);
    const kbSpeed = 30 / 0.15;
    u.knockbackVel = { x: Math.cos(angle) * kbSpeed, y: Math.sin(angle) * kbSpeed };
    const before = u.hp;
    applyDamage(u, damage);
    hits.push({
      pos: { x: u.pos.x, y: u.pos.y }, targetId: u.id, killed: before > 0 && !u.alive,
      team, angle, damage, flanked: false,
    });
  }
}

/** Advance shells and rockets one step; burst the ones that land or collide. */
export function updateOrdnance(
  projectiles: Projectile[],
  units: Unit[],
  dt: number,
  obstacles: Obstacle[],
): { alive: Projectile[]; hits: OrdnanceHit[]; explosions: Explosion[] } {
  const alive: Projectile[] = [];
  const hits: OrdnanceHit[] = [];
  const explosions: Explosion[] = [];
  const burst = (p: Projectile, at: Vec2) => {
    const radius = p.blastRadius ?? 0;
    explosions.push({ pos: { x: at.x, y: at.y }, radius, team: p.team });
    explode(at, radius, p.damage, p.team, units, hits);
  };

  for (const p of projectiles) {
    if (p.kind === 'shell') {
      // Flies over everything; only the landing point matters.
      p.age = (p.age ?? 0) + dt;
      const t = Math.min(1, p.age / (p.flightTime ?? MORTAR_FLIGHT_S));
      const o = p.origin ?? p.pos;
      p.pos = { x: o.x + (p.target.x - o.x) * t, y: o.y + (p.target.y - o.y) * t };
      if (t >= 1) burst(p, p.target);
      else alive.push(p);
      continue;
    }

    // Rocket: steer along the drawn path.
    const path = p.path ?? [];
    const oldPos = { x: p.pos.x, y: p.pos.y };
    let step = Math.hypot(p.vel.x, p.vel.y) * dt;
    while (step > 0 && path.length > 0) {
      const next = path[0];
      const d = dist(p.pos, next);
      if (d <= step) {
        p.pos = { x: next.x, y: next.y };
        step -= d;
        p.distanceTraveled += d;
        path.shift();
      } else {
        const speed = Math.hypot(p.vel.x, p.vel.y);
        p.vel = { x: ((next.x - p.pos.x) / d) * speed, y: ((next.y - p.pos.y) / d) * speed };
        p.pos = { x: p.pos.x + ((next.x - p.pos.x) / d) * step, y: p.pos.y + ((next.y - p.pos.y) / d) * step };
        p.distanceTraveled += step;
        step = 0;
      }
    }
    if (!p.trail) p.trail = [];
    p.trail.push({ x: p.pos.x, y: p.pos.y });
    if (p.trail.length > 8) p.trail.shift();

    const outside = p.pos.x < 0 || p.pos.x > MAP_WIDTH || p.pos.y < 0 || p.pos.y > MAP_HEIGHT;
    const wall = obstacles.some(o => segmentHitsRect(oldPos, p.pos, o, p.radius));
    const struck = units.some(u => u.alive && u.team !== p.team
      && dist(p.pos, u.pos) <= p.radius + u.radius * COLLISION_HITBOX_SCALE);
    if (wall) burst(p, oldPos);
    else if (outside || struck || path.length === 0 || p.distanceTraveled > p.maxRange) burst(p, p.pos);
    else alive.push(p);
  }

  return { alive, hits, explosions };
}
