import { describe, it, expect } from 'vitest';
import { hashGameState } from './online-sync';
import type { Unit } from './types';

/** Create a minimal Unit with only the fields hashGameState reads. */
function makeUnit(overrides: Partial<Pick<Unit, 'pos' | 'hp' | 'alive'>> = {}): Unit {
  return {
    id: 'u1',
    type: 'soldier',
    team: 'blue',
    pos: { x: 100, y: 200 },
    hp: 50,
    maxHp: 100,
    speed: 100,
    damage: 10,
    range: 120,
    radius: 6,
    moveTarget: null,
    waypoints: [],
    attackTargetId: null,
    alive: true,
    fireCooldown: 1,
    fireTimer: 0,
    projectileSpeed: 300,
    projectileRadius: 3,
    vel: { x: 0, y: 0 },
    gunAngle: 0,
    turnSpeed: 1,
    ...overrides,
  } as Unit;
}

describe('hashGameState', () => {
  it('returns the same hash for identical unit states', () => {
    const units = [makeUnit()];
    expect(hashGameState(units)).toBe(hashGameState(units));
  });

  it('returns an unsigned 32-bit integer', () => {
    const hash = hashGameState([makeUnit()]);
    expect(hash).toBeGreaterThanOrEqual(0);
    expect(hash).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(hash)).toBe(true);
  });

  it('returns the FNV offset basis for empty unit list', () => {
    const hash = hashGameState([]);
    expect(hash).toBe(0x811c9dc5);
  });

  it('produces different hashes when position differs', () => {
    const a = hashGameState([makeUnit({ pos: { x: 100, y: 200 } })]);
    const b = hashGameState([makeUnit({ pos: { x: 101, y: 200 } })]);
    expect(a).not.toBe(b);
  });

  it('produces different hashes when hp differs', () => {
    const a = hashGameState([makeUnit({ hp: 50 })]);
    const b = hashGameState([makeUnit({ hp: 49 })]);
    expect(a).not.toBe(b);
  });

  it('produces different hashes when alive differs', () => {
    const a = hashGameState([makeUnit({ alive: true })]);
    const b = hashGameState([makeUnit({ alive: false })]);
    expect(a).not.toBe(b);
  });

  it('is order-dependent (different unit order = different hash)', () => {
    const u1 = makeUnit({ pos: { x: 10, y: 20 }, hp: 100 });
    const u2 = makeUnit({ pos: { x: 30, y: 40 }, hp: 80 });
    const a = hashGameState([u1, u2]);
    const b = hashGameState([u2, u1]);
    expect(a).not.toBe(b);
  });

  it('rounds positions to 2 decimal places to absorb float noise', () => {
    const a = hashGameState([makeUnit({ pos: { x: 100.001, y: 200.004 } })]);
    const b = hashGameState([makeUnit({ pos: { x: 100.004, y: 200.001 } })]);
    // Both round to x=10000, y=20000 so hashes should be equal
    expect(a).toBe(b);
  });

  it('distinguishes positions that differ beyond 2 decimal places', () => {
    const a = hashGameState([makeUnit({ pos: { x: 100.00, y: 200 } })]);
    const b = hashGameState([makeUnit({ pos: { x: 100.01, y: 200 } })]);
    expect(a).not.toBe(b);
  });

  it('rounds hp to 2 decimal places', () => {
    const a = hashGameState([makeUnit({ hp: 50.001 })]);
    const b = hashGameState([makeUnit({ hp: 50.004 })]);
    // Both round to 5000 (50 * 100 rounded)
    expect(a).toBe(b);
  });

  it('is deterministic across multiple calls', () => {
    const units = [
      makeUnit({ pos: { x: 10, y: 20 }, hp: 100, alive: true }),
      makeUnit({ pos: { x: 30, y: 40 }, hp: 50, alive: false }),
    ];
    const results = Array.from({ length: 100 }, () => hashGameState(units));
    expect(new Set(results).size).toBe(1);
  });
});
