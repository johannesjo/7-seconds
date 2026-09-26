import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { MatchStatus } from './online-async';

const fixture = vi.hoisted(() => ({ rows: [] as Record<string, unknown>[], fail: false }));
vi.mock('./online-auth', () => ({ ensureAuth: async () => 'me' }));
vi.mock('./online-debug', () => ({ dlog: () => {} }));
vi.mock('./online', () => ({
  generateRoomId: () => 'new',
  getSupabaseClient: () => ({
    from(table: string) {
      let selected = table === 'matches' ? fixture.rows : [];
      const query = {
        select: () => query,
        or: () => query,
        order: () => query, // fixtures are already newest first
        in(column: string, values: unknown[]) {
          selected = selected.filter(row => values.includes(row[column]));
          return query;
        },
        limit(count: number) { selected = selected.slice(0, count); return query; },
        then(resolve: (result: unknown) => void) {
          return Promise.resolve(fixture.fail
            ? { data: null, error: { message: 'unavailable', code: '42501' } }
            : { data: selected, error: null }).then(resolve);
        },
      };
      return query;
    },
  }),
}));

import { loadMyMatches } from './online-async';

function row(id: string, status: MatchStatus): Record<string, unknown> {
  return { id, status, host_player: 'me', guest_player: 'friend', current_round: 1, seed: null, initial_state: {}, latest_state: {} };
}

describe('loading matches for the hub', () => {
  beforeEach(() => { fixture.rows = []; fixture.fail = false; });

  it('keeps an old unfinished match even after forty newer matches have finished', async () => {
    fixture.rows = [
      ...Array.from({ length: 45 }, (_, i) => row(`done-${i}`, 'host_won')),
      row('old-open-match', 'active'),
    ];
    const summaries = await loadMyMatches();
    expect(summaries).toHaveLength(41);
    expect(summaries?.[0].match.id).toBe('old-open-match');
    expect(summaries?.[0].outcome).toBe('your-turn');
  });

  it('limits history without removing live invitations', async () => {
    fixture.rows = [row('win', 'host_won'), row('loss', 'guest_won'), row('invite', 'open')];
    const summaries = await loadMyMatches(1);
    expect(summaries?.map(s => s.match.id)).toEqual(['invite', 'win']);
  });

  it('reports a failed read instead of an empty match list', async () => {
    fixture.fail = true;
    expect(await loadMyMatches()).toBeNull();
  });
});
