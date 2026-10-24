import { Renderer } from './renderer';
import { Capacitor } from '@capacitor/core';
import { notifyLocalTurn } from './notify';
import { GameEngine, type Difficulty } from './game';
import { createArmy, createMissionArmy, createUnitFromState } from './units';
import { generateBattlefield, generateHordeObstacles, generateHordeElevationZones } from './battlefield';
import { BattleResult, TurnPhase, Unit, Obstacle, ElevationZone, ReplayData, Team } from './types';
import { HORDE_MAX_WAVES, ROUND_DURATION_S, MAP_HEIGHT, SHIELD_MAX_HITS } from './constants';
import { HORDE_WAVES, pickUpgrades, healAllBlue, repositionBlueUnits, randomHordeStartingArmy, applyUpgradesToUnit } from './horde';
import { ReplayPlayer } from './replay';
import { DAY_THEME, NIGHT_THEME } from './theme';
import { AsyncGameController, sessionIO, type PlayRoundInput, type AsyncGameHooks } from './online-async-game';
import type { PathList, FinishReason } from './online-async-core';
import { outcomeNeedsYou } from './online-async-core';
import {
  referee, loadMatch, subscribeMatch, getAsyncJoinId, loadMyMatches, getAsyncShareUrl, casualSession,
  type MatchRecord, type OnlineSession, type RefereeResult,
} from './online-async';
import { currentUserId } from './online-auth';
import { initializeTurnNotifications, getTurnNotificationStatus, setTurnNotifications, closedAppAlerts } from './online-push';
import { showingMatch, openTurnAlertSettings } from './turn-alerts';
import { rememberOpenMatch, renderMatches } from './match-list';
import { getPlayerName, setPlayerName } from './player-name';
import { rankedSession, rankedAvailable, rankedSignedIn, rankedRequest, rankedMatchNote, findRankedMatch, type RankedMatchView } from './ranked';
import { RankedScreen } from './ranked-ui';
import './online-debug'; // side-effect: shows debug overlay when ?debug=1
import { OnlineGameState } from './online-types';
import { PathDrawer } from './path-drawer';
import { recordMatchResultOnce, getOverallScore } from './online-score';
import { createTutorialEncounter, TUTORIAL_LESSONS, tutorialObjectiveMet } from './tutorial';
import { audio } from './audio';
import { pulse, setHapticsEnabled } from './haptics';
import { getSettings, updateSettings, onSettingsChange, type Settings } from './settings';
import { getDailyChallenge, getDailyResult, recordDailyResult, getDailyStreak, formatDailyShare, type DailyChallenge } from './daily';
import { getAiRecord, recordAiResult } from './stats';
import { canRecordClips, startClipRecording, canShareClip, shareClip, downloadClip, type ClipRecording } from './clip';
import type { FeedbackCue } from './effects';

// DOM elements
const promptScreen = document.getElementById('prompt-screen')!;
const battleScreen = document.getElementById('battle-screen')!;
const resultScreen = document.getElementById('result-screen')!;

const battleBtn = document.getElementById('battle-btn')!;
const aiBtn = document.getElementById('ai-btn')!;
const tutorialBtn = document.getElementById('tutorial-btn')!;
const hordeBtn = document.getElementById('horde-btn')!;

const battleHud = document.getElementById('battle-hud')!;
const blueCountEl = document.getElementById('blue-count')!;
const redCountEl = document.getElementById('red-count')!;
const roundTimerEl = document.getElementById('round-timer')!;
const speedToggle = document.getElementById('speed-toggle') as HTMLButtonElement;

const planningOverlay = document.getElementById('planning-overlay')!;
const planningLabel = document.getElementById('planning-label')!;
const confirmBtn = document.getElementById('confirm-btn')!;
const planningInstructions = document.getElementById('planning-instructions')!;
const skipTutorialBtn = document.getElementById('skip-tutorial-btn')!;
const unitInfo = document.getElementById('unit-info')!;
const unitInfoTitle = document.getElementById('unit-info-title')!;
const unitInfoDescription = document.getElementById('unit-info-description')!;
const coverScreen = document.getElementById('cover-screen')!;
const countInEl = document.getElementById('count-in')!;
const roundCounterEl = document.getElementById('round-counter')!;

const winnerTextEl = document.getElementById('winner-text')!;
const winnerSubEl = document.getElementById('winner-sub')!;
const resultStatsEl = document.getElementById('result-stats')!;
const resultRecordEl = document.getElementById('result-record')!;
const shareResultBtn = document.getElementById('share-result-btn')!;
const clipBtn = document.getElementById('clip-btn') as HTMLButtonElement;
const roundBanner = document.getElementById('round-banner')!;
const roundBannerTitle = document.getElementById('round-banner-title')!;
const roundBannerDetail = document.getElementById('round-banner-detail')!;
const rematchBtn = document.getElementById('rematch-btn')!;
const retryEncounterBtn = document.getElementById('retry-encounter-btn')!;
const newBattleBtn = document.getElementById('new-battle-btn')!;
const replayBtn = document.getElementById('replay-btn')!;

const waveCounterEl = document.getElementById('wave-counter')!;
const upgradeScreen = document.getElementById('upgrade-screen')!;
const upgradeCardsEl = document.getElementById('upgrade-cards')!;
const upgradeReplayBtn = document.getElementById('upgrade-replay-btn') as HTMLButtonElement;

const dailyBtn = document.getElementById('daily-btn')!;
const dailyBadge = document.getElementById('daily-badge')!;
const aiRecordEl = document.getElementById('ai-record')!;
const difficultyButtons = [...document.querySelectorAll<HTMLButtonElement>('#difficulty-picker [data-difficulty]')];
const settingToggles = [...document.querySelectorAll<HTMLButtonElement>('.setting-toggle[data-setting]')];
const themeToggle = document.getElementById('theme-toggle')!;
const pixiContainer = document.getElementById('pixi-container')!;

const ctfAiBtn = document.getElementById('ctf-ai-btn')!;
const ctfPvpBtn = document.getElementById('ctf-pvp-btn')!;
const flagStatusEl = document.getElementById('flag-status')!;

// Replay controls
const replayOverlay = document.getElementById('replay-overlay')!;
const replayRestartBtn = document.getElementById('replay-restart-btn')!;
const replayPauseBtn = document.getElementById('replay-pause-btn')!;
const replayExitBtn = document.getElementById('replay-exit-btn')!;
const replayProgress = document.getElementById('replay-progress')!;
const replaySpeedToggle = document.getElementById('replay-speed-toggle') as HTMLButtonElement;

const exitGameBtn = document.getElementById('exit-game-btn')!;

// Online lobby elements
const onlineAsyncBtn = document.getElementById('online-async-btn')!;
const asyncNotify = document.getElementById('async-notify')!;
const asyncNotifyCb = document.getElementById('async-notify-cb') as HTMLInputElement;
const asyncNotifyHint = document.getElementById('async-notify-hint')!;
const asyncNotifyLabel = document.getElementById('async-notify-label')!;
const LOCAL_TURN_HINT = 'Keep this match open for alerts. Closing the app stops turn checks.';
const asyncFirstMoveBtn = document.getElementById('async-first-move-btn')!;
const asyncForfeitBtn = document.getElementById('async-forfeit-btn')!;
const asyncBackBtn = document.getElementById('async-back-btn')!;
const myMatchesBadge = document.getElementById('my-matches-badge')!;
const matchesScreen = document.getElementById('matches-screen')!;
const matchesStatus = document.getElementById('matches-status')!;
const matchesList = document.getElementById('matches-list')!;
const matchesBackBtn = document.getElementById('matches-back-btn')!;
const matchesNewBtn = document.getElementById('matches-new-btn')!;
const matchesRefreshBtn = document.getElementById('matches-refresh-btn') as HTMLButtonElement;
const onlineRandomBtn = document.getElementById('online-random-btn')!;
const onlineLobby = document.getElementById('online-lobby')!;
const onlineStatus = document.getElementById('online-status')!;
const onlineShareContainer = document.getElementById('online-share-container')!;
const onlineShareUrl = document.getElementById('online-share-url') as HTMLInputElement;
const onlineCopyBtn = document.getElementById('online-copy-btn')!;
const onlineCancelBtn = document.getElementById('online-cancel-btn')!;
const onlineSpinner = document.getElementById('online-spinner')!;
const onlineRecord = document.getElementById('online-record')!;

function showOnlineRecord(): void {
  const { wins, losses } = getOverallScore();
  if (wins === 0 && losses === 0) {
    onlineRecord.style.display = 'none';
    return;
  }
  onlineRecord.textContent = `Record: ${wins}W - ${losses}L`;
  onlineRecord.style.display = '';
}

function setOnlineStatus(text: string, showSpinner = false): void {
  onlineStatus.textContent = text;
  onlineSpinner.style.display = showSpinner ? 'block' : 'none';
}

const UNIT_ROLES: Record<Unit['type'], string> = {
  soldier: 'Balanced ranged fighter. Keep enemies within its firing circle.',
  sniper: 'Long range and heavy damage, but fragile. Protect it behind your frontline.',
  blade: 'Builds speed and damage while charging. Sharp turns slow it down.',
  shielder: 'Blocks frontal shots. Its sides and rear are exposed.',
  zombie: 'Slow melee attacker. Must get close to deal damage.',
  bomber: 'Explodes when killed, hurting both teams. Keep your units clear.',
  mortar: 'Lobs shells over cover at where enemies stand. Can’t fire inside its dashed red ring. Keep moving to dodge its blasts.',
  rocketeer: 'No gun: drag from its orange rocket icon to draw the rocket’s flight. It launches when the rocketeer reaches the end of its path.',
};

/** How long a unit tip stays fully opaque before fading so it can't hide the board. */
const UNIT_INFO_FADE_MS = 1800;
let unitInfoFadeTimer: number | undefined;

function showUnitInfo(unit: Unit | null): void {
  unitInfo.hidden = !unit;
  window.clearTimeout(unitInfoFadeTimer);
  unitInfo.classList.remove('faded');
  if (!unit) return;
  unitInfoFadeTimer = window.setTimeout(() => unitInfo.classList.add('faded'), UNIT_INFO_FADE_MS);
  unitInfoTitle.textContent = `${unit.type[0].toUpperCase()}${unit.type.slice(1)}`;
  unitInfoTitle.style.color = unit.team === 'blue' ? 'var(--color-planning-blue)' : 'var(--color-planning-red)';
  let description = UNIT_ROLES[unit.type];
  if (unit.type === 'shielder') {
    const remaining = Math.max(0, SHIELD_MAX_HITS - (unit.shieldHits ?? 0));
    description = remaining > 0
      ? `Blocks ${remaining} more frontal hit${remaining === 1 ? '' : 's'}. Its sides and rear are exposed.`
      : 'Shield broken. Now vulnerable from every direction.';
  }
  unitInfoDescription.textContent = description;
  unitInfo.dataset.placement = unit.pos.y >= MAP_HEIGHT / 2 ? 'top' : 'bottom';
}

