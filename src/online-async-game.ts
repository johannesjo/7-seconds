import { isPlausibleGameState, type OnlineGameState } from './online-types';
import type { AsyncTeam, PathList } from './online-async-core';
import { nextRoundAction, verifyReveal, deriveMatchSeed, hashPaths, blueAlive } from './online-async-core';
import {
  loadMatch, joinAsyncMatch, fetchTurns, turnsForRound,
  commitTurn, revealTurn, persistRoundResult, finishMatch, subscribeMatch,
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

/** Terminal match statuses: the game is over and no further turns are possible. */
export function isTerminalStatus(status: MatchStatus): boolean {
  return status === 'host_won' || status === 'guest_won' || status === 'abandoned';
}

/** UI/engine boundary. The controller owns the async protocol; the host app
 *  owns drawing paths and animating the battle. */
export interface AsyncGameHooks {
  /** It's the local player's turn to plan `round`. Call submitPlan() when done.
   *  `awaitingGuest` is true when no opponent has joined yet (host's first move
   *  before the friend arrives): the UI should keep the share link / invite up
   *  alongside planning, and skip the "it's your turn" notification. */
  onPlanTurn(round: number, startState: OnlineGameState, myTeam: AsyncTeam, awaitingGuest: boolean): void;
  /** We've submitted; nothing to do until the opponent acts. `awaitingGuest`
   *  true means we're still waiting for a friend to *join* (keep the share link
   *  visible), not just to take their turn. */
  onAwaitOpponent(round: number, awaitingGuest: boolean): void;
  /** Both sides revealed — animate the battle, then call onRoundPlayed(). */
  onPlayRound(input: PlayRoundInput): void;
  /** Match finished. */
  onGameOver(status: MatchStatus, finalState: OnlineGameState): void;
  /** Recoverable problem worth surfacing (e.g. backend unavailable).
   *  `canForfeit` is true when the only clean way out is to concede this match
   *  (e.g. the committed plan was lost and can never pass reveal verification),
   *  so the UI can offer a Forfeit action that calls forfeit(). */
  onError(message: string, canForfeit?: boolean): void;
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
  finish(id: string, status: MatchStatus): Promise<boolean>;
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
  finish: finishMatch,
  subscribe: (id, onChange) =>
    subscribeMatch(id, { onTurnChange: () => onChange(), onMatchChange: () => onChange() }),
};

/** Abstracts the browser timers/visibility the safety-net poll needs, so it can
 *  be driven deterministically in tests and is a no-op in a headless context. */
export interface PollEnv {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
  /** True when the app is foregrounded (poll only runs then). */
  isVisible(): boolean;
  /** Subscribe to "became visible" / "network back" — fires an immediate poll.
   *  Returns a teardown. */
  onResume(fn: () => void): () => void;
}

/** How often the safety-net poll re-checks the backend while a match is live
 *  and foregrounded. Realtime push is the fast path; this is the floor that
 *  guarantees the match can never silently hang if the socket dies. */
export const POLL_INTERVAL_MS = 15_000;

/** Default poll environment: real timers + Page Visibility, active only in a
 *  browser. In a headless/test context `document` is undefined and we return a
 *  no-op env so unit tests never spin real timers. */
function defaultPollEnv(): PollEnv | null {
  if (typeof document === 'undefined' || typeof window === 'undefined') return null;
  return {
    setInterval: (fn, ms) => window.setInterval(fn, ms),
    clearInterval: (h) => window.clearInterval(h as number),
    isVisible: () => document.visibilityState === 'visible',
    onResume: (fn) => {
      const vis = () => { if (document.visibilityState === 'visible') fn(); };
      document.addEventListener('visibilitychange', vis);
      window.addEventListener('online', fn);
      return () => {
        document.removeEventListener('visibilitychange', vis);
        window.removeEventListener('online', fn);
      };
    },
  };
}

export interface AsyncGameOptions {
  io?: AsyncIO;
  stash?: PathStash;
  /** Override the poll environment (tests inject a fake; pass null to disable). */
  pollEnv?: PollEnv | null;
}

/** Drives one async match through commit -> reveal -> resolve -> persist,
 *  one round at a time, reacting to Realtime changes. */
export class AsyncGameController {
  private readonly id: string;
  private readonly hooks: AsyncGameHooks;
  private readonly io: AsyncIO;
  private readonly stash: PathStash;
  private readonly pollEnv: PollEnv | null;
  private pollHandle: unknown = null;
  private pollResumeOff: (() => void) | null = null;

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
    this.pollEnv = opts.pollEnv !== undefined ? opts.pollEnv : defaultPollEnv();
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
    this.startPoll();
    await this.evaluate();
    return true;
  }

  /** Safety-net poll: Realtime push is best-effort and can die silently, so
   *  while the match is live and foregrounded we also re-check the backend on a
   *  slow interval, plus immediately whenever the app is resumed or the network
   *  returns. A poll just calls refresh(); fetchTurns() returning null (a
   *  transient read failure) is already a no-op in step(), so a poll can never
   *  act on phantom-empty data or re-prompt a redraw. */
  private startPoll(): void {
    const env = this.pollEnv;
    if (!env) return;
    this.pollHandle = env.setInterval(() => {
      if (this.destroyed || !env.isVisible()) return;
      if (this.match && isTerminalStatus(this.match.status)) return;
      void this.refresh();
    }, POLL_INTERVAL_MS);
    this.pollResumeOff = env.onResume(() => {
      if (this.destroyed) return;
      if (this.match && isTerminalStatus(this.match.status)) return;
      void this.refresh();
    });
  }

  private stopPoll(): void {
    if (this.pollHandle != null) { this.pollEnv?.clearInterval(this.pollHandle); this.pollHandle = null; }
    this.pollResumeOff?.();
    this.pollResumeOff = null;
  }

  private stashKey(round: number): string {
    return `7s-async-${this.id}-r${round}-${this.myTeam}`;
  }

  /** The durable match id (for keying a once-only win/loss record). */
  get matchId(): string { return this.id; }

  /** The local player's team, resolved from the match role at start(). Use this
   *  for win/loss attribution — it is authoritative even when a finished match
   *  is reopened (no planning hook fires to set the UI's team in that path). */
  get team(): AsyncTeam { return this.myTeam; }

  /** The opponent's user id, or null if no opponent has joined yet. */
  get opponentId(): string | null {
    if (!this.match) return null;
    return (this.myTeam === 'blue' ? this.match.guestPlayer : this.match.hostPlayer) ?? null;
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
    const landed = await this.io.persist(this.id, {
      latestState: endState,
      currentRound: round + 1,
      seed,
      status,
      expectedRound: round,
    });
    // Reload unconditionally. If we LOST the advance race (landed === false
    // because the peer already advanced the round), this pulls in their
    // advanced round and the now-set write-once seed, so the next round reuses
    // that seed instead of re-deriving a divergent one. A lost race is benign,
    // not an error worth surfacing.
    await this.refresh();
    // Clear the saved plan only once this round is truly behind us — our write
    // landed, or a peer's write advanced the match past it. Otherwise keep it
    // so a transient failure (retries exhausted, still on this round) can retry.
    if (landed || (this.match != null && this.match.currentRound > round)) {
      this.stash.clear(this.stashKey(round));
    } else if (this.match != null && this.match.currentRound === round) {
      // Neither our write nor a peer's advanced the round: the persist failed
      // transiently (retries are already exhausted inside persistRoundResult).
      // Release the playback latch so the safety-net poll / next realtime event
      // re-resolves this round and re-attempts the write. Without this reset
      // playingRound stays pinned to this round, resolve() can never re-emit,
      // and the session wedges — the one hang the safety-net poll can't undo.
      this.playingRound = null;
      this.playingSeed = null;
    }
  }

  private winnerStatus(state: OnlineGameState): MatchStatus {
    return blueAlive(state) ? 'host_won' : 'guest_won';
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

    if (isTerminalStatus(match.status)) {
      this.hooks.onGameOver(match.status, match.latestState);
      return;
    }

    // The match row (incl. latest_state) is written by participants — for a
    // matchmade stranger that's an untrusted peer. Before feeding it to the
    // engine/renderer (planning and resolve both consume match.latestState),
    // reject an implausible snapshot so a malicious/buggy state can't hang or
    // crash this client. Forfeit is the clean exit (the state can't be fixed).
    if (!isPlausibleGameState(match.latestState)) {
      this.hooks.onError('This match has an invalid game state and can no longer be played.', true);
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
    // 'open' means no guest has joined yet (only the host can be here). We still
    // let the host plan and commit their first move — the commit just waits in
    // the turn log until a friend joins and plays. The UI keeps the share link
    // visible via the awaitingGuest flag.
    const awaitingGuest = match.status === 'open';

    switch (action) {
      case 'commit':
        if (this.planningRound === round) return; // already planning this round
        this.planningRound = round;
        this.hooks.onPlanTurn(round, match.latestState, this.myTeam, awaitingGuest);
        return;

      case 'await-commit':
      case 'await-reveal':
        this.hooks.onAwaitOpponent(round, awaitingGuest);
        return;

      case 'reveal': {
        const mine = this.stash.load(this.stashKey(round));
        if (!mine) {
          // Paths lost (e.g. localStorage cleared, or committed on another
          // device). A redraw can't help: the server already holds our commit
          // hash, so any new paths would fail reveal verification and wedge the
          // round forever. Offer Forfeit as the honest, unwedgeable way out.
          this.hooks.onError(
            'Your planned move for this round was lost and can no longer be revealed. You can forfeit this match to end it cleanly.',
            true,
          );
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

  /** Concede the match: the local player loses, the opponent is recorded the
   *  winner. Used both for a voluntary forfeit and to escape an unrecoverable
   *  stuck state (e.g. a lost commit that can't be revealed). Idempotent via
   *  finishMatch's in-play guard. */
  async forfeit(): Promise<void> {
    if (this.destroyed || !this.match) return;
    const status: MatchStatus = this.myTeam === 'blue' ? 'guest_won' : 'host_won';
    await this.io.finish(this.id, status);
    await this.refresh();
  }

  destroy(): void {
    this.destroyed = true;
    this.stopPoll();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
