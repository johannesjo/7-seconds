import { Renderer } from './renderer';
import { Capacitor } from '@capacitor/core';
import { notifyLocalTurn } from './notify';
import { GameEngine } from './game';
import { createArmy, createMissionArmy, createUnitFromState } from './units';
import { generateBattlefield, generateHordeObstacles, generateHordeElevationZones } from './battlefield';
import { BattleResult, TurnPhase, Unit, Obstacle, ElevationZone, ReplayData, Team } from './types';
import { ARMY_COMPOSITION, HORDE_MAX_WAVES, ROUND_DURATION_S, MAP_HEIGHT, SHIELD_MAX_HITS } from './constants';
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
const resultStatsEl = document.getElementById('result-stats')!;
const rematchBtn = document.getElementById('rematch-btn')!;
const retryEncounterBtn = document.getElementById('retry-encounter-btn')!;
const newBattleBtn = document.getElementById('new-battle-btn')!;
const replayBtn = document.getElementById('replay-btn')!;

const waveCounterEl = document.getElementById('wave-counter')!;
const upgradeScreen = document.getElementById('upgrade-screen')!;
const upgradeCardsEl = document.getElementById('upgrade-cards')!;
const upgradeReplayBtn = document.getElementById('upgrade-replay-btn') as HTMLButtonElement;

const dayModeCb = document.getElementById('day-mode-cb') as HTMLInputElement;
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

function showUnitInfo(unit: Unit | null): void {
  unitInfo.hidden = !unit;
  if (!unit) return;
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
let retryEncounter: { state: OnlineGameState; seed: number } | null = null;
let canRetryEncounter = false;

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
  promptScreen.classList.toggle('active', screen === 'prompt');
  battleScreen.classList.add('active'); // always visible once initialized
  resultScreen.classList.toggle('active', screen === 'result');
  upgradeScreen.style.display = screen === 'horde-upgrade' ? 'flex' : 'none';
  retryEncounterBtn.style.display = screen === 'result' && canRetryEncounter ? '' : 'none';
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
  winnerTextEl.textContent = tutorialPassed ? 'Nicely done!' : 'Try again';
  winnerTextEl.style.color = 'var(--color-result-blue)';
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
      roundTimerEl.textContent = `${Math.ceil(timeLeft)}s`;

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
      const color = result.winner === 'blue' ? 'var(--color-result-blue)' : 'var(--color-result-red)';
      winnerTextEl.innerHTML = `${result.winner === 'blue' ? 'Blue' : 'Red'} Wins!<br><span style="font-size:0.5em;opacity:0.7">${winType}</span>`;
      winnerTextEl.style.color = color;

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

    const color = result.winner === 'blue' ? 'var(--color-result-blue)' : 'var(--color-result-red)';
    winnerTextEl.innerHTML = `${result.winner === 'blue' ? 'Blue' : 'Red'} Wins!<br><span style="font-size:0.5em;opacity:0.7">Elimination!</span>`;
    canRetryEncounter = aiMode && result.winner === 'red' && retryEncounter !== null;
    winnerTextEl.style.color = color;

    const blueTotal = ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0);
    const redTotal = ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0);

    const statsLines = [
      `Duration: ${result.duration.toFixed(1)}s`,
      `Blue survivors: ${result.blueAlive}/${blueTotal}`,
      `Red survivors: ${result.redAlive}/${redTotal}`,
    ];
    resultStatsEl.innerHTML = statsLines.join('<br>');

    rematchBtn.textContent = aiMode ? 'New encounter' : 'Rematch';
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
  lastReplayData = null;
  engine?.stop();
  document.body.classList.toggle('day-mode', dayModeCb.checked);
  renderer!.setTheme(dayModeCb.checked ? DAY_THEME : NIGHT_THEME);
  engine = new GameEngine(renderer!, onGameEvent, {
    aiMode: tutorialLesson === null && aiMode,
    practice: tutorialLesson === null ? undefined : createTutorialEncounter(tutorialLesson),
    initialState: encounter?.state,
    seed: encounter?.seed,
    onInspectUnit: showUnitInfo,
  });
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