const toastEl = document.getElementById('toast')!;
let toastTimer: number | undefined;
/** Transient in-app banner that auto-dismisses. Used for the "it's your turn"
 *  cue while the app is focused. */
function showToast(message: string): void {
  toastEl.textContent = message;
  toastEl.style.opacity = '1';
  toastEl.style.transform = 'translateX(-50%) translateY(0)';
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    toastEl.style.opacity = '0';
    toastEl.style.transform = 'translateX(-50%) translateY(20px)';
  }, 3500);
}

// State
let renderer: Renderer | null = null;
let engine: GameEngine | null = null;
let aiMode = false;
let tutorialLesson: number | null = null;
let tutorialPassed = false;
let tutorialFinished = false;
const TUTORIAL_SEEN_KEY = '7s-tutorial-seen';

function tutorialSeen(): boolean {
  try { return localStorage.getItem(TUTORIAL_SEEN_KEY) !== null; } catch { return true; }
}

function markTutorialSeen(): void {
  try { localStorage.setItem(TUTORIAL_SEEN_KEY, '1'); } catch { /* storage unavailable */ }
}
let retryEncounter: { state: OnlineGameState; seed: number } | null = null;
let canRetryEncounter = false;
/** The current vs-AI battle is a retry of an earlier one: practice, not stats. */
let playingRetry = false;
/** Set while the day's challenge is being played. */
let dailyChallenge: DailyChallenge | null = null;
let currentRound = 1;
let roundStartCounts: { blue: number; red: number } | null = null;
let lastTickSecond: number | null = null;
let clipRecording: ClipRecording | null = null;
/** A recorded clip waiting for a tap on "Share clip" (sharing needs a fresh gesture). */
let readyClip: Blob | null = null;
/** A vs-AI or daily battle whose first fight has started but has no recorded
 *  result yet. Leaving it counts as a loss, so quitting can't dodge one. */
let trackedBattleLive = false;

const DIFFICULTY_KEY = '7s-difficulty';
const DIFFICULTY_LABELS: Record<Difficulty, string> = { easy: 'Easy', normal: 'Normal', hard: 'Hard' };
let difficulty: Difficulty = (() => {
  try {
    const saved = localStorage.getItem(DIFFICULTY_KEY);
    if (saved === 'easy' || saved === 'normal' || saved === 'hard') return saved;
  } catch { /* unavailable */ }
  return 'normal';
})();

// Horde state
let hordeActive = false;
let ctfActive = false;
let ctfHotseat = false;
let hordeWave = 0;
let hordeUnits: Unit[] = [];
let hordeMap: { obstacles: Obstacle[]; elevationZones: ElevationZone[] } | null = null;
let hordeAppliedUpgrades = new Map<string, number>();

// Online state. `onlineActive` flags an online flow in progress (a search or
// an online match), so the search can be cancelled. The playback* state is the
// local player's board: drawn during planning and animated by the headless
// engine when a played round is shown.
let onlineActive = false;
/** Where "Back" goes after an online match: the friend-match hub or Ranked. */
let returnTo: 'matches' | 'ranked' | null = null;
let asyncStartVersion = 0;
let playbackPathDrawer: PathDrawer | null = null;
let playbackUnits: Unit[] = [];
let playbackElevationZones: ElevationZone[] = [];
let playbackEngine: GameEngine | null = null;
let playbackEffectIndex = 0;

// Async ("play-by-mail") state
let asyncController: AsyncGameController | null = null;
let asyncMyTeam: 'blue' | 'red' = 'blue';
let asyncCurrentRound = 1;
/** Set by the playback engine's 'end' event (a side was eliminated). */
let asyncMatchEnded = false;
/** Guards the per-round playback finish so it runs exactly once. */
let asyncRoundFinished = false;
/** The session the current online match is played as (casual or ranked). */
let asyncSession: OnlineSession = casualSession;

// Replay state
let replayPlayer: ReplayPlayer | null = null;
let lastReplayData: ReplayData | null = null;
let returnToScreen: 'result' | 'horde-upgrade' = 'result';

// Recorder module — lazy-loaded only when ?record is in the URL
let recorderMod: typeof import('./recorder') | null = null;
if (new URLSearchParams(location.search).has('record')) {
  import('./recorder').then(m => { recorderMod = m; m.init(); });
}

function showScreen(screen: 'prompt' | 'battle' | 'result' | 'horde-upgrade') {
  document.body.classList.toggle('screen-prompt', screen === 'prompt');
  if (screen !== 'battle') audio.setMood('calm');
  if (screen === 'prompt') refreshMenuMeta();
  if (screen === 'battle') readyClip = null;
  if (screen === 'result') {
    clipBtn.style.display = lastReplayData && canRecordClips() ? '' : 'none';
    clipBtn.textContent = readyClip ? 'Share recorded clip' : 'Share clip';
  }
  promptScreen.classList.toggle('active', screen === 'prompt');
  battleScreen.classList.add('active'); // always visible once initialized
  resultScreen.classList.toggle('active', screen === 'result');
  upgradeScreen.style.display = screen === 'horde-upgrade' ? 'flex' : 'none';
  retryEncounterBtn.style.display = screen === 'result' && canRetryEncounter ? '' : 'none';
}

/** Fill the result card's heading and clear extras from a previous result. */
function setResultHeading(title: string, subtitle: string, color: string): void {
  winnerTextEl.textContent = title;
  winnerSubEl.textContent = subtitle;
  winnerTextEl.style.color = color;
  resultRecordEl.textContent = '';
  shareResultBtn.style.display = 'none';
}

function teamColor(team: Team): string {
  return team === 'blue' ? 'var(--color-result-blue)' : 'var(--color-result-red)';
}

function applyTheme(): void {
  const day = getSettings().dayMode;
  document.body.classList.toggle('day-mode', day);
  renderer?.setTheme(day ? DAY_THEME : NIGHT_THEME);
}

/** Sound, vibration and camera shake for gameplay moments (live and replays). */
function handleFeedbackCue(cue: FeedbackCue): void {
  const shake = !getSettings().reducedMotion;
  switch (cue.type) {
    case 'shot':
      audio.play(cue.heavy ? 'heavy-shot' : 'shot');
      break;
    case 'launch':
      audio.play(cue.weapon === 'shell' ? 'mortar' : 'rocket');
      break;
    case 'hit':
      audio.play('hit', cue.damage / 15);
      break;
    case 'kill':
      audio.play('kill');
      pulse('medium');
      if (shake) renderer?.shake(3);
      break;
    case 'explosion':
      audio.play('explosion', cue.radius / 60);
      pulse('heavy');
      if (shake) renderer?.shake(Math.min(10, cue.radius / 8));
      break;
    case 'shield-break':
      audio.play('shield-break');
      pulse('light');
      break;
  }
}

/** How long the between-round card stays up (matches its CSS animation). */
const ROUND_BANNER_MS = 1600;
let roundBannerTimer: number | undefined;

/** Brief "Round N" card between rounds summing up who fell. */
function showRoundBanner(round: number, before: { blue: number; red: number }, after: { blue: number; red: number }): void {
  const vsComputer = aiMode || hordeActive;
  const blueLost = before.blue - after.blue;
  const redLost = before.red - after.red;
  const parts: string[] = [];
  if (blueLost > 0) parts.push(`${vsComputer ? 'You' : 'Blue'} lost ${blueLost}`);
  if (redLost > 0) parts.push(`${vsComputer ? 'Enemy' : 'Red'} lost ${redLost}`);
  roundBannerTitle.textContent = `Round ${round - 1} over`;
  roundBannerDetail.textContent = parts.length > 0 ? parts.join(' · ') : 'No casualties';
  roundBanner.classList.remove('show');
  void roundBanner.offsetWidth; // restart the animation
  roundBanner.classList.add('show');
  // Timed here too: with reduced motion the card has no fade-out animation.
  window.clearTimeout(roundBannerTimer);
  roundBannerTimer = window.setTimeout(hideRoundBanner, ROUND_BANNER_MS);
  audio.play('round-end');
}

function hideRoundBanner(): void {
  window.clearTimeout(roundBannerTimer);
  roundBanner.classList.remove('show');
}

function onPhaseChange(phase: TurnPhase): void {
  const planning = phase === 'blue-planning' || phase === 'red-planning';

  // Hide HUD during planning so the Done button doesn't overlap
  battleHud.style.display = planning ? 'none' : '';

  // Planning overlay
  if (planning) {
    const team = phase === 'blue-planning' ? 'Blue' : 'Red';
    const color = phase === 'blue-planning'
      ? 'var(--color-planning-blue)'
      : 'var(--color-planning-red)';
    planningLabel.textContent = `${team} Planning`;
    if (tutorialLesson !== null) planningLabel.textContent = TUTORIAL_LESSONS[tutorialLesson].title;
    planningLabel.style.color = color;
    planningOverlay.classList.add('active');
    confirmBtn.classList.add('active');
    roundTimerEl.textContent = '';
  } else {
    planningOverlay.classList.remove('active');
    confirmBtn.classList.remove('active');
  }

  // Cover screen — skip in horde mode (no red planning)
  coverScreen.classList.toggle('active', phase === 'cover' && !hordeActive);
}

function finishTutorialRound(): void {
  if (tutorialLesson === null || tutorialFinished) return;
  tutorialFinished = true;
  captureReplayData();
  tutorialPassed = tutorialObjectiveMet(tutorialLesson, engine!.getUnits(), lastReplayData);
  engine!.stop();
  onPhaseChange('playing');
  const lesson = TUTORIAL_LESSONS[tutorialLesson];
  setResultHeading(tutorialPassed ? 'Nicely done!' : 'Try again', '', 'var(--color-result-blue)');
  audio.play(tutorialPassed ? 'victory' : 'defeat');
  resultStatsEl.textContent = tutorialPassed ? lesson.success : lesson.retry;
  rematchBtn.textContent = !tutorialPassed ? 'Retry lesson'
    : tutorialLesson === TUTORIAL_LESSONS.length - 1 ? 'Play vs AI' : 'Next lesson';
  replayBtn.style.display = lastReplayData ? '' : 'none';
  returnToScreen = 'result';
  showScreen('result');
}

function captureReplayData(): void {
  lastReplayData = engine?.getReplayData() ?? null;
}

