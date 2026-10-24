import type { SupabaseClient } from '@supabase/supabase-js';
import { getSupabaseClient } from './online';
import { ensureAuth } from './online-auth';
import { dlog } from './online-debug';
import { withRetry } from './online-retry';
import type { OnlineGameState } from './online-types';
import { RULES_VERSION, type PathList } from './online-plan';
import type { AsyncTeam, TurnRecord, MatchOutcome, FinishReason } from './online-async-core';
import { summariseMatch } from './online-async-core';

export type MatchStatus = 'open' | 'active' | 'host_won' | 'guest_won' | 'abandoned';

export interface MatchRecord {
  id: string;
  hostPlayer: string;
  guestPlayer: string | null;
  hostName: string | null;
  guestName: string | null;
  /** The guest seat is held by an AI commander. */
  guestBot: boolean;
  initialState: OnlineGameState;
  latestState: OnlineGameState;
  /** Start state and seed of the round before currentRound, to replay it. */
  prevState: OnlineGameState | null;
  prevSeed: number | null;
  currentRound: number;
  status: MatchStatus;
  finishReason: FinishReason | null;
  rules: number;
  ranked: boolean;
  matchmaking: boolean;
  updatedAt: string;
}

export interface RoundTurn extends TurnRecord {
  round: number;
  player: string;
}

/** Who this client plays online as: the anonymous casual guest, or the
 *  Google account signed in for ranked play. Each has its own session and
 *  sees only its own matches. */
export interface OnlineSession {
  client(): SupabaseClient;
  /** The signed-in user id, signing in if this session may do so by itself. */
  ensureUser(): Promise<string | null>;
  ranked: boolean;
}

export const casualSession: OnlineSession = {
  client: getSupabaseClient,
  ensureUser: ensureAuth,
  ranked: false,
};

/** Build a share link for an online match. */
export function getAsyncShareUrl(id: string, ranked = false): string {
  const url = new URL(window.location.href);
  url.searchParams.set('amatch', id);
  if (ranked) url.searchParams.set('ranked', '1');
  else url.searchParams.delete('ranked');
  url.searchParams.delete('join');
  url.searchParams.delete('relay');
  url.searchParams.delete('debug');
  return url.toString();
}

/** Read the match id (and whether it's ranked) from the current URL. */
export function getAsyncJoinId(): string | null {
  return new URLSearchParams(window.location.search).get('amatch');
}

// --- row mapping ---------------------------------------------------------

interface MatchRow {
  id: string;
  host_player: string;
  guest_player: string | null;
  host_name?: string | null;
  guest_name?: string | null;
  guest_bot?: boolean;
  initial_state: OnlineGameState;
  latest_state: OnlineGameState;
  prev_state?: OnlineGameState | null;
  prev_seed?: number | string | null;
  current_round: number;
  status: MatchStatus;
  finish_reason?: FinishReason | null;
  rules?: number;
  ranked?: boolean;
  matchmaking?: boolean;
  updated_at?: string;
}

export function mapMatch(row: MatchRow): MatchRecord {
  return {
    id: row.id,
    hostPlayer: row.host_player,
    guestPlayer: row.guest_player,
    hostName: row.host_name ?? null,
    guestName: row.guest_name ?? null,
    guestBot: row.guest_bot ?? false,
    initialState: row.initial_state,
    latestState: row.latest_state,
    prevState: row.prev_state ?? null,
    // bigint column: PostgREST may hand it back as a string.
    prevSeed: row.prev_seed == null ? null : Number(row.prev_seed),
    currentRound: row.current_round,
    status: row.status,
    finishReason: row.finish_reason ?? null,
    rules: row.rules ?? 1,
    ranked: row.ranked ?? false,
    matchmaking: row.matchmaking ?? false,
    updatedAt: row.updated_at ?? '',
  };
}

interface TurnRow {
  round: number;
  team: AsyncTeam;
  player: string;
  paths: PathList | null;
}

function mapTurn(row: TurnRow): RoundTurn {
  return { round: row.round, team: row.team, player: row.player, paths: row.paths };
}

// --- the referee ---------------------------------------------------------

/** The outcome of a referee request. `status` 0 is a network failure; 426
 *  means this client runs other rules than the server and must be updated. */
export type RefereeResult =
  | { ok: true; match: MatchRecord }
  | { ok: false; status: number; message: string; match?: MatchRecord };

const REFEREE_TIMEOUT_MS = 20_000;
/** Safe to repeat after a lost response: the referee treats a repeat as the
 *  same request. Creating an invite is not (it would make a second one). */
const REPEATABLE = new Set(['join', 'matchmake', 'bot', 'submit', 'advance', 'forfeit', 'cancel']);
const UNREACHABLE = 'Could not reach the online server. Check your connection and try again.';