function startCtfGame(): void {
  lastReplayData = null;
  engine?.stop();
  document.body.classList.toggle('day-mode', dayModeCb.checked);
  renderer!.setTheme(dayModeCb.checked ? DAY_THEME : NIGHT_THEME);
  engine = new GameEngine(renderer!, onGameEvent, {
    aiMode: !ctfHotseat,
    ctfMode: true,
    ctfHotseat,
    onInspectUnit: showUnitInfo,
  });
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
    }
  });
  replayPlayer.start();
}

function stopReplay(): void {
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
  document.body.classList.toggle('day-mode', dayModeCb.checked);
  renderer!.setTheme(dayModeCb.checked ? DAY_THEME : NIGHT_THEME);
  engine = new GameEngine(renderer!, onGameEvent, {
    aiMode: true,
    horde: true,
    hordeBlueUnits: hordeUnits,
    hordeRedArmy: waveDef.enemies,
    hordeMap: hordeMap!,
    onInspectUnit: showUnitInfo,
  });

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

  showScreen('horde-upgrade');
}

function showHordeResult(victory: boolean): void {
  engine?.stop();

  if (victory) {
    winnerTextEl.innerHTML = 'Horde Mode Complete!<br><span style="font-size:0.5em;opacity:0.7">All 10 waves cleared!</span>';
    winnerTextEl.style.color = 'var(--color-result-horde-win)';
  } else {
    winnerTextEl.innerHTML = `Defeated!<br><span style="font-size:0.5em;opacity:0.7">Fallen on Wave ${hordeWave}</span>`;
    winnerTextEl.style.color = 'var(--color-result-red)';
  }

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

dayModeCb.addEventListener('change', () => {
  document.body.classList.toggle('day-mode', dayModeCb.checked);
  if (renderer) renderer.setTheme(dayModeCb.checked ? DAY_THEME : NIGHT_THEME);
});

// --- Event listeners ---
battleBtn.addEventListener('click', async () => {
  aiMode = false;
  await initRenderer();
  startGame();
});

aiBtn.addEventListener('click', async () => {
  aiMode = true;
  await initRenderer();
  startGame();
});

tutorialBtn.addEventListener('click', async () => {
  await initRenderer();
  tutorialLesson = 0;
  startGame();
});

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
    return;
  }
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
      tutorialLesson = null;
      aiMode = true;
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
  engine?.stop();
  engine = null;
  planningOverlay.classList.remove('active');
  confirmBtn.classList.remove('active');
  coverScreen.classList.remove('active');
  roundTimerEl.textContent = '';
  lastReplayData = null;
  tutorialLesson = null;
  retryEncounter = null;
  canRetryEncounter = false;
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
  if (reopen === 'ranked') void rankedScreen.open();
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
asyncForfeitBtn.addEventListener('click', () => {
  const ranked = asyncSession.ranked && asyncController?.record?.status === 'active';
  if (ranked && !confirm('Concede this ranked match? It counts as a loss.')) return;
  asyncForfeitBtn.style.display = 'none';
  setOnlineStatus('Forfeiting…', true);
  void asyncController?.forfeit();
});

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
    playbackEngine.startPlaying();
    renderer!.ticker.add(asyncTickCallback);
  });
}

/** How a finished match is headlined, from this player's side. */
function resultText(status: string, reason: FinishReason | null, iWon: boolean): { title: string; detail: string } {
  if (status === 'abandoned') {
    switch (reason) {
      case 'version': return { title: 'Match Ended', detail: 'It was made with another version of the game' };
      case 'cancelled': return { title: 'Match Withdrawn', detail: 'Nobody had joined yet' };
      default: return { title: 'Match Abandoned', detail: 'Nobody played for too long' };
    }
  }
  const who = opponentName();
  const named = who[0].toUpperCase() + who.slice(1);
  switch (reason) {
    case 'forfeit': return { title: iWon ? 'You Win!' : 'You Lose', detail: iWon ? `${named} conceded` : 'You conceded' };
    case 'timeout': return { title: iWon ? 'You Win!' : 'You Lose', detail: iWon ? `${named} ran out of time` : 'You ran out of time' };
    default: return { title: iWon ? 'You Win!' : 'You Lose', detail: 'Elimination!' };
  }
}

