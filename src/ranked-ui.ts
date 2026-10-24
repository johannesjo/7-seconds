// The Ranked screen: Play Games sign-in, the player's card, their ranked
// matches, recent results and the ladder. Rendered into #ranked-screen.
import {
  rankedRequest, signInRanked, signOutRanked, rankedSignedIn, rankTitle, nextRank, profileSummary,
  battleStateLabel, resultLabel, timeAgo, RankedError,
  type RankedAccount, type RankedLeaderboard, type RankedProfile,
} from './ranked';
import { forgetRankedDevice } from './turn-alerts';

export interface RankedScreenActions {
  /** Open one of the player's ranked matches (`searching`: nobody joined yet). */
  openMatch(id: string, searching: boolean): void;
  /** Start a ranked search. */
  findOpponent(): void;
  /** The screen was closed. */
  closed(): void;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Partial<HTMLElementTagNameMap[K]> & { className?: string } = {}, ...children: (Node | string | null)[]): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props);
  for (const child of children) if (child != null) node.append(child);
  return node;
}

function card(profile: RankedProfile): HTMLElement {
  const avatar = profile.avatar_url ? el('img', { src: profile.avatar_url, alt: '', className: 'ranked-avatar', referrerPolicy: 'no-referrer' }) : null;
  const next = nextRank(profile.rating);
  return el('div', { className: 'ranked-card' },
    avatar,
    el('div', { className: 'ranked-card-text' },
      el('strong', { textContent: profile.display_name }),
      el('span', { textContent: profileSummary(profile) }),
      el('span', { className: 'match-detail', textContent: profile.provisional
        ? `Provisional: your first ${10 - profile.games} rated match${10 - profile.games === 1 ? '' : 'es'} move your rating faster.`
        : next ? `${next.needed} points to ${next.title}.` : 'The highest rank there is.' })));
}

export class RankedScreen {
  private loadVersion = 0;

  constructor(private readonly root: HTMLElement, private readonly actions: RankedScreenActions) {
    root.addEventListener('keydown', event => { if (event.key === 'Escape') this.close(); });
  }

  get isOpen(): boolean { return this.root.style.display === 'block'; }

  close(): void {
    this.loadVersion++;
    this.root.style.display = 'none';
    this.actions.closed();
  }

  async open(): Promise<void> {
    this.root.style.display = 'block';
    await this.render();
  }

  private shell(status: string): { body: HTMLElement; status: HTMLElement } {
    const title = el('h2', { id: 'ranked-title', tabIndex: -1, textContent: 'Ranked' });
    const back = el('button', { textContent: 'Menu', onclick: () => this.close() });
    const statusEl = el('p', { className: 'ranked-status', textContent: status });
    statusEl.setAttribute('role', 'status');
    const body = el('div');
    this.root.replaceChildren(el('div', { className: 'matches-content' },
      el('div', { className: 'matches-header' }, title, back),
      el('p', { className: 'matches-intro', textContent: 'Random opponents, rated with Elo. Plan at your own pace: rounds play when both plans are in. If nobody is searching, an AI commander takes the seat.' }),
      statusEl, body));
    title.focus();
    return { body, status: statusEl };
  }