function onGameEvent(
  event: 'update' | 'end' | 'phase-change' | 'wave-clear',
  data?: BattleResult | { phase: TurnPhase; timeLeft?: number; round?: number },
) {
  if (tutorialLesson !== null && (event === 'end' || (event === 'phase-change'
    && data && 'phase' in data && data.phase === 'blue-planning' && (data.round ?? 1) > 1))) {
    finishTutorialRound();
    return;
  }
  if (event === 'phase-change' && data && 'phase' in data) {
    onPhaseChange(data.phase);
    if (data.round !== undefined) {
      roundCounterEl.textContent = `Round ${data.round}`;
    }
    if (data.phase === 'playing') {
      if (aiMode && tutorialLesson === null && !playingRetry && !ctfActive && !hordeActive) trackedBattleLive = true;
      roundStartCounts = engine?.getAliveCount() ?? null;
      lastTickSecond = null;
      hideRoundBanner();
      audio.play('round-start');
      audio.setMood('tense');
    } else if (data.phase === 'blue-planning') {
      audio.setMood('calm');
      const round = data.round ?? 1;
      if (round > currentRound && roundStartCounts && engine) {
        showRoundBanner(round, roundStartCounts, engine.getAliveCount());
      }
      currentRound = round;
    }
    return;
  }

  if (event === 'update' && engine) {
    const counts = engine.getAliveCount();
    blueCountEl.textContent = `Blue: ${counts.blue}`;
    redCountEl.textContent = `Red: ${counts.red}`;

    // Update wave HUD with live enemy count during horde
    if (hordeActive) {
      waveCounterEl.textContent = `Wave ${hordeWave}/${HORDE_MAX_WAVES}`;
    }

    if (ctfActive && engine) {
      const ctf = engine.getCtfState();
      if (ctf) {
        const blueFlagText = ctf.blueFlag.carrierId ? 'TAKEN' : ctf.blueFlag.dropped ? 'DROPPED' : 'HOME';
        const redFlagText = ctf.redFlag.carrierId ? 'TAKEN' : ctf.redFlag.dropped ? 'DROPPED' : 'HOME';
        flagStatusEl.textContent = `Blue flag: ${blueFlagText} | Red flag: ${redFlagText}`;
      }
    }

    if (data && 'timeLeft' in data && data.timeLeft !== undefined) {
      const timeLeft = data.timeLeft;
      const seconds = Math.ceil(timeLeft);
      roundTimerEl.textContent = `${seconds}s`;
      if (seconds >= 1 && seconds <= 3 && seconds !== lastTickSecond) {
        lastTickSecond = seconds;
        audio.play('tick');
      }

      if (timeLeft <= 3) {
        roundTimerEl.style.color = 'var(--color-timer-critical)';
        const pulse = 1 + 0.1 * Math.sin(Date.now() / 150);
        roundTimerEl.style.transform = `scale(${pulse})`;
      } else {
        roundTimerEl.style.color = '';
        roundTimerEl.style.transform = '';
      }
    }
  }

  if (event === 'wave-clear' && hordeActive) {
    captureReplayData();
    // Store surviving blue units
    hordeUnits = engine!.getUnits().filter(u => u.team === 'blue' && u.alive);
    healAllBlue(hordeUnits);

    if (hordeWave >= HORDE_MAX_WAVES) {
      showHordeResult(true);
    } else {
      showUpgradeSelection();
    }
    return;
  }

  if (event === 'end' && data && 'winner' in data) {
    recorderMod?.stopIfRecording();
    captureReplayData();
    const result = data as BattleResult;

    // Horde defeat
    if (hordeActive) {
      showHordeResult(false);
      return;
    }

    if (ctfActive) {
      const ctf = engine?.getCtfState();
      const isCaptureWin = ctf?.winner !== null;
      const winType = isCaptureWin ? 'Flag Captured!' : 'Elimination!';
      setResultHeading(`${result.winner === 'blue' ? 'Blue' : 'Red'} wins`, winType, teamColor(result.winner));
      audio.play('victory');

      resultStatsEl.innerHTML = [
        `Duration: ${result.duration.toFixed(1)}s`,
        `Win: ${winType}`,
      ].join('<br>');

      rematchBtn.textContent = 'Rematch';
      newBattleBtn.textContent = 'Back';
      replayBtn.style.display = lastReplayData ? '' : 'none';
      returnToScreen = 'result';

      showScreen('result');
      return;
    }

    canRetryEncounter = aiMode && result.winner === 'red' && retryEncounter !== null;
    const won = result.winner === 'blue';
    if (aiMode) {
      setResultHeading(won ? 'Victory' : 'Defeat', won ? 'Enemy eliminated' : 'Your army was wiped out', teamColor(result.winner));
    } else {
      setResultHeading(`${won ? 'Blue' : 'Red'} wins`, 'Elimination', teamColor(result.winner));
    }
    audio.play(won || !aiMode ? 'victory' : 'defeat');
    pulse('heavy');

    const rounds = currentRound;
    const statsLines = [
      `${rounds} round${rounds === 1 ? '' : 's'} · ${result.duration.toFixed(1)}s of combat`,
      `${aiMode ? 'Your' : 'Blue'} survivors: ${result.blueAlive}/${result.blueTotal}`,
      `${aiMode ? 'Enemy' : 'Red'} survivors: ${result.redAlive}/${result.redTotal}`,
    ];
    resultStatsEl.innerHTML = statsLines.join('<br>');

    trackedBattleLive = false;
    if (dailyChallenge) {
      const counts = !playingRetry && recordDailyResult({
        date: dailyChallenge.date, won, rounds, survivors: result.blueAlive, total: result.blueTotal,
      });
      const practice = !counts;
      const streak = getDailyStreak(dailyChallenge.date);
      resultRecordEl.textContent = `Daily #${dailyChallenge.number}${practice ? ' · practice run' : ''}`
        + (streak > 0 ? ` · ${streak}-day win streak` : '');
      shareResultBtn.style.display = '';
    } else if (aiMode && !playingRetry) {
      const record = recordAiResult(difficulty, won);
      const best = won && record.streak === record.bestStreak && record.streak > 1 ? ' (best!)' : '';
      resultRecordEl.textContent = `${DIFFICULTY_LABELS[difficulty]} · ${record.wins}W – ${record.losses}L`
        + (record.streak > 0 ? ` · streak ${record.streak}${best}` : '');
    }

    rematchBtn.textContent = dailyChallenge ? 'Play again' : aiMode ? 'New encounter' : 'Rematch';
    rematchBtn.style.opacity = '1';
    rematchBtn.style.display = '';
    newBattleBtn.textContent = 'Back';
    replayBtn.style.display = lastReplayData ? '' : 'none';
    returnToScreen = 'result';

    showScreen('result');
  }
}

async function initRenderer(): Promise<void> {
  if (renderer) return;
  battleScreen.classList.add('active'); // visible before init so container has dimensions
  renderer = new Renderer();
  await renderer.init(pixiContainer);
  renderer.effects!.onCue = handleFeedbackCue;
  renderer.onPathDrawn = () => audio.play('draw');
}

function showPreview(): void {
  if (!renderer) return;
  const battlefield = generateBattlefield();
  renderer.renderElevationZones(battlefield.elevationZones);
  renderer.renderObstacles(battlefield.obstacles);
  const preview = [...createArmy('blue'), ...createArmy('red')];
  renderer.renderUnits(preview);
}

function startGame(retry = false): void {
  const encounter = retry ? retryEncounter : null;
  canRetryEncounter = false;
  playingRetry = encounter !== null;
  lastReplayData = null;
  engine?.stop();
  applyTheme();
  const daily = tutorialLesson === null && aiMode ? dailyChallenge : null;
  engine = new GameEngine(renderer!, onGameEvent, {
    aiMode: tutorialLesson === null && aiMode,
    practice: tutorialLesson === null ? undefined : createTutorialEncounter(tutorialLesson),
    initialState: encounter?.state,
    seed: encounter?.seed ?? daily?.seed,
    layoutIndex: daily?.layoutIndex,
    composition: daily?.composition,
    difficulty: daily ? 'normal' : difficulty,
    cinematic: !getSettings().reducedMotion,
    onInspectUnit: showUnitInfo,
  });
  resetRoundTracking();
  tutorialFinished = false;
  planningOverlay.classList.toggle('tutorial', tutorialLesson !== null);
  planningInstructions.textContent = tutorialLesson === null
    ? 'Click a unit, drag to draw a path. Repeat for each unit.'
    : TUTORIAL_LESSONS[tutorialLesson].instruction;
  confirmBtn.textContent = tutorialLesson === null ? 'Done' : 'Fight';
  rematchBtn.textContent = 'Rematch';
  showScreen('battle');
  speedToggle.classList.remove('active');
  speedToggle.dataset.speed = '1';
  speedToggle.textContent = '3x';
  roundCounterEl.textContent = 'Round 1';
  engine.startBattle();
  retryEncounter = tutorialLesson === null && aiMode
    ? { state: structuredClone(engine.getOnlineGameState()), seed: engine.getSeed() } : null;
}

function resetRoundTracking(): void {
  currentRound = 1;
  roundStartCounts = null;
  lastTickSecond = null;
  hideRoundBanner();
}

function startCtfGame(): void {
  lastReplayData = null;
  engine?.stop();
  applyTheme();
  engine = new GameEngine(renderer!, onGameEvent, {
    aiMode: !ctfHotseat,
    ctfMode: true,
    ctfHotseat,
    cinematic: !getSettings().reducedMotion,
    onInspectUnit: showUnitInfo,
  });
  resetRoundTracking();
  showScreen('battle');
  speedToggle.classList.remove('active');
  speedToggle.dataset.speed = '1';
  speedToggle.textContent = '3x';
  roundCounterEl.textContent = 'Round 1';
  flagStatusEl.style.display = '';
  engine.startBattle();
}

// --- Replay functions ---

function startReplay(data: ReplayData): void {
  // Hide other overlays
  resultScreen.classList.remove('active');
  upgradeScreen.style.display = 'none';
  planningOverlay.classList.remove('active');
  confirmBtn.classList.remove('active');
  battleHud.style.display = 'none';

  showScreen('battle');
  replayOverlay.classList.add('active');
  replayPauseBtn.textContent = '\u23F8';
  replaySpeedToggle.textContent = '1×';
  replaySpeedToggle.dataset.speed = '1';
  replaySpeedToggle.classList.remove('active');

  replayPlayer = new ReplayPlayer(renderer!, data, (event, eventData) => {
    if (event === 'frame' && eventData) {
      replayProgress.textContent = `${eventData.time.toFixed(1)}s / ${eventData.duration.toFixed(1)}s`;
    }
    if (event === 'end') {
      replayPauseBtn.textContent = '\u25B6';
      if (clipRecording) void finishClip();
    }
  });
  replayPlayer.start();
}

/** Play the last battle's replay while recording it, then share the video. */
function recordClip(): void {
  if (!lastReplayData || !renderer || clipRecording) return;
  audio.unlock();
  startReplay(lastReplayData);
  clipRecording = startClipRecording(renderer.canvas, audio.stream, () => { void finishClip(); });
  if (!clipRecording) {
    showToast('Recording is not supported in this browser');
    return;
  }
  showToast('Recording clip… it will be ready when the replay ends');
}

async function finishClip(): Promise<void> {
  const recording = clipRecording;
  clipRecording = null;
  if (!recording) return;
  const blob = await recording.finish();
  if (!blob) {
    stopReplay();
    showToast('Could not record the clip');
    return;
  }
  if (canShareClip(blob)) {
    // The share sheet needs a fresh tap, so hand it to the button.
    readyClip = blob;
    stopReplay();
    showToast('Clip ready — tap “Share recorded clip”');
  } else {
    stopReplay();
    downloadClip(blob);
    showToast('Clip saved to your downloads');
  }
}

async function onClipButton(): Promise<void> {
  if (!readyClip) {
    recordClip();
    return;
  }
  const outcome = await shareClip(readyClip);
  if (outcome === 'downloaded') showToast('Clip saved to your downloads');
}

