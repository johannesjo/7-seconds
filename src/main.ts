import { Renderer } from './renderer';
import { GameEngine } from './game';
import { createArmy, createMissionArmy, createUnitFromState } from './units';
import { generateBattlefield, generateHordeObstacles, generateHordeElevationZones } from './battlefield';
import { BattleResult, TurnPhase, Unit, Obstacle, ElevationZone, ReplayData, Team } from './types';
import { ARMY_COMPOSITION, HORDE_MAX_WAVES, ROUND_DURATION_S, MAP_HEIGHT, SHIELD_MAX_HITS } from './constants';
import { HORDE_WAVES, pickUpgrades, healAllBlue, repositionBlueUnits, randomHordeStartingArmy, applyUpgradesToUnit } from './horde';
import { ReplayPlayer } from './replay';
import { DAY_THEME, NIGHT_THEME } from './theme';
import { findMatch } from './online-matchmaking';
import { AsyncGameController, type PlayRoundInput, type AsyncGameHooks } from './online-async-game';
import type { PathList } from './online-async-core';
import { outcomeNeedsYou } from './online-async-core';
import { createAsyncMatch, loadMatch, getAsyncJoinId, loadMyMatches, getAsyncShareUrl } from './online-async';
import { currentUserId } from './online-auth';
import { initializeTurnNotifications, getTurnNotificationStatus, setTurnNotifications } from './online-push';
import { rememberOpenMatch, renderMatches } from './match-list';
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
 *  cue while the app is focused; the server delivers background push alerts. */
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

// Online state. `onlineActive` flags an online flow in progress (matchmaking or
// an async match), so the matchmaking search can be cancelled. The playback*
// state is the local player's board: drawn during planning and animated by the
// headless engine when a resolved round plays back.
let onlineActive = false;
let returnToMatches = false;
let asyncStartVersion = 0;
let playbackPathDrawer: PathDrawer | null = null;
let playbackUnits: Unit[] = [];
let playbackElevationZones: ElevationZone[] = [];
let cancelMatchmaking: (() => void) | null = null;
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
/** Deterministic authoritative round result, computed up front (frame-rate
 *  independent). The animated playback is cosmetic; this is what we persist. */
let asyncResult: { endState: OnlineGameState; gameOver: boolean } | null = null;

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
  const reopenMatches = returnToMatches;
  returnToMatches = false;
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
  if (reopenMatches) void openMatchesList();
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

// --- Async ("play-by-mail") online matches -------------------------------

const ASYNC_ROUND_END_TICK = Math.round(ROUND_DURATION_S * 60);

