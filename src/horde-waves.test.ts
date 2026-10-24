import { describe, it, expect } from 'vitest';
import {
  BOSSES, WAVE_MODIFIERS, bossForWave, buildWavePlan, endlessEnemies, rollModifiers, rollPact, withCurse,
  waveComposition, waveScore, describePlan, spawnHordeWave, type HordeWavePlan, type WaveModifierId,
} from './horde-waves';
import { HORDE_WAVES } from './horde';
import { HORDE_MAX_WAVES, MAP_WIDTH, MAP_HEIGHT, UNIT_STATS, setMapSize } from './constants';
import { createRng } from './rng';

const count = (comp: { type: string; count: number }[], type: string) =>
  comp.find(c => c.type === type)?.count ?? 0;

function plan(wave: number, modifiers: WaveModifierId[] = [], extra: Partial<HordeWavePlan> = {}): HordeWavePlan {
  return { wave, enemies: HORDE_WAVES[Math.min(wave, HORDE_MAX_WAVES) - 1].enemies, modifiers, ...extra };
}

describe('bosses', () => {
  it('appear every fifth wave, cycling through the roster', () => {
    expect(bossForWave(4)).toBeUndefined();
    expect(bossForWave(5)).toBe('brute');
    expect(bossForWave(10)).toBe('juggernaut');
    expect(bossForWave(15)).toBe('abomination');
    expect(bossForWave(20)).toBe('brute');
  });

  it('spawn as a single oversized named unit', () => {
    const units = spawnHordeWave(buildWavePlan(5, createRng(1)), [], []);
    const bosses = units.filter(u => u.boss);
    expect(bosses).toHaveLength(1);
    expect(bosses[0].boss).toBe('brute');
    expect(bosses[0].maxHp).toBe(BOSSES.brute.hp);
    expect(bosses[0].radius).toBeGreaterThan(UNIT_STATS.zombie.radius);
    expect(bosses[0].team).toBe('red');
  });

  it('come back tougher on later endless cycles', () => {
    const first = spawnHordeWave(plan(5, [], { boss: 'brute' }), [], []).find(u => u.boss)!;
    const second = spawnHordeWave(plan(20, [], { boss: 'brute' }), [], []).find(u => u.boss)!;
    expect(second.maxHp).toBeGreaterThan(first.maxHp * 1.5);
  });

  it('replace a quarter of the zombies', () => {
    const base = count(HORDE_WAVES[4].enemies, 'zombie');
    expect(count(waveComposition(plan(5, [], { boss: 'brute' })), 'zombie')).toBe(Math.round(base * 0.75));
  });
});

describe('rollModifiers', () => {
  it('leaves early and boss waves unmodified', () => {
    for (let seed = 1; seed < 50; seed++) {
      expect(rollModifiers(1, createRng(seed))).toEqual([]);
      expect(rollModifiers(2, createRng(seed))).toEqual([]);
      expect(rollModifiers(10, createRng(seed))).toEqual([]);
    }
  });

  it('always modifies endless waves, never with two spawn patterns', () => {
    for (let seed = 1; seed < 200; seed++) {
      const mods = rollModifiers(HORDE_MAX_WAVES + 6, createRng(seed));
      expect(mods.length).toBeGreaterThanOrEqual(1);
      expect(new Set(mods).size).toBe(mods.length);
      expect(mods.filter(id => WAVE_MODIFIERS[id].spawn).length).toBeLessThanOrEqual(1);
    }
  });

  it('keeps endless boss waves about the boss', () => {
    expect(rollModifiers(HORDE_MAX_WAVES + 5, createRng(1))).toEqual([]);
  });

  it('respects each modifier\'s earliest wave', () => {
    for (let seed = 1; seed < 200; seed++) {
      for (const id of rollModifiers(4, createRng(seed))) {
        expect(WAVE_MODIFIERS[id].minWave).toBeLessThanOrEqual(4);
      }
    }
  });
});

describe('buildWavePlan', () => {
  it('uses the scripted waves, then endless ones', () => {
    expect(buildWavePlan(3, createRng(1)).enemies).toEqual(HORDE_WAVES[2].enemies);
    const endless = buildWavePlan(HORDE_MAX_WAVES + 1, createRng(1));
    expect(endless.enemies.reduce((n, e) => n + e.count, 0)).toBeGreaterThanOrEqual(
      HORDE_WAVES[HORDE_MAX_WAVES - 1].enemies.reduce((n, e) => n + e.count, 0));
  });

  it('caps endless growth in unit count', () => {
    const total = (wave: number) => endlessEnemies(wave, () => 0).reduce((n, e) => n + e.count, 0);
    expect(total(200)).toBe(total(60));
  });
});

describe('waveComposition', () => {
  it('swarm adds zombies, bomber rush converts some into bombers', () => {
    const base = count(HORDE_WAVES[5].enemies, 'zombie');
    expect(count(waveComposition(plan(6, ['swarm'])), 'zombie')).toBe(Math.round(base * 1.6));
    const rush = waveComposition(plan(6, ['bomber_rush']));
    expect(count(rush, 'zombie') + count(rush, 'bomber')).toBe(base + count(HORDE_WAVES[5].enemies, 'bomber'));
    expect(count(rush, 'bomber')).toBeGreaterThanOrEqual(2);
  });

  it('sniper nest adds snipers', () => {
    expect(count(waveComposition(plan(6, ['sniper_nest'])), 'sniper')).toBe(2);
  });
});

