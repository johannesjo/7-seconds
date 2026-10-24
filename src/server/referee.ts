// The match referee: every write to an online match goes through here (the
// `match-referee` Edge Function wraps it; see supabase/functions). Plans are
// held where no client can read them, each round is resolved with the same
// deterministic engine the clients animate, AI commanders play their seats,
// and ranked results are rated by the database in the same transaction.
//
// Platform-free: storage, randomness, notifications and Play Games
// verification are injected, so the whole protocol is unit tested
// (referee.test.ts) and the database functions separately (referee-sql.test.ts).
import { GameEngine } from '../game';
import { ROUND_DURATION_S } from '../constants';
import { RULES_VERSION, sanitizePlan, blueAlive, type PathList } from '../online-plan';
import { isPlausibleGameState, type OnlineGameState } from '../online-types';
import { planBotPaths, type BotDifficulty } from '../bot';
import { createRng } from '../rng';
import type { Alert } from './alerts';
import { PlayGamesError, type PlayGamesPlayer } from './play-games';

export const ROUND_TICKS = Math.round(ROUND_DURATION_S * 60);

export type Team = 'blue' | 'red';
export type MatchStatus = 'open' | 'active' | 'host_won' | 'guest_won' | 'abandoned';

/** A `matches` row as the service role reads it. */
export interface MatchRow {
  id: string;
  host_player: string;
  guest_player: string | null;
  host_name: string | null;
  guest_name: string | null;
  guest_bot: boolean;
  initial_state: OnlineGameState;
  latest_state: OnlineGameState;
  current_round: number;
  status: MatchStatus;
  rules: number;
  ranked: boolean;
  matchmaking: boolean;
  last_move_at: string;
  abandon_after: string;
  [key: string]: unknown;
}

export interface User {
  id: string;
  /** A permanent account with a Google identity: needed for ranked play. */
  google: boolean;
}

/** A failed database call. `code` is the Postgres SQLSTATE when there is one. */
export class StoreError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}

export interface RefereeStore {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
  match(id: string): Promise<MatchRow | null>;
  plans(id: string, round: number): Promise<{ team: Team; paths: PathList }[]>;
  bot(player: string): Promise<{ difficulty: BotDifficulty } | null>;
}

export interface RefereeDeps {
  store: RefereeStore;
  /** Uniform in [0, 1); the Edge Function backs it with crypto. */
  random(): number;
  /** Send an alert after the response (best effort, never fails a move). */
  notify(alert: Alert): void;
  /** Run work after the response, e.g. an AI commander's catch-up move. */
  background(task: () => Promise<unknown>): void;
  /** Verify a Play Games authorization code; absent until ranked is set up. */
  playGames?: (code: unknown) => Promise<PlayGamesPlayer>;
}

export interface RefereeResponse {
  status: number;
  body: unknown;
}

class RequestError extends Error {
  constructor(message: string, readonly status: number, readonly extra: Record<string, unknown> = {}) { super(message); }
}

const ID = /^[a-z2-9]{6}$/;
const ID_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';
/** Waits before a searcher may call in an AI commander. Casual players may
 *  ask at once; ranked searches give humans a chance first. */
const BOT_WAIT_S = { casual: 0, ranked: 30 };
const UPDATE_APP = 'This version of 7 Seconds doesn’t match the online server. Reload or update the app to keep playing online.';
const IN_PLAY: MatchStatus[] = ['open', 'active'];

export function newMatchId(random: () => number): string {
  let id = '';
  for (let i = 0; i < 6; i++) id += ID_CHARS[Math.floor(random() * ID_CHARS.length)];
  return id;
}

/** A display name from untrusted input: printable, short, never posing as an AI. */
export function cleanName(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const name = value.normalize('NFC')
    .replace(/[\p{C}<>]/gu, '')
    .replace(/\(\s*ai\s*\)/gi, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 24)
    .trim();
  return name || null;
}

function teamOf(match: MatchRow, user: string): Team | null {
  return match.host_player === user ? 'blue' : match.guest_player === user ? 'red' : null;
}

function opponentName(match: MatchRow, team: Team): string | null {
  return team === 'blue' ? match.guest_name : match.host_name;
}

function versionMessage(match: MatchRow): string {
  return `This match was started on ${match.rules > RULES_VERSION ? 'a newer' : 'an older'} version of 7 Seconds and can’t be continued. It ended with no winner.`;
}

