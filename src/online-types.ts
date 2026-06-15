import { Obstacle, ElevationZone, Vec2, Team, UnitType } from './types';

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

/** Host sends blue waypoints + the per-round PRNG seed so both peers can
 *  simulate identically. `seed` is the *effective* seed for this round
 *  (base seed + round number), not the engine's base seed — otherwise rounds
 *  after the first would diverge because the guest can't see the round number. */
export interface OnlineWaypointData {
  bluePaths: { unitId: string; waypoints: Vec2[] }[];
  seed: number;
}

/** Upper bounds on a remote game-state snapshot. A peer is untrusted (especially
 *  in matchmaking against strangers), so reject snapshots larger than these to
 *  avoid a malicious or buggy peer exhausting CPU/memory. Real games are far
 *  smaller (single-digit to low-double-digit armies). */
export const MAX_ONLINE_UNITS = 100;
export const MAX_ONLINE_OBSTACLES = 300;
export const MAX_ONLINE_ELEVATION_ZONES = 300;

/** Validate a remote game-state snapshot before trusting it. */
export function isPlausibleGameState(state: OnlineGameState | null | undefined): state is OnlineGameState {
  return !!state
    && Array.isArray(state.units) && state.units.length <= MAX_ONLINE_UNITS
    && Array.isArray(state.obstacles) && state.obstacles.length <= MAX_ONLINE_OBSTACLES
    && Array.isArray(state.elevationZones) && state.elevationZones.length <= MAX_ONLINE_ELEVATION_ZONES
    && Number.isFinite(state.mapWidth) && state.mapWidth > 0
    && Number.isFinite(state.mapHeight) && state.mapHeight > 0;
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
