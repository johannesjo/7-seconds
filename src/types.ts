export type UnitType = 'soldier' | 'blade' | 'sniper' | 'zombie' | 'shielder' | 'bomber' | 'mortar' | 'rocketeer';
export type Team = 'blue' | 'red';
export type TurnPhase = 'blue-planning' | 'cover' | 'red-planning' | 'playing';

export interface Vec2 {
  x: number;
  y: number;
}

/** A path point. `wait` makes the unit hold here for that many seconds
 *  (still firing) before moving on to the next point. */
export interface Waypoint extends Vec2 {
  wait?: number;
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
  moveTarget: Waypoint | null;
  waypoints: Waypoint[];
  /** Focus-fire order: preferred enemy. While it is in range and visible the
   *  unit stops on its path and engages it. */
  attackTargetId: string | null;
  /** Seconds left on the current hold order (see Waypoint.wait). */
  holdTimer?: number;
  /** Rocketeer only: the drawn flight path of this round's rocket. It launches
   *  once the unit reaches the end of its move path. */
  rocketPath?: Vec2[];
  rocketFired?: boolean;
  alive: boolean;
  fireCooldown: number;
  fireTimer: number;
  projectileSpeed: number;
  projectileRadius: number;
  vel: Vec2;
  gunAngle: number;
  turnSpeed: number;
  stuckTime?: number;
  piercing?: boolean;
  damageReduction?: number;
  knockbackVel?: Vec2;
  /** Blade only: 0–1 directional momentum; builds when moving in a consistent direction. */
  momentum?: number;
  /** Shielder only: number of frontal hits absorbed by shield. Shield breaks at SHIELD_MAX_HITS. */
  shieldHits?: number;
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
  piercing?: boolean;
  hitIds?: Set<string>;
  knockback?: number;
  /** Ordnance: area-damage projectiles with their own flight rules.
   *  shell — mortar round arcing over obstacles to a fixed landing point;
   *  rocket — follows a player-drawn path, bursts on contact. */
  kind?: 'shell' | 'rocket';
  blastRadius?: number;
  /** Shell: launch point and flight progress. */
  origin?: Vec2;
  age?: number;
  flightTime?: number;
  /** Rocket: remaining points of its drawn path. */
  path?: Vec2[];
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
  shieldHits?: number;
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
  kind?: 'shell' | 'rocket';
  /** Shell landing point and flight progress (0..1). */
  tx?: number;
  ty?: number;
  progress?: number;
}

export interface ReplayEvent {
  frame: number;
  type: 'fire' | 'hit' | 'kill' | 'shield-break' | 'explosion';
  pos: Vec2;
  angle: number;
  damage: number;
  flanked: boolean;
  team: Team;
  targetId?: string;
  /** Shield direction at the moment its final frontal hit was absorbed. */
  facingAngle?: number;
  /** Explosion blast radius. */
  radius?: number;
}

export interface ReplayFlagSnapshot {
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  carrierId: string | null;
  dropped: boolean;
}

export interface ReplayFrame {
  units: ReplayUnitSnapshot[];
  projectiles: ReplayProjectileSnapshot[];
  blueFlag?: ReplayFlagSnapshot;
  redFlag?: ReplayFlagSnapshot;
}

export interface ReplayData {
  frames: ReplayFrame[];
  events: ReplayEvent[];
  obstacles: Obstacle[];
  elevationZones: ElevationZone[];
  ctfMode?: boolean;
}

export type UpgradeRarity = 'common' | 'uncommon' | 'rare' | 'epic';

export interface HordeUpgrade {
  id: string;
  label: string;
  description: string;
  category: 'stat' | 'recruit';
  rarity: UpgradeRarity;
  once?: boolean;
  /** Earliest wave at which this upgrade appears in the pool. */
  minWave?: number;
  /** If set, this upgrade only appears when the player owns at least one unit of this type. */
  forType?: UnitType;
  /** If set, upgrade is hidden when this returns false (e.g. no eligible units). */
  canApply?: (units: Unit[]) => boolean;
  apply: (units: Unit[], blocks?: Obstacle[]) => Unit[];
}

export interface CtfFlag {
  team: Team;
  pos: Vec2;
  homePos: Vec2;
  carrierId: string | null;
  dropped: boolean;
}

export interface CtfState {
  blueFlag: CtfFlag;
  redFlag: CtfFlag;
  winner: Team | null;
}
