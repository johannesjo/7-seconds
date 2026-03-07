const SCORE_KEY = '7s-online-scores';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns true if the given string is a valid UUID v4 format. */
export function isValidPlayerId(id: string): boolean {
  return UUID_RE.test(id);
}

export interface PlayerScore {
  wins: number;
  losses: number;
}

type ScoreMap = Record<string, PlayerScore>;

function loadScores(): ScoreMap {
  try {
    const raw = localStorage.getItem(SCORE_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveScores(scores: ScoreMap): void {
  localStorage.setItem(SCORE_KEY, JSON.stringify(scores));
}

export function recordWin(opponentId: string): void {
  const scores = loadScores();
  if (!scores[opponentId]) scores[opponentId] = { wins: 0, losses: 0 };
  scores[opponentId].wins++;
  saveScores(scores);
}

export function recordLoss(opponentId: string): void {
  const scores = loadScores();
  if (!scores[opponentId]) scores[opponentId] = { wins: 0, losses: 0 };
  scores[opponentId].losses++;
  saveScores(scores);
}

export function getScore(opponentId: string): PlayerScore {
  const scores = loadScores();
  return scores[opponentId] ?? { wins: 0, losses: 0 };
}
