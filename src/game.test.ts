import { describe, it, expect } from 'vitest';
import { GameEngine } from './game';
import type { OnlineGameState } from './online-types';

// Regression: shielders (and other chase-type red units) must follow the paths a
// HUMAN player drew. The chase AI is for AI opponents only — when it ran in online
// / hotseat play it overwrote the human red team's waypoints, so their shield
// units appeared to "move on their own" toward the nearest enemy.

/** A red shielder far above a lone blue enemy. Chasing means moving DOWN (+y)
 *  toward the enemy; following the drawn path means moving RIGHT (+x). */
function snapshot(): OnlineGameState {
  return {
    units: [
      { id: 'red_shielder_0', type: 'shielder', team: 'red', x: 300, y: 100, hp: 40, maxHp: 40, radius: 11, speed: 45, range: 20, gunAngle: 0 },
      { id: 'blue_soldier_0', type: 'soldier', team: 'blue', x: 300, y: 700, hp: 100, maxHp: 100, radius: 6, speed: 80, range: 120, gunAngle: 0 },
    ],
    obstacles: [],
    elevationZones: [],
    mapWidth: 600,
    mapHeight: 800,
  };
}

describe('chase AI is AI-only', () => {
  it('a human-controlled (lockstep) red shielder follows its drawn path, not the enemy', () => {
    const eng = new GameEngine(null, () => {}, { seed: 1 }); // aiMode defaults false → guest/hotseat
    eng.loadOnlineGameState(snapshot());
    eng.setBluePaths([]);
    // Player draws a path sending the shielder RIGHT, away from the enemy below.
    eng.setRedPaths([{ unitId: 'red_shielder_0', waypoints: [{ x: 550, y: 100 }] }]);
    eng.startPlaying(1);
    for (let i = 0; i < 90; i++) eng.externalTick(1000 / 60);

    const shielder = eng.getUnits().find(u => u.id === 'red_shielder_0')!;
    expect(shielder.pos.x).toBeGreaterThan(330); // moved along the drawn path
    expect(shielder.pos.y).toBeLessThan(160);    // did NOT chase the enemy downward
  });

  it('an AI-controlled red shielder still chases the enemy (behavior preserved)', () => {
    const eng = new GameEngine(null, () => {}, { seed: 1, aiMode: true });
    eng.loadOnlineGameState(snapshot());
    eng.setBluePaths([]);
    eng.setRedPaths([]); // AI shielders have no drawn path — they chase
    eng.startPlaying(1);
    for (let i = 0; i < 90; i++) eng.externalTick(1000 / 60);

    const shielder = eng.getUnits().find(u => u.id === 'red_shielder_0')!;
    expect(shielder.pos.y).toBeGreaterThan(160); // chased the enemy downward
  });
});
