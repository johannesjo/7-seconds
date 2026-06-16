import { getSupabaseClient, generateRoomId } from './online';
import { ensureAuth } from './online-auth';
import { dlog } from './online-debug';
import { withRetry } from './online-retry';
import type { OnlineGameState } from './online-types';
import type { AsyncTeam, PathList, TurnRecord } from './online-async-core';
import { hashPaths } from './online-async-core';

export type MatchStatus = 'open' | 'active' | 'host_won' | 'guest_won' | 'abandoned';

export interface MatchRecord {
  id: string;
  hostPlayer: string;
  guestPlayer: string | null;
  initialState: OnlineGameState;
  latestState: OnlineGameState;
  seed: number | null;
  currentRound: number;
  status: MatchStatus;
}

export interface RoundTurn extends TurnRecord {
  round: number;
  player: string;
}

/** Build a share link for an async match. Uses a distinct `amatch` param so
 *  async links are never confused with live `?join` WebRTC rooms. */
export function getAsyncShareUrl(id: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('amatch', id);
  url.searchParams.delete('join');
  url.searchParams.delete('relay');
  url.searchParams.delete('debug');
  return url.toString();
}

/** Read the async match id from the current URL, or null if absent. */
export function getAsyncJoinId(): string | null {
  return new URLSearchParams(window.location.search).get('amatch');
}

// --- row mapping ---------------------------------------------------------

interface MatchRow {
  id: string;
  host_player: string;
  guest_player: string | null;
  initial_state: OnlineGameState;
  latest_state: OnlineGameState;
  seed: number | null;
  current_round: number;
  status: MatchStatus;
}

function mapMatch(row: MatchRow): MatchRecord {
  return {
    id: row.id,
    hostPlayer: row.host_player,
    guestPlayer: row.guest_player,
    initialState: row.initial_state,
    latestState: row.latest_state,
    seed: row.seed,
    currentRound: row.current_round,
    status: row.status,
  };
}

interface TurnRow {
  round: number;
  team: AsyncTeam;
  player: string;
  commit_hash: number;
  paths: PathList | null;
}

function mapTurn(row: TurnRow): RoundTurn {
  return {
    round: row.round,
    team: row.team,
    player: row.player,
    commitHash: row.commit_hash,
    paths: row.paths,
  };
}

// --- match lifecycle -----------------------------------------------------

/** Create a new async match as host. Returns the record and share URL,
 *  or null if auth/DB is unavailable. */
export async function createAsyncMatch(
  initialState: OnlineGameState,
): Promise<{ match: MatchRecord; shareUrl: string } | null> {
  const uid = await ensureAuth();
  if (!uid) return null;

  const id = generateRoomId();
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('matches')
    .insert({
      id,
      host_player: uid,
      initial_state: initialState,
      latest_state: initialState,
      current_round: 1,
      status: 'open',
    })
    .select()
    .single();

  if (error || !data) {
    dlog(`async: createMatch failed: ${error?.message}`);
    return null;
  }
  dlog(`async: created match ${id}`);
  return { match: mapMatch(data as MatchRow), shareUrl: getAsyncShareUrl(id) };
}

export async function loadMatch(id: string): Promise<MatchRecord | null> {
  await ensureAuth();
  const client = getSupabaseClient();
  const { data, error } = await client.from('matches').select().eq('id', id).single();
  if (error || !data) {
    dlog(`async: loadMatch ${id} failed: ${error?.message}`);
    return null;
  }
  return mapMatch(data as MatchRow);
}

/** Join an open match as guest. If already a participant, just returns it. */
export async function joinAsyncMatch(id: string): Promise<MatchRecord | null> {
  const uid = await ensureAuth();
  if (!uid) return null;

  const existing = await loadMatch(id);
  if (!existing) return null;
  if (existing.hostPlayer === uid || existing.guestPlayer === uid) return existing;
  if (existing.guestPlayer) {
    dlog(`async: match ${id} already has a guest`);
    return null;
  }

  const client = getSupabaseClient();
  const { data, error } = await client
    .from('matches')
    .update({ guest_player: uid, status: 'active' })
    .eq('id', id)
    .is('guest_player', null)
    .select()
    .single();

  if (error || !data) {
    dlog(`async: joinMatch ${id} failed: ${error?.message}`);
    return null;
  }
  dlog(`async: joined match ${id} as guest`);
  return mapMatch(data as MatchRow);
}

/** Returns the match's turns, or null on a transient load failure (callers
 *  must treat null as "unknown", NOT as "no turns"). */
export async function fetchTurns(id: string): Promise<RoundTurn[] | null> {
  const client = getSupabaseClient();
  const { data, error } = await client
    .from('turns')
    .select()
    .eq('match_id', id)
    .order('round', { ascending: true });
  if (error || !data) {
    dlog(`async: fetchTurns ${id} failed: ${error?.message}`);
    return null;
  }
  return (data as TurnRow[]).map(mapTurn);
}

/** Filter a turn list down to a single round. */
export function turnsForRound(turns: RoundTurn[], round: number): RoundTurn[] {
  return turns.filter(t => t.round === round);
}

// --- commit / reveal -----------------------------------------------------

/** Commit step: store only the hash of our paths (paths column stays null).
 *
 *  Idempotent: a retried or double-fired commit (network flake, double-tap)
 *  must not read as failure just because the row already exists. We upsert with
 *  `ignoreDuplicates` (INSERT ... ON CONFLICT DO NOTHING, so an existing reveal
 *  is never clobbered), then read the slot back: a matching `commit_hash` —
 *  including a row we've since revealed — is success; a *different* hash under
 *  the same (match,round,team) slot is a real conflict we surface. */
