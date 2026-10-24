import { isPlausibleGameState, type OnlineGameState } from './online-types';
import { RULES_VERSION } from './online-plan';
import type { AsyncTeam, PathList, FinishReason } from './online-async-core';
import { nextRoundAction } from './online-async-core';
import {
  loadMatch, fetchTurns, turnsForRound, referee, subscribeMatch,
  type MatchRecord, type MatchStatus, type RoundTurn, type RefereeResult, type LoadResult, type OnlineSession,
} from './online-async';

export interface PlayRoundInput {
  round: number;
  startState: OnlineGameState;
  bluePaths: PathList;
  redPaths: PathList;
  /** The engine seed the referee resolved this round with. */
  seed: number;
}

/** Terminal match statuses: the game is over and no further turns are possible. */
export function isTerminalStatus(status: MatchStatus): boolean {
  return status === 'host_won' || status === 'guest_won' || status === 'abandoned';
}

/** UI/engine boundary. The controller owns the online protocol; the host app
 *  owns drawing paths and animating the battle. */
export interface AsyncGameHooks {
  /** It's the local player's turn to plan `round`. Call submitPlan() when done.
   *  `awaitingGuest` is true when no opponent has joined yet (host's first move
   *  before the friend arrives): the UI should keep the share link / invite up
   *  alongside planning, and skip the "it's your turn" notification. */
  onPlanTurn(round: number, startState: OnlineGameState, myTeam: AsyncTeam, awaitingGuest: boolean, afterError?: boolean): void;
  /** We've submitted; nothing to do until the opponent acts. `awaitingGuest`
   *  true means we're still waiting for a friend to *join*. `playing` true
   *  means both plans are in and the server is playing the round. */
  onAwaitOpponent(round: number, awaitingGuest: boolean, playing?: boolean): void;
  /** A round was played: animate it, then call onRoundPlayed(round). */
  onPlayRound(input: PlayRoundInput): void;
  /** Match finished. */
  onGameOver(status: MatchStatus, finalState: OnlineGameState, reason: FinishReason | null): void;
  /** Recoverable problem worth surfacing (e.g. backend unavailable).
   *  `canForfeit` is true when conceding is the clean way out (e.g. a match
   *  on other rules), so the UI can offer a Forfeit action that calls
   *  forfeit(). The same error is not re-emitted by the safety-net poll until
   *  some other state is shown. */
  onError(message: string, canForfeit?: boolean): void;
  /** This client runs other rules than the server: nothing more can be done
   *  here until the app is reloaded or updated. */
  onOutdated?(message: string): void;
  /** The match record changed (an opponent joined, a name changed, ...). */
  onMatch?(match: MatchRecord): void;
}

/** The last round of each match this device has watched, so a round played
 *  while the player was away is shown when they come back. */
export interface WatchStore {
  get(matchId: string): number | null;
  set(matchId: string, round: number): void;
}

const localWatchStore: WatchStore = {
  get(id) {
    try {
      const raw = localStorage.getItem(`7s-watched-${id}`);
      return raw == null ? null : Number(raw);
    } catch { return null; }
  },
  set(id, round) {
    try { localStorage.setItem(`7s-watched-${id}`, String(round)); } catch { /* unavailable */ }
  },
};

/** Injectable IO so the protocol can be unit-tested with in-memory fakes. */
export interface AsyncIO {
  getUserId(): Promise<string | null>;
  loadMatch(id: string): Promise<LoadResult>;
  joinMatch(id: string): Promise<RefereeResult>;
  fetchTurns(id: string): Promise<RoundTurn[] | null>;
  submit(id: string, round: number, paths: PathList): Promise<RefereeResult>;
  advance(id: string): Promise<RefereeResult>;
  forfeit(id: string): Promise<RefereeResult>;
  /** Withdraw an invite or search nobody joined; never concedes a joined match. */
  cancel(id: string): Promise<RefereeResult>;
  subscribe(id: string, onChange: () => void): () => void;
}

/** Upper bound for one backend call before it counts as failed. */
export const IO_TIMEOUT_MS = 25_000;
/** Referee calls retry transient failures themselves (3 attempts of up to
 *  20 s each, with backoff), so their timeout covers that whole budget:
 *  giving up earlier would let a late retry land after the player redrew. */
export const REFEREE_TIMEOUT_MS = 75_000;