/** Tear down any in-progress async match. */
function destroyAsync(): void {
  asyncStartVersion++;
  asyncController?.destroy();
  asyncController = null;
  playbackPathDrawer?.destroy();
  playbackPathDrawer = null;
  renderer?.ticker.remove(asyncTickCallback);
  stopPlaybackEngine();
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

// Forfeit: concede the match to escape an unrecoverable state (or just give up).
asyncForfeitBtn.addEventListener('click', () => {
  asyncForfeitBtn.style.display = 'none';
  setOnlineStatus('Forfeiting…', true);
  void asyncController?.forfeit();
});

/** Ticker callback that animates a resolved async round headlessly and, once
 *  it ends deterministically (a side eliminated, or the fixed round duration
 *  elapses), reports the authoritative end state back to the controller. */
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
  // The animation's end timing is cosmetic; the persisted result is the
  // deterministic one computed in startAsyncRoundPlayback (frame-independent).
  if (asyncMatchEnded || tick >= ASYNC_ROUND_END_TICK) {
    asyncRoundFinished = true;
    renderer.ticker.remove(asyncTickCallback);
    lastReplayData = playbackEngine.getReplayData() ?? lastReplayData;
    const round = asyncCurrentRound;
    const result = asyncResult;
    stopPlaybackEngine();
    if (result) void asyncController?.onRoundPlayed(round, result.endState, result.gameOver);
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

/** Run a resolved round: compute the authoritative outcome deterministically,
 *  then animate the same round for the player to watch. */
function startAsyncRoundPlayback(input: PlayRoundInput): void {
  stopPlaybackEngine();
  asyncMatchEnded = false;
  asyncRoundFinished = false;
  // The round reported back via onRoundPlayed when playback ends. onPlanTurn
  // also sets this, but it never fires when a match is reopened mid-round (the
  // controller goes straight to reveal/resolve) — a stale round made the
  // controller drop the report and wedged the round.
  asyncCurrentRound = input.round;

  // Vary the PRNG per round (matches the live path's seed + roundNumber scheme;
  // resolveRound and the cosmetic engine both start fresh with roundNumber=1, so
  // without this every round would reuse the same sequence). Applied to BOTH
  // passes and derived only from (match seed, round) so it's identical on every
  // client. Round 1 keeps seed+1, so the match seed itself is unchanged.
  const roundSeed = input.seed + (input.round - 1);

  // Authoritative, frame-rate-independent result — identical on every client.
  asyncResult = GameEngine.resolveRound(
    input.startState, input.bluePaths, input.redPaths, roundSeed, ASYNC_ROUND_END_TICK,
  );

  // Cosmetic animated playback (its sampled end state is NOT persisted).
  playbackEngine = new GameEngine(null, (type) => {
    if (type === 'end') asyncMatchEnded = true;
  }, { seed: roundSeed });
  playbackEngine.loadOnlineGameState(input.startState);
  playbackEngine.setBluePaths(input.bluePaths);
  playbackEngine.setRedPaths(input.redPaths);
  roundCounterEl.textContent = `Round ${input.round}`;

  // Paint the starting positions so the player can read the board, then count
  // in 3-2-1 before the action animates — a beat to orient on who's where
  // before "what happened" replays. startPlaying() is deferred to the count's end.
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

/** Bridge the async protocol controller to the UI / playback engine. */
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
      showScreen('battle');

      if (awaitingGuest && !asyncMatchmade) {
        // Host's first move before a friend joins. The full-screen lobby would
        // cover the canvas, so we keep the invite up with a "Plan first move"
        // button that dismisses the lobby into the (already set-up) planning UI.
        // No "your turn" notification — the host just opened this themselves.
        // (Matchmade games skip this: the stranger is already arriving, so the
        // host just plans — no share link.)
        planningOverlay.classList.remove('active');
        confirmBtn.classList.remove('active');
        onlineShareContainer.style.display = '';
        asyncNotify.style.display = 'flex';
        // Offer Forfeit even while waiting for a guest: lets a host clear an open
        // match to get back under the concurrent-match cap (forfeit() handles
        // 'open' matches), so the cap warning's advice is actually actionable.
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
      // Re-prompted after a failed submit: keep the error toast readable.
      if (afterError) return;
      // Background turn alerts are delivered by the server via native/Web Push.
      if (document.visibilityState === 'visible') showToast("It's your turn!");
    },

    onAwaitOpponent(round, awaitingGuest) {
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
        // Same as the first-move screen: allow forfeiting an open match so the
        // host can drop back under the concurrent-match cap without a guest.
        asyncForfeitBtn.style.display = '';
        setOnlineStatus('First move locked in! Share the link — the match begins when a friend joins.', true);
      } else {
        onlineShareContainer.style.display = 'none';
        setOnlineStatus(`Turn submitted (round ${round}). Waiting for your friend — you can safely leave and return later.`, true);
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

    onGameOver(status, finalState) {
      // Capture from the controller before destroyAsync(): use its authoritative
      // team, not the module-level asyncMyTeam — the latter is only set when WE
      // plan a round this session, so it's stale (and would invert the result)
      // when a finished match is reopened from "My Matches". The W/L record is
      // keyed by opponent uid + match id, recorded once per match.
      const myTeam = asyncController?.team ?? asyncMyTeam;
      const opponentId = asyncController?.opponentId ?? null;
      const matchId = asyncController?.matchId ?? null;
      destroyAsync();
      // When a match ends without round playback the lobby overlay was never
      // dismissed by onPlayRound, so hide it here or it covers the result screen
      // (z-index:25) and the match looks stuck. Three such paths: forfeit
      // (finish -> onGameOver directly), reopening an already-finished match
      // from "My Matches", and a poll/realtime detecting the opponent abandoned
      // while we sit on the await screen. Hiding the lobby also hides the share
      // box nested inside it.
      onlineLobby.style.display = 'none';
      if (status === 'abandoned') {
        winnerTextEl.innerHTML = `Match Abandoned<br><span style="font-size:0.5em;opacity:0.7">Your opponent left</span>`;
        winnerTextEl.style.color = ''; // neutral, not a win/loss color
      } else {
        const winner: Team = status === 'guest_won' ? 'red' : 'blue';
        const iWon = (myTeam === winner);
        if (opponentId && matchId) recordMatchResultOnce(matchId, opponentId, iWon);
        const color = winner === 'blue' ? 'var(--color-result-blue)' : 'var(--color-result-red)';
        winnerTextEl.innerHTML = `${iWon ? 'You Win!' : 'You Lose'}<br><span style="font-size:0.5em;opacity:0.7">Elimination!</span>`;
        winnerTextEl.style.color = color;
      }
      const blueAlive = finalState.units.filter(u => u.team === 'blue' && u.hp > 0).length;
      const redAlive = finalState.units.filter(u => u.team === 'red' && u.hp > 0).length;
      resultStatsEl.innerHTML = [`Blue survivors: ${blueAlive}`, `Red survivors: ${redAlive}`].join('<br>');
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
      // A forfeitable error (e.g. a lost commit that can never be revealed) is a
      // dead end otherwise — offer a clean way to concede and end the match.
      asyncForfeitBtn.style.display = canForfeit ? '' : 'none';
      onlineLobby.style.display = 'flex';
      showScreen('battle');
    },
  };
}

/** Soft cap on simultaneously in-play async matches per player. */
const MAX_CONCURRENT_ASYNC_MATCHES = 5;

/** True while the current async match was created via stranger matchmaking, so
 *  both players are already present: the host should plan immediately rather
 *  than see the friend-invite "share this link / plan your first move" UX. */
let asyncMatchmade = false;

/** Start an async match: create a new one (host) or open/join an existing one. */
async function startAsyncGame(roomId: string | null, opts: { matchmade?: boolean } = {}): Promise<void> {
  destroyAsync();
  const version = asyncStartVersion;
  asyncMatchmade = opts.matchmade ?? false;
  returnToMatches = true;
  onlineActive = true;
  asyncBackBtn.style.display = 'block';
  closeMatchesList();
  showScreen('battle');
  onlineLobby.style.display = 'flex';
  onlineCancelBtn.textContent = 'Back to matches';
  onlineShareContainer.style.display = 'none';
  onlineStatus.style.display = '';
  showOnlineRecord(); // overall W/L (self-hides when there are no games yet)
  asyncNotify.style.display = 'flex';
  void refreshNotificationSetting();
  setOnlineStatus(roomId ? 'Loading match…' : 'Creating match…', true);
  await initRenderer();
  if (version !== asyncStartVersion) return;

  let id = roomId;
  if (!id) {
    // Cap concurrent open matches so a player can't strand a pile of zombies a
    // friend never joins (and clutter their own list). Existing matches can
    // always be resumed/forfeited from the match hub.
    const mine = await loadMyMatches();
    if (version !== asyncStartVersion) return;
    if (!mine) {
      setOnlineStatus('Could not load your matches. Go back and try again.');
      return;
    }
    const liveCount = mine.filter(s =>
      s.match.status === 'open' || s.match.status === 'active').length;
    if (liveCount >= MAX_CONCURRENT_ASYNC_MATCHES) {
      setOnlineStatus(`You have ${liveCount} unfinished matches. Go back to your matches and finish or forfeit one before starting another.`);
      return;
    }
    setOnlineStatus('Creating match...', true);
    const generated = GameEngine.generateInitialState();
    const created = await createAsyncMatch(generated);
    if (version !== asyncStartVersion) return;
    if (!created) {
      setOnlineStatus('Could not create a match. Check your connection, then go back and try again.');
      return;
    }
    id = created.match.id;
    onlineShareContainer.style.display = '';
    setOnlineStatus('Share this link with your friend — the match starts when they join.', true);
  } else {
    setOnlineStatus('Loading match...', true);
  }

  // Populate the invite link for both new and resumed host matches: when a host
  // reopens an open match, the hooks reveal the share box but never set the URL,
  // so without this the field shows up empty. getAsyncShareUrl is id-only/pure.
  onlineShareUrl.value = getAsyncShareUrl(id);

  const controller = new AsyncGameController(id, asyncHooks());
  asyncController = controller;
  const ok = await controller.start();
  if (version !== asyncStartVersion) return;
  if (!ok) {
    controller.destroy();
    asyncController = null;
  } else {
    rememberOpenMatch(id);
  }
}

// One entry point for starting and returning to durable online matches.
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
  renderMatches(matchesList, summaries, id => { void startAsyncGame(id); });
}

matchesNewBtn.addEventListener('click', () => { void startAsyncGame(null); });
matchesRefreshBtn.addEventListener('click', () => { void openMatchesList(); });
matchesBackBtn.addEventListener('click', () => {
  closeMatchesList();
  returnToMatches = false;
  onlineAsyncBtn.focus();
  void refreshMatchesBadge();
});
matchesScreen.addEventListener('keydown', event => {
  if (event.key === 'Escape') matchesBackBtn.click();
});

async function refreshNotificationSetting(): Promise<void> {
  const version = asyncStartVersion;
  asyncNotifyCb.disabled = true;
  asyncNotifyCb.checked = false;
  asyncNotifyHint.textContent = 'Checking notifications…';
  const status = await getTurnNotificationStatus();
  if (version !== asyncStartVersion) return;
  asyncNotifyCb.checked = status.enabled;
  asyncNotifyCb.disabled = !status.available;
  asyncNotifyHint.textContent = status.available ? '' : 'Turn notifications are unavailable in this version of the app or browser.';
}

// Native push / Web Push opt-in, only after an explicit user gesture.
asyncNotifyCb.addEventListener('change', async () => {
  const version = asyncStartVersion;
  const enabled = asyncNotifyCb.checked;
  asyncNotifyCb.disabled = true;
  asyncNotifyHint.textContent = enabled ? 'Enabling…' : 'Turning off…';
  const ok = await setTurnNotifications(enabled).catch(() => false);
  if (version !== asyncStartVersion) return;
  asyncNotifyCb.disabled = false;
  asyncNotifyCb.checked = ok ? enabled : !enabled;
  asyncNotifyHint.textContent = ok
    ? (enabled ? "You'll be notified when it's your turn." : 'Turn notifications are off.')
    : 'Could not save notifications. Check your connection and notification permissions, then try again.';
});

// How long a matchmade guest waits for the host's freshly-created match row to
// replicate into view before giving up: up to JOIN_LAG_TRIES probes spaced
// JOIN_LAG_INTERVAL_MS apart (~4s total; normally resolves on the first probe).
const JOIN_LAG_TRIES = 8;
const JOIN_LAG_INTERVAL_MS = 500;

// Online vs Random — client-side matchmaking via Supabase Realtime
onlineRandomBtn.addEventListener('click', async () => {
  onlineActive = true;
  returnToMatches = false;
  onlineCancelBtn.textContent = 'Cancel search';

  await initRenderer();

  onlineLobby.style.display = 'flex';
  onlineShareContainer.style.display = 'none';
  showOnlineRecord();
  setOnlineStatus('Searching for opponent...', true);

  const { promise, cancel } = findMatch();
  cancelMatchmaking = cancel;

  try {
    const result = await promise;
    cancelMatchmaking = null;

    // Both peers paired on the same room id via presence. Run the stranger game
    // on the durable log too: the host creates the match under that id; the
    // guest joins it. No WebRTC — a present opponent just makes the turn log
    // resolve within seconds (Realtime), and a leaver degrades to play-by-mail.
    if (result.role === 'host') {
      setOnlineStatus('Opponent found! Setting up game...', true);
      const created = await createAsyncMatch(GameEngine.generateInitialState(), result.roomId);
      if (!created) {
        if (onlineActive) setOnlineStatus('Could not start the match. Try again.');
        return;
      }
      await startAsyncGame(result.roomId, { matchmade: true });
    } else {
      setOnlineStatus('Opponent found! Joining game...', true);
      // The host writes the match row right after pairing; tolerate the brief
      // replication lag before it's queryable (also rides out a transient read).
      let exists = false;
      for (let i = 0; i < JOIN_LAG_TRIES && onlineActive && !exists; i++) {
        exists = (await loadMatch(result.roomId)) != null;
        // No sleep after the final probe — we're about to give up anyway.
        if (!exists && i < JOIN_LAG_TRIES - 1) await new Promise((r) => setTimeout(r, JOIN_LAG_INTERVAL_MS));
      }
      if (!exists) {
        if (onlineActive) setOnlineStatus('Could not join the match. Try again.');
        return;
      }
      await startAsyncGame(result.roomId, { matchmade: true });
    }
  } catch {
    cancelMatchmaking = null;
    if (onlineActive) {
      setOnlineStatus('No opponent found. Try again.');
    }
  }
});

// Online lobby share/copy button
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
  cancelMatchmaking?.();
  cancelMatchmaking = null;
  newBattleBtn.click();
});

