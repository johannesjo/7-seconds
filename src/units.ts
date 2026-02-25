import { Unit, UnitType, Team, Vec2, Obstacle, Projectile } from './types';

export interface ProjectileHit {
  pos: Vec2;
  targetId: string;
  killed: boolean;
  team: Team;
}
import { UNIT_STATS, ARMY_COMPOSITION, MAP_WIDTH, MAP_HEIGHT } from './constants';

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
  };
}

export function createArmy(team: Team): Unit[] {
  const units: Unit[] = [];
  const isBlue = team === 'blue';
  const baseX = isBlue ? MAP_WIDTH * 0.15 : MAP_WIDTH * 0.85;
  let index = 0;

  for (const { type, count } of ARMY_COMPOSITION) {
    for (let i = 0; i < count; i++) {
      const spacing = MAP_HEIGHT / 12;
      const yOffset = (index - 4.5) * spacing;
      const pos = { x: baseX, y: MAP_HEIGHT / 2 + yOffset };
      units.push(createUnit(`${team}_${type}_${i}`, type, team, pos));
      index++;
    }
  }

  return units;
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

  // Track velocity for projectile prediction
  unit.vel = { x: (dx / dist) * unit.speed, y: (dy / dist) * unit.speed };

  let newX = unit.pos.x + moveX;
  let newY = unit.pos.y + moveY;

  // Obstacle avoidance
  const blocked = obstacles.some(o => rectContainsCircle(o, { x: newX, y: newY }, unit.radius));
  if (blocked) {
    const hBlocked = obstacles.some(o => rectContainsCircle(o, { x: newX, y: unit.pos.y }, unit.radius));
    const vBlocked = obstacles.some(o => rectContainsCircle(o, { x: unit.pos.x, y: newY }, unit.radius));
    if (!hBlocked) {
      newY = unit.pos.y;
    } else if (!vBlocked) {
      newX = unit.pos.x;
    } else {
      return;
    }
  }

  // Clamp to map bounds
  newX = clamp(newX, unit.radius, MAP_WIDTH - unit.radius);
  newY = clamp(newY, unit.radius, MAP_HEIGHT - unit.radius);

  unit.pos.x = newX;
  unit.pos.y = newY;
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

export function isInRange(attacker: Unit, target: Unit): boolean {
  return distance(attacker.pos, target.pos) <= attacker.range + attacker.radius + target.radius;
}

export function applyDamage(unit: Unit, amount: number): void {
  unit.hp = Math.max(0, unit.hp - amount);
  if (unit.hp === 0) {
    unit.alive = false;
  }
}

export function tryFireProjectile(unit: Unit, target: Unit, dt: number): Projectile | null {
  unit.fireTimer -= dt;
  if (unit.fireTimer > 0) return null;

  unit.fireTimer = unit.fireCooldown;

  // Predict where the target will be when the projectile arrives
  const dx = target.pos.x - unit.pos.x;
  const dy = target.pos.y - unit.pos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const flightTime = dist / unit.projectileSpeed;

  const predictedX = target.pos.x + target.vel.x * flightTime;
  const predictedY = target.pos.y + target.vel.y * flightTime;

  // Calculate velocity toward predicted position
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
    maxRange: unit.range + unit.radius + 40,
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
