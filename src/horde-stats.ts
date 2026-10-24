/** Local Horde record: best wave reached, best score, runs and full clears. */

export interface HordeRecord {
  /** Most waves cleared in a single run. */
  bestWave: number;
  bestScore: number;
  runs: number;
  /** Runs that cleared all scripted waves. */
  clears: number;
}

const KEY = '7s-horde-stats';

function empty(): HordeRecord {
  return { bestWave: 0, bestScore: 0, runs: 0, clears: 0 };
}

export function getHordeRecord(): HordeRecord {
  try {
    const parsed = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<HordeRecord>;
    return parsed && typeof parsed === 'object' ? { ...empty(), ...parsed } : empty();
  } catch {
    return empty();
  }
}

function save(record: HordeRecord): HordeRecord {
  try { localStorage.setItem(KEY, JSON.stringify(record)); } catch { /* unavailable */ }
  return record;
}

export function recordHordeRunStart(): HordeRecord {
  const record = getHordeRecord();
  record.runs++;
  return save(record);
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
