import { UnitStats, UnitType } from './types';

export let MAP_WIDTH = 1200;
export let MAP_HEIGHT = 800;

export function setMapSize(w: number, h: number): void {
  MAP_WIDTH = w;
  MAP_HEIGHT = h;
}

export const UNIT_STATS: Record<UnitType, UnitStats> = {
  scout:   { hp: 30,  speed: 180, damage: 5,  range: 30,  radius: 6,  fireCooldown: 0.5, projectileSpeed: 400, projectileRadius: 3 },
  soldier: { hp: 60,  speed: 120, damage: 10, range: 100, radius: 10, fireCooldown: 1.0, projectileSpeed: 300, projectileRadius: 5 },
  tank:    { hp: 120, speed: 60,  damage: 20, range: 40,  radius: 14, fireCooldown: 1.5, projectileSpeed: 250, projectileRadius: 7 },
  sniper:  { hp: 1,   speed: 80,  damage: 25, range: 300, radius: 7, fireCooldown: 2.0, projectileSpeed: 1200, projectileRadius: 5 },
};

export const ARMY_COMPOSITION: { type: UnitType; count: number }[] = [
  { type: 'soldier', count: 3 },
  { type: 'sniper', count: 1 },
];

export const AI_POLL_INTERVAL_MS = 1500;
export const UNIT_ATTACK_COOLDOWN_MS = 1000;

export const ROUND_DURATION_S = 7;
export const PATH_SAMPLE_DISTANCE = 18;
export const UNIT_SELECT_RADIUS = 30;
export const COVER_SCREEN_DURATION_MS = 1500;
