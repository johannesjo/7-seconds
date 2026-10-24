/** Daily challenge: one map, army and battle seed per calendar day, the same
 *  for every player, with a shareable result. */
import type { UnitType } from './types';
import { createRng } from './rng';
import { generateRandomComposition } from './units';
import { BATTLEFIELD_LAYOUT_COUNT } from './battlefield';

export interface DailyChallenge {
  /** Local calendar date, YYYY-MM-DD. */
  date: string;
  /** Running challenge number shown when sharing. */
  number: number;
  seed: number;
  layoutIndex: number;
  composition: { type: UnitType; count: number }[];
}

export interface DailyResult {
  date: string;
  won: boolean;
  rounds: number;
  survivors: number;
  total: number;
}

interface DailyRecord {
  /** First finished attempt of each day — the one that counts and gets shared. */
  results: DailyResult[];
}

const KEY = '7s-daily';
const FIRST_DAY_UTC = Date.UTC(2026, 0, 1);
const DAY_MS = 86_400_000;
/** Enough history for a long streak without growing storage forever. */
const MAX_RESULTS = 400;

export function localDateKey(now = new Date()): string {
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${now.getFullYear()}-${m}-${d}`;
}

function dayIndex(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - FIRST_DAY_UTC) / DAY_MS);
}

function hashString(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function getDailyChallenge(now = new Date()): DailyChallenge {
  const date = localDateKey(now);
  const seed = hashString(`7s-daily-${date}`) & 0x7fffffff;
  const rng = createRng(seed);
  return {
    date,
    number: dayIndex(date) + 1,
    seed,
    layoutIndex: Math.floor(rng() * BATTLEFIELD_LAYOUT_COUNT),
    composition: generateRandomComposition(rng),
  };
}

function load(): DailyRecord {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '') as DailyRecord;
    if (Array.isArray(parsed?.results)) return parsed;
  } catch { /* missing or corrupt */ }
  return { results: [] };
}

export function getDailyResult(date: string): DailyResult | null {
  return load().results.find(r => r.date === date) ?? null;
}

/** Store the day's first finished attempt; later attempts are practice.
 *  Returns whether this attempt is the one that counts. */
export function recordDailyResult(result: DailyResult): boolean {
  const record = load();
  if (record.results.some(r => r.date === result.date)) return false;
  record.results.push(result);
  record.results = record.results.slice(-MAX_RESULTS);
  try { localStorage.setItem(KEY, JSON.stringify(record)); } catch { /* unavailable */ }
  return true;
}

/** Consecutive days won, ending today (or yesterday while today is unplayed). */
export function getDailyStreak(today: string): number {
  const results = load().results;
  const won = new Set(results.filter(r => r.won).map(r => dayIndex(r.date)));
  let day = dayIndex(today);
  if (!results.some(r => r.date === today)) day--;
  let streak = 0;
  while (won.has(day)) {
    streak++;
    day--;
  }
  return streak;
}

export function formatDailyShare(challenge: DailyChallenge, result: DailyResult, url: string): string {
  const squares = '🟦'.repeat(result.survivors) + '⬛'.repeat(Math.max(0, result.total - result.survivors));
  const rounds = `${result.rounds} round${result.rounds === 1 ? '' : 's'}`;
  const verdict = result.won ? `🏆 Won in ${rounds}` : `💀 Lost in ${rounds}`;
  return `7 Seconds Daily #${challenge.number}\n${verdict}\n${squares} ${result.survivors}/${result.total} survived\n${url}`;
}
