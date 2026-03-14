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

/** Host sends blue waypoints + PRNG seed so both peers can simulate identically. */
export interface OnlineWaypointData {
  bluePaths: { unitId: string; waypoints: Vec2[] }[];
  seed: number;
}

/** Periodic state hash for desync detection (sent every 60 simulation ticks). */
export interface OnlineSyncHash {
  tick: number;
  hash: number;
}

export interface OnlineRoundResult {
  winner: Team;
  blueAlive: number;
  redAlive: number;
  duration: number;
  gameOver: boolean;
}

export type OnlineConnectionState = 'idle' | 'waiting' | 'connecting' | 'connected' | 'reconnecting' | 'disconnected' | 'error';

/** Signals sent between players (rematch request, identity, etc.) */
export interface OnlineSignal {
  type: 'rematch' | 'identity';
  playerId?: string;
}