/** Resolve a call that hasn't settled within IO_TIMEOUT_MS to its failure value.
 *  A request that never settles would otherwise keep evaluate() busy forever,
 *  coalescing every later refresh behind it. Callers treat the failure value as
 *  transient, so the next poll/realtime refresh simply retries. */
export function withTimeout<A extends unknown[], R>(
  fn: (...args: A) => Promise<R>,
  failure: R,
  ms = IO_TIMEOUT_MS,
): (...args: A) => Promise<R> {
  return (...args) => new Promise<R>((resolve, reject) => {
    const timer = setTimeout(() => resolve(failure), ms);
    fn(...args).then(
      value => { clearTimeout(timer); resolve(value); },
      error => { clearTimeout(timer); reject(error); },
    );
  });
}

const TIMED_OUT: RefereeResult = { ok: false, status: 0, message: 'The online server took too long to answer. Try again.' };

/** The real IO for a session (casual or ranked). `name` is sent with moves so
 *  the opponent sees the player's current display name. */
export function sessionIO(session: OnlineSession, name: () => string | null = () => null): AsyncIO {
  return {
    // ensureUser (not a passive session read) so a first-time visitor opening a
    // share link is signed in anonymously before start() gates on the user id.
    getUserId: withTimeout(() => session.ensureUser(), null),
    loadMatch: withTimeout(id => loadMatch(session, id), { kind: 'error' }),
    joinMatch: withTimeout(id => referee.join(session, id, name()), TIMED_OUT, REFEREE_TIMEOUT_MS),
    fetchTurns: withTimeout(id => fetchTurns(session, id), null),
    // An empty name (cleared by the player) removes it from the match.
    submit: withTimeout((id, round, paths) => referee.submit(session, id, round, paths, session.ranked ? null : name() ?? ''), TIMED_OUT, REFEREE_TIMEOUT_MS),
    advance: withTimeout(id => referee.advance(session, id), TIMED_OUT, REFEREE_TIMEOUT_MS),
    forfeit: withTimeout(id => referee.forfeit(session, id), TIMED_OUT, REFEREE_TIMEOUT_MS),
    cancel: withTimeout(id => referee.cancel(session, id), TIMED_OUT, REFEREE_TIMEOUT_MS),
    subscribe: (id, onChange) => subscribeMatch(session, id, onChange),
  };
}

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
  now(): number;
}

/** How often the safety-net poll re-checks the backend while a match is live
 *  and foregrounded. Realtime push is the fast path; this is the floor that
 *  guarantees the match can never silently hang if the socket dies. */
export const POLL_INTERVAL_MS = 15_000;
/** Least time between two catch-up requests for the same match. */
export const ADVANCE_INTERVAL_MS = 8_000;

/** Default poll environment: real timers + Page Visibility, active only in a
 *  browser. In a headless/test context `document` is undefined and we return
 *  null so unit tests never spin real timers. */
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
    now: () => Date.now(),
  };
}

export interface AsyncGameOptions {
  io?: AsyncIO;
  watched?: WatchStore;
  /** Override the poll environment (tests inject a fake; pass null to disable). */
  pollEnv?: PollEnv | null;
  /** Clock for throttling catch-up requests when there is no poll environment. */
  now?: () => number;
}

function versionMessage(match: MatchRecord): string {
  return match.rules > RULES_VERSION
    ? 'This match was started on a newer version of 7 Seconds. Reload or update the app to continue it.'
    : 'This match was started on an older version of 7 Seconds and can’t be continued.';
}

/** Drives one online match: the player plans and submits each round, the
 *  referee plays it once both plans are in, and every client animates the
 *  published round. Reacts to Realtime changes, with a polling safety net. */
export class AsyncGameController {
  private readonly id: string;
  private readonly hooks: AsyncGameHooks;
  private readonly io: AsyncIO;
  private readonly watchStore: WatchStore;
  private readonly pollEnv: PollEnv | null;
  private readonly now: () => number;
  private pollHandle: unknown = null;
  private pollResumeOff: (() => void) | null = null;

