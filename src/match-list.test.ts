import { describe, expect, it } from 'vitest';
import { groupMatches, matchAction } from './match-list';
import type { MatchSummary, MatchStatus } from './online-async';
import type { MatchOutcome } from './online-async-core';

function match(id: string, outcome: MatchOutcome, status: MatchStatus = 'active'): MatchSummary {
  const state = { units: [], obstacles: [], elevationZones: [], mapWidth: 800, mapHeight: 600 };
  return { iAmHost: true, outcome, match: {
    id, status, currentRound: 2, hostPlayer: 'me', guestPlayer: 'friend',
    seed: null, initialState: state, latestState: state,
  } };
}

describe('match hub', () => {
  it('pins the last opened live match ahead of newer matches, without duplicating it', () => {
    const summaries = [match('new', 'your-turn'), match('last', 'their-turn'), match('older', 'your-turn')];
    const groups = groupMatches(summaries, 'last');
    expect(groups[0].title).toBe('Last opened');
    expect(groups[0].matches[0].match.id).toBe('last');
    expect(groups[1].matches.map(s => s.match.id)).toEqual(['new', 'older']);
    expect(groups.flatMap(g => g.matches)).toHaveLength(3);
  });

  it('falls back to the latest unfinished match when the last match ended or disappeared', () => {
    const summaries = [match('finished', 'you-won', 'host_won'), match('latest', 'their-turn')];
    for (const lastId of ['finished', 'missing', null]) {
      const groups = groupMatches(summaries, lastId);
      expect(groups[0].title).toBe('Latest unfinished match');
      expect(groups[0].matches[0].match.id).toBe('latest');
      expect(groups[1].finished).toBe(true);
    }
  });

  it('separates actionable turns and invites from waiting and history', () => {
    const summaries = [
      match('last', 'your-turn'), match('turn', 'your-turn'), match('invite', 'your-turn', 'open'),
      match('waiting', 'their-turn'), match('ready', 'resolving'), match('old', 'abandoned', 'abandoned'),
    ];
    const groups = groupMatches(summaries, 'last');
    expect(groups.map(g => g.title)).toEqual(['Last opened', 'Your turn', 'Invites', 'Waiting & ready rounds', 'Finished matches']);
    expect(groups.flatMap(g => g.matches).map(s => s.match.id)).toEqual(summaries.map(s => s.match.id));
  });

  it('offers sharing for open invitations and a result for every finished outcome', () => {
    expect(matchAction(match('invite', 'your-turn', 'open')).action).toBe('Invite & plan');
    expect(matchAction(match('invite', 'waiting-for-guest', 'open')).action).toBe('Share invite');
    for (const outcome of ['you-won', 'you-lost', 'abandoned'] as const) {
      expect(matchAction(match('old', outcome, 'abandoned')).action).toBe('View result');
    }
  });

  it('does not present a finished match as resumable, including an empty list', () => {
    expect(groupMatches([], null)).toEqual([]);
    const groups = groupMatches([match('old', 'you-lost', 'guest_won')], 'old');
    expect(groups).toHaveLength(1);
    expect(groups[0].finished).toBe(true);
  });
});
