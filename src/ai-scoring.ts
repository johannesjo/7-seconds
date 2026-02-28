import { Unit, Vec2, Obstacle, ElevationZone, UnitType } from './types';
import { ROUND_DURATION_S, MAP_WIDTH, MAP_HEIGHT } from './constants';
import { hasLineOfSight, getElevationLevel, flankScore } from './units';

export interface ScoringContext {
  candidate: Vec2;
  unit: Unit;
  enemies: Unit[];
  obstacles: Obstacle[];
  elevationZones: ElevationZone[];
}

/** Role-based scoring weights per unit type. */
const WEIGHTS: Record<UnitType, {
  distIdeal: [number, number]; // [min, max] preferred distance to nearest enemy
  distPenaltyScale: number;
  los: number;
  elevation: number;
  cover: number;
  flank: number;
}> = {
  sniper:  { distIdeal: [180, 300], distPenaltyScale: 0.15, los: 30, elevation: 25, cover: 20, flank: 5 },
  tank:    { distIdeal: [0, 60],    distPenaltyScale: 0.2,  los: 15, elevation: 5,  cover: 5,  flank: 10 },
  soldier: { distIdeal: [50, 120],  distPenaltyScale: 0.15, los: 20, elevation: 15, cover: 15, flank: 25 },
  zombie:  { distIdeal: [0, 30],    distPenaltyScale: 0.1,  los: 5,  elevation: 0,  cover: 0,  flank: 5 },
};

/** Score a candidate position for a given unit. Higher is better. */
export function scorePosition(ctx: ScoringContext): number {
  const { candidate, unit, enemies, obstacles, elevationZones } = ctx;
  const w = WEIGHTS[unit.type];

  // Check reachability: can the unit reach this position within ROUND_DURATION_S?
  const dx = candidate.x - unit.pos.x;
  const dy = candidate.y - unit.pos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  const maxDist = unit.speed * ROUND_DURATION_S;
  if (dist > maxDist) return -Infinity;

  let score = 0;

  // Find nearest enemy
  let nearestEnemy: Unit | null = null;
  let nearestDist = Infinity;
  for (const e of enemies) {
    const ex = candidate.x - e.pos.x;
    const ey = candidate.y - e.pos.y;
    const eDist = Math.sqrt(ex * ex + ey * ey);
    if (eDist < nearestDist) {
      nearestDist = eDist;
      nearestEnemy = e;
    }
  }

  if (nearestEnemy) {
    // Distance preference: penalize being outside ideal range
    const [idealMin, idealMax] = w.distIdeal;
    if (nearestDist < idealMin) {
      score -= (idealMin - nearestDist) * w.distPenaltyScale;
    } else if (nearestDist > idealMax) {
      score -= (nearestDist - idealMax) * w.distPenaltyScale;
    }

    // Line of sight bonus
    if (hasLineOfSight(candidate, nearestEnemy.pos, obstacles)) {
      score += w.los;
    }

    // Flank angle bonus
    score += flankScore(candidate, nearestEnemy.pos, nearestEnemy.gunAngle) * w.flank;
  }

  // Elevation bonus
  const elevLevel = getElevationLevel(candidate, elevationZones);
  score += elevLevel * w.elevation;

  return score;
}

/** Generate candidate positions for a unit to evaluate. */
export function generateCandidates(
  unit: Unit,
  obstacles: Obstacle[],
  elevationZones: ElevationZone[],
): Vec2[] {
  const maxDist = unit.speed * ROUND_DURATION_S;
  const padding = unit.radius + 4;
  const candidates: Vec2[] = [];

  // 50px grid across reachable area
  const gridStep = 50;
  const minX = Math.max(padding, unit.pos.x - maxDist);
  const maxX = Math.min(MAP_WIDTH - padding, unit.pos.x + maxDist);
  const minY = Math.max(padding, unit.pos.y - maxDist);
  const maxY = Math.min(MAP_HEIGHT - padding, unit.pos.y + maxDist);

  for (let x = minX; x <= maxX; x += gridStep) {
    for (let y = minY; y <= maxY; y += gridStep) {
      const pos = { x, y };
      if (!isInsideObstacle(pos, obstacles, padding)) {
        candidates.push(pos);
      }
    }
  }

  // Center of each reachable elevation zone
  for (const zone of elevationZones) {
    const center = { x: zone.x + zone.w / 2, y: zone.y + zone.h / 2 };
    if (!isInsideObstacle(center, obstacles, padding)) {
      candidates.push(center);
    }
  }

  return candidates;
}

function isInsideObstacle(pos: Vec2, obstacles: Obstacle[], padding: number): boolean {
  return obstacles.some(obs => {
    const cx = Math.max(obs.x, Math.min(obs.x + obs.w, pos.x));
    const cy = Math.max(obs.y, Math.min(obs.y + obs.h, pos.y));
    const dx = pos.x - cx;
    const dy = pos.y - cy;
    return dx * dx + dy * dy < padding * padding;
  });
}
