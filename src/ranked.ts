// Ranked play: an Elo ladder for Play Games players, Android app only. The
// RankedIdentity plugin signs in with Google and Play Games; that Google
// account gets its own Supabase session, separate from the anonymous casual
// one, and plays ranked matches through the same match referee. See docs/ranked.md.
import { Capacitor, registerPlugin } from '@capacitor/core';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';
import { SUPABASE_KEY, SUPABASE_URL } from './online';
import { callReferee, type OnlineSession } from './online-async';
import { RULES_VERSION } from './online-plan';

interface RankedIdentity {
  isAvailable(): Promise<{ available: boolean }>;
  signIn(): Promise<{ idToken: string; nonce: string; serverAuthCode: string }>;
}
const identity = registerPlugin<RankedIdentity>('RankedIdentity');

let client: SupabaseClient | undefined;
export function getRankedClient(): SupabaseClient {
  return client ??= createClient(SUPABASE_URL, SUPABASE_KEY, { auth: { storageKey: '7s-ranked-auth' } });
}

/** The signed-in ranked user, or null. Never signs in by itself: ranked
 *  sign-in is an explicit tap. */
async function rankedUserId(): Promise<string | null> {
  try {
    const { data: { session } } = await getRankedClient().auth.getSession();
    const user = session?.user;
    return user && !user.is_anonymous ? user.id : null;
  } catch { return null; }
}

export const rankedSession: OnlineSession = { client: getRankedClient, ensureUser: rankedUserId, ranked: true };

export interface RankedProfile {
  display_name: string; rating: number; games: number; wins: number; losses: number;
  avatar_url?: string | null;
  peak_rating?: number;
  /** Fewer than ten rated games: ratings move faster (K=40 instead of 32). */
  provisional?: boolean;
  /** Ladder position among rated players; ties share a rank. Null until the first rated result. */
  rank?: number | null;
  you?: boolean;
  /** An AI commander standing in when nobody else is searching. Never on the ladder. */
  bot?: boolean;
}
export type RankedBattleState = 'searching' | 'your_turn' | 'their_turn' | 'expired' | 'won' | 'lost' | 'abandoned';
export interface RankedBattle {
  id: string; status: string; team: 'blue' | 'red'; state: RankedBattleState; round: number;
  updated_at: string; matchmaking: boolean; opponent: RankedProfile | null; delta: number | null;
}
export interface RankedResult {
  match_id: string; opponent: string | null; won: boolean; delta: number;
  reason: 'battle' | 'forfeit' | 'timeout'; finished_at: string; rounds: number;
}
export interface RankedAccount { profile: RankedProfile | null; matches: RankedBattle[]; history: RankedResult[] }
export interface RankedLeaderboard { players: RankedProfile[]; you: RankedProfile | null }
/** One match from this player's side: who they face, what is at stake, and the rated outcome. */
export interface RankedMatchView {
  team: 'blue' | 'red'; status: string; expired: boolean;
  opponent: RankedProfile | null;
  stakes: { win: number; loss: number } | null;
  result: { won: boolean; reason: RankedResult['reason']; delta: number; rating: number; rank: number | null } | null;
}

// Ranks by rating. Everyone starts at 1200, a Sergeant.
const RANK_TITLES: ReadonlyArray<readonly [number, string]> = [
  [1850, 'Marshal'], [1700, 'General'], [1550, 'Colonel'], [1450, 'Major'], [1350, 'Captain'],
  [1250, 'Lieutenant'], [1150, 'Sergeant'], [1050, 'Corporal'],
];
export function rankTitle(rating: number): string {
  return RANK_TITLES.find(([min]) => rating >= min)?.[1] ?? 'Recruit';
}
/** The next title up and how many points it needs, or null for a Marshal. */
export function nextRank(rating: number): { title: string; needed: number } | null {
  const next = [...RANK_TITLES].reverse().find(([min]) => min > rating);
  return next ? { title: next[1], needed: next[0] - rating } : null;
}

/** "+16", "−12" (typographic minus) or "0". */
export function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : delta < 0 ? `−${-delta}` : '0';
}

