import { describe, it, expect, vi } from 'vitest';
import {
  AsyncGameController, withTimeout, IO_TIMEOUT_MS, ADVANCE_INTERVAL_MS,
  type AsyncIO, type AsyncGameHooks, type PlayRoundInput, type PollEnv, type WatchStore,
} from './online-async-game';
import type { PathList } from './online-async-core';
import type { MatchRecord, MatchStatus, RoundTurn, RefereeResult } from './online-async';
import type { OnlineGameState } from './online-types';
import { RULES_VERSION } from './online-plan';

function makeState(blueHp: number, redHp: number): OnlineGameState {
  const unit = (id: string, team: 'blue' | 'red', hp: number) => ({
    id, type: 'soldier' as const, team, x: 0, y: 0, hp, maxHp: 100,
    radius: 10, speed: 50, range: 100, gunAngle: 0,
  });
  return {
    units: [unit('b1', 'blue', blueHp), unit('r1', 'red', redHp)],
    obstacles: [], elevationZones: [], mapWidth: 800, mapHeight: 600,
  };
}

const initial = makeState(100, 100);
const plan = (unitId: string, x = 1): PathList => [{ unitId, waypoints: [{ x, y: 1 }] }];

/** An in-memory referee: holds each plan until both are in, then "resolves"
 *  the round by taking 50 hp off red, so red falls after two rounds. */
class FakeReferee {
  match: MatchRecord;
  turns: RoundTurn[] = [];
  private plans = new Map<string, PathList>();
  listeners = new Set<() => void>();
  calls: string[] = [];
  /** When true, the second plan does not resolve the round (a failed run). */
  holdResolution = false;
  /** Next submit fails with this result. */
  failNextSubmit: RefereeResult | null = null;

  constructor(id: string, host: string, extra: Partial<MatchRecord> = {}) {
    this.match = {
      id, hostPlayer: host, guestPlayer: null, hostName: 'Host', guestName: null, guestBot: false,
      initialState: initial, latestState: initial, prevState: null, prevSeed: null,
      currentRound: 1, status: 'open', finishReason: null, rules: RULES_VERSION,
      ranked: false, matchmaking: false, updatedAt: '', ...extra,
    };
  }

  private notify() { for (const l of [...this.listeners]) l(); }
  private ok(): RefereeResult { return { ok: true, match: { ...this.match } }; }

  /** Seat a guest without a controller (e.g. an AI commander). */
  seat(guest: string, bot = false) {
    this.match = { ...this.match, guestPlayer: guest, guestBot: bot, guestName: bot ? 'Cadet Pip (AI)' : 'Guest', status: 'active' };
  }

  plan(team: 'blue' | 'red', paths: PathList, player: string) {
    const round = this.match.currentRound;
    this.plans.set(`${round}-${team}`, paths);
    this.turns.push({ round, team, player, paths: null });
    this.resolveIfReady();
  }

  resolveIfReady() {
    const round = this.match.currentRound;
    const blue = this.plans.get(`${round}-blue`), red = this.plans.get(`${round}-red`);
    if (!blue || !red || this.holdResolution) return;
    for (const t of this.turns) if (t.round === round) t.paths = t.team === 'blue' ? blue : red;
    const start = this.match.latestState;
    const end = makeState(100, Math.max(0, start.units[1].hp - 50));
    const over = end.units[1].hp <= 0;
    this.match = {
      ...this.match, prevState: start, prevSeed: 1000 + round, latestState: end, currentRound: round + 1,
      ...(over ? { status: 'host_won' as MatchStatus, finishReason: 'battle' as const } : {}),
    };
  }