/** Bridge the online protocol controller to the UI / playback engine. */
function asyncHooks(): AsyncGameHooks {
  return {
    onPlanTurn(round, startState, myTeam, awaitingGuest, afterError) {
      asyncCurrentRound = round;
      asyncMyTeam = myTeam;
      stopPlaybackEngine();

      document.body.classList.toggle('day-mode', dayModeCb.checked);
      renderer!.setTheme(dayModeCb.checked ? DAY_THEME : NIGHT_THEME);
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
        asyncForfeitBtn.textContent = 'Withdraw invite';
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
      if (matchId) void closedAppAlerts().then(serverAlerts => { if (!serverAlerts) void notifyLocalTurn(matchId, round); });
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
        asyncForfeitBtn.textContent = 'Withdraw invite';
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
        winnerTextEl.style.color = ''; // neutral, not a win/loss color
      } else {
        const winner: Team = status === 'guest_won' ? 'red' : 'blue';
        const iWon = myTeam === winner;
        if (!ranked && opponentId && matchId) recordMatchResultOnce(matchId, opponentId, iWon);
        winnerTextEl.style.color = winner === 'blue' ? 'var(--color-result-blue)' : 'var(--color-result-red)';
      }
      winnerTextEl.innerHTML = `${title}<br><span style="font-size:0.5em;opacity:0.7"></span>`;
      (winnerTextEl.lastElementChild as HTMLElement).textContent = detail;
      const blueAlive = finalState.units.filter(u => u.team === 'blue' && u.hp > 0).length;
      const redAlive = finalState.units.filter(u => u.team === 'red' && u.hp > 0).length;
      resultStatsEl.innerHTML = [`Blue survivors: ${blueAlive}`, `Red survivors: ${redAlive}`].join('<br>');
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
      asyncForfeitBtn.textContent = 'Forfeit match';
      asyncForfeitBtn.style.display = canForfeit ? '' : 'none';
      onlineLobby.style.display = 'flex';
      showScreen('battle');
    },

    onMatch(match) {
      updateBattleNote();
      if (match.ranked) void refreshRankedView(match.id);
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
  search = { session, id: null, deadline: Infinity, timer: null, unsubscribe: null, callingBot: false, botAttempts: 0, botRefused: false, lastPoll: 0 };

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
  void initRenderer().then(() => {
    showSearchLobby(ranked);
    search = { session: ranked ? rankedSession : casualSession, id: null, deadline: Infinity, timer: null, unsubscribe: null, callingBot: false, botAttempts: 0, botRefused: false, lastPoll: 0 };
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
  if (current.botRefused) {
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
  if (!result.ok && result.status !== 409) searchCountdown.textContent = result.message;
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

const rankedScreen = new (class extends RankedScreen {
  /** Close without the "closed" side effects (another screen takes over). */
  hide(): void { if (this.isOpen) super.close(); }
})(document.getElementById('ranked-screen')!, {
  openMatch: (id, searching) => {
    if (!searching) { void startAsyncGame(id, { ranked: true }); return; }
    void loadMatch(rankedSession, id).then(loaded => {
      if (loaded.kind === 'ok') resumeSearch(loaded.match, true);
      else void startAsyncGame(id, { ranked: true });
    });
  },
  findOpponent: () => { void startSearch(true); },
  closed: () => {
    promptScreen.inert = false;
    battleScreen.inert = false;
  },
});

rankedBtn.addEventListener('click', () => {
  promptScreen.inert = true;
  battleScreen.inert = true;
  void rankedScreen.open();
});

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
    asyncNotifyHint.textContent = 'Could not turn on notifications. Check your connection and notification permissions, then try again.';
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
    promptScreen.inert = true;
    battleScreen.inert = true;
    void rankedScreen.open();
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

// Initialize renderer and show battlefield preview behind start screen
(async () => {
  await initRenderer();
  document.body.classList.toggle('day-mode', dayModeCb.checked);
  if (dayModeCb.checked) renderer!.setTheme(DAY_THEME);
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
})();
