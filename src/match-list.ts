import type { MatchSummary } from './online-async';
import type { MatchOutcome } from './online-async-core';

const LAST_MATCH_KEY = '7s-last-open-match';

export function rememberOpenMatch(id: string): void {
  try { localStorage.setItem(LAST_MATCH_KEY, id); } catch { /* storage unavailable */ }
}

export function lastOpenMatch(): string | null {
  try { return localStorage.getItem(LAST_MATCH_KEY); } catch { return null; }
}

interface MatchAction {
  status: string;
  detail: string;
  action: string;
}

const ACTIONS: Record<MatchOutcome, MatchAction> = {
  'your-turn': { status: 'Your turn', detail: 'Open the match to continue your turn.', action: 'Play turn' },
  'their-turn': { status: 'Waiting for their move', detail: 'Your move is saved. You can come back later.', action: 'View match' },
  'waiting-for-guest': { status: 'Waiting for a friend', detail: 'Your first move is saved. Send your friend the invite link.', action: 'Share invite' },
  'resolving': { status: 'Round ready', detail: 'Both moves are in. Open the match to play the round.', action: 'Play round' },
  'you-won': { status: 'You won', detail: 'This match is finished.', action: 'View result' },
  'you-lost': { status: 'You lost', detail: 'This match is finished.', action: 'View result' },
  'abandoned': { status: 'Match ended', detail: 'This match is no longer active.', action: 'View result' },
};

export function matchAction(summary: MatchSummary): MatchAction {
  if (summary.match.status === 'open' && summary.outcome === 'your-turn') {
    return { status: 'Invite a friend', detail: 'Share the link or plan your first move while you wait.', action: 'Invite & plan' };
  }
  return ACTIONS[summary.outcome];
}

export interface MatchGroup {
  title: string;
  matches: MatchSummary[];
  finished?: boolean;
}

/** Input is newest first. Keep the last visited live match within easy reach,
 *  then separate turns, waiting matches and history without duplicating rows. */
export function groupMatches(summaries: MatchSummary[], lastId: string | null): MatchGroup[] {
  const live = summaries.filter(s => s.match.status === 'open' || s.match.status === 'active');
  const resume = live.find(s => s.match.id === lastId) ?? live[0];
  const remaining = live.filter(s => s !== resume);
  return [
    { title: resume?.match.id === lastId ? 'Last opened' : 'Latest unfinished match', matches: resume ? [resume] : [] },
    { title: 'Your turn', matches: remaining.filter(s => s.outcome === 'your-turn' && s.match.status === 'active') },
    { title: 'Invites', matches: remaining.filter(s => s.match.status === 'open') },
    { title: 'Waiting & ready rounds', matches: remaining.filter(s => s.match.status === 'active' && s.outcome !== 'your-turn') },
    { title: 'Finished matches', matches: summaries.filter(s => !live.includes(s)), finished: true },
  ].filter(group => group.matches.length > 0);
}

export function renderMatches(container: HTMLElement, summaries: MatchSummary[], onOpen: (id: string) => void): void {
  container.replaceChildren();
  for (const group of groupMatches(summaries, lastOpenMatch())) {
    const section = document.createElement(group.finished ? 'details' : 'section');
    section.className = 'match-group';
    const heading = document.createElement(group.finished ? 'summary' : 'h3');
    heading.textContent = `${group.title}${group.finished ? ` (${group.matches.length})` : ''}`;
    section.appendChild(heading);
    for (const summary of group.matches) {
      const ui = matchAction(summary);
      const row = document.createElement('button');
      row.className = 'match-row';
      row.dataset.outcome = summary.outcome;
      const info = document.createElement('span');
      info.className = 'match-info';
      const label = document.createElement('span');
      label.className = 'match-label';
      label.textContent = `Match ${summary.match.id.toUpperCase()} · Round ${summary.match.currentRound}`;
      const status = document.createElement('strong');
      status.textContent = ui.status;
      const detail = document.createElement('span');
      detail.className = 'match-detail';
      detail.textContent = ui.detail;
      info.append(label, status, detail);
      const action = document.createElement('span');
      action.className = 'match-action';
      action.textContent = `${ui.action} →`;
      row.append(info, action);
      row.addEventListener('click', () => onOpen(summary.match.id));
      section.appendChild(row);
    }
    container.appendChild(section);
  }
}
