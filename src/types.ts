export type UnitType = 'scout' | 'soldier' | 'tank' | 'sniper';
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
  turnSpeed: number;
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
  gunAngle: number;
  turnSpeed: number;
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
  trail?: Vec2[];
}

export interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ElevationZone {
  x: number;
  y: number;
  w: number;
  h: number;
}

export type CoverBlock = Obstacle;

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
  winCondition?: 'elimination' | 'zone-control';
}

export interface HordeWave {
  wave: number;
  enemies: { type: UnitType; count: number }[];
}

export interface HordeUpgrade {
  id: string;
  label: string;
  description: string;
  category: 'stat' | 'recruit';
  apply: (units: Unit[], blocks?: Obstacle[]) => Unit[];
}