/** Leaving a vs-AI or daily battle mid-fight records it as a loss. */
function forfeitTrackedBattle(): void {
  if (!trackedBattleLive || !engine) return;
  trackedBattleLive = false;
  const alive = engine.getAliveCount();
  if (dailyChallenge) {
    const total = engine.getUnits().filter(u => u.team === 'blue').length;
    recordDailyResult({ date: dailyChallenge.date, won: false, rounds: currentRound, survivors: alive.blue, total });
  } else {
    recordAiResult(difficulty, false);
  }
}

function stopReplay(): void {
  clipRecording?.cancel();
  clipRecording = null;
  recorderMod?.stopIfRecording();
  replayPlayer?.stop();
  replayPlayer = null;
  replayOverlay.classList.remove('active');

  if (returnToScreen === 'horde-upgrade') {
    showUpgradeSelection();
  } else {
    showScreen('result');
  }
}

// --- Horde mode functions ---

function startHorde(): void {
  hordeActive = true;
  hordeWave = 0;
  hordeAppliedUpgrades = new Map();
  lastReplayData = null;

  // Generate map once for the whole run (before spawning so units avoid blocks)
  const obstacles = generateHordeObstacles();
  const elevationZones = generateHordeElevationZones();
  hordeMap = { obstacles, elevationZones };

  const allBlocks = obstacles;
  hordeUnits = createMissionArmy('blue', randomHordeStartingArmy(), allBlocks);

  waveCounterEl.style.display = '';
  startNextHordeWave();
}

function startNextHordeWave(): void {
  hordeWave++;
  const waveDef = HORDE_WAVES[hordeWave - 1];
  if (!waveDef) return;

  engine?.stop();
  applyTheme();
  engine = new GameEngine(renderer!, onGameEvent, {
    aiMode: true,
    horde: true,
    cinematic: !getSettings().reducedMotion,
    hordeBlueUnits: hordeUnits,
    hordeRedArmy: waveDef.enemies,
    hordeMap: hordeMap!,
    onInspectUnit: showUnitInfo,
  });

  resetRoundTracking();
  showScreen('battle');
  speedToggle.classList.remove('active');
  speedToggle.dataset.speed = '1';
  speedToggle.textContent = '3x';
  roundCounterEl.textContent = 'Round 1';
  waveCounterEl.textContent = `Wave ${hordeWave}/${HORDE_MAX_WAVES}`;
  engine.startBattle();
}

function showUpgradeSelection(): void {
  const upgrades = pickUpgrades(hordeUnits, hordeWave, hordeAppliedUpgrades);
  upgradeCardsEl.innerHTML = '';

  for (const upgrade of upgrades) {
    const card = document.createElement('div');
    card.className = `upgrade-card rarity-${upgrade.rarity}`;
    const unitTag = upgrade.forType
      ? `<div class="card-unit-type">${upgrade.forType}</div>`
      : (upgrade.category === 'stat' ? '<div class="card-unit-type">all units</div>' : '');
    card.innerHTML = `
      <div class="card-rarity">${upgrade.rarity}</div>
      <div class="card-label">${upgrade.label}</div>
      <div class="card-desc">${upgrade.description}</div>
      ${unitTag}
    `;
    card.addEventListener('click', () => {
      const allBlocks = hordeMap!.obstacles;
      hordeAppliedUpgrades.set(upgrade.id, (hordeAppliedUpgrades.get(upgrade.id) ?? 0) + 1);
      const prevCount = hordeUnits.length;
      hordeUnits = upgrade.apply(hordeUnits, allBlocks);
      if (hordeUnits.length > prevCount) {
        applyUpgradesToUnit(hordeUnits[hordeUnits.length - 1], hordeAppliedUpgrades);
      }
      repositionBlueUnits(hordeUnits, allBlocks);
      showScreen('battle');
      startNextHordeWave();
    });
    upgradeCardsEl.appendChild(card);
  }

  upgradeReplayBtn.style.display = lastReplayData ? 'block' : 'none';

  audio.play('upgrade');
  showScreen('horde-upgrade');
}

function showHordeResult(victory: boolean): void {
  engine?.stop();

  if (victory) {
    setResultHeading('Horde cleared', `All ${HORDE_MAX_WAVES} waves survived`, 'var(--color-result-horde-win)');
  } else {
    setResultHeading('Defeated', `Fallen on wave ${hordeWave}`, 'var(--color-result-red)');
  }
  audio.play(victory ? 'victory' : 'defeat');
  pulse('heavy');

  const survivors = hordeUnits.filter(u => u.alive).length;
  resultStatsEl.innerHTML = [
    `Waves completed: ${victory ? HORDE_MAX_WAVES : hordeWave - 1}/${HORDE_MAX_WAVES}`,
    `Survivors: ${survivors}`,
  ].join('<br>');

  rematchBtn.textContent = 'Try Again';
  newBattleBtn.textContent = 'Back';
  replayBtn.style.display = lastReplayData ? '' : 'none';
  returnToScreen = 'result';

  showScreen('result');
}

// --- Menu: settings, difficulty, daily challenge ---

function syncSettingsUi(settings: Readonly<Settings>): void {
  for (const btn of settingToggles) {
    const key = btn.dataset.setting as keyof Settings;
    btn.setAttribute('aria-pressed', String(settings[key]));
  }
  themeToggle.textContent = settings.dayMode ? 'Paper theme' : 'Night theme';
  document.body.classList.toggle('reduced-motion', settings.reducedMotion);
  audio.setSfxEnabled(settings.sound);
  audio.setMusicEnabled(settings.music);
  setHapticsEnabled(settings.haptics);
}

for (const btn of settingToggles) {
  btn.addEventListener('click', () => {
    const key = btn.dataset.setting as keyof Settings;
    updateSettings({ [key]: !getSettings()[key] });
  });
}
// Vibration only means something on phones and tablets.
const settingsHaptics = settingToggles.find(btn => btn.dataset.setting === 'haptics');
if (settingsHaptics && !Capacitor.isNativePlatform() && !matchMedia('(pointer: coarse)').matches) {
  settingsHaptics.hidden = true;
}
themeToggle.addEventListener('click', () => {
  updateSettings({ dayMode: !getSettings().dayMode });
  applyTheme();
});
onSettingsChange(syncSettingsUi);
syncSettingsUi(getSettings());

function setDifficulty(next: Difficulty): void {
  difficulty = next;
  try { localStorage.setItem(DIFFICULTY_KEY, next); } catch { /* unavailable */ }
  refreshMenuMeta();
}
for (const [index, btn] of difficultyButtons.entries()) {
  btn.addEventListener('click', () => setDifficulty(btn.dataset.difficulty as Difficulty));
  // Radio-group keyboard pattern: arrows move and select, one tab stop.
  btn.addEventListener('keydown', event => {
    const step = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1
      : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const next = difficultyButtons[(index + step + difficultyButtons.length) % difficultyButtons.length];
    setDifficulty(next.dataset.difficulty as Difficulty);
    next.focus();
  });
}

/** Refresh the menu's record line, difficulty picker and daily badge. */
function refreshMenuMeta(): void {
  for (const btn of difficultyButtons) {
    const checked = btn.dataset.difficulty === difficulty;
    btn.setAttribute('aria-checked', String(checked));
    btn.tabIndex = checked ? 0 : -1;
  }
  const record = getAiRecord(difficulty);
  aiRecordEl.textContent = record.wins + record.losses > 0
    ? `${record.wins}W – ${record.losses}L${record.streak > 1 ? ` · streak ${record.streak}` : ''}`
      + (record.bestStreak > 1 ? ` · best ${record.bestStreak}` : '')
    : '';
  const today = getDailyChallenge();
  const result = getDailyResult(today.date);
  const streak = getDailyStreak(today.date);
  dailyBadge.hidden = false;
  dailyBadge.textContent = result
    ? `${result.won ? '✓ won' : '✗ lost'}${streak > 1 ? ` · ${streak}🔥` : ''}`
    : `#${today.number}`;
}

async function shareDailyResult(): Promise<void> {
  const challenge = dailyChallenge ?? getDailyChallenge();
  const result = getDailyResult(challenge.date);
  if (!result) return;
  const text = formatDailyShare(challenge, result, `${location.origin}${location.pathname}`);
  if (navigator.share) {
    try {
      await navigator.share({ text });
      return;
    } catch (err) {
      if ((err as Error)?.name === 'AbortError') return;
    }
  }
  try {
    await navigator.clipboard.writeText(text);
    showToast('Result copied — paste it anywhere');
  } catch {
    showToast('Could not copy the result');
  }
}

// --- Event listeners ---
battleBtn.addEventListener('click', async () => {
  aiMode = false;
  dailyChallenge = null;
  await initRenderer();
  startGame();
});

aiBtn.addEventListener('click', async () => {
  aiMode = true;
  dailyChallenge = null;
  await initRenderer();
  startGame();
});

dailyBtn.addEventListener('click', async () => {
  aiMode = true;
  dailyChallenge = getDailyChallenge();
  await initRenderer();
  startGame();
});

shareResultBtn.addEventListener('click', () => { void shareDailyResult(); });
clipBtn.addEventListener('click', () => { void onClipButton(); });

async function startTutorial(): Promise<void> {
  await initRenderer();
  tutorialLesson = 0;
  startGame();
}

tutorialBtn.addEventListener('click', () => void startTutorial());

skipTutorialBtn.addEventListener('click', () => newBattleBtn.click());

hordeBtn.addEventListener('click', async () => {
  await initRenderer();
  startHorde();
});

ctfAiBtn.addEventListener('click', async () => {
  ctfHotseat = false;
  ctfActive = true;
  await initRenderer();
  startCtfGame();
});

ctfPvpBtn.addEventListener('click', async () => {
  ctfHotseat = true;
  ctfActive = true;
  await initRenderer();
  startCtfGame();
});

confirmBtn.addEventListener('click', () => {
  if (asyncController && playbackPathDrawer) {
    const myUnits = playbackUnits.filter(u => u.team === asyncMyTeam);
    const paths: PathList = myUnits.map(u => ({
      unitId: u.id,
      waypoints: [...u.waypoints],
      ...(u.rocketPath?.length ? { rocketPath: u.rocketPath.map(p => ({ ...p })) } : {}),
    }));
    playbackPathDrawer.destroy();
    playbackPathDrawer = null;
    confirmBtn.classList.remove('active');
    planningOverlay.classList.remove('active');
    planningLabel.textContent = 'Waiting for opponent...';
    void asyncController.submitPlan(paths);
    audio.play('confirm');
    return;
  }
  audio.play('confirm');
  engine?.confirmPlan();
});

coverScreen.addEventListener('click', () => {
  engine?.skipCover();
});

speedToggle.addEventListener('click', () => {
  const isfast = speedToggle.dataset.speed === '3';
  const newSpeed = isfast ? 1 : 3;
  speedToggle.dataset.speed = String(newSpeed);
  speedToggle.classList.toggle('active', !isfast);
  speedToggle.textContent = isfast ? '3x' : '1x';
  engine?.setSpeed(newSpeed);
});

