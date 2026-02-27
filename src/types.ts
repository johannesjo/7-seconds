export type UnitType = 'scout' | 'soldier' | 'tank' | 'sniper' | 'zombie';
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
  stuckTime?: number;
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

// Replay types

export interface ReplayUnitSnapshot {
  id: string;
  type: UnitType;
  team: Team;
  x: number;
  y: number;
  vx: number;
  vy: number;
  gunAngle: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  radius: number;
}

export interface ReplayProjectileSnapshot {
  x: number;
  y: number;
  vx: number;
  vy: number;
  damage: number;
  radius: number;
  team: Team;
  maxRange: number;
  distanceTraveled: number;
  trail?: Vec2[];
}

export interface ReplayEvent {
  frame: number;
  type: 'fire' | 'hit' | 'kill';
  pos: Vec2;
  angle: number;
  damage: number;
  flanked: boolean;
  team: Team;
  targetId?: string;
}

export interface ReplayFrame {
  units: ReplayUnitSnapshot[];
  projectiles: ReplayProjectileSnapshot[];
}

export interface ReplayData {
  frames: ReplayFrame[];
  events: ReplayEvent[];
  obstacles: Obstacle[];
  elevationZones: ElevationZone[];
}

export interface HordeUpgrade {
  id: string;
  label: string;
  description: string;
  category: 'stat' | 'recruit';
  apply: (units: Unit[], blocks?: Obstacle[]) => Unit[];
}