  private match: MatchRecord | null = null;
  private myTeam: AsyncTeam = 'blue';
  private userId: string | null = null;
  private unsubscribe: (() => void) | null = null;
  private evaluating = false;
  private dirty = false;
  /** Round currently shown to the UI for planning, so we set up the draw UI
   *  once per round — a re-emit (e.g. when the opponent submits via a realtime
   *  event while we're still drawing) would wipe the in-progress drawing. */
  private planningRound: number | null = null;
  /** Round currently handed to the UI for playback, so we animate it once and
   *  hold the next step until it has been watched. */
  private playingRound: number | null = null;
  /** Last round this device has shown the player. */
  private watched = 0;
  private destroyed = false;
  /** Last error shown, so a stuck state re-detected by every poll doesn't
   *  re-fire the same error (and reset the UI) every 15s. */
  private lastError: string | null = null;
  /** The next planning prompt follows a failed submit (UI skips "your turn"). */
  private replanAfterError = false;
  private lastAdvanceAt = -Infinity;
  private lastShownMatch: MatchRecord | null = null;
  /** onGameOver has been reported. */
  private over = false;
  /** The server runs other rules: stop until the app is reloaded. */
  private outdated = false;
  /** A refresh is running; `refreshAgain` asks for one more after it. */
  private refreshing = false;
  private refreshAgain = false;
  /** An older-rules match was handed to the referee to end. */
  private voidRequested = false;

  constructor(id: string, hooks: AsyncGameHooks, opts: AsyncGameOptions = {}) {
    this.id = id;
    this.hooks = hooks;
    if (!opts.io) throw new Error('AsyncGameController needs an IO (see sessionIO)');
    this.io = opts.io;
    this.watchStore = opts.watched ?? localWatchStore;
    this.pollEnv = opts.pollEnv !== undefined ? opts.pollEnv : defaultPollEnv();
    this.now = opts.now ?? this.pollEnv?.now ?? (() => Date.now());
  }

  /** Open the match (joining as guest if it's an invite we hold the link to),
   *  subscribe to changes, and drive the first applicable step. */
  async start(): Promise<boolean> {
    this.userId = await this.io.getUserId();
    if (this.destroyed) return false;
    if (!this.userId) {
      this.showError('Online play is unavailable right now.');
      return false;
    }

    const loaded = await this.io.loadMatch(this.id);
    if (this.destroyed) return false;
    let match: MatchRecord;
    if (loaded.kind === 'ok') {
      match = loaded.match;
    } else if (loaded.kind === 'missing') {
      // Not ours yet: an invite link. The referee seats us if it's still open.
      const joined = await this.io.joinMatch(this.id);
      if (this.destroyed) return false;
      if (!joined.ok) {
        this.showError(joined.status === 404 ? 'This match doesn’t exist anymore, or it isn’t yours to join.' : joined.message);
        return false;
      }
      match = joined.match;
    } else {
      // A timeout or network failure, so don't claim it's missing.
      this.showError('Could not load this match. Check your connection and try again.');
      return false;
    }
    this.setMatch(match);
    this.myTeam = match.hostPlayer === this.userId ? 'blue' : 'red';
    // A device that hasn't seen this match before shows its latest round.
    this.watched = this.watchStore.get(this.id) ?? Math.max(0, match.currentRound - 2);

    this.unsubscribe = this.io.subscribe(this.id, () => { void this.refresh(); });
    this.startPoll();
    await this.evaluate();
    return true;
  }

  /** Safety-net poll: Realtime push is best-effort and can die silently, so
   *  while the match is live and foregrounded we also re-check the backend on a
   *  slow interval, plus immediately whenever the app is resumed or the network
   *  returns. */
  private startPoll(): void {
    const env = this.pollEnv;
    if (!env) return;
    const poll = () => {
      if (this.destroyed) return;
      if (this.match && isTerminalStatus(this.match.status) && this.playingRound == null && this.watched >= this.match.currentRound - 1) return;
      void this.refresh();
    };
    this.pollHandle = env.setInterval(() => { if (env.isVisible()) poll(); }, POLL_INTERVAL_MS);
    this.pollResumeOff = env.onResume(poll);
  }