  private async render(): Promise<void> {
    const version = ++this.loadVersion;
    const { body, status } = this.shell('Loading…');
    if (!await rankedSignedIn()) {
      if (version !== this.loadVersion) return;
      this.renderSignIn(body, status);
      return;
    }
    let account: RankedAccount;
    let board: RankedLeaderboard | null = null;
    try {
      [account, board] = await Promise.all([
        rankedRequest<RankedAccount>('me'),
        rankedRequest<RankedLeaderboard>('leaderboard').catch(() => null),
      ]);
    } catch (error) {
      if (version !== this.loadVersion) return;
      status.textContent = error instanceof Error ? error.message : 'Ranked play is unavailable right now.';
      body.append(el('button', { textContent: 'Retry', onclick: () => { void this.render(); } }));
      if (error instanceof RankedError && !error.retryable && !error.outdated) body.append(this.signOutButton());
      return;
    }
    if (version !== this.loadVersion) return;
    if (!account.profile) {
      this.renderSignIn(body, status);
      return;
    }
    status.textContent = '';
    body.append(card(account.profile));
    body.append(el('div', { className: 'matches-toolbar' },
      el('button', { id: 'ranked-find-btn', textContent: 'Find ranked opponent', onclick: () => this.actions.findOpponent() }),
      el('button', { textContent: 'Refresh', onclick: () => { void this.render(); } })));

    if (account.matches.length > 0) {
      const section = el('section', { className: 'match-group' }, el('h3', { textContent: 'Your ranked matches' }));
      for (const battle of account.matches) {
        const vs = battle.opponent ? `vs ${battle.opponent.display_name} (${battle.opponent.rating})` : 'Waiting for an opponent';
        const row = el('button', { className: 'match-row', onclick: () => this.actions.openMatch(battle.id, battle.state === 'searching') },
          el('span', { className: 'match-info' },
            el('span', { className: 'match-label', textContent: vs }),
            el('strong', { textContent: battleStateLabel(battle) })),
          el('span', { className: 'match-action', textContent: battle.state === 'your_turn' ? 'Play →' : 'View →' }));
        row.dataset.outcome = battle.state === 'your_turn' ? 'your-turn' : battle.state;
        section.append(row);
      }
      body.append(section);
    }

    if (account.history.length > 0) {
      const list = el('ol', { className: 'ranked-list' });
      for (const result of account.history) {
        list.append(el('li', { className: result.won ? 'win' : 'loss' },
          el('span', { textContent: resultLabel(result) }),
          el('span', { className: 'match-detail', textContent: ` · ${timeAgo(result.finished_at)}` })));
      }
      body.append(el('section', { className: 'match-group' }, el('h3', { textContent: 'Recent results' }), list));
    }

    if (board) {
      const list = el('ol', { className: 'ranked-list ranked-ladder' });
      for (const player of board.players) {
        const item = el('li', {},
          el('span', { textContent: `#${player.rank ?? '–'} ${player.display_name}` }),
          el('span', { className: 'match-detail', textContent: ` · ${player.rating} · ${rankTitle(player.rating)} · ${player.wins}W ${player.losses}L` }));
        if (player.you) item.classList.add('you');
        list.append(item);
      }
      const section = el('details', { className: 'match-group' }, el('summary', { textContent: `Leaderboard (${board.players.length})` }), list);
      if (board.players.length === 0) section.append(el('p', { className: 'match-detail', textContent: 'Nobody is rated yet. Win a ranked match to top the ladder.' }));
      if (board.you && !board.players.some(p => p.you)) section.append(el('p', { className: 'match-detail', textContent: `You: ${profileSummary(board.you)}` }));
      body.append(section);
    }

    body.append(el('div', { className: 'matches-toolbar ranked-account' }, this.signOutButton(), el('button', {
      textContent: 'Delete ranked profile',
      onclick: async () => {
        if (!confirm('Delete your ranked profile? Unfinished ranked matches count as losses, and your rating and history are removed. This can’t be undone.')) return;
        status.textContent = 'Deleting…';
        try {
          await forgetRankedDevice();
          await rankedRequest('deleteProfile');
          await signOutRanked();
          status.textContent = 'Your ranked profile was deleted.';
          void this.render();
        } catch (error) {
          status.textContent = error instanceof Error ? error.message : 'Could not delete the profile. Try again.';
        }
      },
    })));
    body.append(el('p', { className: 'matches-note', textContent: 'Ranked uses your Play Games name and picture. Your Google account and email are never shown to other players.' }));
  }

  private signOutButton(): HTMLButtonElement {
    return el('button', {
      textContent: 'Sign out',
      onclick: async () => {
        await forgetRankedDevice();
        await signOutRanked();
        void this.render();
      },
    });
  }

  private renderSignIn(body: HTMLElement, status: HTMLElement): void {
    status.textContent = '';
    const button = el('button', { id: 'ranked-signin-btn', textContent: 'Sign in with Play Games' });
    button.onclick = async () => {
      button.disabled = true;
      status.textContent = 'Signing in…';
      try {
        await signInRanked();
        await this.render();
      } catch (error) {
        button.disabled = false;
        status.textContent = error instanceof Error ? error.message : 'Sign-in failed. Try again.';
      }
    };
    body.append(el('p', { className: 'match-detail', textContent: 'Sign in with Google Play Games to get a rating and appear on the leaderboard. Everyone starts at 1200.' }), button);
  }
}
