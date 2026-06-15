import { Obstacle, ElevationZone, Vec2, Team, UnitType } from './types';
import { UNIT_STATS } from './constants';

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

const VALID_TEAMS: ReadonlySet<string> = new Set<Team>(['blue', 'red']);

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

/** A rectangle (obstacle / elevation zone) with finite, non-negative extents. */
function isValidRect(r: { x?: unknown; y?: unknown; w?: unknown; h?: unknown } | null | undefined): boolean {
  return !!r
    && isFiniteNumber(r.x) && isFiniteNumber(r.y)
    && isFiniteNumber(r.w) && r.w >= 0
    && isFiniteNumber(r.h) && r.h >= 0;
}

/** A unit snapshot with a known type, valid team, and finite numeric fields.
 *  An unknown `type` is the dangerous case: createUnit() does UNIT_STATS[type]
 *  and would throw on `undefined.hp`, crashing the guest's state handler. */
function isValidUnit(u: OnlineGameState['units'][number] | null | undefined): boolean {
  return !!u
    && typeof u.id === 'string'
    && typeof u.type === 'string' && Object.prototype.hasOwnProperty.call(UNIT_STATS, u.type)
    && VALID_TEAMS.has(u.team)
    && isFiniteNumber(u.x) && isFiniteNumber(u.y)
    && isFiniteNumber(u.hp) && u.hp >= 0
    && isFiniteNumber(u.maxHp) && u.maxHp > 0
    && isFiniteNumber(u.radius) && u.radius >= 0
    && isFiniteNumber(u.speed) && u.speed >= 0
    && isFiniteNumber(u.range) && u.range >= 0
    && isFiniteNumber(u.gunAngle);
}

/** Validate a remote game-state snapshot before trusting it. Checks both array
 *  sizes (DoS bound) and per-element contents (unknown unit types / NaN / negative
 *  values that would crash the engine or corrupt the renderer). */
export function isPlausibleGameState(state: OnlineGameState | null | undefined): state is OnlineGameState {
  return !!state
    && Array.isArray(state.units) && state.units.length <= MAX_ONLINE_UNITS
    && Array.isArray(state.obstacles) && state.obstacles.length <= MAX_ONLINE_OBSTACLES
    && Array.isArray(state.elevationZones) && state.elevationZones.length <= MAX_ONLINE_ELEVATION_ZONES
    && Number.isFinite(state.mapWidth) && state.mapWidth > 0
    && Number.isFinite(state.mapHeight) && state.mapHeight > 0
    && state.units.every(isValidUnit)
    && state.obstacles.every(isValidRect)
    && state.elevationZones.every(isValidRect);
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