  private stopPoll(): void {
    if (this.pollHandle != null) { this.pollEnv?.clearInterval(this.pollHandle); this.pollHandle = null; }
    this.pollResumeOff?.();
    this.pollResumeOff = null;
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

  /** The match as last loaded. */
  get record(): MatchRecord | null { return this.match; }

  /** Local player finished drawing paths for the current round. */
  async submitPlan(paths: PathList): Promise<void> {
    if (this.destroyed || !this.match) return;
    const round = this.match.currentRound;
    const result = await this.io.submit(this.id, round, paths);
    if (this.destroyed) return;
    if (result.ok) {
      this.setMatch(result.match);
      await this.evaluate();
      return;
    }
    if (result.match) this.setMatch(result.match);
    if (result.status === 426) {
      this.markOutdated(result.message);
      return;
    }
    if (result.status === 409) {
      // Permanent: the match moved on (finished, expired).
      this.showError(result.message);
    } else {
      this.showError('Could not submit your turn. Try again.');
      this.replanAfterError = true;
    }
    // The UI already tore down the drawing for this submit. Release the
    // planning latch so a still-unplanned round re-prompts planning instead of
    // leaving the player on a dead "waiting" screen.
    if (this.planningRound === round) this.planningRound = null;
    await this.evaluate();
  }

  /** UI reports the animation of `round` finished. */
  async onRoundPlayed(round: number): Promise<void> {
    if (this.destroyed || round !== this.playingRound) return;
    this.playingRound = null;
    this.markWatched(round);
    await this.evaluate();
  }

  private markWatched(round: number): void {
    if (round <= this.watched) return;
    this.watched = round;
    this.watchStore.set(this.id, round);
  }

  private markOutdated(message: string): void {
    if (this.outdated) return;
    this.outdated = true;
    this.stopPoll();
    if (this.hooks.onOutdated) this.hooks.onOutdated(message);
    else this.hooks.onError(message);
  }

  private showError(message: string, canForfeit?: boolean): void {
    if (message === this.lastError) return;
    this.lastError = message;
    this.hooks.onError(message, canForfeit);
  }

  private setMatch(match: MatchRecord): void {
    this.match = match;
    const shown = this.lastShownMatch;
    if (!shown || shown.guestPlayer !== match.guestPlayer || shown.hostName !== match.hostName
        || shown.guestName !== match.guestName || shown.status !== match.status) {
      this.lastShownMatch = match;
      this.hooks.onMatch?.(match);
    }
  }

  /** Reload the match from the backend, then re-evaluate. A burst of
   *  Realtime events (one round brings several) collapses into at most one
   *  more reload after the running one. */
  private async refresh(): Promise<void> {
    if (this.destroyed) return;
    if (this.refreshing) { this.refreshAgain = true; return; }
    this.refreshing = true;
    try {
      do {
        this.refreshAgain = false;
        const loaded = await this.io.loadMatch(this.id);
        if (this.destroyed) return;
        if (loaded.kind === 'ok') this.setMatch(loaded.match);
        else if (loaded.kind === 'missing') {
          this.showError('This match no longer exists.');
          return;
        }
      } while (this.refreshAgain);
    } finally {
      this.refreshing = false;
    }
    await this.evaluate();
  }

  /** Ask the referee to catch up on what the server owes (an AI commander's
   *  move, a round whose plans are both in), at most every few seconds. */
  private async catchUp(): Promise<void> {
    const now = this.now();
    if (now - this.lastAdvanceAt < ADVANCE_INTERVAL_MS) return;
    this.lastAdvanceAt = now;
    const result = await this.io.advance(this.id);
    if (this.destroyed) return;
    if (result.match) this.setMatch(result.match);
    if (!result.ok && result.status === 426) this.markOutdated(result.message);
    else if (!result.ok && result.status === 409 && !result.match) this.showError(result.message);
    if (result.match) this.dirty = true;
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
    if (this.destroyed || !this.match || this.playingRound != null || this.outdated) return;
    const match = this.match;

    if (match.rules !== RULES_VERSION && !isTerminalStatus(match.status)) {
      // Newer rules: this app is outdated, and the match can go on after an
      // update. Older rules: the referee ends it with no winner.
      if (match.rules > RULES_VERSION) {
        this.markOutdated(versionMessage(match));
        return;
      }
      if (!this.voidRequested) {
        this.voidRequested = true;
        this.lastAdvanceAt = -Infinity;
        await this.catchUp();
        if (this.match !== match) return;
      }
      this.showError(versionMessage(match));
      return;
    }

    // A round played since this device last looked: show it first.
    const last = match.currentRound - 1;
    if (last >= 1 && this.watched < last) {
      // Only replay with the rules the round was played under.
      if (match.rules === RULES_VERSION && match.prevState && match.prevSeed != null && isPlausibleGameState(match.prevState)) {
        const allTurns = await this.io.fetchTurns(this.id);
        // A newer record arrived meanwhile: its own evaluation takes over.
        if (this.destroyed || allTurns == null || this.match !== match) return;
        const turns = turnsForRound(allTurns, last);
        const blue = turns.find(t => t.team === 'blue')?.paths;
        const red = turns.find(t => t.team === 'red')?.paths;
        if (blue && red) {
          this.play({ round: last, startState: match.prevState, bluePaths: blue, redPaths: red, seed: match.prevSeed });
          return;
        }
      }
      // Nothing to replay (e.g. the match ended by forfeit): move on.
      this.markWatched(last);
    }

    if (isTerminalStatus(match.status)) {
      if (this.over) return;
      this.over = true;
      this.lastError = null;
      this.replanAfterError = false;
      this.hooks.onGameOver(match.status, match.latestState, match.finishReason);
      return;
    }

    // Never feed the engine/renderer a snapshot that could hang or crash it.
    if (!isPlausibleGameState(match.latestState)) {
      this.showError('This match has an invalid game state and can no longer be played.', true);
      return;
    }

    const round = match.currentRound;
    const allTurns = await this.io.fetchTurns(this.id);
    // null = transient load failure: do nothing rather than act on a phantom
    // empty list (which would wrongly re-prompt a planned player to redraw).
    if (this.destroyed || allTurns == null || this.match !== match) return;
    const action = nextRoundAction(turnsForRound(allTurns, round), this.myTeam);
    // 'open' means no guest has joined yet (only the host can be here). The
    // host may still plan their first move; it waits until a friend joins.
    const awaitingGuest = match.status === 'open';

    switch (action) {
      case 'plan':
        if (this.planningRound === round) return; // already planning this round
        this.planningRound = round;
        this.lastError = null;
        try {
          this.hooks.onPlanTurn(round, match.latestState, this.myTeam, awaitingGuest, this.replanAfterError);
        } catch (e) {
          // Release the latch so a later evaluate re-prompts instead of
          // skipping this round's planning forever.
          console.error('async: failed to set up planning', e);
          this.planningRound = null;
        }
        this.replanAfterError = false;
        return;

      case 'await':
        this.lastError = null;
        this.replanAfterError = false;
        this.hooks.onAwaitOpponent(round, awaitingGuest, false);
        // An AI commander plans at once; if it hasn't, the server owes a move.
        if (match.guestBot) await this.catchUp();
        return;

      case 'resolve':
        // Both plans are in: the referee plays the round the moment the
        // second arrives, so this only lasts if that failed. Ask again.
        this.lastError = null;
        this.hooks.onAwaitOpponent(round, false, true);
        await this.catchUp();
        return;
    }
  }

  private play(input: PlayRoundInput): void {
    this.playingRound = input.round;
    this.planningRound = null;
    this.lastError = null;
    this.replanAfterError = false;
    try {
      this.hooks.onPlayRound(input);
    } catch (e) {
      // Playback never started, so onRoundPlayed will never come. Skip the
      // animation rather than wedge the match behind it.
      console.error('async: failed to play round', e);
      this.playingRound = null;
      this.markWatched(input.round);
      this.dirty = true;
    }
  }

  /** Concede the match: the opponent is recorded the winner (an invite or a
   *  search nobody joined is just withdrawn). Idempotent on the server. */
  async forfeit(): Promise<void> {
    if (this.destroyed || !this.match) return;
    // Each attempt reports its own failure, even when it reads like the last one.
    this.lastError = null;
    const result = await this.io.forfeit(this.id);
    if (this.destroyed) return;
    if (result.match) this.setMatch(result.match);
    if (!result.ok) {
      this.showError(result.message, true);
      return;
    }
    this.lastError = null;
    await this.evaluate();
  }

  /** Withdraw an invite or search nobody has joined. Never concedes: if
   *  someone joined meanwhile, the match simply goes on. Resolves to an error
   *  message, or null once the match was withdrawn or goes on. */
  async withdraw(): Promise<string | null> {
    if (this.destroyed || !this.match) return null;
    const result = await this.io.cancel(this.id);
    if (this.destroyed) return null;
    if (result.match) this.setMatch(result.match);
    if (!result.ok) return result.message;
    this.lastError = null;
    await this.evaluate();
    return null;
  }

  destroy(): void {
    this.destroyed = true;
    this.stopPoll();
    this.unsubscribe?.();
    this.unsubscribe = null;
  }
}
