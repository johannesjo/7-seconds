import type { OnlineGameState } from './online-types';
import type { AsyncTeam, PathList } from './online-async-core';
import { nextRoundAction, verifyReveal, deriveMatchSeed, hashPaths } from './online-async-core';
import {
  loadMatch, joinAsyncMatch, fetchTurns, turnsForRound,
  commitTurn, revealTurn, persistRoundResult, subscribeMatch,
  type MatchRecord, type MatchStatus, type RoundTurn,
} from './online-async';
import { ensureAuth } from './online-auth';

export interface PlayRoundInput {
  round: number;
  startState: OnlineGameState;
  bluePaths: PathList;
  redPaths: PathList;
  seed: number;
}

/** UI/engine boundary. The controller owns the async protocol; the host app
 *  owns drawing paths and animating the battle. */
export interface AsyncGameHooks {
  /** It's the local player's turn to plan `round`. Call submitPlan() when done. */
  onPlanTurn(round: number, startState: OnlineGameState, myTeam: AsyncTeam): void;
  /** We've submitted; nothing to do until the opponent acts. */
  onAwaitOpponent(round: number): void;
  /** Both sides revealed — animate the battle, then call onRoundPlayed(). */
  onPlayRound(input: PlayRoundInput): void;
  /** Match finished. */
  onGameOver(status: MatchStatus, finalState: OnlineGameState): void;
  /** Recoverable problem worth surfacing (e.g. backend unavailable). */
  onError(message: string): void;
}

/** Persists drawn paths between the commit and reveal steps so a player can
 *  close the app after committing and still reveal on return. */
export interface PathStash {
  save(key: string, paths: PathList): void;
  load(key: string): PathList | null;
  clear(key: string): void;
}

const localStoragePathStash: PathStash = {
  save(key, paths) {
    try { localStorage.setItem(key, JSON.stringify(paths)); } catch { /* unavailable */ }
  },
  load(key) {
    try {
      const raw = localStorage.getItem(key);
      return raw ? (JSON.parse(raw) as PathList) : null;
    } catch { return null; }
  },
  clear(key) {
    try { localStorage.removeItem(key); } catch { /* unavailable */ }
  },
};

/** Injectable IO so the protocol can be unit-tested with in-memory fakes. */
export interface AsyncIO {
  getUserId(): Promise<string | null>;
  loadMatch(id: string): Promise<MatchRecord | null>;
  joinMatch(id: string): Promise<MatchRecord | null>;
  fetchTurns(id: string): Promise<RoundTurn[] | null>;
  commit(id: string, round: number, team: AsyncTeam, paths: PathList): Promise<boolean>;
  reveal(id: string, round: number, team: AsyncTeam, paths: PathList): Promise<boolean>;
  persist(id: string, update: { latestState: OnlineGameState; currentRound: number; seed?: number; status?: MatchStatus; expectedRound?: number }): Promise<boolean>;
  subscribe(id: string, onChange: () => void): () => void;
}

const realIO: AsyncIO = {
  // ensureAuth (not a passive session read) so a first-time visitor opening a
  // share link is signed in anonymously before start() gates on the user id.
  getUserId: ensureAuth,
  loadMatch,
  joinMatch: joinAsyncMatch,
  fetchTurns,
  commit: commitTurn,
  reveal: revealTurn,
  persist: persistRoundResult,
  subscribe: (id, onChange) =>
    subscribeMatch(id, { onTurnChange: () => onChange(), onMatchChange: () => onChange() }),
};

export interface AsyncGameOptions {
  io?: AsyncIO;
  stash?: PathStash;
}

/** Drives one async match through commit -> reveal -> resolve -> persist,
 *  one round at a time, reacting to Realtime changes. */
export class AsyncGameController {
  private readonly id: string;
  private readonly hooks: AsyncGameHooks;
  private readonly io: AsyncIO;
  private readonly stash: PathStash;

  private match: MatchRecord | null = null;
  private myTeam: AsyncTeam = 'blue';
  private userId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private evaluating = false;
  private dirty = false;
  /** Round currently shown to the UI for planning, so we set up the draw UI
   *  once per round — a re-emit (e.g. when the opponent commits via a realtime
   *  event while we're still drawing) would wipe the in-progress drawing. */
  private planningRound: number | null = null;
  /** Round currently handed to the UI for playback, so we animate it once. */
  private playingRound: number | null = null;
  /** Seed used to resolve the round currently being played (persisted atomically
   *  with the round-1 advance so later rounds reuse it). */
  private playingSeed: number | null = null;
  private destroyed = false;

  constructor(id: string, hooks: AsyncGameHooks, opts: AsyncGameOptions = {}) {
    this.id = id;
    this.hooks = hooks;
    this.io = opts.io ?? realIO;
    this.stash = opts.stash ?? localStoragePathStash;
  }

  get matchRecord(): MatchRecord | null {
    return this.match;
  }

  /** Open the match (joining as guest if it's open and we're not the host),
   *  subscribe to changes, and drive the first applicable step. */
  async start(): Promise<boolean> {
    this.userId = await this.io.getUserId();
    if (!this.userId) {
      this.hooks.onError('Online play is unavailable right now.');
      return false;
    }

    let match = await this.io.loadMatch(this.id);
    if (!match) {
      this.hooks.onError('Match not found.');
      return false;
    }
    // Join as guest if there's an open seat and we're not the host.
    if (match.status === 'open' && match.hostPlayer !== this.userId) {
      match = await this.io.joinMatch(this.id);
      if (!match) {
        this.hooks.onError('Could not join this match.');
        return false;
      }
    }
    this.match = match;
    this.myTeam = match.hostPlayer === this.userId ? 'blue' : 'red';

    this.unsubscribe = this.io.subscribe(this.id, () => { void this.refresh(); });
    await this.evaluate();
    return true;
  }

