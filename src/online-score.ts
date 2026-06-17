const SCORE_KEY = '7s-online-scores';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Returns true if the given string is a valid UUID v4 format. */
export function isValidPlayerId(id: string): boolean {
  return UUID_RE.test(id);
}

interface PlayerScore {
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
  try {
    localStorage.setItem(SCORE_KEY, JSON.stringify(scores));
  } catch { /* localStorage unavailable */ }
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

const SCORED_KEY = '7s-scored-matches';

/** Record a finished match's result at most once. Async game-over can re-fire
 *  whenever a decided match is reopened (e.g. from "My Matches"), so we key on
 *  the durable match id and skip any match already scored. */
export function recordMatchResultOnce(matchId: string, opponentId: string, won: boolean): void {
  if (!isValidPlayerId(opponentId)) return;
  let scored: string[];
  try {
    const parsed = JSON.parse(localStorage.getItem(SCORED_KEY) ?? '[]');
    scored = Array.isArray(parsed) ? parsed : []; // tolerate a corrupted value
  } catch { scored = []; }
  if (scored.includes(matchId)) return;
  if (won) recordWin(opponentId); else recordLoss(opponentId);
  try { localStorage.setItem(SCORED_KEY, JSON.stringify([...scored, matchId])); } catch { /* unavailable */ }
}

export function getScore(opponentId: string): PlayerScore {
  const scores = loadScores();
  return scores[opponentId] ?? { wins: 0, losses: 0 };
}

/** Sum wins/losses across all opponents for an overall record. */
export function getOverallScore(): PlayerScore {
  const scores = loadScores();
  let wins = 0;
  let losses = 0;
  for (const s of Object.values(scores)) {
    wins += s.wins;
    losses += s.losses;
  }
  return { wins, losses };
}