  ioFor(userId: string): AsyncIO {
    const team = () => (this.match.hostPlayer === userId ? 'blue' : 'red');
    return {
      getUserId: async () => userId,
      loadMatch: async () => (userId === this.match.hostPlayer || userId === this.match.guestPlayer)
        ? { kind: 'ok', match: { ...this.match } } : { kind: 'missing' },
      joinMatch: async () => {
        this.calls.push('join');
        if (this.match.guestPlayer && this.match.guestPlayer !== userId) return { ok: false, status: 409, message: 'This match already has two players' };
        if (!this.match.guestPlayer) { this.seat(userId); this.notify(); }
        return this.ok();
      },
      fetchTurns: async () => this.turns.map(t => ({ ...t })),
      submit: async (_id, round, paths) => {
        this.calls.push('submit');
        if (this.failNextSubmit) { const f = this.failNextSubmit; this.failNextSubmit = null; return f; }
        if (round !== this.match.currentRound) return { ok: false, status: 409, message: 'The round has changed. Reload the match.' };
        this.plan(team(), paths, userId);
        if (this.match.guestBot && !this.turns.some(t => t.round === round && t.team === 'red')) this.plan('red', plan('r1'), 'bot');
        this.notify();
        return this.ok();
      },
      advance: async () => {
        this.calls.push('advance');
        const round = this.match.currentRound;
        if (this.match.guestBot && this.match.status === 'active' && !this.turns.some(t => t.round === round && t.team === 'red')) this.plan('red', plan('r1'), 'bot');
        this.resolveIfReady();
        this.notify();
        return this.ok();
      },
      cancel: async () => {
        this.calls.push('cancel');
        if (this.match.status === 'open' && !this.match.guestPlayer) {
          this.match = { ...this.match, status: 'abandoned', finishReason: 'cancelled' };
          this.notify();
        }
        return this.ok();
      },
      forfeit: async () => {
        this.calls.push('forfeit');
        if (this.match.status === 'open' || this.match.status === 'active') {
          this.match = { ...this.match, status: team() === 'blue' ? 'guest_won' : 'host_won', finishReason: 'forfeit' };
          this.notify();
        }
        return this.ok();
      },
      subscribe: (_id, onChange) => {
        this.listeners.add(onChange);
        return () => this.listeners.delete(onChange);
      },
    };
  }
}

function memWatch(): WatchStore & { data: Map<string, number> } {
  const data = new Map<string, number>();
  return { data, get: id => data.get(id) ?? null, set: (id, r) => { data.set(id, r); } };
}

/** Controllable poll environment: tick() fires the interval, resume() fires a
 *  visibility/network-back event, and visible toggles foreground state. */
function fakePollEnv() {
  let intervalFn: (() => void) | null = null;
  let resumeFn: (() => void) | null = null;
  const env: PollEnv & { tick: () => void; resume: () => void; visible: boolean; time: number } = {
    visible: true,
    time: 0,
    setInterval: (fn) => { intervalFn = fn; return 1; },
    clearInterval: () => { intervalFn = null; },
    isVisible: () => env.visible,
    onResume: (fn) => { resumeFn = fn; return () => { resumeFn = null; }; },
    now: () => env.time,
    tick: () => intervalFn?.(),
    resume: () => resumeFn?.(),
  };
  return env;
}

interface Spy {
  hooks: AsyncGameHooks;
  planTurns: number[];
  planAwaiting: boolean[];
  planAfterError: boolean[];
  awaits: { awaitingGuest: boolean; playing: boolean }[];
  plays: PlayRoundInput[];
  gameOver: { status: MatchStatus; reason: string | null }[];
  errors: string[];
  forfeitable: boolean[];
}
function makeHooks(onPlay?: (input: PlayRoundInput) => void): Spy {
  const spy: Omit<Spy, 'hooks'> = { planTurns: [], planAwaiting: [], planAfterError: [], awaits: [], plays: [], gameOver: [], errors: [], forfeitable: [] };
  return {
    ...spy,
    hooks: {
      onPlanTurn: (round, _s, _t, awaitingGuest, afterError) => { spy.planTurns.push(round); spy.planAwaiting.push(awaitingGuest); spy.planAfterError.push(!!afterError); },
      onAwaitOpponent: (_round, awaitingGuest, playing) => { spy.awaits.push({ awaitingGuest, playing: !!playing }); },
      onPlayRound: (input) => { spy.plays.push(input); onPlay?.(input); },
      onGameOver: (status, _state, reason) => { spy.gameOver.push({ status, reason }); },
      onError: (msg, canForfeit) => { spy.errors.push(msg); spy.forfeitable.push(!!canForfeit); },
    },
  } as Spy;
}