async function invokeOnce(session: OnlineSession, body: Record<string, unknown>): Promise<RefereeResult & { transient?: boolean }> {
  let result;
  try {
    result = await session.client().functions.invoke('match-referee', { body, timeout: REFEREE_TIMEOUT_MS });
  } catch (error) {
    dlog(`referee: ${body.action} threw ${error}`);
    return { ok: false, status: 0, message: UNREACHABLE, transient: true };
  }
  const { data, error } = result;
  if (!error) {
    const row = (data as { match?: MatchRow } | null)?.match;
    return row ? { ok: true, match: mapMatch(row) } : { ok: false, status: 500, message: 'The online server sent an unexpected reply.' };
  }
  const response = (error as { context?: unknown }).context instanceof Response ? (error as { context: Response }).context : null;
  if (!response) return { ok: false, status: 0, message: UNREACHABLE, transient: true };
  const payload = await response.clone().json().catch(() => null) as { error?: unknown; match?: MatchRow } | null;
  const message = typeof payload?.error === 'string' ? payload.error : UNREACHABLE;
  dlog(`referee: ${body.action} -> ${response.status} ${message}`);
  return {
    ok: false, status: response.status, message,
    ...(payload?.match ? { match: mapMatch(payload.match) } : {}),
    transient: response.status >= 500 || response.status === 429,
  };
}

/** Call the match referee as `session`. Transient failures of repeatable
 *  actions are retried with backoff before they are reported. */
export async function callReferee(session: OnlineSession, action: string, params: Record<string, unknown> = {}, sleep = (ms: number) => new Promise(r => setTimeout(r, ms))): Promise<RefereeResult> {
  if (!await session.ensureUser()) return { ok: false, status: 401, message: 'Online play is unavailable right now.' };
  const body = { action, rules: RULES_VERSION, ...params };
  const attempts = REPEATABLE.has(action) ? 3 : 1;
  for (let attempt = 1; ; attempt++) {
    const { transient, ...result } = await invokeOnce(session, body);
    if (result.ok || !transient || attempt >= attempts) return result;
    await sleep(400 * 2 ** attempt + Math.random() * 200);
  }
}

/** Short names for the referee actions every match uses. */
export const referee = {
  create: (s: OnlineSession, name: string | null) => callReferee(s, 'create', { name }),
  join: (s: OnlineSession, id: string, name: string | null) => callReferee(s, 'join', { id, name }),
  matchmake: (s: OnlineSession, name: string | null) => callReferee(s, 'matchmake', { name, ranked: s.ranked }),
  bot: (s: OnlineSession, id: string, difficulty?: 'recruit' | 'veteran') => callReferee(s, 'bot', { id, difficulty }),
  submit: (s: OnlineSession, id: string, round: number, paths: PathList, name: string | null) => callReferee(s, 'submit', { id, round, paths, name }),
  advance: (s: OnlineSession, id: string) => callReferee(s, 'advance', { id }),
  forfeit: (s: OnlineSession, id: string) => callReferee(s, 'forfeit', { id }),
  cancel: (s: OnlineSession, id: string) => callReferee(s, 'cancel', { id }),
};

// --- reads (RLS: a player sees only their own matches) ---------------------

/** `missing`: no such match visible to this player (not theirs, or gone);
 *  `error`: the read failed and the answer is unknown. */
export type LoadResult = { kind: 'ok'; match: MatchRecord } | { kind: 'missing' } | { kind: 'error' };

export async function loadMatch(session: OnlineSession, id: string): Promise<LoadResult> {
  if (!await session.ensureUser()) return { kind: 'error' };
  const res = await withRetry(() => session.client().from('matches').select().eq('id', id).maybeSingle(), { label: `loadMatch ${id}` })
    .catch(() => null);
  if (!res || res.error) {
    dlog(`async: loadMatch ${id} failed: ${res?.error?.message ?? 'connection error'}`);
    return { kind: 'error' };
  }
  return res.data ? { kind: 'ok', match: mapMatch(res.data as MatchRow) } : { kind: 'missing' };
}

/** Returns the match's turns, or null on a transient load failure (callers
 *  must treat null as "unknown", NOT as "no turns"). */
export async function fetchTurns(session: OnlineSession, id: string): Promise<RoundTurn[] | null> {
  const res = await withRetry(
    () => session.client().from('turns').select('round, team, player, paths').eq('match_id', id).order('round', { ascending: true }),
    { label: `fetchTurns ${id}` },
  ).catch(() => null);
  if (!res || res.error || !res.data) {
    dlog(`async: fetchTurns ${id} failed: ${res?.error?.message ?? 'connection error'}`);
    return null;
  }
  return (res.data as TurnRow[]).map(mapTurn);
}

