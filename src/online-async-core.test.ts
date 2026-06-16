import { describe, it, expect } from 'vitest';
import {
  hashPaths,
  deriveMatchSeed,
  nextRoundAction,
  isRoundResolvable,
  verifyReveal,
  summariseMatch,
  outcomeNeedsYou,
  type PathList,
  type TurnRecord,
} from './online-async-core';

const bluePaths: PathList = [
  { unitId: 'b1', waypoints: [{ x: 10, y: 20 }, { x: 30, y: 40 }] },
  { unitId: 'b2', waypoints: [{ x: 5, y: 5 }] },
];
const redPaths: PathList = [
  { unitId: 'r1', waypoints: [{ x: 100, y: 200 }] },
];

describe('hashPaths', () => {
  it('is deterministic', () => {
    expect(hashPaths(bluePaths)).toBe(hashPaths(bluePaths));
  });

  it('is independent of unit ordering', () => {
    const reordered: PathList = [bluePaths[1], bluePaths[0]];
    expect(hashPaths(reordered)).toBe(hashPaths(bluePaths));
  });

  it('depends on waypoint order (order is significant)', () => {
    const swapped: PathList = [
      { unitId: 'b1', waypoints: [{ x: 30, y: 40 }, { x: 10, y: 20 }] },
      bluePaths[1],
    ];
    expect(hashPaths(swapped)).not.toBe(hashPaths(bluePaths));
  });

  it('absorbs sub-0.01 float noise', () => {
    const jittered: PathList = [
      { unitId: 'b1', waypoints: [{ x: 10.0001, y: 19.9999 }, { x: 30, y: 40 }] },
      bluePaths[1],
    ];
    expect(hashPaths(jittered)).toBe(hashPaths(bluePaths));
  });

  it('differs for different paths', () => {
    expect(hashPaths(bluePaths)).not.toBe(hashPaths(redPaths));
  });

  it('returns an unsigned 32-bit integer', () => {
    const h = hashPaths(bluePaths);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(h)).toBe(true);
  });
});

describe('deriveMatchSeed', () => {
  it('is deterministic for the same inputs', () => {
    const a = deriveMatchSeed('room42', 111, 222);
    const b = deriveMatchSeed('room42', 111, 222);
    expect(a).toBe(b);
  });

  it('changes with room, blue hash, or red hash', () => {
    const base = deriveMatchSeed('room42', 111, 222);
    expect(deriveMatchSeed('room43', 111, 222)).not.toBe(base);
    expect(deriveMatchSeed('room42', 999, 222)).not.toBe(base);
    expect(deriveMatchSeed('room42', 111, 999)).not.toBe(base);
  });

  it('stays within the engine seed range (positive 31-bit)', () => {
    for (const [r, b, g] of [['a', 1, 2], ['xyz', 0xffffffff, 0], ['q', 12345, 67890]] as const) {
      const s = deriveMatchSeed(r, b, g);
      expect(s).toBeGreaterThanOrEqual(0);
      expect(s).toBeLessThanOrEqual(0x7fffffff);
    }
  });
});

// --- round state machine -------------------------------------------------

const blueCommit: TurnRecord = { team: 'blue', commitHash: hashPaths(bluePaths), paths: null };
const redCommit: TurnRecord = { team: 'red', commitHash: hashPaths(redPaths), paths: null };
const blueReveal: TurnRecord = { ...blueCommit, paths: bluePaths };
const redReveal: TurnRecord = { ...redCommit, paths: redPaths };

