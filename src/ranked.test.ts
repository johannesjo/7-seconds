import { describe, it, expect } from 'vitest';
import { rankTitle, nextRank, formatDelta, timeAgo, battleStateLabel, resultLabel, profileSummary, rankedMatchNote, type RankedBattle } from './ranked';

describe('ranked labels', () => {
  it('titles ratings, starting players as Sergeants', () => {
    expect(rankTitle(1200)).toBe('Sergeant');
    expect(rankTitle(1000)).toBe('Recruit');
    expect(rankTitle(1900)).toBe('Marshal');
    expect(nextRank(1200)).toEqual({ title: 'Lieutenant', needed: 50 });
    expect(nextRank(1850)).toBeNull();
  });

  it('formats rating changes and times', () => {
    expect(formatDelta(16)).toBe('+16');
    expect(formatDelta(-12)).toBe('−12');
    expect(formatDelta(0)).toBe('0');
    const now = Date.parse('2026-10-24T12:00:00Z');
    expect(timeAgo('2026-10-24T11:55:00Z', now)).toBe('5 min ago');
    expect(timeAgo('2026-10-22T12:00:00Z', now)).toBe('2 d ago');
  });

  it('describes battles, results and profiles', () => {
    const battle = { state: 'your_turn', round: 3 } as RankedBattle;
    expect(battleStateLabel(battle)).toBe('Your turn · round 3');
    expect(resultLabel({ match_id: 'x', opponent: null, won: false, delta: -20, reason: 'timeout', finished_at: '', rounds: 4 }))
      .toBe('Lost on time vs a former commander · −20');
    expect(profileSummary({ display_name: 'A', rating: 1260, games: 3, wins: 2, losses: 1, rank: 4, peak_rating: 1280 }))
      .toBe('Lieutenant · 1260 Elo · #4 · 2W 1L · peak 1280');
  });

  it('shows the stakes during a match and the rating change after it', () => {
    const opponent = { display_name: 'Major Flint (AI)', rating: 1300, games: 0, wins: 0, losses: 0, bot: true };
    expect(rankedMatchNote({ team: 'blue', status: 'active', expired: false, opponent, stakes: { win: 26, loss: -14 }, result: null }).text)
      .toBe('Ranked · Win +26 / Loss −14 · vs Major Flint (AI) (1300)');
    expect(rankedMatchNote({ team: 'blue', status: 'host_won', expired: false, opponent, stakes: null,
      result: { won: true, reason: 'battle', delta: 26, rating: 1226, rank: 2 } })).toEqual({ tone: 'win', text: 'Victory · +26 Elo · now 1226 (Sergeant, #2)' });
    expect(rankedMatchNote(null).text).toMatch(/Elo/);
  });
});
