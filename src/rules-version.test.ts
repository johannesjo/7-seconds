// Tripwire for online rules changes. The referee resolves each online round
// and clients animate the same round locally, so both must run the same rules.
// These scripted battles use no AI and no map generation: only the simulation.
// If this fails after a change to movement, combat, ordnance or terrain:
//   1. bump RULES_VERSION in src/online-plan.ts,
//   2. paste the printed values into GOLDEN,
//   3. add a migration ending older matches (see docs/online-play.md, "Rules versions").
import { describe, it, expect } from 'vitest';
import { GameEngine } from './game';
import { UNIT_STATS, ROUND_DURATION_S } from './constants';
import type { OnlineGameState } from './online-types';
import type { PathList } from './online-plan';
import type { Team, UnitType } from './types';

const TICKS = Math.round(ROUND_DURATION_S * 60);
const TYPES: UnitType[] = ['soldier', 'sniper', 'blade', 'shielder', 'bomber', 'mortar', 'rocketeer'];

function unit(id: string, type: UnitType, team: Team, x: number, y: number) {
  const s = UNIT_STATS[type];
  return { id, type, team, x, y, hp: s.hp, maxHp: s.hp, radius: s.radius, speed: s.speed, range: s.range, gunAngle: team === 'blue' ? -Math.PI / 2 : Math.PI / 2 };
}

/** Mirrored armies of every type on a map with cover and hills; `shift`
 *  staggers the lines so each scenario plays out differently. */
function scenario(shift: number): OnlineGameState {
  const units = TYPES.flatMap((type, i) => {
    const x = 140 + i * 120;
    return [unit(`blue_${type}`, type, 'blue', x + shift, 900 - (i % 2) * 40), unit(`red_${type}`, type, 'red', x - shift, 100 + (i % 3) * 30)];
  });
  return {
    units,
    obstacles: [{ x: 300, y: 450, w: 120, h: 30 }, { x: 600, y: 520, w: 30, h: 140 }, { x: 140 + shift, y: 300, w: 80, h: 80 }],
    elevationZones: [{ x: 450, y: 380, w: 160, h: 120 }, { x: 80, y: 600, w: 120, h: 100 }],
    mapWidth: 1000,
    mapHeight: 1000,
  };
}

/** Each unit heads across the map in a zig-zag; rocketeers fire at the
 *  enemy's middle. Varies with the round so later rounds differ too. */
function orders(state: OnlineGameState, team: Team, round: number): PathList {
  const dir = team === 'blue' ? -1 : 1;
  return state.units.filter(u => u.team === team && u.hp > 0).map((u, i) => {
    const sway = ((i + round) % 3 - 1) * 70;
    const waypoints = [
      { x: u.x + sway, y: u.y + dir * 120 },
      { x: u.x - sway / 2, y: u.y + dir * (200 + round * 30) },
    ];
    return u.type === 'rocketeer'
      ? { unitId: u.id, waypoints, rocketPath: [{ x: 500 + sway, y: 500 }, { x: 500, y: team === 'blue' ? 150 : 850 }] }
      : { unitId: u.id, waypoints };
  });
}

function fingerprint(state: OnlineGameState): string {
  return state.units.map(u => `${u.id}:${u.x.toFixed(2)},${u.y.toFixed(2)},${u.hp.toFixed(2)}`).join(';');
}

function fnv(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Three rounds of each scenario under a few seeds. */
function outcomes(): string[] {
  const out: string[] = [];
  for (const shift of [0, 35, 70]) {
    for (const seed of [1, 99, 123456]) {
      let state = scenario(shift);
      const rounds: string[] = [];
      for (let round = 1; round <= 3; round++) {
        const result = GameEngine.resolveRound(state, orders(state, 'blue', round), orders(state, 'red', round), seed + round - 1, TICKS);
        state = result.endState;
        rounds.push(fnv(fingerprint(state)));
        if (result.gameOver) break;
      }
      out.push(rounds.join('-'));
    }
  }
  return out;
}

const GOLDEN: string[] = [
  "47650fcb-5fb7700d-41f55768", "47650fcb-5fb7700d-41f55768", "47650fcb-5fb7700d-41f55768",
  "5547cd8e-a85e0e7c-90f18790", "5547cd8e-a85e0e7c-90f18790", "5547cd8e-a85e0e7c-90f18790",
  "3dc4bfdc-1e4f0e6f-08efe825", "3dc4bfdc-1e4f0e6f-08efe825", "3dc4bfdc-1e4f0e6f-08efe825",
];

describe('online rules version', () => {
  it('scripted battles end as recorded for this RULES_VERSION', () => {
    const actual = outcomes();
    if (JSON.stringify(actual) !== JSON.stringify(GOLDEN)) {
      console.log(`Battle outcomes changed. Bump RULES_VERSION and set GOLDEN to:\n${JSON.stringify(actual, null, 2)}`);
    }
    expect(actual).toEqual(GOLDEN);
  });

  it('exercises combat: units take damage and fall', () => {
    let state = scenario(35);
    for (let round = 1; round <= 3; round++) {
      state = GameEngine.resolveRound(state, orders(state, 'blue', round), orders(state, 'red', round), round, TICKS).endState;
    }
    expect(state.units.some(u => u.hp > 0 && u.hp < u.maxHp)).toBe(true);
    expect(state.units.some(u => u.hp <= 0)).toBe(true);
  });

  it('is deterministic', () => {
    expect(outcomes()).toEqual(outcomes());
  });
});