describe('nextRoundAction', () => {
  it('asks me to commit when I have not yet', () => {
    expect(nextRoundAction([], 'blue')).toBe('commit');
    expect(nextRoundAction([redCommit], 'blue')).toBe('commit');
  });

  it('waits for opponent commit after I commit', () => {
    expect(nextRoundAction([blueCommit], 'blue')).toBe('await-commit');
  });

  it('asks me to reveal once both committed', () => {
    expect(nextRoundAction([blueCommit, redCommit], 'blue')).toBe('reveal');
    expect(nextRoundAction([blueCommit, redCommit], 'red')).toBe('reveal');
  });

  it('waits for opponent reveal after I reveal', () => {
    expect(nextRoundAction([blueReveal, redCommit], 'blue')).toBe('await-reveal');
  });

  it('resolves once both revealed', () => {
    expect(nextRoundAction([blueReveal, redReveal], 'blue')).toBe('resolve');
    expect(nextRoundAction([blueReveal, redReveal], 'red')).toBe('resolve');
  });
});

describe('isRoundResolvable', () => {
  it('is false until both reveal', () => {
    expect(isRoundResolvable([])).toBe(false);
    expect(isRoundResolvable([blueCommit, redCommit])).toBe(false);
    expect(isRoundResolvable([blueReveal, redCommit])).toBe(false);
  });
  it('is true once both reveal', () => {
    expect(isRoundResolvable([blueReveal, redReveal])).toBe(true);
  });
});

describe('verifyReveal', () => {
  it('accepts a reveal matching its commitment', () => {
    expect(verifyReveal(blueReveal)).toBe(true);
  });
  it('rejects an unrevealed turn', () => {
    expect(verifyReveal(blueCommit)).toBe(false);
  });
  it('rejects paths that do not match the committed hash', () => {
    const tampered: TurnRecord = { team: 'blue', commitHash: hashPaths(bluePaths), paths: redPaths };
    expect(verifyReveal(tampered)).toBe(false);
  });
});

describe('summariseMatch', () => {
  const commit = (team: 'blue' | 'red'): TurnRecord => ({ team, commitHash: 1, paths: null });
  const reveal = (team: 'blue' | 'red'): TurnRecord => ({ team, commitHash: 1, paths: [] });

  it('open match: host needs to make the first move, then waits for a guest', () => {
    expect(summariseMatch('open', true, [])).toBe('your-turn');
    expect(summariseMatch('open', true, [commit('blue')])).toBe('waiting-for-guest');
  });

  it('active match: your turn until you commit, then their turn', () => {
    // Host (blue) hasn't committed.
    expect(summariseMatch('active', true, [])).toBe('your-turn');
    expect(summariseMatch('active', true, [commit('red')])).toBe('your-turn');
    // Host committed, waiting on red.
    expect(summariseMatch('active', true, [commit('blue')])).toBe('their-turn');
  });

  it('active match: reveal is still your turn; both revealed is resolving', () => {
    // Both committed, host (blue) not revealed yet → your turn (to reveal).
    expect(summariseMatch('active', true, [commit('blue'), commit('red')])).toBe('your-turn');
    // Host revealed, waiting on red reveal → their turn.
    expect(summariseMatch('active', true, [reveal('blue'), commit('red')])).toBe('their-turn');
    // Both revealed → resolving.
    expect(summariseMatch('active', true, [reveal('blue'), reveal('red')])).toBe('resolving');
  });

  it('mirrors correctly for the guest (red)', () => {
    expect(summariseMatch('active', false, [])).toBe('your-turn');
    expect(summariseMatch('active', false, [commit('red')])).toBe('their-turn');
  });

  it('terminal statuses resolve to win/loss from my perspective', () => {
    expect(summariseMatch('host_won', true, [])).toBe('you-won');
    expect(summariseMatch('host_won', false, [])).toBe('you-lost');
    expect(summariseMatch('guest_won', true, [])).toBe('you-lost');
    expect(summariseMatch('guest_won', false, [])).toBe('you-won');
    expect(summariseMatch('abandoned', true, [])).toBe('abandoned');
  });

  it('outcomeNeedsYou flags only the your-turn state', () => {
    expect(outcomeNeedsYou('your-turn')).toBe(true);
    expect(outcomeNeedsYou('their-turn')).toBe(false);
    expect(outcomeNeedsYou('waiting-for-guest')).toBe(false);
    expect(outcomeNeedsYou('you-won')).toBe(false);
  });
});
