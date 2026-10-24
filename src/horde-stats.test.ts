import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getHordeRecord, recordHordeRunStart, recordHordeProgress, recordHordeClear } from './horde-stats';

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  });
});

describe('horde record', () => {
  it('keeps the best wave and score across runs', () => {
    recordHordeRunStart();
    recordHordeProgress(1, 100);
    recordHordeProgress(2, 250);
    recordHordeRunStart();
    recordHordeProgress(1, 150);
    expect(getHordeRecord()).toEqual({ bestWave: 2, bestScore: 250, runs: 2, clears: 0 });
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
});