window.addEventListener('age-verified-async-join', ((e: CustomEvent<string>) => {
  void startAsyncGame(e.detail);
}) as EventListener);

// Clean up online connections on tab close to avoid zombie Supabase channels
window.addEventListener('beforeunload', () => {
  asyncController?.destroy();
});

// A push tap uses the same entry route and age gate as a shared invite link.
void initializeTurnNotifications(id => { window.location.assign(getAsyncShareUrl(id)); });

// Initialize renderer and show battlefield preview behind start screen
(async () => {
  await initRenderer();
  document.body.classList.toggle('day-mode', dayModeCb.checked);
  if (dayModeCb.checked) renderer!.setTheme(DAY_THEME);
  showPreview();
  showScreen('prompt');

  // Count available turns without signing in a new player on load.
  void refreshMatchesBadge();

  // Async match link (?amatch=) — distinct from live ?join= WebRTC rooms.
  const asyncJoinId = getAsyncJoinId();
  if (asyncJoinId) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('amatch');
    window.history.replaceState({}, '', cleanUrl.toString());
    if (localStorage.getItem('7s-age-verified')) {
      void startAsyncGame(asyncJoinId);
    } else {
      sessionStorage.setItem('7s-pending-async-join', asyncJoinId);
    }
    return;
  }
})();
