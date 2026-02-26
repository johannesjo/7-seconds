import { Unit, UnitType, Team, Vec2, Obstacle, Projectile, ElevationZone } from './types';

export interface ProjectileHit {
  pos: Vec2;
  targetId: string;
  killed: boolean;
  team: Team;
}
import { UNIT_STATS, ARMY_COMPOSITION, MAP_WIDTH, MAP_HEIGHT, ELEVATION_RANGE_BONUS } from './constants';

export function createUnit(id: string, type: UnitType, team: Team, pos: Vec2): Unit {
  const stats = UNIT_STATS[type];
  return {
    id,
    type,
    team,
    pos: { ...pos },
    hp: stats.hp,
    maxHp: stats.hp,
    speed: stats.speed,
    damage: stats.damage,
    range: stats.range,
    radius: stats.radius,
    moveTarget: null,
    waypoints: [],
    attackTargetId: null,
    alive: true,
    fireCooldown: stats.fireCooldown,
    fireTimer: 0,
    projectileSpeed: stats.projectileSpeed,
    projectileRadius: stats.projectileRadius,
    vel: { x: 0, y: 0 },
    gunAngle: team === 'blue' ? -Math.PI / 2 : Math.PI / 2,
  };
}

export function createArmy(team: Team): Unit[] {
  const units: Unit[] = [];
  const isBlue = team === 'blue';
  const baseY = isBlue ? MAP_HEIGHT * 0.85 : MAP_HEIGHT * 0.15;
  const totalUnits = ARMY_COMPOSITION.reduce((sum, c) => sum + c.count, 0);
  const spacing = 60;
  const groupWidth = spacing * (totalUnits - 1);
  const startX = (MAP_WIDTH - groupWidth) / 2;
  let index = 0;

  for (const { type, count } of ARMY_COMPOSITION) {
    for (let i = 0; i < count; i++) {
      const x = startX + spacing * index;
      const pos = { x, y: baseY };
      units.push(createUnit(`${team}_${type}_${i}`, type, team, pos));
      index++;
    }
  }

  return units;
}

/** Create an army from a custom composition (used by campaign missions). */
export function createMissionArmy(team: Team, composition: { type: UnitType; count: number }[]): Unit[] {
  const units: Unit[] = [];
  const isBlue = team === 'blue';
  const totalUnits = composition.reduce((sum, c) => sum + c.count, 0);
  const spacing = 60;

  if (isBlue) {
    // Blue spawns at bottom, single row like createArmy
    const baseY = MAP_HEIGHT * 0.85;
    const groupWidth = spacing * (totalUnits - 1);
    const startX = (MAP_WIDTH - groupWidth) / 2;
    let index = 0;
    for (const { type, count } of composition) {
      for (let i = 0; i < count; i++) {
        const x = startX + spacing * index;
        units.push(createUnit(`${team}_${type}_${i}`, type, team, { x, y: baseY }));
        index++;
      }
    }
  } else {
    // Red spawns spread across the top ~60% of the map
    const margin = 80;
    const xRange = MAP_WIDTH - margin * 2;
    const yMin = MAP_HEIGHT * 0.08;
    const yMax = MAP_HEIGHT * 0.55;
    // Deterministic spread: distribute evenly with staggered offsets
    const cols = Math.min(totalUnits, Math.ceil(Math.sqrt(totalUnits * 2)));
    const rows = Math.ceil(totalUnits / cols);
    const xStep = xRange / Math.max(cols, 1);
    const yStep = (yMax - yMin) / Math.max(rows, 1);
    let index = 0;
    for (const { type, count } of composition) {
      for (let i = 0; i < count; i++) {
        const row = Math.floor(index / cols);
        const col = index % cols;
        // Stagger odd rows by half a step for a less grid-like feel
        const stagger = row % 2 === 1 ? xStep * 0.5 : 0;
        const x = margin + xStep * 0.5 + col * xStep + stagger;
        const y = yMin + yStep * 0.5 + row * yStep;
        units.push(createUnit(`${team}_${type}_${i}`, type, team, {
          x: Math.min(x, MAP_WIDTH - margin),
          y,
        }));
        index++;
      }
    }
  }

  return units;
}

