import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  formatDailyShare, getDailyChallenge, getDailyResult, getDailyStreak, localDateKey, recordDailyResult,
} from './daily';

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => { storage.set(key, value); },
  });
});

const day = (date: string, won: boolean) => ({ date, won, rounds: 2, survivors: won ? 2 : 0, total: 4 });

describe('daily challenge', () => {
  it('is the same all day and changes from day to day', () => {
    const morning = getDailyChallenge(new Date(2026, 9, 24, 7, 0));
    const night = getDailyChallenge(new Date(2026, 9, 24, 23, 59));
    expect(night).toEqual(morning);
    expect(morning.date).toBe('2026-10-24');
    const week = Array.from({ length: 7 }, (_, i) => getDailyChallenge(new Date(2026, 9, 24 + i)));
    expect(new Set(week.map(c => c.seed)).size).toBe(7);
    expect(week[1].number).toBe(morning.number + 1);
  });

  it('numbers challenges from the first day of 2026', () => {
    expect(getDailyChallenge(new Date(2026, 0, 1)).number).toBe(1);
    expect(localDateKey(new Date(2026, 1, 3))).toBe('2026-02-03');
  });

  it('keeps only the first finished attempt of a day', () => {
    expect(recordDailyResult(day('2026-10-24', false))).toBe(true);
    expect(recordDailyResult(day('2026-10-24', true))).toBe(false);
    expect(getDailyResult('2026-10-24')?.won).toBe(false);
  });

  it('counts consecutive won days, still alive while today is unplayed', () => {
    recordDailyResult(day('2026-10-20', true));
    recordDailyResult(day('2026-10-22', true));
    recordDailyResult(day('2026-10-23', true));
    expect(getDailyStreak('2026-10-24')).toBe(2);
    recordDailyResult(day('2026-10-24', true));
    expect(getDailyStreak('2026-10-24')).toBe(3);
    expect(getDailyStreak('2026-10-26')).toBe(0);
  });

  it('formats a spoiler-free share text', () => {
    const challenge = getDailyChallenge(new Date(2026, 9, 24));
    const text = formatDailyShare(challenge, { date: challenge.date, won: true, rounds: 1, survivors: 3, total: 5 }, 'https://x.test/');
    expect(text).toBe(`7 Seconds Daily #${challenge.number}\n🏆 Won in 1 round\n🟦🟦🟦⬛⬛ 3/5 survived\nhttps://x.test/`);
  });
});
