import { CtfState, CtfFlag, Unit, Team, Vec2 } from './types';
import { MAP_WIDTH, MAP_HEIGHT, CTF_BASE_ZONE_WIDTH, CTF_FLAG_PICKUP_RADIUS, CTF_CARRIER_SPEED_MULTIPLIER } from './constants';

export function createCtfState(): CtfState {
  const blueHome: Vec2 = { x: CTF_BASE_ZONE_WIDTH / 2, y: MAP_HEIGHT / 2 };
  const redHome: Vec2 = { x: MAP_WIDTH - CTF_BASE_ZONE_WIDTH / 2, y: MAP_HEIGHT / 2 };

  return {
    blueFlag: { team: 'blue', pos: { ...blueHome }, homePos: { ...blueHome }, carrierId: null, dropped: false },
    redFlag: { team: 'red', pos: { ...redHome }, homePos: { ...redHome }, carrierId: null, dropped: false },
    winner: null,
  };
}

function dist(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function updateFlag(flag: CtfFlag, units: Unit[]): void {
  // If carrier is dead, drop the flag
  if (flag.carrierId) {
    const carrier = units.find(u => u.id === flag.carrierId);
    if (!carrier || !carrier.alive) {
      flag.carrierId = null;
      flag.dropped = true;
      return;
    }
    // Flag follows carrier
    flag.pos = { x: carrier.pos.x, y: carrier.pos.y };
    return;
  }

  // Check for pickups / returns
  for (const unit of units) {
    if (!unit.alive) continue;
    if (dist(unit.pos, flag.pos) > CTF_FLAG_PICKUP_RADIUS) continue;

    if (unit.team === flag.team) {
      if (flag.dropped) {
        flag.pos = { ...flag.homePos };
        flag.dropped = false;
      }
    } else {
      flag.carrierId = unit.id;
      flag.dropped = false;
      return;
    }
  }
}

export function updateCtfFlags(state: CtfState, units: Unit[]): void {
  updateFlag(state.blueFlag, units);
  updateFlag(state.redFlag, units);
}

function isFlagAtHome(flag: CtfFlag): boolean {
  return !flag.carrierId && !flag.dropped;
}

export function checkCtfCapture(state: CtfState): Team | null {
  // Can only capture if your own flag is safe at home
  if (state.blueFlag.carrierId && state.blueFlag.pos.x > MAP_WIDTH - CTF_BASE_ZONE_WIDTH && isFlagAtHome(state.redFlag)) {
    return 'red';
  }
  if (state.redFlag.carrierId && state.redFlag.pos.x < CTF_BASE_ZONE_WIDTH && isFlagAtHome(state.blueFlag)) {
    return 'blue';
  }
  return null;
}

/** Reduce unit speed when carrying the flag. */
export function applyCarrierPenalty(unit: Unit, state: CtfState): number {
  if (state.blueFlag.carrierId === unit.id || state.redFlag.carrierId === unit.id) {
    return unit.speed * CTF_CARRIER_SPEED_MULTIPLIER;
  }
  return unit.speed;
}

/** Check if a unit is currently carrying a flag. */
export function isCarrying(unitId: string, state: CtfState): boolean {
  return state.blueFlag.carrierId === unitId || state.redFlag.carrierId === unitId;
}