/** Smoothly rotate unit.gunAngle toward desiredAngle via shortest arc, capped at ~5 rad/s. */
export function updateGunAngle(unit: Unit, desiredAngle: number, dt: number): void {
  const MAX_TURN_SPEED = 5; // rad/s (~1s for full 180° turn)
  let diff = desiredAngle - unit.gunAngle;
  // Normalize to [-PI, PI] for shortest arc
  diff = ((diff + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (diff < -Math.PI) diff += 2 * Math.PI;
  const maxStep = MAX_TURN_SPEED * dt;
  if (Math.abs(diff) <= maxStep) {
    unit.gunAngle = desiredAngle;
  } else {
    unit.gunAngle += Math.sign(diff) * maxStep;
  }
  // Keep in [-PI, PI]
  unit.gunAngle = ((unit.gunAngle + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (unit.gunAngle < -Math.PI) unit.gunAngle += 2 * Math.PI;
}

/** Pop the next waypoint into moveTarget when the current one is reached. */
export function advanceWaypoint(unit: Unit): void {
  if (!unit.alive) return;

  const atTarget = !unit.moveTarget ||
    (Math.abs(unit.pos.x - unit.moveTarget.x) < 2 &&
     Math.abs(unit.pos.y - unit.moveTarget.y) < 2);

  if (atTarget) {
    unit.moveTarget = unit.waypoints.length > 0
      ? unit.waypoints.shift()!
      : null;
  }
}

function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function rectContainsCircle(obs: Obstacle, pos: Vec2, radius: number): boolean {
  const closestX = clamp(pos.x, obs.x, obs.x + obs.w);
  const closestY = clamp(pos.y, obs.y, obs.y + obs.h);
  const dx = pos.x - closestX;
  const dy = pos.y - closestY;
  return dx * dx + dy * dy < radius * radius;
}

export function moveUnit(unit: Unit, dt: number, obstacles: Obstacle[]): void {
  if (!unit.moveTarget || !unit.alive) {
    unit.vel = { x: 0, y: 0 };
    return;
  }

  const dx = unit.moveTarget.x - unit.pos.x;
  const dy = unit.moveTarget.y - unit.pos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 2) {
    unit.pos.x = unit.moveTarget.x;
    unit.pos.y = unit.moveTarget.y;
    unit.vel = { x: 0, y: 0 };
    return;
  }

  const step = unit.speed * dt;
  const moveX = (dx / dist) * Math.min(step, dist);
  const moveY = (dy / dist) * Math.min(step, dist);

  const oldX = unit.pos.x;
  const oldY = unit.pos.y;

  let newX = oldX + moveX;
  let newY = oldY + moveY;

  // Obstacle avoidance
  const blocked = obstacles.some(o => rectContainsCircle(o, { x: newX, y: newY }, unit.radius));
  if (blocked) {
    const hBlocked = obstacles.some(o => rectContainsCircle(o, { x: newX, y: oldY }, unit.radius));
    const vBlocked = obstacles.some(o => rectContainsCircle(o, { x: oldX, y: newY }, unit.radius));
    if (!hBlocked) {
      newY = oldY;
    } else if (!vBlocked) {
      newX = oldX;
    } else {
      unit.vel = { x: 0, y: 0 };
      return;
    }
  }

  // Clamp to map bounds
  newX = clamp(newX, unit.radius, MAP_WIDTH - unit.radius);
  newY = clamp(newY, unit.radius, MAP_HEIGHT - unit.radius);

  unit.pos.x = newX;
  unit.pos.y = newY;

  // Velocity from actual displacement (accurate for prediction)
  unit.vel = dt > 0
    ? { x: (newX - oldX) / dt, y: (newY - oldY) / dt }
    : { x: 0, y: 0 };
}

/** Push overlapping units apart so they don't stack on the same spot. */
export function separateUnits(units: Unit[]): void {
  const alive = units.filter(u => u.alive);
  for (let i = 0; i < alive.length; i++) {
    for (let j = i + 1; j < alive.length; j++) {
      const a = alive[i];
      const b = alive[j];
      const dx = b.pos.x - a.pos.x;
      const dy = b.pos.y - a.pos.y;
      const dist = Math.sqrt(dx * dx + dy * dy);
      const minDist = a.radius + b.radius;

      if (dist < minDist && dist > 0.01) {
        const overlap = (minDist - dist) / 2;
        const nx = dx / dist;
        const ny = dy / dist;
        a.pos.x -= nx * overlap;
        a.pos.y -= ny * overlap;
        b.pos.x += nx * overlap;
        b.pos.y += ny * overlap;

        // Keep within bounds
        a.pos.x = clamp(a.pos.x, a.radius, MAP_WIDTH - a.radius);
        a.pos.y = clamp(a.pos.y, a.radius, MAP_HEIGHT - a.radius);
        b.pos.x = clamp(b.pos.x, b.radius, MAP_WIDTH - b.radius);
        b.pos.y = clamp(b.pos.y, b.radius, MAP_HEIGHT - b.radius);
      } else if (dist <= 0.01) {
        // Exactly overlapping — nudge apart with small random offset
        a.pos.x -= 1;
        b.pos.x += 1;
      }
    }
  }
}

export function findTarget(attacker: Unit, allUnits: Unit[], preferredId: string | null): Unit | null {
  const enemies = allUnits.filter(u => u.alive && u.team !== attacker.team);
  if (enemies.length === 0) return null;

  if (preferredId) {
    const preferred = enemies.find(u => u.id === preferredId);
    if (preferred) return preferred;
  }

  let nearest = enemies[0];
  let nearestDist = distance(attacker.pos, nearest.pos);
  for (let i = 1; i < enemies.length; i++) {
    const d = distance(attacker.pos, enemies[i].pos);
    if (d < nearestDist) {
      nearest = enemies[i];
      nearestDist = d;
    }
  }
  return nearest;
}

/** Count how many elevation zones overlap a position (0 = flat ground). */
export function getElevationLevel(pos: Vec2, zones: ElevationZone[]): number {
  let level = 0;
  for (const z of zones) {
    if (pos.x >= z.x && pos.x <= z.x + z.w && pos.y >= z.y && pos.y <= z.y + z.h) {
      level++;
    }
  }
  return level;
}

/** Backward-compat wrapper: true when on at least one elevation zone. */
export function isOnElevation(pos: Vec2, zones: ElevationZone[]): boolean {
  return getElevationLevel(pos, zones) > 0;
}

export function isInRange(attacker: Unit, target: Unit, elevationZones: ElevationZone[] = []): boolean {
  const level = getElevationLevel(attacker.pos, elevationZones);
  const range = attacker.range * (1 + ELEVATION_RANGE_BONUS * level);
  return distance(attacker.pos, target.pos) <= range + attacker.radius + target.radius;
}

export function applyDamage(unit: Unit, amount: number): void {
  unit.hp = Math.max(0, unit.hp - amount);
  if (unit.hp === 0) {
    unit.alive = false;
  }
}

export function tryFireProjectile(unit: Unit, target: Unit, dt: number, elevationZones: ElevationZone[] = []): Projectile | null {
  unit.fireTimer -= dt;
  if (unit.fireTimer > 0) return null;

  unit.fireTimer = unit.fireCooldown;

  // Iterative prediction: refine flight time twice for accuracy at long range
  let predictedX = target.pos.x;
  let predictedY = target.pos.y;
  for (let iter = 0; iter < 2; iter++) {
    const pdx = predictedX - unit.pos.x;
    const pdy = predictedY - unit.pos.y;
    const pdist = Math.sqrt(pdx * pdx + pdy * pdy);
    const flightTime = pdist / unit.projectileSpeed;
    predictedX = target.pos.x + target.vel.x * flightTime;
    predictedY = target.pos.y + target.vel.y * flightTime;
  }

  const pdx = predictedX - unit.pos.x;
  const pdy = predictedY - unit.pos.y;
  const pdist = Math.sqrt(pdx * pdx + pdy * pdy);

  if (pdist < 1) return null;

  return {
    pos: { x: unit.pos.x, y: unit.pos.y },
    vel: { x: (pdx / pdist) * unit.projectileSpeed, y: (pdy / pdist) * unit.projectileSpeed },
    target: { x: predictedX, y: predictedY },
    damage: unit.damage,
    radius: unit.projectileRadius,
    team: unit.team,
    maxRange: unit.range * (1 + ELEVATION_RANGE_BONUS * getElevationLevel(unit.pos, elevationZones)) + unit.radius + 40,
    distanceTraveled: 0,
  };
}

export function updateProjectiles(
  projectiles: Projectile[],
  units: Unit[],
  dt: number,
): { alive: Projectile[]; hits: ProjectileHit[] } {
  const alive: Projectile[] = [];
  const hits: ProjectileHit[] = [];

  for (const p of projectiles) {
    // Move projectile
    const moveX = p.vel.x * dt;
    const moveY = p.vel.y * dt;
    p.pos.x += moveX;
    p.pos.y += moveY;
    p.distanceTraveled += Math.sqrt(moveX * moveX + moveY * moveY);

    // Track trail (max 5 entries)
    if (!p.trail) p.trail = [];
    p.trail.push({ x: p.pos.x, y: p.pos.y });
    if (p.trail.length > 5) p.trail.shift();

    // Check if out of bounds or past max range
    if (p.pos.x < 0 || p.pos.x > MAP_WIDTH || p.pos.y < 0 || p.pos.y > MAP_HEIGHT) continue;
    if (p.distanceTraveled > p.maxRange) continue;

    // Check hit against enemy units
    let hit = false;
    for (const unit of units) {
      if (!unit.alive || unit.team === p.team) continue;
      const dx = p.pos.x - unit.pos.x;
      const dy = p.pos.y - unit.pos.y;
      const hitDist = p.radius + unit.radius;
      if (dx * dx + dy * dy <= hitDist * hitDist) {
        const wasBefore = unit.hp;
        applyDamage(unit, p.damage);
        hits.push({
          pos: { x: p.pos.x, y: p.pos.y },
          targetId: unit.id,
          killed: wasBefore > 0 && !unit.alive,
          team: p.team,
        });
        hit = true;
        break;
      }
    }

    if (!hit) alive.push(p);
  }

  return { alive, hits };
}
