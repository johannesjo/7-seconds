import { describe, it, expect } from 'vitest';
import * as src from './engine-entry';
// The vendored bundle the Edge Function actually imports. Importing it here
// proves it (a) is valid ESM, (b) runs with no DOM, and (c) reproduces the
// engine bit-for-bit. If the bundle is stale, `npm run build:edge` regenerates
// it and this test guards against drift.
// @ts-expect-error - generated JS bundle, no type declarations
import * as bundle from '../supabase/functions/_shared/engine.mjs';

const blue = [{ unitId: 'b1', waypoints: [{ x: 10, y: 20 }] }];
const red = [{ unitId: 'r1', waypoints: [{ x: 100, y: 200 }] }];

describe('edge engine bundle', () => {
  // A minimal hand-rolled start state (avoids depending on generateInitialState).
  const state = {
    units: [
      { id: 'b1', type: 'soldier', team: 'blue', x: 100, y: 300, hp: 100, maxHp: 100, radius: 10, speed: 60, range: 120, gunAngle: 0 },
      { id: 'r1', type: 'soldier', team: 'red', x: 700, y: 300, hp: 100, maxHp: 100, radius: 10, speed: 60, range: 120, gunAngle: 0 },
    ],
    obstacles: [], elevationZones: [], mapWidth: 800, mapHeight: 600,
  } as unknown as Parameters<typeof src.resolveRound>[0];

  it('resolveRound matches the source engine exactly (deterministic, headless)', () => {
    expect(typeof bundle.resolveRound).toBe('function');
    const a = src.resolveRound(structuredClone(state), blue, red, 4242, 360);
    const b = bundle.resolveRound(structuredClone(state), blue, red, 4242, 360);
    expect(JSON.stringify(b.endState)).toBe(JSON.stringify(a.endState));
    expect(b.gameOver).toBe(a.gameOver);
  });

  it('exposes the commit/seed helpers and they agree with the source', () => {
    expect(bundle.hashPaths(blue)).toBe(src.hashPaths(blue));
    expect(bundle.deriveMatchSeed('room1', 11, 22)).toBe(src.deriveMatchSeed('room1', 11, 22));
    const turn = { team: 'blue', commitHash: src.hashPaths(blue), paths: blue };
    expect(bundle.verifyReveal(turn)).toBe(true);
    expect(bundle.verifyReveal({ team: 'blue', commitHash: 1, paths: blue })).toBe(false);
  });

  it('exposes ROUND_DURATION_S for the per-round tick budget', () => {
    expect(bundle.ROUND_DURATION_S).toBe(src.ROUND_DURATION_S);
  });

  it('blueAlive decides the winner consistently', () => {
    expect(bundle.blueAlive({ units: [{ team: 'blue', hp: 5 }] })).toBe(true);
    expect(bundle.blueAlive({ units: [{ team: 'blue', hp: 0 }] })).toBe(false);
  });
});
