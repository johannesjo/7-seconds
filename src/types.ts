export type UnitType = 'scout' | 'soldier' | 'tank';
export type Team = 'blue' | 'red';
export type GamePhase = 'prompt' | 'battle' | 'result';

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
  attackTargetId: string | null;
  alive: boolean;
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