rematchBtn.addEventListener('click', async () => {
  await initRenderer();
  if (tutorialLesson !== null) {
    if (tutorialPassed) tutorialLesson++;
    if (tutorialLesson === TUTORIAL_LESSONS.length) {
      markTutorialSeen();
      tutorialLesson = null;
      aiMode = true;
      dailyChallenge = null;
    }
    startGame();
    return;
  }
  if (ctfActive) {
    startCtfGame();
  } else if (hordeActive) {
    startHorde(); // restart from wave 1
  } else {
    startGame();
  }
});

retryEncounterBtn.addEventListener('click', () => {
  if (canRetryEncounter && retryEncounter) startGame(true);
});

newBattleBtn.addEventListener('click', () => {
  const reopen = returnTo;
  returnTo = null;
  recorderMod?.cancelIfRecording();
  forfeitTrackedBattle();
  engine?.stop();
  engine = null;
  planningOverlay.classList.remove('active');
  confirmBtn.classList.remove('active');
  coverScreen.classList.remove('active');
  roundTimerEl.textContent = '';
  lastReplayData = null;
  if (tutorialLesson !== null) markTutorialSeen();
  tutorialLesson = null;
  retryEncounter = null;
  canRetryEncounter = false;
  playingRetry = false;
  dailyChallenge = null;
  resetRoundTracking();
  planningOverlay.classList.remove('tutorial');
  planningInstructions.textContent = 'Click a unit, drag to draw a path. Repeat for each unit.';
  confirmBtn.textContent = 'Done';
  rematchBtn.textContent = 'Rematch';

  // Reset online state
  stopSearch();
  destroyAsync();
  onlineActive = false;
  onlineLobby.style.display = 'none';
  // The other funnel back to the menu (a match just ended — e.g. an open-match
  // forfeit). Recount so the menu badge doesn't keep a stale count.
  void refreshMatchesBadge();

  // Reset horde state
  hordeActive = false;
  hordeWave = 0;
  hordeUnits = [];
  hordeMap = null;
  hordeAppliedUpgrades = new Map();
  waveCounterEl.style.display = 'none';

  ctfActive = false;
  ctfHotseat = false;
  flagStatusEl.style.display = 'none';

  showPreview();
  showScreen('prompt');
  if (reopen === 'matches') void openMatchesList();
  if (reopen === 'ranked') openRankedScreen();
});

// Exit game button (in battle HUD)
exitGameBtn.addEventListener('click', () => {
  if (!confirm('Exit the current game?')) return;
  newBattleBtn.click();
});

// Replay button on result screen
replayBtn.addEventListener('click', () => {
  if (lastReplayData) {
    startReplay(lastReplayData);
  }
});

// Replay button on upgrade screen
upgradeReplayBtn.addEventListener('click', () => {
  if (lastReplayData) {
    returnToScreen = 'horde-upgrade';
    startReplay(lastReplayData);
  }
});

// Replay control buttons
replayRestartBtn.addEventListener('click', () => {
  replayPlayer?.restart();
  replayPauseBtn.textContent = '\u23F8';
});

replayPauseBtn.addEventListener('click', () => {
  if (!replayPlayer) return;
  replayPlayer.togglePause();
  replayPauseBtn.textContent = replayPlayer.isPaused ? '\u25B6' : '\u23F8';
});

replayExitBtn.addEventListener('click', () => {
  stopReplay();
});

replaySpeedToggle.addEventListener('click', () => {
  const speeds = [1, 0.5, 3];
  const current = Number(replaySpeedToggle.dataset.speed);
  const speed = speeds[(speeds.indexOf(current) + 1) % speeds.length];
  replaySpeedToggle.dataset.speed = String(speed);
  replaySpeedToggle.classList.toggle('active', speed !== 1);
  replayPlayer?.setSpeed(speed);
  replaySpeedToggle.textContent = `${speed}×`;
});

/** Tear down the headless playback engine used to animate a resolved async
 *  round (shared teardown for the async match playback). */
function stopPlaybackEngine(): void {
  cancelCountIn(); // drop any pending count-in so it can't start a torn-down round
  audio.setMood('calm');
  if (playbackEngine) {
    playbackEngine.stop();
    playbackEngine = null;
  }
  renderer?.ticker.remove(asyncTickCallback);
  renderer?.renderProjectiles([]);
}


// --- Online matches --------------------------------------------------------
// Every move goes to the match referee, which plays each round once both plans
// are in; this client draws the plan and animates the published round.

const ASYNC_ROUND_END_TICK = Math.round(ROUND_DURATION_S * 60);
const battleNote = document.getElementById('battle-note')!;
const searchPanel = document.getElementById('search-panel')!;
const searchCountdown = document.getElementById('search-countdown')!;
const searchBotButtons = document.getElementById('search-bot-buttons')!;
const searchBotEasyBtn = document.getElementById('search-bot-easy-btn') as HTMLButtonElement;
const searchBotHardBtn = document.getElementById('search-bot-hard-btn') as HTMLButtonElement;
const onlineLobbyTitle = document.getElementById('online-lobby-title')!;
const rankedBtn = document.getElementById('ranked-btn')!;
const playerNameInput = document.getElementById('player-name-input') as HTMLInputElement;

/** The ranked header for the match on screen, once fetched. */
let rankedView: RankedMatchView | null = null;
let rankedViewVersion = 0;

/** Tear down any in-progress online match. */
function destroyAsync(): void {
  asyncStartVersion++;
  rankedViewVersion++;
  asyncController?.destroy();
  asyncController = null;
  asyncSession = casualSession;
  rankedView = null;
  playbackPathDrawer?.destroy();
  playbackPathDrawer = null;
  renderer?.ticker.remove(asyncTickCallback);
  stopPlaybackEngine();
  showingMatch(null);
  battleNote.style.display = 'none';
  asyncNotify.style.display = 'none';
  asyncFirstMoveBtn.style.display = 'none';
  asyncForfeitBtn.style.display = 'none';
  setForfeitMode('forfeit');
  onlineReloadBtn.style.display = 'none';
  asyncBackBtn.style.display = 'none';
}

asyncBackBtn.addEventListener('click', () => {
  if (planningOverlay.classList.contains('active') && playbackUnits.some(unit => unit.waypoints.length > 0)
      && !confirm('Leave this match? Your unsubmitted paths will not be saved.')) return;
  newBattleBtn.click();
});

// Host's "Plan your first move" button: dismiss the share-link lobby and reveal
// the planning overlay (set up underneath in onPlanTurn) so the host can draw.
asyncFirstMoveBtn.addEventListener('click', () => {
  asyncFirstMoveBtn.style.display = 'none';
  onlineLobby.style.display = 'none';
  planningOverlay.classList.add('active');
  confirmBtn.classList.add('active');
});

// Forfeit: concede the match (or withdraw an invite nobody joined).
/** The lobby's forfeit button either withdraws an invite nobody joined
 *  (never a concession) or concedes the match. */
function setForfeitMode(mode: 'withdraw' | 'forfeit'): void {
  asyncForfeitBtn.dataset.mode = mode;
  asyncForfeitBtn.textContent = mode === 'withdraw' ? 'Withdraw invite' : 'Forfeit match';
}

asyncForfeitBtn.addEventListener('click', async () => {
  const controller = asyncController;
  if (!controller) return;
  if (asyncForfeitBtn.dataset.mode === 'withdraw') {
    const status = onlineStatus.textContent ?? '';
    asyncForfeitBtn.style.display = 'none';
    setOnlineStatus('Withdrawing…', true);
    const error = await controller.withdraw();
    if (error && controller === asyncController) {
      showToast(error);
      setOnlineStatus(status);
      asyncForfeitBtn.style.display = '';
    }
    return;
  }
  if (controller.record?.status === 'active') {
    const question = controller.record.ranked ? 'Concede this ranked match? It counts as a loss.' : `Concede this match? ${opponentName()[0].toUpperCase()}${opponentName().slice(1)} wins.`;
    if (!confirm(question)) return;
  }
  asyncForfeitBtn.style.display = 'none';
  setOnlineStatus('Forfeiting…', true);
  void controller.forfeit();
});

const onlineReloadBtn = document.getElementById('online-reload-btn')!;
onlineReloadBtn.addEventListener('click', () => { window.location.reload(); });

/** The opponent's name as this player should read it. */
function opponentName(match: MatchRecord | null = asyncController?.record ?? null): string {
  if (!match || !asyncController) return 'your opponent';
  const mine = asyncController.team;
  const name = mine === 'blue' ? match.guestName : match.hostName;
  return name ?? (match.guestBot && mine === 'blue' ? 'the AI commander' : 'your opponent');
}

/** The line under the HUD: who you play (and, ranked, what is at stake). */
function updateBattleNote(): void {
  const match = asyncController?.record;
  if (!match) { battleNote.style.display = 'none'; return; }
  battleNote.classList.remove('win', 'loss');
  if (match.ranked) {
    const note = rankedMatchNote(rankedView);
    battleNote.textContent = note.text;
    if (note.tone) battleNote.classList.add(note.tone);
  } else if (match.guestPlayer) {
    battleNote.textContent = `vs ${opponentName(match)}`;
  } else {
    battleNote.style.display = 'none';
    return;
  }
  battleNote.style.display = 'block';
}

/** Fetch the ranked header (stakes, then the rated result). The result is
 *  written as the match ends, so a few retries cover a slow update. */
async function refreshRankedView(id: string, attempts = 3): Promise<void> {
  const version = ++rankedViewVersion;
  for (let i = 0; i < attempts; i++) {
    try {
      const { battle } = await rankedRequest<{ battle: RankedMatchView }>('view', { id });
      if (version !== rankedViewVersion) return;
      rankedView = battle;
      updateBattleNote();
      const over = battle.status !== 'open' && battle.status !== 'active';
      if (!over || battle.result || battle.status === 'abandoned') return;
    } catch { /* retried below */ }
    await new Promise(r => setTimeout(r, 1500 * (i + 1)));
    if (version !== rankedViewVersion) return;
  }
}

/** Ticker callback that animates a played round headlessly and reports back
 *  once it ends (a side eliminated, or the fixed round duration elapsed). */
function asyncTickCallback(ticker: { deltaMS: number }): void {
  if (!playbackEngine || !renderer) return;
  playbackEngine.externalTick(ticker.deltaMS);

  const units = playbackEngine.getUnits();
  const dt = ticker.deltaMS / 1000;
  renderer.renderUnits(units, dt, undefined, playbackEngine.phase === 'playing');
  renderer.renderProjectiles(playbackEngine.getProjectiles());

  const { events, nextIndex } = playbackEngine.getReplayEventsSince(playbackEffectIndex);
  if (events.length > 0) {
    renderer.effects?.dispatchEvents(events);
    playbackEffectIndex = nextIndex;
  }
  renderer.effects?.update(dt);

  const counts = playbackEngine.getAliveCount();
  blueCountEl.textContent = `Blue: ${counts.blue}`;
  redCountEl.textContent = `Red: ${counts.red}`;

  if (asyncRoundFinished) return;
  const tick = playbackEngine.getSimulationTick();
  if (asyncMatchEnded || tick >= ASYNC_ROUND_END_TICK) {
    asyncRoundFinished = true;
    renderer.ticker.remove(asyncTickCallback);
    lastReplayData = playbackEngine.getReplayData() ?? lastReplayData;
    const round = asyncCurrentRound;
    stopPlaybackEngine();
    void asyncController?.onRoundPlayed(round);
  }
}

