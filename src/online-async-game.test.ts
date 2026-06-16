import { describe, it, expect } from 'vitest';
import { AsyncGameController, type AsyncIO, type PathStash, type AsyncGameHooks, type PlayRoundInput, type PollEnv } from './online-async-game';
import { hashPaths, type AsyncTeam, type PathList } from './online-async-core';
import type { MatchRecord, MatchStatus, RoundTurn } from './online-async';
import type { OnlineGameState } from './online-types';

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

/** Shared in-memory backend two controllers talk to. */
class FakeBackend {
  match: MatchRecord;
  turns: RoundTurn[] = [];
  listeners = new Set<() => void>();

  constructor(id: string, host: string) {
    this.match = {
      id, hostPlayer: host, guestPlayer: null,
      initialState: initial, latestState: initial,
      seed: null, currentRound: 1, status: 'open',
    };
  }

  private notify() { for (const l of [...this.listeners]) l(); }

  ioFor(userId: string): AsyncIO {
    return {
      getUserId: async () => userId,
      loadMatch: async () => ({ ...this.match }),
      joinMatch: async () => {
        if (!this.match.guestPlayer) {
          this.match = { ...this.match, guestPlayer: userId, status: 'active' };
          this.notify();
        }
        return { ...this.match };
      },
      fetchTurns: async () => this.turns.map(t => ({ ...t })),
      commit: async (_id, round, team, paths) => {
        this.turns.push({ round, team, player: userId, commitHash: hashPaths(paths), paths: null });
        this.notify();
        return true;
      },
      reveal: async (_id, round, team, paths) => {
        const t = this.turns.find(x => x.round === round && x.team === team);
        if (t) t.paths = paths;
        this.notify();
        return true;
      },
      persist: async (_id, update) => {
        // Optimistic concurrency: a stale/duplicate writer no-ops.
        if (update.expectedRound != null && this.match.currentRound !== update.expectedRound) {
          return false;
        }
        this.match = {
          ...this.match,
          latestState: update.latestState,
          currentRound: update.currentRound,
          ...(update.seed != null ? { seed: update.seed } : {}),
          ...(update.status ? { status: update.status } : {}),
        };
        this.notify();
        return true;
      },
      finish: async (_id, status) => {
        if (this.match.status !== 'open' && this.match.status !== 'active') return false;
        this.match = { ...this.match, status };
        this.notify();
        return true;
      },
      subscribe: (_id, onChange) => {
        this.listeners.add(onChange);
        return () => this.listeners.delete(onChange);
      },
    };
  }
}

function memStash(): PathStash {
  const m = new Map<string, PathList>();
  return {
    save: (k, p) => { m.set(k, p); },
    load: (k) => m.get(k) ?? null,
    clear: (k) => { m.delete(k); },
  };
}

/** Controllable poll environment: tick() fires the interval, resume() fires a
 *  visibility/network-back event, and visible toggles foreground state. */
function fakePollEnv() {
  let intervalFn: (() => void) | null = null;
  let resumeFn: (() => void) | null = null;
  const env: PollEnv & { tick: () => void; resume: () => void; visible: boolean; cleared: boolean } = {
    visible: true,
    cleared: false,
    setInterval: (fn) => { intervalFn = fn; return 1; },
    clearInterval: () => { env.cleared = true; intervalFn = null; },
    isVisible: () => env.visible,
    onResume: (fn) => { resumeFn = fn; return () => { resumeFn = null; }; },
    tick: () => intervalFn?.(),
    resume: () => resumeFn?.(),
  };
  return env;
}

interface Spy { hooks: AsyncGameHooks; waiting: number[]; planTurns: number[]; plays: PlayRoundInput[]; gameOver: MatchStatus[]; errors: string[]; forfeitable: boolean[]; }
function makeHooks(): Spy {
  const waiting: number[] = [];
  const planTurns: number[] = [];
  const plays: PlayRoundInput[] = [];
  const gameOver: MatchStatus[] = [];
  const errors: string[] = [];
  const forfeitable: boolean[] = [];
  return {
    waiting, planTurns, plays, gameOver, errors, forfeitable,
    hooks: {
      onWaitingForGuest: (round) => { waiting.push(round); },
      onPlanTurn: (round) => { planTurns.push(round); },
      onAwaitOpponent: () => {},
      onPlayRound: (input) => { plays.push(input); },
      onGameOver: (status) => { gameOver.push(status); },
      onError: (msg, canForfeit) => { errors.push(msg); forfeitable.push(!!canForfeit); },
    },
  };
}

