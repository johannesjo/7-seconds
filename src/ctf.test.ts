import { describe, it, expect } from 'vitest';
import { createCtfState, updateCtfFlags, checkCtfCapture } from './ctf';
import { createUnit } from './units';
import { MAP_WIDTH, MAP_HEIGHT, CTF_BASE_ZONE_WIDTH, CTF_FLAG_PICKUP_RADIUS } from './constants';

describe('createCtfState', () => {
  it('creates flags at base positions', () => {
    const state = createCtfState();
    expect(state.blueFlag.pos.x).toBeLessThan(CTF_BASE_ZONE_WIDTH);
    expect(state.redFlag.pos.x).toBeGreaterThan(MAP_WIDTH - CTF_BASE_ZONE_WIDTH);
    expect(state.blueFlag.carrierId).toBeNull();
    expect(state.redFlag.carrierId).toBeNull();
    expect(state.winner).toBeNull();
  });
});

describe('updateCtfFlags', () => {
  it('picks up enemy flag when unit walks into it', () => {
    const state = createCtfState();
    const redUnit = createUnit('r1', 'soldier', 'red', { ...state.blueFlag.pos });
    updateCtfFlags(state, [redUnit]);
    expect(state.blueFlag.carrierId).toBe('r1');
  });

  it('does not pick up own flag at home', () => {
    const state = createCtfState();
    const blueUnit = createUnit('b1', 'soldier', 'blue', { ...state.blueFlag.pos });
    updateCtfFlags(state, [blueUnit]);
    expect(state.blueFlag.carrierId).toBeNull();
  });

  it('drops flag when carrier dies', () => {
    const state = createCtfState();
    const redUnit = createUnit('r1', 'soldier', 'red', { x: 400, y: 400 });
    state.blueFlag.carrierId = 'r1';
    state.blueFlag.pos = { x: 400, y: 400 };
    redUnit.alive = false;
    updateCtfFlags(state, [redUnit]);
    expect(state.blueFlag.carrierId).toBeNull();
    expect(state.blueFlag.dropped).toBe(true);
    expect(state.blueFlag.pos).toEqual({ x: 400, y: 400 });
  });

  it('returns own dropped flag to base when ally touches it', () => {
    const state = createCtfState();
    state.blueFlag.dropped = true;
    state.blueFlag.pos = { x: 300, y: 400 };
    const blueUnit = createUnit('b1', 'soldier', 'blue', { x: 300, y: 400 });
    updateCtfFlags(state, [blueUnit]);
    expect(state.blueFlag.dropped).toBe(false);
    expect(state.blueFlag.pos).toEqual(state.blueFlag.homePos);
  });

  it('ally picks up dropped enemy flag to continue carrying', () => {
    const state = createCtfState();
    state.blueFlag.dropped = true;
    state.blueFlag.pos = { x: 300, y: 400 };
    const redUnit = createUnit('r2', 'soldier', 'red', { x: 300, y: 400 });
    updateCtfFlags(state, [redUnit]);
    expect(state.blueFlag.carrierId).toBe('r2');
    expect(state.blueFlag.dropped).toBe(false);
  });

  it('flag follows carrier position', () => {
    const state = createCtfState();
    const redUnit = createUnit('r1', 'soldier', 'red', { x: 500, y: 300 });
    state.blueFlag.carrierId = 'r1';
    updateCtfFlags(state, [redUnit]);
    expect(state.blueFlag.pos).toEqual({ x: 500, y: 300 });
  });
});

describe('checkCtfCapture', () => {
  it('returns winning team when carrier reaches home base', () => {
    const state = createCtfState();
    state.blueFlag.carrierId = 'r1';
    // Red carries blue flag to red's home base
    state.blueFlag.pos = { ...state.redFlag.homePos };
    const result = checkCtfCapture(state);
    expect(result).toBe('red');
  });

  it('returns null when no capture', () => {
    const state = createCtfState();
    state.blueFlag.carrierId = 'r1';
    state.blueFlag.pos = { x: MAP_WIDTH / 2, y: MAP_HEIGHT / 2 };
    const result = checkCtfCapture(state);
    expect(result).toBeNull();
  });
});