const flush = () => new Promise(r => setTimeout(r, 0));
/** Let refreshes started by realtime events finish. */
const settle = async () => { for (let i = 0; i < 5; i++) await flush(); };

function controller(backend: FakeReferee, user: string, spy: Spy, opts: { watched?: WatchStore; pollEnv?: PollEnv | null } = {}) {
  return new AsyncGameController(backend.match.id, spy.hooks, {
    io: backend.ioFor(user), watched: opts.watched ?? memWatch(), pollEnv: opts.pollEnv ?? null, now: () => 0,
  });
}

describe('AsyncGameController', () => {
  it('surfaces an error and does not start if not authenticated', async () => {
    const backend = new FakeReferee('m1', 'host');
    const spy = makeHooks();
    const c = new AsyncGameController('m1', spy.hooks, { io: { ...backend.ioFor('host'), getUserId: async () => null }, pollEnv: null });
    expect(await c.start()).toBe(false);
    expect(spy.errors[0]).toMatch(/unavailable/);
  });

  it('does not call a match missing when it could not be loaded', async () => {
    const backend = new FakeReferee('m1', 'host');
    const spy = makeHooks();
    const io = { ...backend.ioFor('guest'), loadMatch: async () => ({ kind: 'error' as const }) };
    const c = new AsyncGameController('m1', spy.hooks, { io, pollEnv: null });
    expect(await c.start()).toBe(false);
    expect(spy.errors).toEqual(['Could not load this match. Check your connection and try again.']);
    expect(backend.calls).not.toContain('join');
  });

  it('joins an invite it holds the link to, and reports a full one', async () => {
    const backend = new FakeReferee('m1', 'host');
    const guest = makeHooks();
    expect(await controller(backend, 'guest', guest).start()).toBe(true);
    expect(guest.planTurns).toEqual([1]);
    const third = makeHooks();
    expect(await controller(backend, 'third', third).start()).toBe(false);
    expect(third.errors).toEqual(['This match already has two players']);
  });

  it('lets the host plan their first move before a guest joins', async () => {
    const backend = new FakeReferee('m1', 'host');
    const host = makeHooks();
    const c = controller(backend, 'host', host);
    await c.start();
    expect(host.planTurns).toEqual([1]);
    expect(host.planAwaiting).toEqual([true]);
    await c.submitPlan(plan('b1'));
    await settle();
    expect(host.awaits.at(-1)).toEqual({ awaitingGuest: true, playing: false });
  });

  it('plays a round on both screens once the second plan is in, then plans the next', async () => {
    const backend = new FakeReferee('m1', 'host');
    const host = makeHooks();
    const guest = makeHooks();
    const hc = controller(backend, 'host', host);
    const gc = controller(backend, 'guest', guest);
    await hc.start();
    await gc.start();
    await hc.submitPlan(plan('b1', 5));
    await flush();
    expect(guest.planTurns).toEqual([1]); // the host's plan didn't disturb the guest's drawing

    await gc.submitPlan(plan('r1', 7));
    await settle();
    for (const spy of [host, guest]) {
      expect(spy.plays).toHaveLength(1);
      expect(spy.plays[0]).toMatchObject({ round: 1, seed: 1001, startState: initial, bluePaths: plan('b1', 5), redPaths: plan('r1', 7) });
    }
    // Nothing more until the animation has been watched.
    expect(host.planTurns).toEqual([1]);
    await hc.onRoundPlayed(1);
    await gc.onRoundPlayed(1);
    await settle();
    expect(host.planTurns).toEqual([1, 2]);
    expect(guest.planTurns).toEqual([1, 2]);
  });

  it('shows the final round, then the result with its reason', async () => {
    const backend = new FakeReferee('m1', 'host');
    backend.seat('guest');
    const host = makeHooks();
    const hc = controller(backend, 'host', host);
    await hc.start();
    for (const round of [1, 2]) {
      backend.plan('red', plan('r1'), 'guest');
      await hc.submitPlan(plan('b1'));
      await settle();
      expect(host.plays.at(-1)?.round).toBe(round);
      expect(host.gameOver).toEqual([]);
      await hc.onRoundPlayed(round);
      await settle();
    }
    expect(host.gameOver).toEqual([{ status: 'host_won', reason: 'battle' }]);
  });

  it('replays the round played while the player was away, once', async () => {
    const backend = new FakeReferee('m1', 'host');
    backend.seat('guest');
    backend.plan('blue', plan('b1'), 'host');
    backend.plan('red', plan('r1'), 'guest');
    const watched = memWatch();
    watched.set('m1', 0);
    const guest = makeHooks();
    const gc = controller(backend, 'guest', guest, { watched });
    await gc.start();
    expect(guest.plays.map(p => p.round)).toEqual([1]);
    expect(guest.planTurns).toEqual([]);
    await gc.onRoundPlayed(1);
    expect(guest.planTurns).toEqual([2]);
    expect(watched.get('m1')).toBe(1);
    gc.destroy();

    const again = makeHooks();
    await controller(backend, 'guest', again, { watched }).start();
    expect(again.plays).toEqual([]);
    expect(again.planTurns).toEqual([2]);
  });

  it('on a new device shows only the latest round', async () => {
    const backend = new FakeReferee('m1', 'host');
    backend.seat('guest');
    backend.match = { ...backend.match, latestState: makeState(100, 300) }; // three rounds' worth of red hp
    for (let i = 0; i < 2; i++) { backend.plan('blue', plan('b1'), 'host'); backend.plan('red', plan('r1'), 'guest'); }
    const guest = makeHooks();
    await controller(backend, 'guest', guest).start();
    expect(guest.plays.map(p => p.round)).toEqual([2]);
  });

  it('skips a broken animation instead of wedging the match', async () => {
    const backend = new FakeReferee('m1', 'host');
    backend.seat('guest');
    backend.plan('blue', plan('b1'), 'host');
    backend.plan('red', plan('r1'), 'guest');
    const spy = makeHooks(() => { throw new Error('renderer gone'); });
    const watched = memWatch();
    watched.set('m1', 0);
    await controller(backend, 'guest', spy, { watched }).start();
    expect(spy.planTurns).toEqual([2]);
  });

  it('asks the referee to catch up when an AI commander owes a move, at most every few seconds', async () => {
    const backend = new FakeReferee('m1', 'host', { matchmaking: true });
    backend.seat('bot', true);
    const env = fakePollEnv();
    const host = makeHooks();
    // The commander's plan went missing: the host is left waiting.
    const io = { ...backend.ioFor('host'), submit: async (_id: string, _r: number, paths: PathList) => {
      backend.plan('blue', paths, 'host');
      return { ok: true as const, match: { ...backend.match } };
    } };
    const hc = new AsyncGameController('m1', host.hooks, { io, watched: memWatch(), pollEnv: env });
    await hc.start();
    const advanceSpy = vi.spyOn(io, 'advance');
    await hc.submitPlan(plan('b1'));
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    expect(host.plays.map(p => p.round)).toEqual([1]);
    await hc.onRoundPlayed(1);

    // Round 2: the commander again owes a move, but a fresh catch-up waits.
    env.time += ADVANCE_INTERVAL_MS / 2;
    await hc.submitPlan(plan('b1'));
    expect(advanceSpy).toHaveBeenCalledTimes(1);
    env.time += ADVANCE_INTERVAL_MS;
    env.tick();
    await flush(); await flush();
    expect(advanceSpy).toHaveBeenCalledTimes(2);
    expect(host.plays.map(p => p.round)).toEqual([1, 2]);
  });

  it('asks the referee to play a round whose plans are both in', async () => {
    const backend = new FakeReferee('m1', 'host');
    backend.seat('guest');
    backend.holdResolution = true;
    const host = makeHooks();
    const hc = controller(backend, 'host', host);
    await hc.start();
    backend.plan('red', plan('r1'), 'guest');
    await hc.submitPlan(plan('b1'));
    await settle();
    expect(host.awaits.at(-1)).toEqual({ awaitingGuest: false, playing: true });
    expect(backend.calls).toContain('advance');
    backend.holdResolution = false;
    hc.destroy();
    // A later catch-up (here: forced past the throttle) plays it.
    const late = new AsyncGameController('m1', host.hooks, { io: backend.ioFor('host'), watched: memWatch(), pollEnv: null, now: () => 1e9 });
    await late.start();
    expect(host.plays.map(p => p.round)).toEqual([1]);
  });

  it('re-prompts planning after a failed submit, flagged so the UI can skip "your turn"', async () => {
    const backend = new FakeReferee('m1', 'host');
    backend.seat('guest');
    const host = makeHooks();
    const hc = controller(backend, 'host', host);
    await hc.start();
    backend.failNextSubmit = { ok: false, status: 0, message: 'offline' };
    await hc.submitPlan(plan('b1'));
    expect(host.errors).toEqual(['Could not submit your turn. Try again.']);
    expect(host.planTurns).toEqual([1, 1]);
    expect(host.planAfterError).toEqual([false, true]);
  });

  it('shows a permanent refusal as it is', async () => {
    const backend = new FakeReferee('m1', 'host');
    backend.seat('guest');
    const host = makeHooks();
    const hc = controller(backend, 'host', host);
    await hc.start();
    backend.failNextSubmit = { ok: false, status: 426, message: 'Reload or update the app.' };
    await hc.submitPlan(plan('b1'));
    expect(host.errors).toEqual(['Reload or update the app.']);
  });

  it('refuses a match on newer rules without offering a forfeit', async () => {
    const backend = new FakeReferee('m1', 'host', { rules: RULES_VERSION + 1 });
    backend.seat('guest');
    const host = makeHooks();
    await controller(backend, 'host', host).start();
    expect(host.errors[0]).toMatch(/newer version/);
    expect(host.forfeitable).toEqual([false]);
    expect(host.planTurns).toEqual([]);
  });

  it('refuses to play an implausible match state', async () => {
    const backend = new FakeReferee('m1', 'host', { latestState: { units: 'x' } as unknown as OnlineGameState });
    backend.seat('guest');
    const host = makeHooks();
    await controller(backend, 'host', host).start();
    expect(host.forfeitable).toEqual([true]);
    expect(host.planTurns).toEqual([]);
  });

  it('forfeits: the opponent wins and the match is over', async () => {
    const backend = new FakeReferee('m1', 'host');
    backend.seat('guest');
    const host = makeHooks();
    const hc = controller(backend, 'host', host);
    await hc.start();
    await hc.forfeit();
    await settle();
    expect(host.gameOver).toEqual([{ status: 'guest_won', reason: 'forfeit' }]);
    expect(hc.team).toBe('blue');
  });

  it('safety-net poll recovers a turn the realtime channel never delivered', async () => {
    const backend = new FakeReferee('m1', 'host');
    backend.seat('guest');
    const env = fakePollEnv();
    const host = makeHooks();
    const hc = new AsyncGameController('m1', host.hooks, { io: { ...backend.ioFor('host'), subscribe: () => () => {} }, watched: memWatch(), pollEnv: env });
    await hc.start();
    await hc.submitPlan(plan('b1'));
    backend.plan('red', plan('r1'), 'guest'); // resolves without telling anyone
    env.visible = false;
    env.tick();
    await flush();
    expect(host.plays).toEqual([]); // no polling in the background
    env.visible = true;
    env.resume();
    await flush(); await flush();
    expect(host.plays.map(p => p.round)).toEqual([1]);
  });

  it('does not re-emit the same stuck-state error on every poll', async () => {
    const backend = new FakeReferee('m1', 'host', { rules: RULES_VERSION + 1 });
    backend.seat('guest');
    const env = fakePollEnv();
    const host = makeHooks();
    await new AsyncGameController('m1', host.hooks, { io: backend.ioFor('host'), watched: memWatch(), pollEnv: env }).start();
    env.tick(); await flush();
    env.tick(); await flush();
    expect(host.errors).toHaveLength(1);
  });
});

