import { Renderer } from './renderer';
import { GameEngine } from './game';
import { createArmy, createMissionArmy, createUnitFromState } from './units';
import { generateObstacles, generateElevationZones, generateHordeObstacles, generateHordeElevationZones } from './battlefield';
import { BattleResult, TurnPhase, Unit, Obstacle, ElevationZone, ReplayData, Team } from './types';
import { ARMY_COMPOSITION, HORDE_MAX_WAVES, ROUND_DURATION_S } from './constants';
import { HORDE_WAVES, pickUpgrades, healAllBlue, repositionBlueUnits, randomHordeStartingArmy, applyUpgradesToUnit } from './horde';
import { ReplayPlayer } from './replay';
import { DAY_THEME, NIGHT_THEME } from './theme';
import { findMatch } from './online-matchmaking';
import { AsyncGameController, type PlayRoundInput, type AsyncGameHooks } from './online-async-game';
import type { PathList, MatchOutcome } from './online-async-core';
import { outcomeNeedsYou } from './online-async-core';
import { createAsyncMatch, loadMatch, getAsyncJoinId, loadMyMatches } from './online-async';
import { currentUserId } from './online-auth';
import { registerTurnNotifications, setTurnNotifications } from './online-push';
import './online-debug'; // side-effect: shows debug overlay when ?debug=1
import { OnlineGameState } from './online-types';
import { PathDrawer } from './path-drawer';
import { recordMatchResultOnce, getOverallScore } from './online-score';
import { requestNotificationPermission, notify } from './notify';

// DOM elements
const promptScreen = document.getElementById('prompt-screen')!;
const battleScreen = document.getElementById('battle-screen')!;
const resultScreen = document.getElementById('result-screen')!;

const battleBtn = document.getElementById('battle-btn')!;
const aiBtn = document.getElementById('ai-btn')!;
const hordeBtn = document.getElementById('horde-btn')!;

const battleHud = document.getElementById('battle-hud')!;
const blueCountEl = document.getElementById('blue-count')!;
const redCountEl = document.getElementById('red-count')!;
const roundTimerEl = document.getElementById('round-timer')!;
const speedToggle = document.getElementById('speed-toggle') as HTMLButtonElement;

const planningOverlay = document.getElementById('planning-overlay')!;
const planningLabel = document.getElementById('planning-label')!;
const confirmBtn = document.getElementById('confirm-btn')!;
const coverScreen = document.getElementById('cover-screen')!;
const roundCounterEl = document.getElementById('round-counter')!;

const winnerTextEl = document.getElementById('winner-text')!;
const resultStatsEl = document.getElementById('result-stats')!;
const rematchBtn = document.getElementById('rematch-btn')!;
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
const myMatchesBtn = document.getElementById('my-matches-btn')!;
const myMatchesBadge = document.getElementById('my-matches-badge')!;
const matchesScreen = document.getElementById('matches-screen')!;
const matchesStatus = document.getElementById('matches-status')!;
const matchesList = document.getElementById('matches-list')!;
const matchesBackBtn = document.getElementById('matches-back-btn')!;
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

const toastEl = document.getElementById('toast')!;
let toastTimer: number | undefined;
/** Transient in-app banner that auto-dismisses. Used for the "it's your turn"
 *  cue while the app is focused; backgrounded users get notify() instead. */
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

function captureReplayData(): void {
  lastReplayData = engine?.getReplayData() ?? null;
}

function onGameEvent(
  event: 'update' | 'end' | 'phase-change' | 'wave-clear',
  data?: BattleResult | { phase: TurnPhase; timeLeft?: number; round?: number },
) {
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
    winnerTextEl.style.color = color;

    const blueTotal = ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0);
    const redTotal = ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0);

    const statsLines = [
      `Duration: ${result.duration.toFixed(1)}s`,
      `Blue survivors: ${result.blueAlive}/${blueTotal}`,
      `Red survivors: ${result.redAlive}/${redTotal}`,
    ];
    resultStatsEl.innerHTML = statsLines.join('<br>');

    rematchBtn.textContent = 'Rematch';
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
  renderer.renderElevationZones(generateElevationZones());
  renderer.renderObstacles(generateObstacles());
  const preview = [...createArmy('blue'), ...createArmy('red')];
  renderer.renderUnits(preview);
}