/** Map a store failure to the response the client sees. */
function storeFailure(error: unknown): RequestError {
  if (error instanceof RequestError) return error;
  if (error instanceof PlayGamesError) return new RequestError(error.message, error.transient ? 503 : 400);
  if (error instanceof StoreError) {
    if (error.code === 'P0001') return new RequestError(error.message, 409);
    if (/^(23\d{3}|22\d{3}|42501)$/.test(error.code ?? '')) return new RequestError(error.message, 400);
  }
  return new RequestError('The online server is unavailable right now. Try again.', 503);
}

export async function handleReferee(user: User | null, body: unknown, deps: RefereeDeps): Promise<RefereeResponse> {
  try {
    if (!user) throw new RequestError('Sign-in required', 401);
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new RequestError('Invalid request', 400);
    const referee = new Referee(user, body as Record<string, unknown>, deps);
    return { status: 200, body: await referee.run() };
  } catch (error) {
    const failure = storeFailure(error);
    if (failure.status === 503) console.error('match-referee failed', error);
    return { status: failure.status, body: { error: failure.message, ...failure.extra } };
  }
}

/** One request. */
class Referee {
  private readonly store: RefereeStore;

  constructor(private readonly user: User, private readonly body: Record<string, unknown>, private readonly deps: RefereeDeps) {
    this.store = deps.store;
  }

  async run(): Promise<unknown> {
    const { action } = this.body;
    if (typeof action !== 'string') throw new RequestError('Invalid request', 400);
    if (['create', 'join', 'matchmake', 'bot', 'submit'].includes(action) && this.body.rules !== RULES_VERSION) {
      throw new RequestError(UPDATE_APP, 426);
    }
    const ranked = ['profile', 'me', 'leaderboard', 'view', 'deleteProfile'].includes(action)
      || (action === 'matchmake' && this.body.ranked === true);
    if (ranked && !this.user.google) throw new RequestError('Ranked play needs a Google Play Games sign-in.', 401);

    switch (action) {
      case 'create': return this.create();
      case 'join': return this.join();
      case 'matchmake': return this.matchmake(ranked);
      case 'bot': return this.callBot();
      case 'submit': return this.submit();
      case 'advance': return this.advance();
      case 'forfeit': return this.forfeit();
      case 'cancel': return { match: await this.store.rpc<MatchRow>('seven_cancel', { actor: this.user.id, m_id: (await this.mine()).match.id }) };
      case 'profile': return this.profile();
      case 'me': return this.overview();
      case 'leaderboard': return this.store.rpc('seven_ranked_leaderboard', { actor: this.user.id });
      case 'view': return this.view();
      case 'deleteProfile':
        await this.store.rpc('seven_ranked_delete_profile', { actor: this.user.id });
        return { deleted: true };
      default: throw new RequestError('Unknown action', 400);
    }
  }

  // --- matches -------------------------------------------------------------

  private matchId(): string {
    const { id } = this.body;
    if (typeof id !== 'string' || !ID.test(id)) throw new RequestError('Invalid match id', 400);
    return id;
  }

  /** The caller's match and team. Matches on other rules are ended first. */
  private async mine(): Promise<{ match: MatchRow; team: Team }> {
    const match = await this.store.match(this.matchId());
    const team = match && teamOf(match, this.user.id);
    if (!match || !team) throw new RequestError('Match not found', 404);
    return { match, team };
  }