export async function commitTurn(
  id: string, round: number, team: AsyncTeam, paths: PathList,
): Promise<boolean> {
  const uid = await ensureAuth();
  if (!uid) return false;
  const client = getSupabaseClient();
  const hash = hashPaths(paths);
  const ins = await withRetry(
    () => client.from('turns').upsert(
      { match_id: id, round, team, player: uid, commit_hash: hash },
      { onConflict: 'match_id,round,team', ignoreDuplicates: true },
    ),
    { label: `commitTurn r${round}/${team}` },
  );
  if (ins.error) {
    dlog(`async: commitTurn r${round}/${team} failed: ${ins.error.message}`);
    return false;
  }
  // Verify what's actually stored. ignoreDuplicates returns no row on conflict,
  // so this read is the source of truth for "did my commitment land".
  const check = await withRetry(
    () => client.from('turns').select('commit_hash')
      .eq('match_id', id).eq('round', round).eq('team', team).maybeSingle(),
    { label: `commitTurn verify r${round}/${team}` },
  );
  if (check.error || !check.data) {
    // Couldn't confirm (transient). The upsert itself reported no error, so
    // treat as committed rather than prompting a redraw the player already did.
    return true;
  }
  const stored = Number((check.data as { commit_hash: number | string }).commit_hash);
  if (stored === hash) return true;
  dlog(`async: commitTurn r${round}/${team} slot holds a different commitment (${stored} != ${hash})`);
  return false;
}

/** Reveal step: fill in our paths once both sides have committed. */
export async function revealTurn(
  id: string, round: number, team: AsyncTeam, paths: PathList,
): Promise<boolean> {
  const client = getSupabaseClient();
  const { error } = await withRetry(
    () => client
      .from('turns')
      .update({ paths, revealed_at: new Date().toISOString() })
      .eq('match_id', id)
      .eq('round', round)
      .eq('team', team),
    { label: `revealTurn r${round}/${team}` },
  );
  if (error) {
    dlog(`async: revealTurn r${round}/${team} failed: ${error.message}`);
    return false;
  }
  return true;
}

/** Persist the result of resolving a round: advance the snapshot/round, and
 *  set the match seed on round 1 and the final status when the game is over.
 *
 *  `expectedRound` applies optimistic concurrency — the update only lands while
 *  the row is still on that round, so a late or duplicate writer (both players
 *  resolve independently) can't clobber progress already made. */
export async function persistRoundResult(
  id: string,
  update: {
    latestState: OnlineGameState; currentRound: number;
    seed?: number; status?: MatchStatus; expectedRound?: number;
  },
): Promise<boolean> {
  const client = getSupabaseClient();
  const patch: Record<string, unknown> = {
    latest_state: update.latestState,
    current_round: update.currentRound,
  };
  if (update.seed != null) patch.seed = update.seed;
  if (update.status) patch.status = update.status;

  // `.select('id')` returns the rows the update actually touched. With the
  // optimistic `expectedRound` guard this is 0 rows when another client already
  // advanced the round — a *benign* lost race, not an error. Returning false
  // here lets the controller distinguish "my write landed" from "someone beat
  // me to it" and avoid re-deriving a divergent seed.
  const res = await withRetry(() => {
    let query = client.from('matches').update(patch).eq('id', id);
    if (update.expectedRound != null) query = query.eq('current_round', update.expectedRound);
    return query.select('id');
  }, { label: `persistRoundResult ${id}` });

  if (res.error) {
    dlog(`async: persistRoundResult ${id} failed: ${res.error.message}`);
    return false;
  }
  const rows = (res.data as unknown[] | null)?.length ?? 0;
  return rows > 0;
}

// --- realtime ------------------------------------------------------------

export interface MatchSubscription {
  onTurnChange: (turn: RoundTurn) => void;
  onMatchChange: (match: MatchRecord) => void;
}

/** Max channel reconnect attempts before we lean entirely on the safety-net
 *  poll. Kept small: the poll already guarantees liveness, so this is just to
 *  recover the low-latency push path opportunistically. */
const MAX_SUBSCRIBE_RETRIES = 5;

/** Subscribe to Postgres changes for a match. When both players are online
 *  these fire within seconds; when one is away the rows simply wait.
 *
 *  Self-healing: Realtime can drop the socket (sleep/resume, network change)
 *  and never recover on its own — the old code only logged the bad status, so a
 *  match could hang silently. Here a CHANNEL_ERROR / TIMED_OUT / CLOSED tears
 *  the channel down and re-subscribes with bounded backoff. The controller's
 *  safety-net poll is the ultimate guarantee; this just restores instant push.
 *  Returns an unsubscribe function. */
export function subscribeMatch(id: string, handlers: MatchSubscription): () => void {
  const client = getSupabaseClient();
  let channel: ReturnType<typeof client.channel> | null = null;
  let closed = false;
  let attempt = 0;
  let retryTimer: ReturnType<typeof setTimeout> | null = null;

  const connect = (): void => {
    if (closed) return;
    channel = client
      .channel(`match:${id}`)
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'turns', filter: `match_id=eq.${id}` },
        (payload) => {
          const row = payload.new as TurnRow;
          if (row?.round != null) handlers.onTurnChange(mapTurn(row));
        },
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'matches', filter: `id=eq.${id}` },
        (payload) => {
          const row = payload.new as MatchRow;
          if (row?.id) handlers.onMatchChange(mapMatch(row));
        },
      )
      .subscribe((status) => {
        dlog(`async: match:${id} subscription ${status}`);
        if (status === 'SUBSCRIBED') { attempt = 0; return; }
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
          scheduleReconnect();
        }
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