function startGame(): void {
  lastReplayData = null;
  engine?.stop();
  document.body.classList.toggle('day-mode', dayModeCb.checked);
  renderer!.setTheme(dayModeCb.checked ? DAY_THEME : NIGHT_THEME);
  engine = new GameEngine(renderer!, onGameEvent, {
    aiMode,
  });
  showScreen('battle');
  speedToggle.classList.remove('active');
  speedToggle.dataset.speed = '1';
  speedToggle.textContent = '3x';
  roundCounterEl.textContent = 'Round 1';
  engine.startBattle();
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
  replaySpeedToggle.textContent = '3x';
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
    const paths: PathList = myUnits.map(u => ({ unitId: u.id, waypoints: [...u.waypoints] }));
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
  if (ctfActive) {
    startCtfGame();
  } else if (hordeActive) {
    startHorde(); // restart from wave 1
  } else {
    startGame();
  }
});

newBattleBtn.addEventListener('click', () => {
  recorderMod?.cancelIfRecording();
  engine?.stop();
  engine = null;
  planningOverlay.classList.remove('active');
  confirmBtn.classList.remove('active');
  coverScreen.classList.remove('active');
  roundTimerEl.textContent = '';
  lastReplayData = null;

  // Reset online state
  destroyAsync();
  onlineActive = false;
  onlineLobby.style.display = 'none';

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
  const isActive = replaySpeedToggle.classList.toggle('active');
  const speed = isActive ? 3 : 1;
  replayPlayer?.setSpeed(speed);
  replaySpeedToggle.textContent = isActive ? '1x' : '3x';
});

/** Tear down the headless playback engine used to animate a resolved async
 *  round (shared teardown for the async match playback). */
function stopPlaybackEngine(): void {
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
  asyncController?.destroy();
  asyncController = null;
  renderer?.ticker.remove(asyncTickCallback);
  stopPlaybackEngine();
  asyncNotify.style.display = 'none';
  asyncFirstMoveBtn.style.display = 'none';
  asyncForfeitBtn.style.display = 'none';
}

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

/** Run a resolved round: compute the authoritative outcome deterministically,
 *  then animate the same round for the player to watch. */
function startAsyncRoundPlayback(input: PlayRoundInput): void {
  stopPlaybackEngine();
  asyncMatchEnded = false;
  asyncRoundFinished = false;

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
  playbackEngine.startPlaying();
  playbackEffectIndex = 0;
  roundCounterEl.textContent = `Round ${input.round}`;
  renderer!.ticker.add(asyncTickCallback);
}

