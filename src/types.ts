export type UnitType = 'scout' | 'soldier' | 'tank';
export type Team = 'blue' | 'red';
export type GamePhase = 'prompt' | 'battle' | 'result';
export type TurnPhase = 'blue-planning' | 'cover' | 'red-planning' | 'playing';

export interface Vec2 {
  x: number;
  y: number;
}

export interface UnitStats {
  hp: number;
  speed: number;
  damage: number;
  range: number;
  radius: number;
  fireCooldown: number;
  projectileSpeed: number;
  projectileRadius: number;
}

export interface Unit {
  id: string;
  type: UnitType;
  team: Team;
  pos: Vec2;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  range: number;
  radius: number;
  moveTarget: Vec2 | null;
  waypoints: Vec2[];
  attackTargetId: string | null;
  alive: boolean;
  fireCooldown: number;
  fireTimer: number;
  projectileSpeed: number;
  projectileRadius: number;
  vel: Vec2;
}

export interface Projectile {
  pos: Vec2;
  vel: Vec2;
  target: Vec2;
  damage: number;
  radius: number;
  team: Team;
  maxRange: number;
  distanceTraveled: number;
}

export interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AiUnitOrder {
  id: string;
  move_to: [number, number];
  attack: string | null;
}

export interface AiResponse {
  orders: AiUnitOrder[];
}

export interface BattleResult {
  winner: Team;
  blueAlive: number;
  redAlive: number;
  blueKilled: number;
  redKilled: number;
  duration: number;
}
