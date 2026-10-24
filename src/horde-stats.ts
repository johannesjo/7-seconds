/** Local Horde record: best wave reached, best score and full clears. */

export interface HordeRecord {
  /** Most waves cleared in a single run. */
  bestWave: number;
  bestScore: number;
  /** Runs that cleared all scripted waves. */
  clears: number;
}

const KEY = '7s-horde-stats';

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

export function getHordeRecord(): HordeRecord {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Record<keyof HordeRecord, unknown>> | null;
    return { bestWave: count(parsed?.bestWave), bestScore: count(parsed?.bestScore), clears: count(parsed?.clears) };
  } catch {
    return { bestWave: 0, bestScore: 0, clears: 0 };
  }
}

function save(record: HordeRecord): HordeRecord {
  try { localStorage.setItem(KEY, JSON.stringify(record)); } catch { /* unavailable */ }
  return record;
}

/** Saved after every cleared wave, so a run abandoned mid-way still counts. */
export function recordHordeProgress(wavesCleared: number, score: number): HordeRecord {
  const record = getHordeRecord();
  record.bestWave = Math.max(record.bestWave, wavesCleared);
  record.bestScore = Math.max(record.bestScore, score);
  return save(record);
}

export function recordHordeClear(): HordeRecord {
  const record = getHordeRecord();
  record.clears++;
  return save(record);
}
