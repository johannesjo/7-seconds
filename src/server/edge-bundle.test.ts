import { describe, it, expect } from 'vitest';
import * as source from './edge-entry';
// The committed bundle the Edge Function imports. Importing it here proves it
// is valid ESM, runs with no DOM, and reproduces the engine bit for bit.
// `npm run referee:check` (CI) fails when it is older than the source.
import * as typedBundle from '../../supabase/functions/match-referee/referee.mjs';
import { createRng } from '../rng';

// referee.d.mts types only what the Edge Function uses; the test reaches further.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const bundle = typedBundle as unknown as Record<string, any>;

describe('match-referee bundle', () => {
  it('exports what the Edge Function and its type declarations name', () => {
    for (const name of ['handleReferee', 'StoreError', 'verifyPlayGames', 'alertText', 'webPushPayload', 'fcmMessage']) {
      expect(typeof bundle[name]).toBe('function');
    }
    expect(bundle.RULES_VERSION).toBe(source.RULES_VERSION);
  });

  it('resolves rounds and plans commanders exactly like the source', () => {
    const state = source.GameEngine.generateInitialState();
    const blue = source.planBotPaths(state, 'blue', 'veteran', createRng(5));
    const red = bundle.planBotPaths(state, 'red', 'recruit', createRng(6));
    expect(red).toEqual(source.planBotPaths(state, 'red', 'recruit', createRng(6)));
    const a = source.GameEngine.resolveRound(structuredClone(state), blue, red, 77, 360);
    const b = bundle.GameEngine.resolveRound(structuredClone(state), blue, red, 77, 360);
    expect(JSON.stringify(b.endState)).toBe(JSON.stringify(a.endState));
    expect(b.gameOver).toBe(a.gameOver);
  });
});
