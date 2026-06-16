import { describe, it, expect } from 'vitest';
import { GameEngine } from './game';
import type { OnlineGameState } from './online-types';

// Guards the C1/C2 determinism fix: the authoritative round result must be a
// pure function of (startState, paths, seed, maxTicks) — never of frame pacing.
describe('GameEngine.resolveRound', () => {
  const start: OnlineGameState = GameEngine.generateInitialState();
  const noPaths: { unitId: string; waypoints: { x: number; y: number }[] }[] = [];

  it('is deterministic for identical inputs', () => {
    const a = GameEngine.resolveRound(start, noPaths, noPaths, 12345, 360);
    const b = GameEngine.resolveRound(start, noPaths, noPaths, 12345, 360);
    expect(JSON.stringify(a.endState)).toBe(JSON.stringify(b.endState));
    expect(a.gameOver).toBe(b.gameOver);
  });

  it('does not mutate the input start state', () => {
    const snapshot = JSON.stringify(start);
    GameEngine.resolveRound(start, noPaths, noPaths, 7, 360);
    expect(JSON.stringify(start)).toBe(snapshot);
  });

  it('reports game over when a side starts already eliminated', () => {
    // Red present but with zero units alive -> blue wins immediately.
    const blueOnly: OnlineGameState = {
      ...start,
      units: start.units.filter(u => u.team === 'blue'),
    };
    const res = GameEngine.resolveRound(blueOnly, noPaths, noPaths, 1, 360);
    expect(res.gameOver).toBe(true);
  });

  it('stops early on elimination rather than always running maxTicks', () => {
    const blueOnly: OnlineGameState = {
      ...start,
      units: start.units.filter(u => u.team === 'blue'),
    };
    // Already eliminated at tick 0 -> identical result regardless of maxTicks.
    const short = GameEngine.resolveRound(blueOnly, noPaths, noPaths, 1, 10);
    const long = GameEngine.resolveRound(blueOnly, noPaths, noPaths, 1, 3600);
    expect(JSON.stringify(short.endState)).toBe(JSON.stringify(long.endState));
    expect(short.gameOver).toBe(true);
  });
});