/** Per-number duration of the pre-playback count-in (ms). */
const COUNT_IN_STEP_MS = 700;
let countInTimer: ReturnType<typeof setTimeout> | null = null;

/** Cancel a running 3-2-1 count-in and hide its overlay. Safe anytime (e.g.
 *  when playback is torn down mid-count). */
function cancelCountIn(): void {
  if (countInTimer !== null) { clearTimeout(countInTimer); countInTimer = null; }
  countInEl.style.display = 'none';
}

/** Count "3, 2, 1" over the (already painted) board, then run `onDone` — a beat
 *  to read the starting positions before the round animates. */
function runCountIn(onDone: () => void): void {
  cancelCountIn();
  let n = 3;
  const show = (): void => {
    countInEl.textContent = String(n);
    countInEl.style.display = 'flex';
    // Re-trigger the pop animation for each number (a reflow restarts it).
    countInEl.classList.remove('pop');
    void countInEl.offsetWidth;
    countInEl.classList.add('pop');
    countInTimer = setTimeout(() => {
      n -= 1;
      if (n >= 1) show();
      else { cancelCountIn(); onDone(); }
    }, COUNT_IN_STEP_MS);
  };
  show();
}

/** Animate a round the referee played, from its start state, both plans and
 *  the seed it used: the same deterministic simulation, shown frame by frame. */
function startAsyncRoundPlayback(input: PlayRoundInput): void {
  stopPlaybackEngine();
  asyncMatchEnded = false;
  asyncRoundFinished = false;
  asyncCurrentRound = input.round;

  playbackEngine = new GameEngine(null, (type) => {
    if (type === 'end') asyncMatchEnded = true;
  }, { seed: input.seed });
  playbackEngine.loadOnlineGameState(input.startState);
  playbackEngine.setBluePaths(input.bluePaths);
  playbackEngine.setRedPaths(input.redPaths);
  roundCounterEl.textContent = `Round ${input.round}`;

  // Paint the starting positions so the player can read the board, then count
  // in 3-2-1 before the action animates.
  renderer!.adaptToRemoteMap(input.startState.mapWidth, input.startState.mapHeight);
  renderer!.renderElevationZones(input.startState.elevationZones);
  renderer!.renderObstacles(input.startState.obstacles);
  renderer!.renderUnits(playbackEngine.getUnits());
  runCountIn(() => {
    if (!playbackEngine) return; // left the match during the count-in
    playbackEffectIndex = 0;
    audio.play('round-start');
    audio.setMood('tense');
    playbackEngine.startPlaying();
    renderer!.ticker.add(asyncTickCallback);
  });
}

/** How a finished match is headlined, from this player's side. */
function resultText(status: string, reason: FinishReason | null, iWon: boolean): { title: string; detail: string } {
  if (status === 'abandoned') {
    switch (reason) {
      case 'version': return { title: 'Match ended', detail: 'It was made with another version of the game' };
      case 'cancelled': return { title: 'Match withdrawn', detail: 'Nobody had joined yet' };
      case 'battle': return { title: 'Draw', detail: 'Both armies fell together' };
      default: return { title: 'Match abandoned', detail: 'Nobody played for too long' };
    }
  }
  const who = opponentName();
  const named = who[0].toUpperCase() + who.slice(1);
  switch (reason) {
    case 'forfeit': return { title: iWon ? 'Victory' : 'Defeat', detail: iWon ? `${named} conceded` : 'You conceded' };
    case 'timeout': return { title: iWon ? 'Victory' : 'Defeat', detail: iWon ? `${named} ran out of time` : 'You ran out of time' };
    default: return { title: iWon ? 'Victory' : 'Defeat', detail: 'Elimination' };
  }
}

/** Bridge the online protocol controller to the UI / playback engine. */
function asyncHooks(): AsyncGameHooks {
  return {
    onPlanTurn(round, startState, myTeam, awaitingGuest, afterError) {
      asyncCurrentRound = round;
      asyncMyTeam = myTeam;
      stopPlaybackEngine();

      applyTheme();
      renderer!.adaptToRemoteMap(startState.mapWidth, startState.mapHeight);
      renderer!.effects?.clear();
      renderer!.clearDyingUnits();

      playbackUnits = startState.units.map(u => createUnitFromState(u));
      playbackElevationZones = startState.elevationZones;
      renderer!.renderElevationZones(startState.elevationZones);
      renderer!.renderObstacles(startState.obstacles);
      renderer!.renderUnits(playbackUnits);

      playbackPathDrawer?.destroy();
      playbackPathDrawer = new PathDrawer(renderer!.stage, renderer!.canvas);
      playbackPathDrawer.onInspectUnit = showUnitInfo;
      playbackPathDrawer.onPathDrawn = () => audio.play('draw');
      playbackPathDrawer.enable(myTeam, playbackUnits, playbackElevationZones);

      planningLabel.textContent = 'Your Planning';
      planningLabel.style.color = myTeam === 'blue'
        ? 'var(--color-planning-blue)' : 'var(--color-planning-red)';
      battleHud.style.display = 'none';
      roundCounterEl.textContent = `Round ${round}`;
      updateBattleNote();
      showScreen('battle');

      if (awaitingGuest && !asyncMatchmade) {
        // Host's first move before a friend joins. The full-screen lobby would
        // cover the canvas, so we keep the invite up with a "Plan first move"
        // button that dismisses the lobby into the (already set-up) planning UI.
        planningOverlay.classList.remove('active');
        confirmBtn.classList.remove('active');
        onlineShareContainer.style.display = '';
        asyncNotify.style.display = 'flex';
        // Withdrawing an invite nobody joined frees a slot under the match limit.
        setForfeitMode('withdraw');
        asyncForfeitBtn.style.display = '';
        asyncFirstMoveBtn.style.display = '';
        setOnlineStatus('Share this link so a friend can join — or plan your first move now.', false);
        onlineLobby.style.display = 'flex';
        return;
      }

      onlineLobby.style.display = 'none';
      asyncFirstMoveBtn.style.display = 'none';
      planningOverlay.classList.add('active');
      confirmBtn.classList.add('active');
      // Re-prompted after a failed submit: keep the error toast readable and
      // don't alert for a turn the player just tried to take.
      if (afterError) return;
      if (document.visibilityState === 'visible') showToast(round === 1 ? 'Plan your first move!' : "It's your turn!");
      // Without server-sent alerts, Android can still show a local one if this
      // running match gets a turn update while its WebView is backgrounded.
      const matchId = asyncController?.matchId;
      const ranked = asyncSession.ranked;
      if (matchId) void closedAppAlerts().then(serverAlerts => { if (!serverAlerts) void notifyLocalTurn(matchId, round, ranked); });
    },

    onAwaitOpponent(round, awaitingGuest, playing) {
      playbackPathDrawer?.destroy();
      playbackPathDrawer = null;
      planningOverlay.classList.remove('active');
      confirmBtn.classList.remove('active');
      asyncFirstMoveBtn.style.display = 'none';
      asyncForfeitBtn.style.display = 'none';
      if (awaitingGuest && !asyncMatchmade) {
        // First move locked in, but still nobody to play against — keep the
        // invite visible so a friend can join and start the match.
        onlineShareContainer.style.display = '';
        asyncNotify.style.display = 'flex';
        setForfeitMode('withdraw');
        asyncForfeitBtn.style.display = '';
        setOnlineStatus('First move locked in! Share the link — the match begins when a friend joins.', true);
      } else {
        onlineShareContainer.style.display = 'none';
        const match = asyncController?.record;
        if (playing) setOnlineStatus('Both plans are in. Playing the round…', true);
        else if (match?.guestBot) setOnlineStatus(`${opponentName()[0].toUpperCase()}${opponentName().slice(1)} is planning…`, true);
        else setOnlineStatus(`Plan submitted (round ${round}). Waiting for ${opponentName()} — you can leave and come back later.`, true);
        asyncNotify.style.display = match?.guestBot ? 'none' : 'flex';
      }
      onlineLobby.style.display = 'flex';
      showScreen('battle');
    },

    onPlayRound(input) {
      onlineLobby.style.display = 'none';
      asyncFirstMoveBtn.style.display = 'none';
      asyncForfeitBtn.style.display = 'none';
      planningOverlay.classList.remove('active');
      confirmBtn.classList.remove('active');
      battleHud.style.display = '';
      showScreen('battle');
      startAsyncRoundPlayback(input);
    },

    onGameOver(status, finalState, reason) {
      // Capture from the controller before destroyAsync(): its team is
      // authoritative even when a finished match is reopened.
      const myTeam = asyncController?.team ?? asyncMyTeam;
      const opponentId = asyncController?.opponentId ?? null;
      const matchId = asyncController?.matchId ?? null;
      const ranked = asyncSession.ranked;
      const { title, detail } = resultText(status, reason, status === (myTeam === 'blue' ? 'host_won' : 'guest_won'));
      const note = ranked ? rankedView : null;
      destroyAsync();
      onlineLobby.style.display = 'none';
      if (status === 'abandoned') {
        // Neutral, not a win/loss color
        setResultHeading(title, detail, '');
      } else {
        const winner: Team = status === 'guest_won' ? 'red' : 'blue';
        const iWon = myTeam === winner;
        if (!ranked && opponentId && matchId) recordMatchResultOnce(matchId, opponentId, iWon);
        setResultHeading(title, detail, teamColor(winner));
        audio.play(iWon ? 'victory' : 'defeat');
      }
      const survivors = (team: Team) => {
        const army = finalState.units.filter(u => u.team === team);
        return `${army.filter(u => u.hp > 0).length}/${army.length}`;
      };
      resultStatsEl.innerHTML = [`Blue survivors: ${survivors('blue')}`, `Red survivors: ${survivors('red')}`].join('<br>');
      if (ranked && matchId) {
        // The rated result: shown once the database has it.
        const line = document.createElement('div');
        line.className = 'ranked-result-line';
        line.textContent = rankedMatchNote(note).text;
        resultStatsEl.append(document.createElement('br'), line);
        void rankedRequest<{ battle: RankedMatchView }>('view', { id: matchId })
          .then(({ battle }) => { line.textContent = rankedMatchNote(battle).text; })
          .catch(() => { line.textContent = 'Open Ranked to see your new rating.'; });
      }
      rematchBtn.style.display = 'none';
      replayBtn.style.display = lastReplayData ? '' : 'none';
      newBattleBtn.textContent = 'Back';
      returnToScreen = 'result';
      showScreen('result');
    },

    onError(message, canForfeit) {
      // Also toast it: some errors are followed at once by a re-prompt to plan
      // (a failed submit), which hides the lobby that shows the status line.
      showToast(message);
      onlineShareContainer.style.display = 'none';
      asyncFirstMoveBtn.style.display = 'none';
      setOnlineStatus(message);
      setForfeitMode('forfeit');
      asyncForfeitBtn.style.display = canForfeit ? '' : 'none';
      onlineLobby.style.display = 'flex';
      showScreen('battle');
    },

    onMatch(match) {
      updateBattleNote();
      if (match.ranked) void refreshRankedView(match.id);
      // A friend joined while the invite was up: no more link or withdrawing.
      if (match.status === 'active' && asyncForfeitBtn.dataset.mode === 'withdraw') {
        setForfeitMode('forfeit');
        asyncForfeitBtn.style.display = 'none';
        onlineShareContainer.style.display = 'none';
        const joined = `${opponentName(match)[0].toUpperCase()}${opponentName(match).slice(1)} joined!`;
        if (asyncFirstMoveBtn.style.display !== 'none') setOnlineStatus(`${joined} Plan your first move.`);
        else if (onlineLobby.style.display === 'none') showToast(joined);
      }
    },

    onOutdated(message) {
      playbackPathDrawer?.destroy();
      playbackPathDrawer = null;
      planningOverlay.classList.remove('active');
      confirmBtn.classList.remove('active');
      onlineShareContainer.style.display = 'none';
      asyncFirstMoveBtn.style.display = 'none';
      asyncForfeitBtn.style.display = 'none';
      asyncNotify.style.display = 'none';
      setOnlineStatus(message);
      onlineReloadBtn.style.display = '';
      onlineLobby.style.display = 'flex';
      showScreen('battle');
    },
  };
}