  /** Repeats insert attempts whose random id was already taken. */
  private async withFreshId(insert: (id: string) => Promise<MatchRow>): Promise<MatchRow> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await insert(newMatchId(() => this.deps.random()));
      } catch (error) {
        if (!(error instanceof StoreError) || error.code !== '23505' || attempt >= 4) throw error;
      }
    }
  }

  private initialState(): OnlineGameState {
    return GameEngine.generateInitialState();
  }

  private async create(): Promise<unknown> {
    const name = cleanName(this.body.name);
    const match = await this.withFreshId(id => this.store.rpc<MatchRow>('seven_create', {
      actor: this.user.id, m_id: id, p_rules: RULES_VERSION, initial: this.initialState(), p_name: name,
    }));
    return { match };
  }

  private async join(): Promise<unknown> {
    const id = this.matchId();
    const before = await this.store.match(id);
    if (!before || before.ranked || before.matchmaking) throw new RequestError('Match not found', 404);
    if (teamOf(before, this.user.id)) return { match: await this.ended(before) };
    if (before.rules !== RULES_VERSION) throw new RequestError(versionMessage(before), 409);
    const match = await this.store.rpc<MatchRow>('seven_join', { actor: this.user.id, m_id: id, p_name: cleanName(this.body.name) });
    this.alert(match, 'blue', 'joined');
    return { match };
  }

  private async matchmake(ranked: boolean): Promise<unknown> {
    const name = cleanName(this.body.name);
    const match = await this.withFreshId(id => this.store.rpc<MatchRow>('seven_matchmake', {
      actor: this.user.id, m_id: id, is_ranked: ranked, p_rules: RULES_VERSION, initial: this.initialState(), p_name: name,
    }));
    // Paired into someone's search just now: tell them, unless they've gone.
    if (match.guest_player === this.user.id && match.current_round === 1) this.alert(match, 'blue', 'joined');
    return { match };
  }

  /** The searcher calls in an AI commander. */
  private async callBot(): Promise<unknown> {
    const { match, team } = await this.mine();
    if (team !== 'blue' || !match.matchmaking) throw new RequestError('Only a search can call in an AI commander', 400);
    const difficulty = !match.ranked && (this.body.difficulty === 'recruit' || this.body.difficulty === 'veteran') ? this.body.difficulty : null;
    const wait = match.ranked ? BOT_WAIT_S.ranked : BOT_WAIT_S.casual;
    const seated = await this.store.rpc<MatchRow>('seven_seat_bot', { m_id: match.id, min_wait: `${wait} seconds`, p_difficulty: difficulty });
    return { match: await this.settle(seated) };
  }

  private async submit(): Promise<unknown> {
    const { match, team } = await this.mine();
    // seven_submit_plan settles an idle match itself.
    const current = await this.ended(match, false);
    if (!IN_PLAY.includes(current.status)) throw new RequestError('This match has finished', 409, { match: current });
    const round = this.body.round;
    if (!Number.isInteger(round)) throw new RequestError('Invalid round', 400);
    const plan = sanitizePlan(this.body.paths, current.latest_state, team);
    if (!plan) throw new RequestError('Invalid orders', 400);
    const result = await this.store.rpc<{ match: MatchRow; both: boolean; expired?: boolean }>('seven_submit_plan', {
      actor: this.user.id, m_id: current.id, p_round: round, p_paths: plan, p_name: current.ranked ? null : cleanName(this.body.name),
    });
    if (result.expired) throw new RequestError('This match passed its idle limit and has ended.', 409, { match: result.match });
    const settled = await this.settle(result.match);
    this.alertAfterMove(result.match, settled, team);
    return { match: settled };
  }

  /** Catch up on anything the server owes: an AI commander's move, a round
   *  whose plans are both in, an idle match to settle. Clients call this when
   *  they have waited a while; it is cheap when nothing is owed. */
  private async advance(): Promise<unknown> {
    const { match, team } = await this.mine();
    const current = await this.ended(match);
    const settled = await this.settle(current);
    this.alertAfterMove(current, settled, team);
    return { match: settled };
  }

  private async forfeit(): Promise<unknown> {
    const { match, team } = await this.mine();
    const ended = await this.store.rpc<MatchRow>('seven_forfeit', { actor: this.user.id, m_id: match.id });
    if (match.status === 'active' && ended.finish_reason === 'forfeit') this.alert(ended, team === 'blue' ? 'red' : 'blue', 'forfeit');
    return { match: ended };
  }

  /** End a match that can no longer be played: other rules, or idle too long. */
  private async ended(match: MatchRow, expire = true): Promise<MatchRow> {
    if (!IN_PLAY.includes(match.status)) return match;
    if (match.rules !== RULES_VERSION) {
      const voided = await this.store.rpc<MatchRow>('seven_finish', { m_id: match.id, winner: null, reason: 'version' });
      if (this.body.action === 'forfeit' || this.body.action === 'cancel') return voided;
      throw new RequestError(versionMessage(match), 409, { match: voided });
    }
    return expire ? this.store.rpc<MatchRow>('seven_expire_match', { m_id: match.id }) : match;
  }

  /** Do whatever the server owes this match, and return it as it now stands.
   *  An AI commander plans as soon as a round begins; a round is resolved as
   *  soon as both plans are in. */
  private async settle(match: MatchRow): Promise<MatchRow> {
    let current = match;
    for (let step = 0; step < 4 && current.status === 'active'; step++) {
      if (!isPlausibleGameState(current.latest_state)) {
        console.error(`match-referee: implausible state in ${current.id}`);
        return this.store.rpc<MatchRow>('seven_finish', { m_id: current.id, winner: null, reason: 'abandoned' });
      }
      const plans = await this.store.plans(current.id, current.current_round);
      if (plans.length === 2) {
        await this.resolve(current, plans);
      } else if (current.guest_bot && current.guest_player && !plans.some(p => p.team === 'red')) {
        await this.botPlans(current, current.guest_player);
      } else {
        break;
      }
      current = (await this.store.match(current.id)) ?? current;
    }
    return current;
  }

  private async botPlans(match: MatchRow, bot: string): Promise<void> {
    const difficulty = (await this.store.bot(bot))?.difficulty ?? 'veteran';
    const rng = createRng(Math.floor(this.deps.random() * 0x7fffffff));
    const paths = planBotPaths(match.latest_state, 'red', difficulty, rng);
    try {
      await this.store.rpc('seven_submit_plan', { actor: bot, m_id: match.id, p_round: match.current_round, p_paths: paths, p_name: null });
    } catch (error) {
      // Another request planned for the commander meanwhile.
      if (!(error instanceof StoreError && error.code === 'P0001')) throw error;
    }
  }

  private async resolve(match: MatchRow, plans: { team: Team; paths: PathList }[]): Promise<void> {
    const blue = plans.find(p => p.team === 'blue')!.paths;
    const red = plans.find(p => p.team === 'red')!.paths;
    // A fresh seed every round, published with the result: nobody can
    // rehearse a round against its exact random sequence in advance.
    const seed = Math.floor(this.deps.random() * 0x7fffffff);
    const { endState, gameOver } = GameEngine.resolveRound(match.latest_state, blue, red, seed, ROUND_TICKS);
    const winner = gameOver ? (blueAlive(endState) ? 'blue' : 'red') : null;
    await this.store.rpc<boolean>('seven_apply_round', { m_id: match.id, p_round: match.current_round, p_end: endState, p_seed: seed, p_winner: winner });
  }

  // --- alerts --------------------------------------------------------------

  /** Alert the human in `recipient`'s seat about `match` (never an AI commander). */
  private alert(match: MatchRow, recipient: Team, kind: Alert['kind'], extra: Partial<Alert> = {}): void {
    const player = recipient === 'blue' ? match.host_player : match.guest_player;
    if (!player || player === this.user.id || (recipient === 'red' && match.guest_bot)) return;
    this.deps.notify({ player, match: match.id, kind, ranked: match.ranked, opponent: opponentName(match, recipient), round: match.current_round, ...extra });
  }

  /** After the caller's move: the opponent hears that it's their turn, that
   *  the round was played, or how the match ended. */
  private alertAfterMove(before: MatchRow, after: MatchRow, team: Team): void {
    const other: Team = team === 'blue' ? 'red' : 'blue';
    if (after.status === 'host_won' || after.status === 'guest_won') {
      if (after.finish_reason === 'battle') this.alert(after, other, 'result', { won: (after.status === 'host_won') === (other === 'blue') });
    } else if (after.status === 'active' && after.current_round > before.current_round) {
      this.alert(after, other, 'round');
    } else if (after.status === 'active' && this.body.action === 'submit') {
      this.alert(after, other, 'turn');
    }
  }

  // --- ranked ----------------------------------------------------------------

  private async profile(): Promise<unknown> {
    if (!this.deps.playGames) throw new RequestError('Ranked play isn’t set up on this server yet.', 503);
    const player = await this.deps.playGames(this.body.serverAuthCode);
    const p = await this.store.rpc<Record<string, unknown>>('seven_ranked_profile', {
      actor: this.user.id, pgs_id: player.id, pgs_name: player.name, pgs_avatar: player.avatar,
    });
    const { display_name, avatar_url, rating, games, wins, losses, peak_rating } = p;
    return { profile: { display_name, avatar_url, rating, games, wins, losses, peak_rating } };
  }

  private async overview(): Promise<unknown> {
    const overview = await this.store.rpc<{ matches?: { id: string; state: string; opponent?: { bot?: boolean } | null }[] }>(
      'seven_ranked_overview', { actor: this.user.id });
    // Catch up on a move an AI commander still owes, e.g. after a failed run.
    for (const battle of overview.matches ?? []) {
      if (battle.state === 'their_turn' && battle.opponent?.bot) {
        this.deps.background(async () => {
          const match = await this.store.match(battle.id);
          if (match) await this.settle(match);
        });
      }
    }
    return overview;
  }

  private async view(): Promise<unknown> {
    const battle = await this.store.rpc<unknown>('seven_ranked_view', { actor: this.user.id, m_id: this.matchId() });
    if (!battle) throw new RequestError('Match not found', 404);
    return { battle };
  }
}
