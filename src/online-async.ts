import { getSupabaseClient, generateRoomId } from './online';
import { ensureAuth } from './online-auth';
import { dlog } from './online-debug';
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

/** Commit step: store only the hash of our paths (paths column stays null). */
export async function commitTurn(
  id: string, round: number, team: AsyncTeam, paths: PathList,
): Promise<boolean> {
  const uid = await ensureAuth();
  if (!uid) return false;
  const client = getSupabaseClient();
  const { error } = await client.from('turns').insert({
    match_id: id,
    round,
    team,
    player: uid,
    commit_hash: hashPaths(paths),
  });
  if (error) {
    dlog(`async: commitTurn r${round}/${team} failed: ${error.message}`);
    return false;
  }
  return true;
}

/** Reveal step: fill in our paths once both sides have committed. */
export async function revealTurn(
  id: string, round: number, team: AsyncTeam, paths: PathList,
): Promise<boolean> {
  const client = getSupabaseClient();
  const { error } = await client
    .from('turns')
    .update({ paths, revealed_at: new Date().toISOString() })
    .eq('match_id', id)
    .eq('round', round)
    .eq('team', team);
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

  let query = client.from('matches').update(patch).eq('id', id);
  if (update.expectedRound != null) query = query.eq('current_round', update.expectedRound);

  const { error } = await query;
  if (error) {
    dlog(`async: persistRoundResult ${id} failed: ${error.message}`);
    return false;
  }
  return true;
}

// --- realtime ------------------------------------------------------------

export interface MatchSubscription {
  onTurnChange: (turn: RoundTurn) => void;
  onMatchChange: (match: MatchRecord) => void;
}

/** Subscribe to Postgres changes for a match. When both players are online
 *  these fire within seconds; when one is away the rows simply wait. Returns
 *  an unsubscribe function. */
export function subscribeMatch(id: string, handlers: MatchSubscription): () => void {
  const client = getSupabaseClient();
  const channel = client
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
    .subscribe((status) => dlog(`async: match:${id} subscription ${status}`));

  return () => { client.removeChannel(channel); };
}
