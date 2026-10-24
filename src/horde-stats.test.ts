import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getHordeRecord, recordHordeProgress, recordHordeClear } from './horde-stats';

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  });
});

describe('horde record', () => {
  it('keeps the best wave and score across runs', () => {
    recordHordeProgress(1, 100);
    recordHordeProgress(2, 250);
    recordHordeProgress(1, 150);
    expect(getHordeRecord()).toEqual({ bestWave: 2, bestScore: 250, clears: 0 });
  });

  it('counts full clears', () => {
    recordHordeClear();
    expect(getHordeRecord().clears).toBe(1);
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('7s-horde-stats', '{not json');
    expect(getHordeRecord().bestWave).toBe(0);
    expect(recordHordeProgress(3, 300).bestWave).toBe(3);
  });

  it('ignores stored fields that are not counts', () => {
    localStorage.setItem('7s-horde-stats', JSON.stringify({ bestWave: 'x', bestScore: null, clears: -2 }));
    expect(recordHordeProgress(2, 200)).toEqual({ bestWave: 2, bestScore: 200, clears: 0 });
  });
});