  private stashKey(round: number): string {
    return `7s-async-${this.id}-r${round}-${this.myTeam}`;
  }

  /** Local player finished drawing paths for the current round. */
  async submitPlan(paths: PathList): Promise<void> {
    if (this.destroyed || !this.match) return;
    const round = this.match.currentRound;
    this.stash.save(this.stashKey(round), paths);
    const ok = await this.io.commit(this.id, round, this.myTeam, paths);
    if (!ok) {
      this.hooks.onError('Could not submit your turn. Try again.');
      return;
    }
    await this.evaluate();
  }

  /** UI reports the animated battle finished with this authoritative end state. */
  async onRoundPlayed(round: number, endState: OnlineGameState, gameOver: boolean): Promise<void> {
    if (this.destroyed || !this.match) return;
    // Only the controller that actually resolved+played this round advances it.
    // resolve() sets playingRound and playingSeed together, so this guarantees
    // playingSeed is present — the write-once seed is never dropped on the
    // round-1 advance. A controller that never played this round (e.g. recreated
    // mid-playback) ignores the call and resolves the round itself.
    if (round !== this.playingRound) return;
    if (round !== this.match.currentRound) return;

    const status: MatchStatus | undefined = gameOver
      ? this.winnerStatus(endState)
      : undefined;
    // Persist the derived seed once (round 1), atomically with the advance, and
    // guard on the current round so a late/duplicate writer can't clobber.
    const seed = this.match.seed == null ? (this.playingSeed ?? undefined) : undefined;
    if (this.match.seed == null && seed == null) {
      // Defensive: never advance round 1 without persisting the write-once seed.
      this.hooks.onError('Could not resolve the round; please retry.');
      return;
    }
    await this.io.persist(this.id, {
      latestState: endState,
      currentRound: round + 1,
      seed,
      status,
      expectedRound: round,
    });
    this.stash.clear(this.stashKey(round));
    await this.refresh();
  }

  private winnerStatus(state: OnlineGameState): MatchStatus {
    const blueAlive = state.units.some(u => u.team === 'blue' && u.hp > 0);
    return blueAlive ? 'host_won' : 'guest_won';
  }

  /** Reload match + turns from the backend, then re-evaluate. */
  private async refresh(): Promise<void> {
    if (this.destroyed) return;
    const match = await this.io.loadMatch(this.id);
    if (match) this.match = match;
    await this.evaluate();
  }

  /** Decide and perform the next step. Re-entrant calls are coalesced. */
  private async evaluate(): Promise<void> {
    if (this.evaluating) { this.dirty = true; return; }
    this.evaluating = true;
    try {
      do {
        this.dirty = false;
        await this.step();
      } while (this.dirty && !this.destroyed);
    } finally {
      this.evaluating = false;
    }
  }

  private async step(): Promise<void> {
    if (this.destroyed || !this.match) return;
    const match = this.match;

    if (match.status === 'host_won' || match.status === 'guest_won' || match.status === 'abandoned') {
      this.hooks.onGameOver(match.status, match.latestState);
      return;
    }

    const round = match.currentRound;
    const allTurns = await this.io.fetchTurns(this.id);
    // null = transient load failure: do nothing rather than act on a phantom
    // empty list (which would wrongly re-prompt a committed player to redraw).
    // A later realtime event or reopen re-drives evaluate().
    if (allTurns == null) return;
    const turns = turnsForRound(allTurns, round);
    const action = nextRoundAction(turns, this.myTeam);

    switch (action) {
      case 'commit':
        if (this.planningRound === round) return; // already planning this round
        this.planningRound = round;
        this.hooks.onPlanTurn(round, match.latestState, this.myTeam);
        return;

      case 'await-commit':
      case 'await-reveal':
        this.hooks.onAwaitOpponent(round);
        return;

      case 'reveal': {
        const mine = this.stash.load(this.stashKey(round));
        if (!mine) {
          // Paths lost (e.g. localStorage cleared on another device).
          this.hooks.onError('Your submitted plan was lost; please redraw it.');
          return;
        }
        await this.io.reveal(this.id, round, this.myTeam, mine);
        await this.refresh();
        return;
      }

      case 'resolve':
        this.resolve(round, turns, match);
        return;
    }
  }

  private resolve(round: number, turns: RoundTurn[], match: MatchRecord): void {
    if (this.playingRound === round) return; // already animating this round

    const blue = turns.find(t => t.team === 'blue');
    const red = turns.find(t => t.team === 'red');
    if (!blue || !red || !blue.paths || !red.paths) return;

    // Reject a peer that changed their paths after committing.
    if (!verifyReveal(blue) || !verifyReveal(red)) {
      this.hooks.onError('Opponent submission failed verification.');
      return;
    }

    // Round 1 derives the seed from both blind commits (anti-grind); later
    // rounds reuse the stored match seed. The seed is persisted atomically with
    // the round-1 advance in onRoundPlayed — not here — to avoid a write race.
    const seed = match.seed ?? deriveMatchSeed(this.id, hashPaths(blue.paths), hashPaths(red.paths));
    this.playingRound = round;
    this.playingSeed = seed;
    this.hooks.onPlayRound({
      round,
      startState: match.latestState,
      bluePaths: blue.paths,
      redPaths: red.paths,
      seed,
    });
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
