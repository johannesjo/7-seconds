import { UnitStats, UnitType } from './types';

export const MAP_WIDTH = 1200;
export const MAP_HEIGHT = 800;

export const UNIT_STATS: Record<UnitType, UnitStats> = {
  scout:   { hp: 30,  speed: 180, damage: 5,  range: 20, radius: 6,  fireCooldown: 0.5, projectileSpeed: 400, projectileRadius: 3 },
  soldier: { hp: 60,  speed: 120, damage: 10, range: 80, radius: 10, fireCooldown: 1.0, projectileSpeed: 300, projectileRadius: 5 },
  tank:    { hp: 120, speed: 60,  damage: 20, range: 25, radius: 14, fireCooldown: 1.5, projectileSpeed: 250, projectileRadius: 7 },
};

export const ARMY_COMPOSITION: { type: UnitType; count: number }[] = [
  { type: 'soldier', count: 6 },
];

export const AI_POLL_INTERVAL_MS = 1500;
export const UNIT_ATTACK_COOLDOWN_MS = 1000;
