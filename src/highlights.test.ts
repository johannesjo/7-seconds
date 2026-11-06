import { describe, it, expect } from 'vitest';
import {
  HighlightTracker, MULTI_KILL_WINDOW_S, battleHighlights, createTally, findMvp, mergeTally, multiKillLabel, roundHighlights,
  type HitSource, type TallyHit,
} from './highlights';

const sniper: HitSource = { id: 'blue_sniper', type: 'sniper', team: 'blue' };
const soldier: HitSource = { id: 'blue_soldier', type: 'soldier', team: 'blue' };
const redSoldier: HitSource = { id: 'red_soldier', type: 'soldier', team: 'red' };

function kill(source: HitSource, extra: Partial<TallyHit> = {}): TallyHit {
  return { team: source.team, source, damage: 30, killed: true, flanked: false, ...extra };
}

describe('HighlightTracker', () => {
  it('chains kills by one team inside the window into a multi-kill', () => {
    const t = new HighlightTracker();
    expect(t.recordHit(kill(sniper), 1)).toBe(1);
    expect(t.recordHit(kill(soldier), 1 + MULTI_KILL_WINDOW_S * 0.5)).toBe(2);
    expect(t.recordHit(kill(soldier), 1 + MULTI_KILL_WINDOW_S)).toBe(3);
    expect(t.round.teams.blue.bestStreak).toBe(3);
  });

  it('restarts the chain after a gap, and keeps teams apart', () => {
    const t = new HighlightTracker();
    t.recordHit(kill(sniper), 1);
    expect(t.recordHit(kill(redSoldier), 1.1)).toBe(1);
    expect(t.recordHit(kill(sniper), 1 + MULTI_KILL_WINDOW_S + 0.01)).toBe(1);
  });

  it('a non-kill hit neither extends nor breaks a chain', () => {
    const t = new HighlightTracker();
    t.recordHit(kill(sniper), 1);
    expect(t.recordHit(kill(sniper, { killed: false }), 1.2)).toBe(0);
    expect(t.recordHit(kill(sniper), 1.3)).toBe(2);
  });

  it('starts every round fresh but keeps the battle total', () => {
    const t = new HighlightTracker();
    t.recordHit(kill(sniper, { flanked: true }), 1);
    t.recordShieldBreak('blue');
    t.startRound();
    expect(t.round.teams.blue.kills).toBe(0);
    expect(t.recordHit(kill(sniper), 1.1)).toBe(1);
    expect(t.battle.teams.blue).toMatchObject({ kills: 2, flanks: 1, shieldBreaks: 1 });
    expect(t.battle.units.get(sniper.id)?.kills).toBe(2);
  });

  it('counts team totals for hits with no known source', () => {
    const t = new HighlightTracker();
    t.recordHit({ team: 'red', damage: 40, killed: true, flanked: false }, 2);
    expect(t.battle.teams.red.kills).toBe(1);
    expect(t.battle.units.size).toBe(0);
  });
});

describe('multiKillLabel', () => {
  it('names chains of two or more', () => {
    expect(multiKillLabel(1)).toBeNull();
    expect(multiKillLabel(2)).toBe('Double kill');
    expect(multiKillLabel(4)).toBe('Quad kill');
    expect(multiKillLabel(9)).toBe('Rampage');
  });
});

describe('findMvp', () => {
  it('picks most kills, then most damage, on the asked side', () => {
    const t = new HighlightTracker();
    t.recordHit(kill(sniper, { damage: 30 }), 1);
    t.recordHit(kill(soldier, { damage: 10 }), 3);
    t.recordHit(kill(redSoldier), 5);
    t.recordHit(kill(redSoldier), 7);
    expect(findMvp(t.battle, 'blue')?.id).toBe(sniper.id);
    expect(findMvp(t.battle, null)?.id).toBe(redSoldier.id);
    expect(findMvp(createTally(), 'blue')).toBeNull();
  });
});

