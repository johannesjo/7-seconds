import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getAiRecord, recordAiResult } from './stats';

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  });
});

describe('vs AI record', () => {
  it('tracks wins, losses and streaks per difficulty', () => {
    recordAiResult('normal', true);
    recordAiResult('normal', true);
    recordAiResult('normal', false);
    recordAiResult('normal', true);
    recordAiResult('hard', false);
    expect(getAiRecord('normal')).toEqual({ wins: 3, losses: 1, streak: 1, bestStreak: 2 });
    expect(getAiRecord('hard')).toEqual({ wins: 0, losses: 1, streak: 0, bestStreak: 0 });
    expect(getAiRecord('easy')).toEqual({ wins: 0, losses: 0, streak: 0, bestStreak: 0 });
  });

  it('survives corrupt storage', () => {
    localStorage.setItem('7s-ai-stats', '{not json');
    expect(getAiRecord('normal').wins).toBe(0);
    expect(recordAiResult('normal', true).wins).toBe(1);
  });
});