describe('AsyncGameController after review', () => {
  function outdatedSpy() {
    const spy = makeHooks();
    const outdated: string[] = [];
    spy.hooks.onOutdated = msg => { outdated.push(msg); };
    return { spy, outdated };
  }

  it('withdrawing an invite never concedes a match a friend has joined', async () => {
    const backend = new FakeReferee('m1', 'host');
    const host = makeHooks();
    const hc = controller(backend, 'host', host);
    await hc.start();
    backend.seat('guest'); // the friend joins while the invite is on screen
    expect(await hc.withdraw()).toBeNull();
    expect(backend.match.status).toBe('active');
    expect(backend.calls).toEqual(['cancel']);
  });

  it('withdraws an invite nobody joined', async () => {
    const backend = new FakeReferee('m1', 'host');
    const host = makeHooks();
    const hc = controller(backend, 'host', host);
    await hc.start();
    await hc.withdraw();
    await settle();
    expect(host.gameOver).toEqual([{ status: 'abandoned', reason: 'cancelled' }]);
  });

  it('reports every failed forfeit, not just the first', async () => {
    const backend = new FakeReferee('m1', 'host');
    backend.seat('guest');
    const host = makeHooks();
    const io = { ...backend.ioFor('host'), forfeit: async () => ({ ok: false as const, status: 0, message: 'offline' }) };
    const hc = new AsyncGameController('m1', host.hooks, { io, watched: memWatch(), pollEnv: null });
    await hc.start();
    await hc.forfeit();
    await hc.forfeit();
    expect(host.errors).toEqual(['offline', 'offline']);
  });

  it('stops for good when the server says this app is outdated', async () => {
    const backend = new FakeReferee('m1', 'host');
    backend.seat('guest');
    const { spy, outdated } = outdatedSpy();
    const hc = controller(backend, 'host', spy);
    await hc.start();
    backend.failNextSubmit = { ok: false, status: 426, message: 'Reload or update the app.' };
    await hc.submitPlan(plan('b1'));
    await settle();
    expect(outdated).toEqual(['Reload or update the app.']);
    expect(spy.planTurns).toEqual([1]); // no fresh "your turn" prompt
  });

  it('a match on newer rules waits for an update, with no forfeit on offer', async () => {
    const backend = new FakeReferee('m1', 'host', { rules: RULES_VERSION + 1 });
    backend.seat('guest');
    const { spy, outdated } = outdatedSpy();
    await controller(backend, 'host', spy).start();
    expect(outdated[0]).toMatch(/newer version/);
    expect(spy.forfeitable).toEqual([]);
    expect(backend.calls).not.toContain('forfeit');
  });

  it('asks the referee to end a match on older rules, instead of conceding it', async () => {
    const backend = new FakeReferee('m1', 'host', { rules: RULES_VERSION - 1 });
    backend.seat('guest');
    const io = { ...backend.ioFor('host'), advance: async () => {
      backend.match = { ...backend.match, status: 'abandoned', finishReason: 'version' };
      return { ok: false as const, status: 409, message: 'older version', match: { ...backend.match } };
    } };
    const spy = makeHooks();
    await new AsyncGameController('m1', spy.hooks, { io, watched: memWatch(), pollEnv: null }).start();
    await settle();
    expect(spy.gameOver).toEqual([{ status: 'abandoned', reason: 'version' }]);
  });

  it('collapses a burst of realtime events into one extra reload', async () => {
    const backend = new FakeReferee('m1', 'host');
    backend.seat('guest');
    let loads = 0;
    const base = backend.ioFor('host');
    const io = { ...base, loadMatch: async (id: string) => { loads++; await flush(); return base.loadMatch(id); } };
    const hc = new AsyncGameController('m1', makeHooks().hooks, { io, watched: memWatch(), pollEnv: null });
    await hc.start();
    loads = 0;
    for (let i = 0; i < 9; i++) backend.listeners.forEach(l => l());
    await settle();
    expect(loads).toBe(2);
  });
});

describe('withTimeout', () => {
  it('treats a hung call as failed so the next refresh can retry', async () => {
    vi.useFakeTimers();
    try {
      const hung = withTimeout(() => new Promise<boolean>(() => {}), false);
      const result = hung();
      await vi.advanceTimersByTimeAsync(IO_TIMEOUT_MS);
      await expect(result).resolves.toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });

  it('passes through results and errors of calls that settle in time', async () => {
    await expect(withTimeout(async (x: number) => x * 2, 0)(21)).resolves.toBe(42);
    await expect(withTimeout(async () => { throw new Error('boom'); }, 0)()).rejects.toThrow('boom');
  });
});
