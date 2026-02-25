import { Unit, UnitType, Team, Vec2, Obstacle } from './types';
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
    attackTargetId: null,
    alive: true,
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
  if (!unit.moveTarget || !unit.alive) return;

  const dx = unit.moveTarget.x - unit.pos.x;
  const dy = unit.moveTarget.y - unit.pos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 2) {
    unit.pos.x = unit.moveTarget.x;
    unit.pos.y = unit.moveTarget.y;
    return;
  }

  const step = unit.speed * dt;
  const moveX = (dx / dist) * Math.min(step, dist);
  const moveY = (dy / dist) * Math.min(step, dist);

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
  newX = clamp(newX, 0, MAP_WIDTH);
  newY = clamp(newY, 0, MAP_HEIGHT);

  unit.pos.x = newX;
  unit.pos.y = newY;
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