/** Filter a turn list down to a single round. */
export function turnsForRound(turns: RoundTurn[], round: number): RoundTurn[] {
  return turns.filter(t => t.round === round);
}

// --- "my matches" list ---------------------------------------------------

export interface MatchSummary {
  match: MatchRecord;
  iAmHost: boolean;
  outcome: MatchOutcome;
}

/** Load all live matches plus recent history for the signed-in casual player,
 *  each collapsed to a single player-facing outcome. Returns null on a
 *  transient failure (caller shows a retry, not "no matches"). */
export async function loadMyMatches(limit = 40, session: OnlineSession = casualSession): Promise<MatchSummary[] | null> {
  const uid = await session.ensureUser();
  if (!uid) return null;
  const client = session.client();

  const query = () => client.from('matches').select()
    .or(`host_player.eq.${uid},guest_player.eq.${uid}`)
    .order('updated_at', { ascending: false });
  // History must never push an older unfinished match out of the resume list.
  const results = await Promise.all([
    withRetry(() => query().in('status', ['open', 'active']), { label: 'loadMyMatches live' }),
    withRetry(() => query().in('status', ['host_won', 'guest_won', 'abandoned']).limit(limit), { label: 'loadMyMatches history' }),
  ]).catch(() => null);
  if (!results || results.some(res => res.error || !res.data)) {
    dlog('async: loadMyMatches failed');
    return null;
  }
  const matches = results.flatMap(res => (res.data as MatchRow[]).map(mapMatch));

  // Batch the current-round turns for in-play matches in one query (avoids N+1).
  const live = matches.filter(m => m.status === 'open' || m.status === 'active');
  const turnsByMatch = new Map<string, RoundTurn[]>();
  if (live.length > 0) {
    const tres = await withRetry(
      () => client.from('turns').select('match_id, round, team, player, paths').in('match_id', live.map(m => m.id)),
      { label: 'loadMyMatches turns' },
    ).catch(() => null);
    if (!tres || tres.error) {
      dlog(`async: loadMyMatches turns failed: ${tres?.error?.message ?? 'connection error'}`);
      return null;
    }
    for (const row of (tres.data as (TurnRow & { match_id: string })[] | null) ?? []) {
      const list = turnsByMatch.get(row.match_id) ?? [];
      list.push(mapTurn(row));
      turnsByMatch.set(row.match_id, list);
    }
  }

  return matches.map((m) => {
    const iAmHost = m.hostPlayer === uid;
    const roundTurns = (turnsByMatch.get(m.id) ?? []).filter(t => t.round === m.currentRound);
    return { match: m, iAmHost, outcome: summariseMatch(m.status, iAmHost, roundTurns, m.matchmaking) };
  });
}

// --- realtime ------------------------------------------------------------

/** Max channel reconnect attempts before we lean entirely on the safety-net
 *  poll. Kept small: the poll already guarantees liveness, so this is just to
 *  recover the low-latency push path opportunistically. */
const MAX_SUBSCRIBE_RETRIES = 5;

/** Subscribe to Postgres changes for a match. When both players are online
 *  these fire within seconds; when one is away the rows simply wait.
 *
 *  Self-healing: Realtime can drop the socket (sleep/resume, network change)
 *  and never recover on its own. A CHANNEL_ERROR / TIMED_OUT / CLOSED tears
 *  the channel down and re-subscribes with bounded backoff. The controller's
 *  safety-net poll is the ultimate guarantee; this just restores instant push.
 *  Returns an unsubscribe function. */
export function subscribeMatch(session: OnlineSession, id: string, onChange: () => void): () => void {
  const client = session.client();
  let channel: ReturnType<typeof client.channel> | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (closed) return;
    channel = client
      .channel(`match:${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'turns', filter: `match_id=eq.${id}` }, () => onChange())
      .on('postgres_changes', { event: '*', schema: 'public', table: 'matches', filter: `id=eq.${id}` }, () => onChange())
      .subscribe((status) => {
        dlog(`async: match:${id} subscription ${status}`);
        if (status === 'SUBSCRIBED') { attempt = 0; return; }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') scheduleReconnect();
      });
  };

  const scheduleReconnect = (): void => {
    if (closed || retryTimer || attempt >= MAX_SUBSCRIBE_RETRIES) return;
    const delay = Math.min(16_000, 1_000 * 2 ** attempt);
    attempt++;
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (channel) { void client.removeChannel(channel); channel = null; }
      connect();
    }, delay);
  };

  connect();

  return () => {
    closed = true;
    if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
    if (channel) { void client.removeChannel(channel); channel = null; }
  };
}