describe('roundHighlights', () => {
  it('leads with the multi-kill, then the MVP', () => {
    const t = new HighlightTracker();
    t.recordHit(kill(sniper), 1);
    t.recordHit(kill(sniper), 1.2);
    expect(roundHighlights(t.round, 'blue')).toEqual(['Double kill!', 'MVP: Sniper, 2 kills']);
  });

  it('respects a higher multi-kill bar (Horde) and falls back to flanks', () => {
    const t = new HighlightTracker();
    t.recordHit(kill(sniper, { flanked: true }), 1);
    t.recordHit(kill(soldier, { flanked: true }), 1.2);
    expect(roundHighlights(t.round, 'blue', 3)).toEqual(['2 flank hits']);
  });

  it('names the team when two players share the screen', () => {
    const t = new HighlightTracker();
    t.recordHit(kill(redSoldier), 1);
    t.recordHit(kill(redSoldier), 1.1);
    expect(roundHighlights(t.round, null)).toEqual(['Red: Double kill!', 'MVP: Red soldier, 2 kills']);
  });

  it('is empty for a quiet round', () => {
    expect(roundHighlights(createTally(), 'blue')).toEqual([]);
  });
});

describe('battleHighlights', () => {
  it('sums up the MVP, flanks, shields and best moment', () => {
    const t = new HighlightTracker();
    t.recordHit(kill(sniper, { damage: 45, flanked: true }), 1);
    t.recordHit(kill(sniper, { damage: 30 }), 1.4);
    t.recordShieldBreak('blue');
    expect(battleHighlights(t.battle, 'blue')).toEqual([
      'MVP: Sniper · 2 kills · 75 damage · 1 flank hit',
      'Flank hits: 1',
      'Shields broken: 1',
      'Best moment: Double kill',
    ]);
  });

  it('shows both sides for two players', () => {
    const t = new HighlightTracker();
    t.recordHit(kill(sniper, { flanked: true }), 1);
    t.recordHit(kill(redSoldier, { flanked: true }), 2);
    t.recordHit(kill(redSoldier, { killed: false, flanked: true }), 3);
    expect(battleHighlights(t.battle, null)).toContain('Flank hits: Blue 1 · Red 2');
  });
});

describe('mergeTally', () => {
  it('adds a wave into a run, keeping the best streak', () => {
    const run = createTally();
    const a = new HighlightTracker();
    a.recordHit(kill(sniper), 1);
    a.recordHit(kill(sniper), 1.1);
    const b = new HighlightTracker();
    b.recordHit(kill(sniper), 1);
    mergeTally(run, a.battle);
    mergeTally(run, b.battle);
    expect(run.units.get(sniper.id)?.kills).toBe(3);
    expect(run.teams.blue.bestStreak).toBe(2);
    // The run's copy is its own: later waves don't write into the first
    expect(a.battle.units.get(sniper.id)?.kills).toBe(2);
  });
});

describe('engine credits hits to the units that dealt them', () => {
  it('tallies a soldier line shooting down a lone enemy', async () => {
    const { GameEngine } = await import('./game');
    const { UNIT_STATS } = await import('./constants');
    const s = UNIT_STATS.soldier;
    const unit = (id: string, team: 'blue' | 'red', x: number, y: number) => ({
      id, type: 'soldier' as const, team, x, y, hp: s.hp, maxHp: s.hp, radius: s.radius, speed: s.speed, range: s.range,
      gunAngle: team === 'blue' ? -Math.PI / 2 : Math.PI / 2,
    });
    const engine = new GameEngine(null, () => {}, { seed: 7 });
    engine.loadOnlineGameState({
      units: [unit('blue_a', 'blue', 150, 400), unit('blue_b', 'blue', 210, 400), unit('red_a', 'red', 180, 320)],
      obstacles: [], elevationZones: [], mapWidth: 360, mapHeight: 640,
    });
    engine.startPlaying();
    for (let i = 0; i < 360 && engine.getAliveCount().red > 0; i++) engine.externalTick(1000 / 60);

    expect(engine.getAliveCount().red).toBe(0);
    const tally = engine.battleTally;
    expect(tally.teams.blue.kills).toBe(1);
    const credited = [...tally.units.values()].filter(u => u.team === 'blue');
    expect(credited.length).toBeGreaterThan(0);
    expect(credited.reduce((n, u) => n + u.kills, 0)).toBe(1);
    expect(credited.every(u => u.id === 'blue_a' || u.id === 'blue_b')).toBe(true);
    expect(tally.teams.blue.damage).toBeGreaterThanOrEqual(s.hp);
  });
});