const flush = async () => { for (let i = 0; i < 100; i++) await Promise.resolve(); };

const bluePlan: PathList = [{ unitId: 'b1', waypoints: [{ x: 1, y: 2 }] }];
const redPlan: PathList = [{ unitId: 'r1', waypoints: [{ x: 3, y: 4 }] }];

describe('AsyncGameController', () => {
  it('runs a round through commit, auto-reveal, and resolve for both players', async () => {
    const be = new FakeBackend('m1', 'host-uid');
    const hostSpy = makeHooks();
    const guestSpy = makeHooks();
    const host = new AsyncGameController('m1', hostSpy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });
    const guest = new AsyncGameController('m1', guestSpy.hooks, { io: be.ioFor('guest-uid'), stash: memStash() });

    await host.start();
    await guest.start();
    await flush();

    // Both were asked to plan round 1.
    expect(hostSpy.planTurns).toContain(1);
    expect(guestSpy.planTurns).toContain(1);

    // Both submit; reveal happens automatically once both have committed.
    await host.submitPlan(bluePlan);
    await guest.submitPlan(redPlan);
    await flush();

    // Both reach resolution and are handed the same round to animate.
    expect(hostSpy.plays.length).toBeGreaterThan(0);
    expect(guestSpy.plays.length).toBeGreaterThan(0);
    const hp = hostSpy.plays[0];
    const gp = guestSpy.plays[0];
    expect(hp.round).toBe(1);
    expect(hp.bluePaths).toEqual(bluePlan);
    expect(hp.redPaths).toEqual(redPlan);

    // Seed is derived deterministically and identical on both sides.
    expect(hp.seed).toBe(gp.seed);
    expect(hp.seed).toBeGreaterThanOrEqual(0);

    expect(hostSpy.errors).toEqual([]);
    expect(guestSpy.errors).toEqual([]);
    host.destroy();
    guest.destroy();
  });

  it('advances to the next round after a non-terminal round is played', async () => {
    const be = new FakeBackend('m2', 'host-uid');
    const hostSpy = makeHooks();
    const host = new AsyncGameController('m2', hostSpy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });
    // Seed guest commit/reveal directly into the backend for a simpler single-driver test.
    const guestIO = be.ioFor('guest-uid');
    await guestIO.joinMatch('m2');

    await host.start();
    await flush();
    await host.submitPlan(bluePlan);
    await guestIO.commit('m2', 1, 'red', redPlan);
    await guestIO.reveal('m2', 1, 'red', redPlan);
    await flush();

    expect(hostSpy.plays.length).toBe(1);
    // Round 1 ends with both alive -> not game over -> advance to round 2.
    await host.onRoundPlayed(1, makeState(80, 60), false);
    await flush();

    expect(be.match.currentRound).toBe(2);
    expect(be.match.status).toBe('active');
    expect(hostSpy.planTurns).toContain(2);
    host.destroy();
  });

  it('ends the match with the correct winner when a side is eliminated', async () => {
    const be = new FakeBackend('m3', 'host-uid');
    const hostSpy = makeHooks();
    const host = new AsyncGameController('m3', hostSpy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });
    const guestIO = be.ioFor('guest-uid');
    await guestIO.joinMatch('m3');

    await host.start();
    await flush();
    await host.submitPlan(bluePlan);
    await guestIO.commit('m3', 1, 'red', redPlan);
    await guestIO.reveal('m3', 1, 'red', redPlan);
    await flush();

    // Red wiped out -> host (blue) wins.
    await host.onRoundPlayed(1, makeState(50, 0), true);
    await flush();

    expect(be.match.status).toBe('host_won');
    expect(hostSpy.gameOver).toContain('host_won');
    host.destroy();
  });

  it('surfaces an error and does not start if not authenticated', async () => {
    const be = new FakeBackend('m4', 'host-uid');
    const spy = makeHooks();
    const io = { ...be.ioFor('host-uid'), getUserId: async () => null };
    const ctrl = new AsyncGameController('m4', spy.hooks, { io, stash: memStash() });
    const ok = await ctrl.start();
    expect(ok).toBe(false);
    expect(spy.errors.length).toBe(1);
  });

  it('rejects a tampered reveal that does not match its commitment', async () => {
    const be = new FakeBackend('m5', 'host-uid');
    const hostSpy = makeHooks();
    const host = new AsyncGameController('m5', hostSpy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });
    const guestIO = be.ioFor('guest-uid');
    await guestIO.joinMatch('m5');

    await host.start();
    await flush();
    await host.submitPlan(bluePlan);
    // Guest commits to redPlan but reveals different paths.
    await guestIO.commit('m5', 1, 'red', redPlan);
    await guestIO.reveal('m5', 1, 'red', [{ unitId: 'r1', waypoints: [{ x: 99, y: 99 }] }]);
    await flush();

    expect(hostSpy.plays.length).toBe(0);
    expect(hostSpy.errors.some(e => /verification/i.test(e))).toBe(true);
    host.destroy();
  });

  it('reveals from the stash after the app is closed and reopened post-commit', async () => {
    const be = new FakeBackend('m6', 'host-uid');
    const guestIO = be.ioFor('guest-uid');
    await guestIO.joinMatch('m6');
    const stash = memStash(); // survives the controller being recreated (= app reopen)

    // First session: commit, then "close the app" (destroy) before revealing.
    const spy1 = makeHooks();
    const host1 = new AsyncGameController('m6', spy1.hooks, { io: be.ioFor('host-uid'), stash });
    await host1.start();
    await flush();
    await host1.submitPlan(bluePlan);
    host1.destroy();

    // Opponent submits while we're away.
    await guestIO.commit('m6', 1, 'red', redPlan);
    await guestIO.reveal('m6', 1, 'red', redPlan);

    // Second session: a fresh controller must auto-reveal from the stash and play.
    const spy2 = makeHooks();
    const host2 = new AsyncGameController('m6', spy2.hooks, { io: be.ioFor('host-uid'), stash });
    await host2.start();
    await flush();

    expect(spy2.errors).toEqual([]);
    expect(spy2.plays.length).toBe(1);
    expect(spy2.plays[0].bluePaths).toEqual(bluePlan);
    host2.destroy();
  });

  it('errors (no deadlock crash) when the committed plan is lost from the stash', async () => {
    const be = new FakeBackend('m7', 'host-uid');
    const guestIO = be.ioFor('guest-uid');
    await guestIO.joinMatch('m7');

    // Commit recorded server-side, but this device has no stash entry.
    await be.ioFor('host-uid').commit('m7', 1, 'blue', bluePlan);
    await guestIO.commit('m7', 1, 'red', redPlan);
    await guestIO.reveal('m7', 1, 'red', redPlan);

    const spy = makeHooks();
    const host = new AsyncGameController('m7', spy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });
    await host.start();
    await flush();

    expect(spy.plays.length).toBe(0);
    expect(spy.errors.some(e => /lost|redraw/i.test(e))).toBe(true);
    host.destroy();
  });

  it('offers forfeit when a committed plan is lost, and forfeiting ends the match', async () => {
    const be = new FakeBackend('m17', 'host-uid');
    const guestIO = be.ioFor('guest-uid');
    await guestIO.joinMatch('m17');

    // Host commit recorded server-side, but this device has no stash entry, and
    // the opponent has already revealed → host is stuck in reveal with no plan.
    await be.ioFor('host-uid').commit('m17', 1, 'blue', bluePlan);
    await guestIO.commit('m17', 1, 'red', redPlan);
    await guestIO.reveal('m17', 1, 'red', redPlan);

    const spy = makeHooks();
    const host = new AsyncGameController('m17', spy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });
    await host.start();
    await flush();

    expect(spy.errors.some(e => /lost/i.test(e))).toBe(true);
    expect(spy.forfeitable).toContain(true); // UI may offer a Forfeit action

    // Forfeiting concedes: host is blue, so the guest (red) wins.
    await host.forfeit();
    await flush();
    expect(be.match.status).toBe('guest_won');
    expect(spy.gameOver).toContain('guest_won');
    host.destroy();
  });

  it('forfeit is a no-op once the match is already decided', async () => {
    const be = new FakeBackend('m18', 'host-uid');
    be.match = { ...be.match, guestPlayer: 'guest-uid', status: 'host_won' };
    const spy = makeHooks();
    const host = new AsyncGameController('m18', spy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });
    await host.start();
    await flush();
    await host.forfeit();
    await flush();
    expect(be.match.status).toBe('host_won'); // unchanged
    host.destroy();
  });

  it('carries state into round 2 and reuses the round-1 seed', async () => {
    const be = new FakeBackend('m8', 'host-uid');
    const hostSpy = makeHooks();
    const host = new AsyncGameController('m8', hostSpy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });
    const guestIO = be.ioFor('guest-uid');
    await guestIO.joinMatch('m8');

    // Round 1.
    await host.start();
    await flush();
    await host.submitPlan(bluePlan);
    await guestIO.commit('m8', 1, 'red', redPlan);
    await guestIO.reveal('m8', 1, 'red', redPlan);
    await flush();
    const seed1 = hostSpy.plays[0].seed;

    const endState1 = makeState(80, 60);
    await host.onRoundPlayed(1, endState1, false);
    await flush();
    expect(be.match.seed).toBe(seed1);          // seed persisted on round 1
    expect(be.match.currentRound).toBe(2);

    // Round 2 with DIFFERENT paths (so a re-derived seed would differ).
    const bluePlan2: PathList = [{ unitId: 'b1', waypoints: [{ x: 7, y: 7 }] }];
    const redPlan2: PathList = [{ unitId: 'r1', waypoints: [{ x: 8, y: 8 }] }];
    await host.submitPlan(bluePlan2);
    await guestIO.commit('m8', 2, 'red', redPlan2);
    await guestIO.reveal('m8', 2, 'red', redPlan2);
    await flush();

    expect(hostSpy.plays.length).toBe(2);
    expect(hostSpy.plays[1].startState).toEqual(endState1); // carryover
    expect(hostSpy.plays[1].seed).toBe(seed1);              // reused, not re-derived
    host.destroy();
  });

  it('advances exactly once when both players resolve and persist the same round', async () => {
    const be = new FakeBackend('m9', 'host-uid');
    const hostSpy = makeHooks();
    const guestSpy = makeHooks();
    const host = new AsyncGameController('m9', hostSpy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });
    const guest = new AsyncGameController('m9', guestSpy.hooks, { io: be.ioFor('guest-uid'), stash: memStash() });

    await host.start();
    await guest.start();
    await flush();
    await host.submitPlan(bluePlan);
    await guest.submitPlan(redPlan);
    await flush();

    expect(hostSpy.plays.length).toBe(1);
    expect(guestSpy.plays.length).toBe(1);

    // Both clients independently finish playback and persist the same round.
    const endState = makeState(70, 70);
    await host.onRoundPlayed(1, endState, false);
    await guest.onRoundPlayed(1, endState, false);
    await flush();

    // Optimistic guard => advance once (round 2), not twice (round 3).
    expect(be.match.currentRound).toBe(2);
    host.destroy();
    guest.destroy();
  });

  it('reports game over when the match is already abandoned', async () => {
    const be = new FakeBackend('m10', 'host-uid');
    be.match = { ...be.match, guestPlayer: 'guest-uid', status: 'abandoned' };
    const spy = makeHooks();
    const host = new AsyncGameController('m10', spy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });
    await host.start();
    await flush();
    expect(spy.gameOver).toContain('abandoned');
    expect(spy.plays.length).toBe(0);
    host.destroy();
  });

  it('persists and reuses the seed even when a client loses the round-1 write race', async () => {
    const be = new FakeBackend('m11', 'host-uid');
    const hostSpy = makeHooks();
    const guestSpy = makeHooks();
    const host = new AsyncGameController('m11', hostSpy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });
    const guest = new AsyncGameController('m11', guestSpy.hooks, { io: be.ioFor('guest-uid'), stash: memStash() });

    await host.start();
    await guest.start();
    await flush();
    await host.submitPlan(bluePlan);
    await guest.submitPlan(redPlan);
    await flush();

    const seed1 = hostSpy.plays[0].seed;
    expect(guestSpy.plays[0].seed).toBe(seed1);

    // Both clients finish playback and persist round 1; only one write lands.
    const endState1 = makeState(80, 60);
    await host.onRoundPlayed(1, endState1, false);
    await guest.onRoundPlayed(1, endState1, false);
    await flush();
    expect(be.match.seed).toBe(seed1);
    expect(be.match.currentRound).toBe(2);

    // Round 2 with different paths: BOTH must reuse seed1, not re-derive.
    const bluePlan2: PathList = [{ unitId: 'b1', waypoints: [{ x: 7, y: 7 }] }];
    const redPlan2: PathList = [{ unitId: 'r1', waypoints: [{ x: 8, y: 8 }] }];
    await host.submitPlan(bluePlan2);
    await guest.submitPlan(redPlan2);
    await flush();

    expect(hostSpy.plays[1].seed).toBe(seed1);
    expect(guestSpy.plays[1].seed).toBe(seed1);
    host.destroy();
    guest.destroy();
  });

  it('ignores onRoundPlayed for a round this controller did not play', async () => {
    const be = new FakeBackend('m12', 'host-uid');
    be.match = { ...be.match, guestPlayer: 'guest-uid', status: 'active' };
    const spy = makeHooks();
    const host = new AsyncGameController('m12', spy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });
    await host.start();
    await flush();

    // A stray/late onRoundPlayed for a round this controller never resolved must
    // not advance the match (which would drop the write-once seed).
    await host.onRoundPlayed(1, makeState(0, 50), true);
    await flush();
    expect(be.match.currentRound).toBe(1);
    expect(be.match.status).toBe('active');
    host.destroy();
  });

  it('does not re-prompt planning when the opponent commits first (preserves in-progress drawing)', async () => {
    const be = new FakeBackend('m13', 'host-uid');
    const hostSpy = makeHooks();
    const host = new AsyncGameController('m13', hostSpy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });
    const guestIO = be.ioFor('guest-uid');
    await guestIO.joinMatch('m13');

    await host.start();
    await flush();
    expect(hostSpy.planTurns).toEqual([1]); // prompted to plan round 1 exactly once

    // Opponent commits while the host is still drawing round 1. The realtime
    // event re-drives evaluate(), but onPlanTurn must NOT fire again — re-firing
    // would rebuild the draw UI and wipe the host's in-progress waypoints.
    await guestIO.commit('m13', 1, 'red', redPlan);
    await flush();
    expect(hostSpy.planTurns).toEqual([1]); // still once, not re-prompted

    host.destroy();
  });

  it('safety-net poll recovers a turn the realtime channel never delivered', async () => {
    // Simulate a dead subscription: the controller's subscribe is a no-op, so
    // the only way it learns the opponent moved is the poll.
    const be = new FakeBackend('m15', 'host-uid');
    const deadSubIO: AsyncIO = { ...be.ioFor('host-uid'), subscribe: () => () => {} };
    const guestIO = be.ioFor('guest-uid');
    await guestIO.joinMatch('m15');

    const spy = makeHooks();
    const env = fakePollEnv();
    const host = new AsyncGameController('m15', spy.hooks, { io: deadSubIO, stash: memStash(), pollEnv: env });
    await host.start();
    await flush();
    await host.submitPlan(bluePlan);
    await flush();

    // Opponent commits+reveals, but no realtime event reaches us.
    await guestIO.commit('m15', 1, 'red', redPlan);
    await guestIO.reveal('m15', 1, 'red', redPlan);
    await flush();
    expect(spy.plays.length).toBe(0); // nothing delivered the change yet

    // A poll tick picks it up and the round resolves.
    env.tick();
    await flush();
    expect(spy.plays.length).toBe(1);
    expect(spy.errors).toEqual([]);
    host.destroy();
    expect(env.cleared).toBe(true);
  });

  it('does not poll while backgrounded, and refreshes immediately on resume', async () => {
    const be = new FakeBackend('m16', 'host-uid');
    const deadSubIO: AsyncIO = { ...be.ioFor('host-uid'), subscribe: () => () => {} };
    const guestIO = be.ioFor('guest-uid');
    await guestIO.joinMatch('m16');

    const spy = makeHooks();
    const env = fakePollEnv();
    const host = new AsyncGameController('m16', spy.hooks, { io: deadSubIO, stash: memStash(), pollEnv: env });
    await host.start();
    await flush();
    await host.submitPlan(bluePlan);
    await guestIO.commit('m16', 1, 'red', redPlan);
    await guestIO.reveal('m16', 1, 'red', redPlan);
    await flush();

    // Backgrounded: a tick must do nothing.
    env.visible = false;
    env.tick();
    await flush();
    expect(spy.plays.length).toBe(0);

    // Resume (visibility back / network back) refreshes immediately.
    env.visible = true;
    env.resume();
    await flush();
    expect(spy.plays.length).toBe(1);
    host.destroy();
  });

  it('keeps the host on the share screen until a guest joins (no premature planning)', async () => {
    const be = new FakeBackend('m14', 'host-uid'); // status 'open', no guest
    const hostSpy = makeHooks();
    const host = new AsyncGameController('m14', hostSpy.hooks, { io: be.ioFor('host-uid'), stash: memStash() });

    await host.start();
    await flush();
    // No friend yet → wait on the share screen, do NOT prompt planning.
    expect(hostSpy.waiting).toContain(1);
    expect(hostSpy.planTurns).toEqual([]);

    // Friend opens the link and joins → host is now prompted to plan round 1.
    await be.ioFor('guest-uid').joinMatch('m14');
    await flush();
    expect(hostSpy.planTurns).toEqual([1]);

    host.destroy();
  });
});

