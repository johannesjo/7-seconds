import { describe, it, expect } from 'vitest';
import { nextRoundAction, summariseMatch, outcomeNeedsYou, type TurnRecord } from './online-async-core';

const submitted = (team: 'blue' | 'red'): TurnRecord => ({ team, paths: null });
const published = (team: 'blue' | 'red'): TurnRecord => ({ team, paths: [] });

describe('nextRoundAction', () => {
  it('plans until the player has submitted', () => {
    expect(nextRoundAction([], 'blue')).toBe('plan');
    expect(nextRoundAction([submitted('red')], 'blue')).toBe('plan');
  });

  it('waits for the opponent after submitting', () => {
    expect(nextRoundAction([submitted('blue')], 'blue')).toBe('await');
    expect(nextRoundAction([submitted('red')], 'red')).toBe('await');
  });

  it('is resolving once both are in, published or not', () => {
    expect(nextRoundAction([submitted('blue'), submitted('red')], 'red')).toBe('resolve');
    expect(nextRoundAction([published('blue'), published('red')], 'blue')).toBe('resolve');
  });
});

describe('summariseMatch', () => {
  it('reports finished matches from the player’s side', () => {
    expect(summariseMatch('host_won', true, [])).toBe('you-won');
    expect(summariseMatch('host_won', false, [])).toBe('you-lost');
    expect(summariseMatch('guest_won', false, [])).toBe('you-won');
    expect(summariseMatch('abandoned', true, [])).toBe('abandoned');
  });

  it('tells invites from searches', () => {
    expect(summariseMatch('open', true, [])).toBe('your-turn');
    expect(summariseMatch('open', true, [submitted('blue')])).toBe('waiting-for-guest');
    expect(summariseMatch('open', true, [], true)).toBe('searching');
  });

  it('maps an active round to whose move it is', () => {
    expect(summariseMatch('active', false, [submitted('blue')])).toBe('your-turn');
    expect(summariseMatch('active', true, [submitted('blue')])).toBe('their-turn');
    expect(summariseMatch('active', true, [submitted('blue'), submitted('red')])).toBe('resolving');
  });

  it('only a turn of yours needs you', () => {
    expect(outcomeNeedsYou('your-turn')).toBe(true);
    for (const o of ['their-turn', 'searching', 'resolving', 'you-won'] as const) expect(outcomeNeedsYou(o)).toBe(false);
  });
});
