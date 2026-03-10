import { Obstacle, ElevationZone, Vec2, ReplayUnitSnapshot, ReplayProjectileSnapshot, ReplayEvent, Team, UnitType } from './types';

export interface OnlineGameState {
  units: {
    id: string;
    type: UnitType;
    team: Team;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    radius: number;
    speed: number;
    range: number;
    gunAngle: number;
  }[];
  obstacles: Obstacle[];
  elevationZones: ElevationZone[];
  mapWidth: number;
  mapHeight: number;
}

export type OnlinePhase = 'blue-planning' | 'red-planning' | 'playing' | 'round-end';

export interface OnlinePathData {
  paths: { unitId: string; waypoints: Vec2[] }[];
}

export interface OnlineFrameData {
  units: ReplayUnitSnapshot[];
  projectiles: ReplayProjectileSnapshot[];
  events: ReplayEvent[];
  timeLeft: number;
}

export interface OnlineRoundResult {
  winner: Team | 'draw';
  blueAlive: number;
  redAlive: number;
  duration: number;
  gameOver: boolean;
}

export type OnlineConnectionState = 'idle' | 'waiting' | 'connecting' | 'connected' | 'disconnected' | 'error';

/** Signals sent between players (rematch request, identity, etc.) */
export interface OnlineSignal {
  type: 'rematch' | 'identity';
  playerId?: string;
}