/** True while the current online match was found by matchmaking, so both
 *  players are already present: the host should plan immediately rather
 *  than see the friend-invite "share this link / plan your first move" UX. */
let asyncMatchmade = false;

/** Open an online match: create a friend invite (no id), or open/join one. */
async function startAsyncGame(roomId: string | null, opts: { matchmade?: boolean; ranked?: boolean } = {}): Promise<void> {
  stopSearch();
  destroyAsync();
  const version = asyncStartVersion;
  const session = opts.ranked ? rankedSession : casualSession;
  asyncSession = session;
  asyncMatchmade = opts.matchmade ?? false;
  returnTo = opts.ranked ? 'ranked' : 'matches';
  onlineActive = true;
  asyncBackBtn.textContent = opts.ranked ? '← Ranked' : '← Matches';
  asyncBackBtn.style.display = 'block';
  closeMatchesList();
  rankedScreen.hide();
  showScreen('battle');
  onlineLobbyTitle.textContent = opts.ranked ? 'Ranked' : 'Online';
  onlineLobby.style.display = 'flex';
  onlineCancelBtn.textContent = opts.ranked ? 'Back to Ranked' : 'Back to matches';
  onlineShareContainer.style.display = 'none';
  searchPanel.style.display = 'none';
  onlineStatus.style.display = '';
  if (opts.ranked) onlineRecord.style.display = 'none';
  else showOnlineRecord(); // overall W/L (self-hides when there are no games yet)
  asyncNotify.style.display = 'flex';
  void refreshNotificationSetting();
  setOnlineStatus(roomId ? 'Loading match…' : 'Creating match…', true);
  await initRenderer();
  if (version !== asyncStartVersion) return;

  let id = roomId;
  if (!id) {
    const created = await referee.create(casualSession, getPlayerName());
    if (version !== asyncStartVersion) return;
    if (!created.ok) {
      setOnlineStatus(created.status === 0 ? 'Could not create a match. Check your connection, then go back and try again.' : created.message);
      return;
    }
    id = created.match.id;
    onlineShareContainer.style.display = '';
    setOnlineStatus('Share this link with your friend — the match starts when they join.', true);
  } else {
    setOnlineStatus('Loading match…', true);
  }

  onlineShareUrl.value = getAsyncShareUrl(id);

  const controller = new AsyncGameController(id, asyncHooks(), {
    io: sessionIO(session, () => (session.ranked ? null : getPlayerName())),
  });
  asyncController = controller;
  showingMatch(id);
  const ok = await controller.start();
  if (version !== asyncStartVersion) return;
  if (!ok) {
    controller.destroy();
    asyncController = null;
  } else if (!opts.ranked) {
    rememberOpenMatch(id);
  }
}

// --- Random opponents: a search, and an AI commander if nobody comes ---------

/** Seconds a search waits for a human before an AI commander takes the seat.
 *  Ranked searches wait longer (the server allows commanders after 30 s). */
const SEARCH_BOT_DELAY_S = { casual: 20, ranked: 40 };
const SEARCH_POLL_MS = 3_000;

interface Search {
  session: OnlineSession;
  id: string | null;
  deadline: number;
  timer: ReturnType<typeof setInterval> | null;
  unsubscribe: (() => void) | null;
  callingBot: boolean;
  /** Automatic AI requests made; after two refusals the search waits for a player. */
  botAttempts: number;
  /** No more automatic AI request (it was refused); the player can still ask. */
  botRefused: boolean;
  /** Why the last AI request failed, shown until the next one. */
  notice: string | null;
  lastPoll: number;
}
let search: Search | null = null;
let searchVersion = 0;

function stopSearch(): void {
  searchVersion++;
  if (!search) return;
  if (search.timer) clearInterval(search.timer);
  search.unsubscribe?.();
  search = null;
  searchPanel.style.display = 'none';
}

/** Search for a random opponent, casual or ranked. */
async function startSearch(ranked: boolean): Promise<void> {
  stopSearch();
  destroyAsync();
  const version = searchVersion;
  const session = ranked ? rankedSession : casualSession;
  onlineActive = true;
  returnTo = ranked ? 'ranked' : null;
  closeMatchesList();
  rankedScreen.hide();
  await initRenderer();
  if (version !== searchVersion) return;
  showSearchLobby(ranked);
  setOnlineStatus('Looking for an opponent…', true);
  search = { session, id: null, deadline: Infinity, timer: null, unsubscribe: null, callingBot: false, botAttempts: 0, botRefused: false, notice: null, lastPoll: 0 };

  const result: RefereeResult = ranked ? await findRankedMatch() : await referee.matchmake(casualSession, getPlayerName());
  if (version !== searchVersion) {
    // Cancelled while the request was out: withdraw a search it opened.
    if (result.ok && result.match.status === 'open') void referee.cancel(session, result.match.id);
    return;
  }
  if (!result.ok) {
    searchPanel.style.display = 'none';
    setOnlineStatus(result.status === 0 ? 'Could not reach the online server. Check your connection and try again.' : result.message);
    return;
  }
  handleSearchMatch(result.match);
}

/** Pick an open search back up (from the match list or Ranked). */
function resumeSearch(match: MatchRecord, ranked: boolean): void {
  stopSearch();
  destroyAsync();
  onlineActive = true;
  returnTo = ranked ? 'ranked' : 'matches';
  closeMatchesList();
  rankedScreen.hide();
  const version = searchVersion;
  void initRenderer().then(() => {
    if (version !== searchVersion) return; // left meanwhile
    showSearchLobby(ranked);
    search = { session: ranked ? rankedSession : casualSession, id: null, deadline: Infinity, timer: null, unsubscribe: null, callingBot: false, botAttempts: 0, botRefused: false, notice: null, lastPoll: 0 };
    handleSearchMatch(match);
  });
}

function showSearchLobby(ranked: boolean): void {
  showScreen('battle');
  onlineLobbyTitle.textContent = ranked ? 'Ranked search' : 'Finding an opponent';
  onlineLobby.style.display = 'flex';
  onlineShareContainer.style.display = 'none';
  asyncNotify.style.display = 'none';
  onlineRecord.style.display = 'none';
  searchPanel.style.display = 'flex';
  searchCountdown.textContent = '';
  // Casual players may pick a commander at once; ranked gives humans a chance first.
  searchBotButtons.style.display = ranked ? 'none' : 'flex';
  searchBotEasyBtn.disabled = false;
  searchBotHardBtn.disabled = false;
  onlineCancelBtn.textContent = 'Cancel search';
}

/** A search's match: start playing once someone has joined, else wait. */
function handleSearchMatch(match: MatchRecord): void {
  const current = search;
  if (!current) return;
  if (match.guestPlayer) {
    void startAsyncGame(match.id, { matchmade: true, ranked: current.session.ranked });
    return;
  }
  if (current.id === null) {
    current.id = match.id;
    const delay = current.session.ranked ? SEARCH_BOT_DELAY_S.ranked : SEARCH_BOT_DELAY_S.casual;
    // A resumed casual search may already have waited long enough. Ranked
    // always waits in full: the server refuses a commander before 30 s.
    const waited = current.session.ranked ? 0 : Math.max(0, (Date.now() - Date.parse(match.updatedAt || '')) / 1000) || 0;
    current.deadline = Date.now() + Math.max(0, delay - waited) * 1000;
    current.unsubscribe = subscribeMatch(current.session, match.id, () => { void pollSearch(); });
    current.timer = setInterval(() => { void tickSearch(); }, 1000);
  }
  setOnlineStatus('Searching for an opponent…', true);
  void tickSearch();
}

async function tickSearch(): Promise<void> {
  const current = search;
  if (!current || current.id === null) return;
  const left = Math.ceil((current.deadline - Date.now()) / 1000);
  if (current.callingBot) return;
  if (current.notice) {
    searchCountdown.textContent = current.notice;
  } else if (current.botRefused) {
    searchCountdown.textContent = current.session.ranked
      ? 'Still searching. You already have three ranked matches against AI commanders, so this one waits for a player.'
      : 'Still searching for a player.';
  } else if (left > 0) {
    searchCountdown.textContent = current.session.ranked
      ? `Nobody yet. If no player joins in ${left} s, an AI commander takes the seat (rated as usual).`
      : `Nobody yet. An AI commander joins in ${left} s, or pick one now.`;
  } else {
    await callSearchBot();
    return;
  }
  if (Date.now() - current.lastPoll >= SEARCH_POLL_MS) await pollSearch();
}

/** Realtime is the fast path; this poll covers a dropped socket. */
async function pollSearch(): Promise<void> {
  const current = search;
  if (!current || current.id === null) return;
  current.lastPoll = Date.now();
  const loaded = await loadMatch(current.session, current.id);
  if (search !== current || loaded.kind !== 'ok') return;
  if (loaded.match.status !== 'open' && loaded.match.status !== 'active') {
    stopSearch();
    setOnlineStatus('This search has ended. Start a new one.');
    return;
  }
  if (loaded.match.guestPlayer) handleSearchMatch(loaded.match);
}

