import { UnitStats, UnitType } from './types';

export let MAP_WIDTH = 1200;
export let MAP_HEIGHT = 800;

export function setMapSize(w: number, h: number): void {
  MAP_WIDTH = w;
  MAP_HEIGHT = h;
}

export const UNIT_STATS: Record<UnitType, UnitStats> = {
  soldier: { hp: 60,  speed: 100, damage: 10, range: 120, radius: 10, fireCooldown: 1.0, projectileSpeed: 300, projectileRadius: 5, turnSpeed: 2.5 },
  blade:   { hp: 80,  speed: 120, damage: 12, range: 25,  radius: 12, fireCooldown: 0.5, projectileSpeed: 600, projectileRadius: 3, turnSpeed: 3.0 },
  sniper:  { hp: 15,  speed: 70,  damage: 30, range: 300, radius: 7, fireCooldown: 2.5, projectileSpeed: 1200, projectileRadius: 5, turnSpeed: 1.2 },
  zombie:  { hp: 20,  speed: 55,  damage: 14, range: 20,  radius: 8, fireCooldown: 0.8, projectileSpeed: 300, projectileRadius: 4, turnSpeed: 3.0 },
};

export const ARMY_COMPOSITION: { type: UnitType; count: number }[] = [
  { type: 'soldier', count: 3 },
  { type: 'sniper', count: 1 },
];

export const AI_POLL_INTERVAL_MS = 1500;
export const UNIT_ATTACK_COOLDOWN_MS = 1000;

export const ROUND_DURATION_S = 6;
export const PATH_SAMPLE_DISTANCE = 18;
export const UNIT_SELECT_RADIUS = 30;
export const COVER_SCREEN_DURATION_MS = 1500;
export const ELEVATION_RANGE_BONUS = 0.2;
export const FLANK_ANGLE_THRESHOLD = Math.PI / 3; // 60° half-cone = 120° front
export const FLANK_DAMAGE_MULTIPLIER = 1.5;
export const HORDE_MAX_WAVES = 12;
export const HORDE_STARTING_ARMY: { type: UnitType; count: number }[] = [
  { type: 'soldier', count: 2 },
];