/** Compact relative time for result lists. */
export function timeAgo(iso: string, now = Date.now()): string {
  const minutes = Math.floor((now - Date.parse(iso)) / 60000);
  if (!Number.isFinite(minutes)) return '';
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  if (minutes < 24 * 60) return `${Math.floor(minutes / 60)} h ago`;
  if (minutes < 30 * 24 * 60) return `${Math.floor(minutes / (24 * 60))} d ago`;
  return new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

export function battleStateLabel(battle: RankedBattle): string {
  switch (battle.state) {
    case 'searching': return 'Searching for an opponent';
    case 'your_turn': return `Your turn · round ${battle.round}`;
    case 'their_turn': return `Opponent planning · round ${battle.round}`;
    case 'expired': return 'Idle limit reached · settling';
    case 'won': return 'Victory';
    case 'lost': return 'Defeat';
    case 'abandoned': return 'Abandoned';
  }
}

export function resultHeadline(result: Pick<RankedResult, 'won' | 'reason'>): string {
  if (result.reason === 'forfeit') return result.won ? 'Won by concession' : 'Conceded';
  if (result.reason === 'timeout') return result.won ? 'Won on time' : 'Lost on time';
  return result.won ? 'Victory' : 'Defeat';
}

export function resultLabel(result: RankedResult): string {
  return `${resultHeadline(result)} vs ${result.opponent ?? 'a former commander'} · ${formatDelta(result.delta)}`;
}

export function profileSummary(profile: RankedProfile): string {
  const parts = [`${rankTitle(profile.rating)} · ${profile.rating} Elo`];
  if (profile.rank) parts.push(`#${profile.rank}`);
  parts.push(`${profile.wins}W ${profile.losses}L`);
  if (profile.peak_rating && profile.peak_rating > profile.rating) parts.push(`peak ${profile.peak_rating}`);
  return parts.join(' · ');
}

/** The line shown during a ranked match. Kept short for phones. */
export function rankedMatchNote(view: RankedMatchView | null): { text: string; tone: 'win' | 'loss' | null } {
  if (view?.result) {
    const { delta, rating, rank } = view.result;
    return { tone: view.result.won ? 'win' : 'loss',
      text: `${resultHeadline(view.result)} · ${formatDelta(delta)} Elo · now ${rating} (${rankTitle(rating)}${rank ? `, #${rank}` : ''})` };
  }
  if (view?.status === 'abandoned') return { tone: null, text: 'Ranked · Abandoned · no rating change' };
  if (view && view.status !== 'open' && view.status !== 'active') return { tone: null, text: 'Ranked · Match over · rating updating…' };
  if (view?.expired) return { tone: null, text: 'Ranked · Idle limit reached · settling' };
  const opponent = view?.opponent;
  if (!opponent) return { tone: null, text: 'Ranked · Wins and losses change your Elo' };
  const stakes = view.stakes ? ` · Win ${formatDelta(view.stakes.win)} / Loss ${formatDelta(view.stakes.loss)}` : '';
  return { tone: null, text: `Ranked${stakes} · vs ${opponent.display_name} (${opponent.rating})` };
}

export async function rankedAvailable(): Promise<boolean> {
  if (Capacitor.getPlatform() !== 'android' || !Capacitor.isPluginAvailable('RankedIdentity')) return false;
  try { return (await identity.isAvailable()).available; } catch { return false; }
}

export async function rankedSignedIn(): Promise<boolean> {
  return (await rankedUserId()) != null;
}

export class RankedError extends Error {
  /** `outdated`: the server runs other rules, so the app must be reloaded or updated (HTTP 426). */
  constructor(message: string, readonly retryable: boolean, readonly outdated = false) { super(message); }
}

/** A ranked read or account action (not a match move; those go through the
 *  match controller). Profile linking gets longer: the server makes several
 *  Google calls, and timing out after it linked the single-use code would
 *  force another sign-in. */
export async function rankedRequest<T>(action: string, params: Record<string, unknown> = {}): Promise<T> {
  const slow = action === 'profile' || action === 'deleteProfile';
  const { data, error } = await getRankedClient().functions.invoke('match-referee', {
    body: { action, rules: RULES_VERSION, ...params }, timeout: slow ? 60_000 : 20_000,
  });
  if (!error) return data as T;
  const response = (error as { context?: unknown }).context instanceof Response ? (error as { context: Response }).context : null;
  let message = 'Ranked play is unavailable. Check your connection and try again.';
  if (response) {
    const body = await response.clone().json().catch(() => null) as { error?: unknown } | null;
    if (typeof body?.error === 'string') message = body.error;
  }
  throw new RankedError(message, !response || response.status >= 500 || response.status === 429, response?.status === 426);
}

export async function signInRanked(): Promise<RankedProfile> {
  if (!await rankedAvailable()) throw new Error('Ranked play needs the 7 Seconds app from Google Play. Update it if Ranked is unavailable.');
  const { idToken, nonce, serverAuthCode } = await identity.signIn();
  const { error } = await getRankedClient().auth.signInWithIdToken({ provider: 'google', token: idToken, nonce });
  if (error) throw new Error('Google sign-in failed. Please try again.');
  // A Play Games code is single-use: never automatically retry this exchange.
  const { profile } = await rankedRequest<{ profile: RankedProfile }>('profile', { serverAuthCode });
  return profile;
}

export async function signOutRanked(): Promise<void> {
  await getRankedClient().auth.signOut().catch(() => {});
}

/** Find a ranked opponent (or open a search the next player joins). */
export const findRankedMatch = () => callReferee(rankedSession, 'matchmake', { ranked: true });
