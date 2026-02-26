import { Unit, UnitType, Team, Vec2, Obstacle, Projectile, ElevationZone } from './types';

export interface ProjectileHit {
  pos: Vec2;
  targetId: string;
  killed: boolean;
  team: Team;
}
import { UNIT_STATS, ARMY_COMPOSITION, MAP_WIDTH, MAP_HEIGHT, ELEVATION_RANGE_BONUS } from './constants';

/** Check if line segment from a to b intersects rect expanded by padding (slab method). */
export function segmentHitsRect(a: Vec2, b: Vec2, rect: Obstacle, padding: number): boolean {
  const left = rect.x - padding;
  const right = rect.x + rect.w + padding;
  const top = rect.y - padding;
  const bottom = rect.y + rect.h + padding;

  const dx = b.x - a.x;
  const dy = b.y - a.y;

  let tMin = 0;
  let tMax = 1;

  if (Math.abs(dx) < 1e-8) {
    if (a.x < left || a.x > right) return false;
  } else {
    let t1 = (left - a.x) / dx;
    let t2 = (right - a.x) / dx;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  if (Math.abs(dy) < 1e-8) {
    if (a.y < top || a.y > bottom) return false;
  } else {
    let t1 = (top - a.y) / dy;
    let t2 = (bottom - a.y) / dy;
    if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
    tMin = Math.max(tMin, t1);
    tMax = Math.min(tMax, t2);
    if (tMin > tMax) return false;
  }

  return true;
}

/** Check if a point overlaps any obstacle (with padding). */
function pointHitsObstacle(p: Vec2, obstacles: Obstacle[], padding: number): boolean {
  return obstacles.some(obs => {
    const cx = Math.max(obs.x, Math.min(obs.x + obs.w, p.x));
    const cy = Math.max(obs.y, Math.min(obs.y + obs.h, p.y));
    const dx = p.x - cx;
    const dy = p.y - cy;
    return dx * dx + dy * dy < padding * padding;
  });
}

/** Insert detour waypoints around obstacles blocking the segment from a to b. */
export function detourWaypoints(a: Vec2, b: Vec2, obstacles: Obstacle[], padding: number, depth = 0): Vec2[] {
  const MAX_DEPTH = 6;
  if (depth >= MAX_DEPTH) return [];

  // Find the first blocking obstacle (closest to a by projecting obstacle center onto segment)
  let firstObs: Obstacle | null = null;
  let firstT = Infinity;

  for (const obs of obstacles) {
    if (!segmentHitsRect(a, b, obs, padding)) continue;
    const cx = obs.x + obs.w / 2;
    const cy = obs.y + obs.h / 2;
    const sx = b.x - a.x;
    const sy = b.y - a.y;
    const len2 = sx * sx + sy * sy;
    const t = len2 > 0 ? ((cx - a.x) * sx + (cy - a.y) * sy) / len2 : 0;
    if (t < firstT) {
      firstT = t;
      firstObs = obs;
    }
  }

  if (!firstObs) return [];

  const obs = firstObs;
  // Offset corners beyond the expanded rect so segments from them don't re-hit this obstacle
  const cp = padding + 3;
  const corners: Vec2[] = [
    { x: obs.x - cp, y: obs.y - cp },
    { x: obs.x + obs.w + cp, y: obs.y - cp },
    { x: obs.x - cp, y: obs.y + obs.h + cp },
    { x: obs.x + obs.w + cp, y: obs.y + obs.h + cp },
  ];

  // Filter out corners that land inside other obstacles or out of map bounds
  const validCorners = corners
    .map(c => ({
      x: Math.max(padding, Math.min(MAP_WIDTH - padding, c.x)),
      y: Math.max(padding, Math.min(MAP_HEIGHT - padding, c.y)),
    }))
    .filter(c => !pointHitsObstacle(c, obstacles, padding));

  if (validCorners.length === 0) {
    // All corners blocked — try midpoints along obstacle edges instead
    const edgeMids: Vec2[] = [
      { x: obs.x + obs.w / 2, y: obs.y - cp },
      { x: obs.x + obs.w / 2, y: obs.y + obs.h + cp },
      { x: obs.x - cp, y: obs.y + obs.h / 2 },
      { x: obs.x + obs.w + cp, y: obs.y + obs.h / 2 },
    ];
    const fallback = edgeMids
      .map(c => ({
        x: Math.max(padding, Math.min(MAP_WIDTH - padding, c.x)),
        y: Math.max(padding, Math.min(MAP_HEIGHT - padding, c.y)),
      }))
      .filter(c => !pointHitsObstacle(c, obstacles, padding));
    if (fallback.length === 0) return [];
    validCorners.push(...fallback);
  }

  // Pick corner that minimizes total detour distance
  let bestCorner = validCorners[0];
  let bestDist = Infinity;
  for (const c of validCorners) {
    const dist = Math.hypot(c.x - a.x, c.y - a.y) + Math.hypot(b.x - c.x, b.y - c.y);
    if (dist < bestDist) {
      bestDist = dist;
      bestCorner = c;
    }
  }

  const before = detourWaypoints(a, bestCorner, obstacles, padding, depth + 1);
  const after = detourWaypoints(bestCorner, b, obstacles, padding, depth + 1);
  return [...before, bestCorner, ...after];
}

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

/** Smoothly rotate unit.gunAngle toward desiredAngle via shortest arc, capped at ~2 rad/s. */
export function updateGunAngle(unit: Unit, desiredAngle: number, dt: number): void {
  const MAX_TURN_SPEED = 2; // rad/s (~1.6s for full 180° turn)
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

/** Pop the next waypoint into moveTarget when the current one is reached or stuck. */
export function advanceWaypoint(unit: Unit): void {
  if (!unit.alive) return;

  const atTarget = !unit.moveTarget ||
    (Math.abs(unit.pos.x - unit.moveTarget.x) < 2 &&
     Math.abs(unit.pos.y - unit.moveTarget.y) < 2);

  // Skip waypoint if unit is stuck (not moving but has a target)
  const speed = unit.vel.x * unit.vel.x + unit.vel.y * unit.vel.y;
  const stuck = unit.moveTarget && speed < 1 &&
    (Math.abs(unit.pos.x - unit.moveTarget.x) > 4 ||
     Math.abs(unit.pos.y - unit.moveTarget.y) > 4);

  if (atTarget || stuck) {
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

/** Push a position out of any overlapping obstacles. */
function pushOutOfObstacles(pos: Vec2, radius: number, obstacles: Obstacle[]): void {
  for (const obs of obstacles) {
    const closestX = clamp(pos.x, obs.x, obs.x + obs.w);
    const closestY = clamp(pos.y, obs.y, obs.y + obs.h);
    const dx = pos.x - closestX;
    const dy = pos.y - closestY;
    const dist2 = dx * dx + dy * dy;
    if (dist2 < radius * radius && dist2 > 0.001) {
      const dist = Math.sqrt(dist2);
      const push = radius - dist + 0.5;
      pos.x += (dx / dist) * push;
      pos.y += (dy / dist) * push;
    } else if (dist2 <= 0.001) {
      // Center is exactly inside obstacle — push to nearest edge
      const toLeft = pos.x - obs.x;
      const toRight = obs.x + obs.w - pos.x;
      const toTop = pos.y - obs.y;
      const toBottom = obs.y + obs.h - pos.y;
      const minDist = Math.min(toLeft, toRight, toTop, toBottom);
      if (minDist === toLeft) pos.x = obs.x - radius - 0.5;
      else if (minDist === toRight) pos.x = obs.x + obs.w + radius + 0.5;
      else if (minDist === toTop) pos.y = obs.y - radius - 0.5;
      else pos.y = obs.y + obs.h + radius + 0.5;
    }
  }
}

export function moveUnit(unit: Unit, dt: number, obstacles: Obstacle[], allUnits: Unit[] = []): void {
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
  let dirX = dx / dist;
  let dirY = dy / dist;

  // Steer around nearby units in our path
  const lookAhead = unit.radius * 3;
  let steerX = 0;
  let steerY = 0;
  for (const other of allUnits) {
    if (other === unit || !other.alive) continue;
    const ox = other.pos.x - unit.pos.x;
    const oy = other.pos.y - unit.pos.y;
    const oDist = Math.sqrt(ox * ox + oy * oy);
    const minSep = unit.radius + other.radius + 2;
    if (oDist >= lookAhead + other.radius || oDist < 0.01) continue;

    // Is the other unit ahead of us? (dot product with direction)
    const dot = ox * dirX + oy * dirY;
    if (dot < 0) continue; // behind us

    // Perpendicular distance to our movement line
    const perpDist = Math.abs(-dirY * ox + dirX * oy);
    if (perpDist < minSep) {
      // Steer perpendicular — away from the blocking unit
      const side = -dirY * ox + dirX * oy; // signed perpendicular
      const steerDir = side >= 0 ? 1 : -1;
      const strength = (minSep - perpDist) / minSep;
      steerX += -dirY * steerDir * strength;
      steerY += dirX * steerDir * strength;
    }
  }

  // Blend steering into direction
  if (steerX !== 0 || steerY !== 0) {
    dirX += steerX * 0.6;
    dirY += steerY * 0.6;
    const len = Math.sqrt(dirX * dirX + dirY * dirY);
    if (len > 0.01) { dirX /= len; dirY /= len; }
  }

  const moveX = dirX * Math.min(step, dist);
  const moveY = dirY * Math.min(step, dist);

  const oldX = unit.pos.x;
  const oldY = unit.pos.y;

  let newX = oldX + moveX;
  let newY = oldY + moveY;

  // Obstacle avoidance with sliding
  const blocked = obstacles.some(o => rectContainsCircle(o, { x: newX, y: newY }, unit.radius));
  if (blocked) {
    const hBlocked = obstacles.some(o => rectContainsCircle(o, { x: newX, y: oldY }, unit.radius));
    const vBlocked = obstacles.some(o => rectContainsCircle(o, { x: oldX, y: newY }, unit.radius));
    if (!hBlocked) {
      newY = oldY;
    } else if (!vBlocked) {
      newX = oldX;
    } else {
      // Both axes blocked — push out of obstacle instead of freezing
      pushOutOfObstacles(unit.pos, unit.radius, obstacles);
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
export function separateUnits(units: Unit[], obstacles: Obstacle[] = []): void {
  const alive = units.filter(u => u.alive);
  const ITERATIONS = 3;

  for (let iter = 0; iter < ITERATIONS; iter++) {
    for (let i = 0; i < alive.length; i++) {
      for (let j = i + 1; j < alive.length; j++) {
        const a = alive[i];
        const b = alive[j];
        const dx = b.pos.x - a.pos.x;
        const dy = b.pos.y - a.pos.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const minDist = a.radius + b.radius + 1; // +1 small buffer to prevent touching

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

  // Push units out of obstacles after separation
  for (const unit of alive) {
    pushOutOfObstacles(unit.pos, unit.radius, obstacles);
    unit.pos.x = clamp(unit.pos.x, unit.radius, MAP_WIDTH - unit.radius);
    unit.pos.y = clamp(unit.pos.y, unit.radius, MAP_HEIGHT - unit.radius);
  }
}

/** Check if line of sight from a to b is clear of obstacles. */
export function hasLineOfSight(a: Vec2, b: Vec2, obstacles: Obstacle[]): boolean {
  return !obstacles.some(o => segmentHitsRect(a, b, o, 0));
}

export function findTarget(attacker: Unit, allUnits: Unit[], preferredId: string | null, obstacles: Obstacle[] = []): Unit | null {
  const enemies = allUnits.filter(u => u.alive && u.team !== attacker.team);
  if (enemies.length === 0) return null;

  if (preferredId) {
    const preferred = enemies.find(u => u.id === preferredId);
    if (preferred && hasLineOfSight(attacker.pos, preferred.pos, obstacles)) return preferred;
  }

  // Split into visible and blocked enemies
  let nearestVisible: Unit | null = null;
  let nearestVisibleDist = Infinity;
  let nearestAny: Unit | null = null;
  let nearestAnyDist = Infinity;

  for (const enemy of enemies) {
    const d = distance(attacker.pos, enemy.pos);
    if (d < nearestAnyDist) {
      nearestAny = enemy;
      nearestAnyDist = d;
    }
    if (hasLineOfSight(attacker.pos, enemy.pos, obstacles) && d < nearestVisibleDist) {
      nearestVisible = enemy;
      nearestVisibleDist = d;
    }
  }

  return nearestVisible ?? nearestAny;
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

  // Gun must be aligned with target before firing (makes flanking viable)
  const aimAngle = Math.atan2(target.pos.y - unit.pos.y, target.pos.x - unit.pos.x);
  let aimDiff = aimAngle - unit.gunAngle;
  aimDiff = ((aimDiff + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (aimDiff < -Math.PI) aimDiff += 2 * Math.PI;
  if (Math.abs(aimDiff) > 0.15) return null; // ~8.5° tolerance

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
  obstacles: Obstacle[] = [],
): { alive: Projectile[]; hits: ProjectileHit[] } {
  const alive: Projectile[] = [];
  const hits: ProjectileHit[] = [];

  for (const p of projectiles) {
    // Move projectile
    const oldPos = { x: p.pos.x, y: p.pos.y };
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

    // Check if projectile hit an obstacle
    if (obstacles.some(o => segmentHitsRect(oldPos, p.pos, o, p.radius))) continue;

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
