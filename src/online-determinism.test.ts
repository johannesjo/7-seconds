import { describe, it, expect } from 'vitest';
import { GameEngine } from './game';
import { hashGameState } from './online-sync';
import type { OnlineGameState } from './online-types';

// Proves the lockstep fix: the host transmits the *per-round* seed and the guest
// simulates with it, so both peers produce identical state for EVERY round — not
// just round 1. A red zombie chasing a blue unit consumes RNG via its "shamble"
// wobble (units.ts) on every move step, so any seed difference shows up in the
// state hash. Without that RNG consumer the seed would be invisible and these
// tests would be false passes.

function makeSnapshot(): OnlineGameState {
  return {
    units: [
      // Red zombie chases the nearest enemy via the engine's chase AI (no paths).
      { id: 'red1', type: 'zombie', team: 'red', x: 500, y: 700, hp: 100, maxHp: 100, radius: 7, speed: 60, range: 0, gunAngle: 0 },
      { id: 'blue1', type: 'soldier', team: 'blue', x: 500, y: 250, hp: 100, maxHp: 100, radius: 6, speed: 80, range: 120, gunAngle: 0 },
    ],
    obstacles: [],
    elevationZones: [],
    mapWidth: 600,
    mapHeight: 800,
  };
}

/** Run a guest-style headless round with an explicit per-round seed. */
function runRound(roundSeed: number, steps: number): number {
  const eng = new GameEngine(null, () => {}, { seed: roundSeed });
  eng.loadOnlineGameState(makeSnapshot());
  eng.setBluePaths([]); // blue holds position
  eng.setRedPaths([]);  // zombie chases via AI
  eng.startPlaying(roundSeed);
  for (let i = 0; i < steps; i++) eng.externalTick(1000 / 60);
  return hashGameState(eng.getUnits());
}

describe('lockstep determinism', () => {
  it('two engines with the same round seed produce identical state', () => {
    const a = runRound(12347, 40);
    const b = runRound(12347, 40);
    expect(b).toBe(a);
  });

  it('is sensitive to the seed — proves the hash actually depends on it', () => {
    // Round 2: host derives base+2. The old bug had the guest always use base+1,
    // because its fresh headless engine never tracked the round number. The two
    // seeds must yield different state, otherwise the round-2 fix is untestable.
    const base = 12345;
    const hostRound2 = runRound(base + 2, 40);
    const buggyGuestRound2 = runRound(base + 1, 40);
    expect(buggyGuestRound2).not.toBe(hostRound2);
  });

  it('startPlaying(roundSeed) overrides the constructor seed for the RNG', () => {
    // Host transmits the round seed regardless of how the guest engine was
    // constructed, so the explicit arg must win.
    const fromArg = (() => {
      const eng = new GameEngine(null, () => {}, { seed: 999 });
      eng.loadOnlineGameState(makeSnapshot());
      eng.setBluePaths([]);
      eng.setRedPaths([]);
      eng.startPlaying(12347); // explicit round seed
      for (let i = 0; i < 40; i++) eng.externalTick(1000 / 60);
      return hashGameState(eng.getUnits());
    })();
    expect(fromArg).toBe(runRound(12347, 40));
  });
});