describe('spawnHordeWave', () => {
  it('spawns enemies along the sides on a flank attack', () => {
    const units = spawnHordeWave(plan(6, ['flank']), [], []);
    for (const u of units) {
      expect(Math.min(u.pos.x, MAP_WIDTH - u.pos.x)).toBeLessThan(120);
      expect(u.pos.y).toBeGreaterThan(MAP_HEIGHT * 0.2 - 1);
      expect(u.pos.y).toBeLessThan(MAP_HEIGHT * 0.65 + 1);
    }
  });

  it('keeps flank columns at the sides on the narrowest map', () => {
    setMapSize(360, 620);
    try {
      const units = spawnHordeWave(plan(HORDE_MAX_WAVES + 15, ['swarm', 'flank']), [], []);
      for (const u of units) {
        expect(Math.min(u.pos.x, MAP_WIDTH - u.pos.x)).toBeLessThanOrEqual(MAP_WIDTH * 0.3);
      }
    } finally {
      setMapSize(1000, 1000);
    }
  });

  it('brings half the melee horde in close on an ambush, never a gunner', () => {
    const units = spawnHordeWave(plan(8, ['ambush']), [], []);
    const melee = units.filter(u => ['zombie', 'blade', 'shielder', 'bomber'].includes(u.type));
    const close = units.filter(u => u.pos.y >= MAP_HEIGHT * 0.45);
    expect(close.length).toBe(Math.floor(melee.length / 2));
    expect(close.every(u => melee.includes(u))).toBe(true);
  });

  it('keeps the nest out of range of the spawn line on a small map', () => {
    setMapSize(360, 620);
    try {
      const units = spawnHordeWave(plan(6, ['sniper_nest']), [], [{ x: 100, y: 200, w: 150, h: 80 }]);
      for (const u of units.filter(s => s.type === 'sniper')) {
        expect(MAP_HEIGHT * 0.92 - u.pos.y).toBeGreaterThan(UNIT_STATS.sniper.range * 1.2);
      }
    } finally {
      setMapSize(1000, 1000);
    }
  });

  it('digs the nest snipers in on the furthest hill up the map', () => {
    const hill = { x: 300, y: 350, w: 200, h: 80 };
    const units = spawnHordeWave(plan(6, ['sniper_nest']), [], [{ x: 100, y: 800, w: 150, h: 60 }, hill]);
    const onHill = units.filter(u => u.type === 'sniper'
      && u.pos.x >= hill.x && u.pos.x <= hill.x + hill.w && u.pos.y >= hill.y && u.pos.y <= hill.y + hill.h);
    expect(onHill).toHaveLength(2);
  });

  it('applies armored and frenzy to enemy stats', () => {
    const units = spawnHordeWave(plan(6, ['armored', 'frenzy']), [], []);
    const zombie = units.find(u => u.type === 'zombie')!;
    expect(zombie.maxHp).toBe(UNIT_STATS.zombie.hp * 1.5);
    expect(zombie.hp).toBe(zombie.maxHp);
    expect(zombie.speed).toBeCloseTo(UNIT_STATS.zombie.speed * 1.3);
  });

  it('makes endless enemies tougher', () => {
    const units = spawnHordeWave(plan(HORDE_MAX_WAVES + 5), [], []);
    expect(units.find(u => u.type === 'zombie')!.maxHp).toBeGreaterThan(UNIT_STATS.zombie.hp);
  });

  it('gives every enemy a unique id', () => {
    const units = spawnHordeWave(plan(10, ['sniper_nest', 'bomber_rush'], { boss: 'juggernaut' }), [], []);
    expect(new Set(units.map(u => u.id)).size).toBe(units.length);
  });
});

describe('pacts', () => {
  it('are not offered before wave 3', () => {
    for (let seed = 1; seed < 50; seed++) {
      expect(rollPact(plan(2), createRng(seed))).toBeNull();
    }
  });

  it('never curse a wave with a modifier it is too early for', () => {
    for (let seed = 1; seed < 200; seed++) {
      const pact = rollPact(plan(3), createRng(seed));
      if (pact) expect(WAVE_MODIFIERS[pact.curse].minWave).toBeLessThanOrEqual(3);
    }
  });

  it('curse with a modifier the wave can take', () => {
    let offered = 0;
    for (let seed = 1; seed < 100; seed++) {
      const next = plan(7, ['flank']);
      const pact = rollPact(next, createRng(seed));
      if (!pact) continue;
      offered++;
      expect(pact.curse).not.toBe('flank');
      expect(pact.curse).not.toBe('ambush');
      const cursed = withCurse(next, pact.curse);
      expect(cursed.modifiers).toContain(pact.curse);
      expect(cursed.curse).toBe(pact.curse);
    }
    expect(offered).toBeGreaterThan(0);
  });
});

describe('waveScore', () => {
  it('rewards modifiers and bosses', () => {
    expect(waveScore(plan(1))).toBe(100);
    expect(waveScore(plan(6, ['frenzy', 'armored']))).toBe(200);
    expect(waveScore(plan(5, [], { boss: 'brute' }))).toBe(350);
  });
});

describe('describePlan', () => {
  it('names the boss first, then the modifiers', () => {
    expect(describePlan(plan(1))).toBe('');
    expect(describePlan(plan(5, ['frenzy'], { boss: 'brute' }))).toBe('The Brute · Frenzy');
  });
});
