/** Local vs-AI record per difficulty: wins, losses and win streaks. */
import type { Difficulty } from './game';

export interface AiRecord {
  wins: number;
  losses: number;
  streak: number;
  bestStreak: number;
}

const KEY = '7s-ai-stats';

type AllRecords = Partial<Record<Difficulty, AiRecord>>;

function empty(): AiRecord {
  return { wins: 0, losses: 0, streak: 0, bestStreak: 0 };
}

function load(): AllRecords {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as AllRecords;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function getAiRecord(difficulty: Difficulty): AiRecord {
  return { ...empty(), ...load()[difficulty] };
}

export function recordAiResult(difficulty: Difficulty, won: boolean): AiRecord {
  const all = load();
  const record = { ...empty(), ...all[difficulty] };
  if (won) {
    record.wins++;
    record.streak++;
    record.bestStreak = Math.max(record.bestStreak, record.streak);
  } else {
    record.losses++;
    record.streak = 0;
  }
  all[difficulty] = record;
  try { localStorage.setItem(KEY, JSON.stringify(all)); } catch { /* unavailable */ }
  return record;
}