/** Bridge the async protocol controller to the UI / playback engine. */
function asyncHooks(): AsyncGameHooks {
  return {
    onPlanTurn(round, startState, myTeam, awaitingGuest) {
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
        asyncForfeitBtn.style.display = 'none';
        asyncFirstMoveBtn.style.display = '';
        setOnlineStatus('Share this link so a friend can join — or plan your first move now.', false);
        onlineLobby.style.display = 'flex';
        return;
      }

      onlineLobby.style.display = 'none';
      asyncFirstMoveBtn.style.display = 'none';
      planningOverlay.classList.add('active');
      confirmBtn.classList.add('active');
      // It's the player's turn: in-app toast when focused; notify() (OS / native
      // Capacitor on Android) covers the backgrounded case and self-guards on
      // visibility, so the two never double-fire.
      if (document.visibilityState === 'visible') showToast("It's your turn!");
      notify('7 Seconds', "It's your turn to plan!");
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
  asyncMatchmade = opts.matchmade ?? false;
  await initRenderer();
  destroyAsync();
  showScreen('battle');
  onlineLobby.style.display = 'flex';
  onlineShareContainer.style.display = 'none';
  onlineStatus.style.display = '';
  showOnlineRecord(); // overall W/L (self-hides when there are no games yet)
  asyncNotify.style.display = 'flex';
  // Reflect current push state in the checkbox (permission granted ≈ subscribed).
  asyncNotifyCb.checked = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  asyncNotifyHint.textContent = '';
  void registerTurnNotifications();

  let id = roomId;
  if (!id) {
    // Cap concurrent open matches so a player can't strand a pile of zombies a
    // friend never joins (and clutter their own list). Existing matches can
    // always be resumed/forfeited from "My Matches".
    const mine = await loadMyMatches();
    const liveCount = mine?.filter(s =>
      s.match.status === 'open' || s.match.status === 'active').length ?? 0;
    if (liveCount >= MAX_CONCURRENT_ASYNC_MATCHES) {
      setOnlineStatus(`You already have ${liveCount} matches on the go. Finish or forfeit one from "My Matches" before starting another.`);
      return;
    }
    setOnlineStatus('Creating match...', true);
    const generated = GameEngine.generateInitialState();
    const created = await createAsyncMatch(generated);
    if (!created) {
      setOnlineStatus('Could not create match. Async play needs the backend enabled.');
      return;
    }
    id = created.match.id;
    onlineShareContainer.style.display = '';
    onlineShareUrl.value = created.shareUrl;
    setOnlineStatus('Share this link with your friend — the match starts when they join.', true);
  } else {
    setOnlineStatus('Loading match...', true);
  }

  asyncController = new AsyncGameController(id, asyncHooks());
  const ok = await asyncController.start();
  if (!ok) { asyncController = null; }
}

// Play a Friend — create a durable match and share its link. Live when the
// friend is also present (Realtime), play-by-mail when they're not.
onlineAsyncBtn.addEventListener('click', () => {
  requestNotificationPermission();
  void startAsyncGame(null);
});

// --- My Matches: resume any in-flight async match (drop-in / drop-out) -----

const MATCH_OUTCOME_UI: Record<MatchOutcome, { text: string; color: string }> = {
  'your-turn': { text: 'Your turn', color: 'var(--color-btn-green-text)' },
  'their-turn': { text: 'Their turn', color: 'var(--color-online-status)' },
  'waiting-for-guest': { text: 'Waiting for a friend to join', color: 'var(--color-online-status)' },
  'resolving': { text: 'Playing…', color: 'var(--color-online-status)' },
  'you-won': { text: 'You won', color: 'var(--color-result-blue)' },
  'you-lost': { text: 'You lost', color: 'var(--color-result-red)' },
  'abandoned': { text: 'Abandoned', color: 'var(--color-online-status)' },
};

/** Reveal the "My Matches" menu entry (with an unread badge) only for players
 *  who already have a session — never forces an anonymous account on load. */
async function refreshMatchesBadge(): Promise<void> {
  if (!(await currentUserId())) { myMatchesBtn.style.display = 'none'; return; }
  const summaries = await loadMyMatches();
  if (!summaries || summaries.length === 0) { myMatchesBtn.style.display = 'none'; return; }
  myMatchesBtn.style.display = '';
  const needsYou = summaries.filter(s => outcomeNeedsYou(s.outcome)).length;
  myMatchesBadge.textContent = String(needsYou);
  myMatchesBadge.style.display = needsYou > 0 ? '' : 'none';
}

async function openMatchesList(): Promise<void> {
  matchesScreen.style.display = 'flex';
  matchesList.innerHTML = '';
  matchesStatus.style.display = '';
  matchesStatus.textContent = 'Loading…';
  const summaries = await loadMyMatches();
  if (!summaries) {
    matchesStatus.textContent = 'Could not load your matches. Check your connection and try again.';
    return;
  }
  if (summaries.length === 0) {
    matchesStatus.textContent = 'No matches yet. Start an Async match to play a friend over time.';
    return;
  }
  matchesStatus.style.display = 'none';
  // Surface matches that need the player first, newest within each group.
  const sorted = [...summaries].sort(
    (a, b) => Number(outcomeNeedsYou(b.outcome)) - Number(outcomeNeedsYou(a.outcome)),
  );
  for (const s of sorted) {
    const ui = MATCH_OUTCOME_UI[s.outcome];
    const row = document.createElement('button');
    row.style.cssText = 'display:flex;justify-content:space-between;align-items:center;gap:12px;width:100%;box-sizing:border-box;padding:14px 16px;font-size:15px;background:var(--color-online-url-bg);color:var(--color-text);border:1px solid var(--color-btn-border);border-radius:6px;cursor:pointer;text-align:left';
    const left = document.createElement('span');
    left.textContent = `Round ${s.match.currentRound}`;
    left.style.opacity = '0.8';
    const right = document.createElement('span');
    right.textContent = ui.text;
    right.style.color = ui.color;
    right.style.fontWeight = 'bold';
    row.append(left, right);
    row.addEventListener('click', () => {
      matchesScreen.style.display = 'none';
      void startAsyncGame(s.match.id);
    });
    matchesList.appendChild(row);
  }
}

myMatchesBtn.addEventListener('click', () => { void openMatchesList(); });
matchesBackBtn.addEventListener('click', () => {
  matchesScreen.style.display = 'none';
  void refreshMatchesBadge();
});

// Async notification opt-in (email + web push)
asyncNotifyCb.addEventListener('change', async () => {
  if (!asyncNotifyCb.checked) {
    await setTurnNotifications(false);
    asyncNotifyHint.textContent = '';
    return;
  }
  // Enabling: await the permission grant before subscribing — Web Push can only
  // capture a subscription once permission is 'granted'.
  asyncNotifyHint.textContent = 'Enabling…';
  await requestNotificationPermission();
  const granted = typeof Notification !== 'undefined' && Notification.permission === 'granted';
  if (!granted) {
    asyncNotifyCb.checked = false;
    asyncNotifyHint.textContent = 'Notifications are blocked in your browser settings.';
    return;
  }
  const ok = await setTurnNotifications(true);
  asyncNotifyCb.checked = ok;
  asyncNotifyHint.textContent = ok ? "You'll be notified when it's your turn." : 'Could not enable notifications.';
});

// How long a matchmade guest waits for the host's freshly-created match row to
// replicate into view before giving up: up to JOIN_LAG_TRIES probes spaced
// JOIN_LAG_INTERVAL_MS apart (~4s total; normally resolves on the first probe).
const JOIN_LAG_TRIES = 8;
const JOIN_LAG_INTERVAL_MS = 500;

// Online vs Random — client-side matchmaking via Supabase Realtime
onlineRandomBtn.addEventListener('click', async () => {
  onlineActive = true;
  requestNotificationPermission();

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
  destroyAsync();
  onlineActive = false;
  onlineLobby.style.display = 'none';
  showScreen('prompt');
});

window.addEventListener('age-verified-async-join', ((e: CustomEvent<string>) => {
  void startAsyncGame(e.detail);
}) as EventListener);

// Clean up online connections on tab close to avoid zombie Supabase channels
window.addEventListener('beforeunload', () => {
  asyncController?.destroy();
});

// Initialize renderer and show battlefield preview behind start screen
(async () => {
  await initRenderer();
  document.body.classList.toggle('day-mode', dayModeCb.checked);
  if (dayModeCb.checked) renderer!.setTheme(DAY_THEME);
  showPreview();
  showScreen('prompt');

  // Reveal "My Matches" (with an unread badge) if this player already has
  // matches — passive session read, so it never signs anyone in on load.
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