async function callSearchBot(difficulty?: 'recruit' | 'veteran'): Promise<void> {
  const current = search;
  if (!current || current.id === null || current.callingBot) return;
  current.callingBot = true;
  current.notice = null;
  searchBotEasyBtn.disabled = true;
  searchBotHardBtn.disabled = true;
  searchCountdown.textContent = 'An AI commander is taking the seat…';
  const result = await referee.bot(current.session, current.id, difficulty);
  if (search !== current) return;
  current.callingBot = false;
  searchBotEasyBtn.disabled = false;
  searchBotHardBtn.disabled = false;
  if (result.ok && result.match.guestPlayer) {
    handleSearchMatch(result.match);
    return;
  }
  // Refused (too early, or too many ranked AI matches) or failed: keep
  // searching, and ask once more a little later.
  if (difficulty === undefined && ++current.botAttempts < 2) current.deadline = Date.now() + 30_000;
  else current.botRefused = true;
  current.notice = !result.ok && result.status !== 409 ? result.message : null;
  void tickSearch();
}

searchBotEasyBtn.addEventListener('click', () => { void callSearchBot('recruit'); });
searchBotHardBtn.addEventListener('click', () => { void callSearchBot('veteran'); });

onlineRandomBtn.addEventListener('click', () => { void startSearch(false); });

// --- The friend-match hub --------------------------------------------------

// One entry point for starting and returning to friend matches.
onlineAsyncBtn.addEventListener('click', () => { void openMatchesList(); });

/** Passive menu refresh: never creates an anonymous account on load. */
async function refreshMatchesBadge(): Promise<void> {
  if (!(await currentUserId())) { myMatchesBadge.style.display = 'none'; return; }
  const summaries = await loadMyMatches();
  if (!summaries) return;
  const needsYou = summaries.filter(s => s.match.status === 'active' && outcomeNeedsYou(s.outcome)).length;
  myMatchesBadge.textContent = `${needsYou} turn${needsYou === 1 ? '' : 's'}`;
  myMatchesBadge.style.display = needsYou > 0 ? '' : 'none';
}

let matchesLoadVersion = 0;

function closeMatchesList(): void {
  matchesLoadVersion++;
  matchesScreen.style.display = 'none';
  promptScreen.inert = false;
  battleScreen.inert = false;
}

async function openMatchesList(): Promise<void> {
  const alreadyOpen = matchesScreen.style.display === 'block';
  const version = ++matchesLoadVersion;
  matchesScreen.style.display = 'block';
  promptScreen.inert = true;
  battleScreen.inert = true;
  if (!alreadyOpen) {
    matchesScreen.scrollTop = 0;
    playerNameInput.value = getPlayerName() ?? '';
    document.getElementById('matches-title')!.focus();
  }
  matchesList.replaceChildren();
  matchesStatus.style.display = '';
  matchesStatus.textContent = 'Loading your matches…';
  matchesRefreshBtn.disabled = true;
  matchesRefreshBtn.textContent = 'Refresh';
  // A new player can browse the hub without creating an account yet.
  const summaries = await currentUserId() ? await loadMyMatches() : [];
  if (version !== matchesLoadVersion) return;
  matchesRefreshBtn.disabled = false;
  if (!summaries) {
    matchesStatus.textContent = 'Could not load your matches. Check your connection, then retry.';
    matchesRefreshBtn.textContent = 'Retry';
    return;
  }
  if (summaries.length === 0) {
    matchesStatus.textContent = 'No matches yet. Tap “New match”, then send the invite link to a friend.';
    return;
  }
  matchesStatus.style.display = 'none';
  renderMatches(matchesList, summaries, id => {
    const summary = summaries.find(s => s.match.id === id);
    if (summary?.outcome === 'searching') resumeSearch(summary.match, false);
    else void startAsyncGame(id);
  });
}

playerNameInput.addEventListener('change', () => {
  setPlayerName(playerNameInput.value);
  playerNameInput.value = getPlayerName() ?? '';
});
matchesNewBtn.addEventListener('click', () => { void startAsyncGame(null); });
matchesRefreshBtn.addEventListener('click', () => { void openMatchesList(); });
matchesBackBtn.addEventListener('click', () => {
  closeMatchesList();
  returnTo = null;
  onlineAsyncBtn.focus();
  void refreshMatchesBadge();
});
matchesScreen.addEventListener('keydown', event => {
  if (event.key === 'Escape') matchesBackBtn.click();
});

// --- Ranked ---------------------------------------------------------------

const rankedScreen = new RankedScreen(document.getElementById('ranked-screen')!, {
  openMatch: (id, searching) => {
    if (!searching) { void startAsyncGame(id, { ranked: true }); return; }
    void loadMatch(rankedSession, id).then(loaded => {
      if (loaded.kind === 'ok') resumeSearch(loaded.match, true);
      else void startAsyncGame(id, { ranked: true });
    });
  },
  findOpponent: () => { void startSearch(true); },
  closed: restoreFocus => {
    promptScreen.inert = false;
    battleScreen.inert = false;
    if (restoreFocus && rankedBtn.offsetParent) rankedBtn.focus();
  },
});

/** Ranked is a modal dialog over the menu: what's behind it is inert. */
function openRankedScreen(): void {
  promptScreen.inert = true;
  battleScreen.inert = true;
  void rankedScreen.open();
}

rankedBtn.addEventListener('click', openRankedScreen);

// The Ranked button appears only in the Android app with Play Games configured.
void rankedAvailable().then(available => { rankedBtn.style.display = available ? '' : 'none'; });

// --- Turn alerts --------------------------------------------------------------

async function refreshNotificationSetting(): Promise<void> {
  const version = asyncStartVersion;
  const native = Capacitor.isNativePlatform();
  const serverAlerts = await closedAppAlerts();
  if (version !== asyncStartVersion) return;
  asyncNotifyLabel.textContent = native ? 'Turn alerts on this device' : "Notify me when it's my turn";
  asyncNotifyCb.disabled = true;
  asyncNotifyCb.checked = false;
  asyncNotifyHint.textContent = 'Checking notifications…';
  const status = await getTurnNotificationStatus();
  if (version !== asyncStartVersion) return;
  asyncNotifyCb.checked = status.enabled;
  asyncNotifyCb.disabled = !status.available;
  asyncNotifyHint.textContent = !status.available
    ? 'Turn notifications are unavailable in this version of the app or browser.'
    : status.blocked ? 'Notifications are off for 7 Seconds in Android settings. Tap here to allow them.'
    : native && !serverAlerts ? LOCAL_TURN_HINT : '';
}

asyncNotifyHint.addEventListener('click', () => {
  if (asyncNotifyHint.textContent?.startsWith('Notifications are off')) void openTurnAlertSettings();
});

// Turn alerts opt-in after an explicit user gesture.
asyncNotifyCb.addEventListener('change', async () => {
  const version = asyncStartVersion;
  const enabled = asyncNotifyCb.checked;
  asyncNotifyCb.disabled = true;
  asyncNotifyHint.textContent = enabled ? 'Enabling…' : 'Turning off…';
  const ok = await setTurnNotifications(enabled).catch(() => false);
  if (version !== asyncStartVersion) return;
  asyncNotifyCb.disabled = false;
  asyncNotifyCb.checked = ok ? enabled : !enabled;
  if (!ok) {
    const status = await getTurnNotificationStatus().catch(() => null);
    if (version !== asyncStartVersion) return;
    asyncNotifyHint.textContent = status?.blocked
      ? 'Notifications are off for 7 Seconds in Android settings. Tap here to allow them.'
      : 'Could not turn on notifications. Check your connection and notification permissions, then try again.';
    return;
  }
  const serverAlerts = await closedAppAlerts();
  asyncNotifyHint.textContent = !enabled ? 'Turn notifications are off.'
    : Capacitor.isNativePlatform() && !serverAlerts ? LOCAL_TURN_HINT : "You'll be notified when it's your turn.";
});

// --- Lobby buttons ----------------------------------------------------------

onlineCopyBtn.addEventListener('click', async () => {
  const url = onlineShareUrl.value;
  if (navigator.share) {
    try {
      await navigator.share({ title: '7 Seconds — Online PvP', text: 'Join my game!', url });
    } catch {
      // User cancelled share sheet — ignore
    }
  } else {
    onlineShareUrl.select();
    await navigator.clipboard.writeText(url);
    onlineCopyBtn.textContent = 'Copied!';
    setTimeout(() => { onlineCopyBtn.textContent = 'Share Link'; }, 2000);
  }
});

onlineCancelBtn.addEventListener('click', () => {
  // Leaving a search withdraws it, unless someone joined meanwhile.
  if (search?.id) void referee.cancel(search.session, search.id);
  stopSearch();
  newBattleBtn.click();
});

/** Open a match from a link or a tapped alert. Ranked matches need the ranked
 *  sign-in; without it, the Ranked screen asks for it. */
async function openLinkedMatch(id: string, ranked: boolean): Promise<void> {
  if (ranked && !await rankedSignedIn()) {
    openRankedScreen();
    return;
  }
  void startAsyncGame(id, { ranked });
}

window.addEventListener('age-verified-async-join', ((e: CustomEvent<string>) => {
  const [id, ranked] = e.detail.split('|');
  void openLinkedMatch(id, ranked === 'ranked');
}) as EventListener);

// Clean up online connections on tab close to avoid zombie Supabase channels
window.addEventListener('beforeunload', () => {
  asyncController?.destroy();
  stopSearch();
});

// A tapped alert uses the same entry route and age gate as an invite link.
void initializeTurnNotifications(
  (id, ranked) => { window.location.assign(getAsyncShareUrl(id, ranked)); },
  () => { void refreshMatchesBadge(); },
);

document.addEventListener('visibilitychange', () => {
  audio.setPageHidden(document.visibilityState === 'hidden');
});
// Closing the page mid-fight counts the same as pressing Exit.
window.addEventListener('pagehide', forfeitTrackedBattle);

// Browsers only allow audio after a user gesture; every button also clicks.
document.addEventListener('pointerdown', () => audio.unlock(), { capture: true });
document.addEventListener('keydown', () => audio.unlock(), { capture: true });
document.addEventListener('click', event => {
  const button = (event.target as Element | null)?.closest?.('button, .upgrade-card');
  if (button && button !== confirmBtn) audio.play('ui');
}, { capture: true });

// Initialize renderer and show battlefield preview behind start screen
(async () => {
  await initRenderer();
  applyTheme();
  showPreview();
  showScreen('prompt');

  // Count available turns without signing in a new player on load.
  void refreshMatchesBadge();

  // Online match link (?amatch=id, plus &ranked=1 for ranked matches).
  const asyncJoinId = getAsyncJoinId();
  if (asyncJoinId) {
    const ranked = new URLSearchParams(window.location.search).get('ranked') === '1';
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('amatch');
    cleanUrl.searchParams.delete('ranked');
    window.history.replaceState({}, '', cleanUrl.toString());
    if (localStorage.getItem('7s-age-verified')) {
      void openLinkedMatch(asyncJoinId, ranked);
    } else {
      sessionStorage.setItem('7s-pending-async-join', ranked ? `${asyncJoinId}|ranked` : asyncJoinId);
    }
    return;
  }

  // First launch: walk new players through the tutorial (once the age gate is passed).
  if (!tutorialSeen() && !new URLSearchParams(location.search).has('record')) {
    if (localStorage.getItem('7s-age-verified')) {
      void startTutorial();
    } else {
      window.addEventListener('age-verified', () => void startTutorial(), { once: true });
    }
  }
})();
