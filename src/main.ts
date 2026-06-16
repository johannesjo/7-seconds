import { Renderer } from './renderer';
import { GameEngine } from './game';
import { hashGameState } from './online-sync';
import { createArmy, createMissionArmy, createUnitFromState } from './units';
import { generateObstacles, generateElevationZones, generateHordeObstacles, generateHordeElevationZones } from './battlefield';
import { BattleResult, TurnPhase, Unit, Obstacle, ElevationZone, ReplayData, Team } from './types';
import { ARMY_COMPOSITION, HORDE_MAX_WAVES, ROUND_DURATION_S } from './constants';
import { HORDE_WAVES, pickUpgrades, healAllBlue, repositionBlueUnits, randomHordeStartingArmy, applyUpgradesToUnit } from './horde';
import { ReplayPlayer } from './replay';
import { DAY_THEME, NIGHT_THEME } from './theme';
import { OnlineHost } from './online-host';
import { OnlineGuest } from './online-guest';
import { getJoinRoomId } from './online';
import { findMatch } from './online-matchmaking';
import { AsyncGameController, type PlayRoundInput, type AsyncGameHooks } from './online-async-game';
import type { PathList } from './online-async-core';
import { createAsyncMatch, getAsyncJoinId } from './online-async';
import { registerTurnNotifications } from './online-push';
import './online-debug'; // side-effect: shows debug overlay when ?debug=1
import { OnlineConnectionState, OnlineGameState, OnlinePhase, OnlineRoundResult, OnlinePathData, OnlineWaypointData, OnlineSyncHash } from './online-types';
import { PathDrawer } from './path-drawer';
import { recordWin, recordLoss, getScore, getOverallScore } from './online-score';
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
const onlineBtn = document.getElementById('online-btn')!;
const onlineAsyncBtn = document.getElementById('online-async-btn')!;
const asyncNotify = document.getElementById('async-notify')!;
const asyncEmail = document.getElementById('async-email') as HTMLInputElement;
const asyncNotifyBtn = document.getElementById('async-notify-btn')!;
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

// Online state
let onlineHost: OnlineHost | null = null;
let onlineGuest: OnlineGuest | null = null;
let onlineActive = false;
let onlineRole: 'host' | 'guest' | null = null;
let guestPathDrawer: PathDrawer | null = null;
let guestUnits: Unit[] = [];
let guestElevationZones: ElevationZone[] = [];
let guestObstacles: Obstacle[] = [];
let opponentPlayerId: string | null = null;
let localRematchRequested = false;
let cancelMatchmaking: (() => void) | null = null;
let guestEngine: GameEngine | null = null;
let guestLastGameState: OnlineGameState | null = null;
let guestEffectIndex = 0;
let pendingSyncHashes: OnlineSyncHash[] = [];

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
  if (onlineActive && onlineRole === 'host') {
    if (phase === 'red-planning') {
      // Check if guest paths already arrived while host was planning
      const pathData = onlineHost?.consumeGuestPaths();
      if (pathData) {
        // Guest was faster — apply paths and start battle immediately
        engine?.setRedPaths(pathData.paths);
        engine?.confirmPlan();
        return;
      }
      planningLabel.textContent = 'Waiting for opponent...';
      planningOverlay.classList.add('active');
      confirmBtn.classList.remove('active');
      battleHud.style.display = 'none';
      return;
    }
    if (phase === 'cover') {
      // Cover is skipped in online host mode, no action needed
      return;
    }
  }

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
    // Host: periodically send sync hash to guest
    if (onlineActive && onlineRole === 'host') {
      hostSendSyncHash();
    }

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

    if (onlineActive && onlineRole === 'host' && onlineHost) {
      onlineHost.sendResult({
        winner: result.winner,
        blueAlive: result.blueAlive,
        redAlive: result.redAlive,
        duration: result.duration,
        gameOver: true,
      });
      // Record score — host is blue (skip draws)
      if (opponentPlayerId) {
        if (result.winner === 'blue') recordWin(opponentPlayerId);
        else if (result.winner === 'red') recordLoss(opponentPlayerId);
      }
    }

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
    // Show score for online games
    if (onlineActive && opponentPlayerId) {
      const score = getScore(opponentPlayerId);
      statsLines.push(`Score: ${score.wins} - ${score.losses}`);
    }
    resultStatsEl.innerHTML = statsLines.join('<br>');

    localRematchRequested = false;
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
  if (asyncController && !onlineActive && guestPathDrawer) {
    const myUnits = guestUnits.filter(u => u.team === asyncMyTeam);
    const paths: PathList = myUnits.map(u => ({ unitId: u.id, waypoints: [...u.waypoints] }));
    guestPathDrawer.destroy();
    guestPathDrawer = null;
    confirmBtn.classList.remove('active');
    planningOverlay.classList.remove('active');
    planningLabel.textContent = 'Waiting for opponent...';
    void asyncController.submitPlan(paths);
    return;
  }
  if (onlineActive && onlineRole === 'guest' && guestPathDrawer) {
    const redUnits = guestUnits.filter(u => u.team === 'red');
    const paths: OnlinePathData = {
      paths: redUnits.map(u => ({ unitId: u.id, waypoints: [...u.waypoints] })),
    };
    onlineGuest?.sendPaths(paths);
    guestPathDrawer.destroy();
    guestPathDrawer = null;
    confirmBtn.classList.remove('active');
    planningLabel.textContent = 'Waiting for opponent...';
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
  if (onlineActive) {
    // Online rematch: send request and wait for both players
    localRematchRequested = true;
    rematchBtn.textContent = 'Waiting...';
    rematchBtn.style.opacity = '0.5';

    if (onlineRole === 'host') {
      onlineHost?.sendRematchRequest();
      if (onlineHost?.guestWantsRematch) {
        startOnlineRematch();
      }
    } else {
      onlineGuest?.sendRematchRequest();
      if (onlineGuest?.hostWantsRematch) {
        // Host will start the game — guest just waits
      }
    }
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
  onlineHost?.destroy();
  onlineHost = null;
  onlineGuest?.destroy();
  onlineGuest = null;
  destroyAsync();
  guestLastGameState = null;
  onlineActive = false;
  onlineRole = null;
  opponentPlayerId = null;
  localRematchRequested = false;
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

// --- Online PvP functions ---

function startOnlineRematch(): void {
  localRematchRequested = false;
  onlineHost?.resetRematch();
  onlineGuest?.resetRematch();
  startOnlineHostGame();
}

/** Track the last hash tick sent so we send once per sync interval. */
let hostLastHashTick = -1;
const SYNC_INTERVAL = 60; // send hash every 60 simulation ticks (1 second)

function startOnlineHostGame(): void {
  lastReplayData = null;
  engine?.stop();
  document.body.classList.toggle('day-mode', dayModeCb.checked);
  renderer!.setTheme(dayModeCb.checked ? DAY_THEME : NIGHT_THEME);
  renderer!.effects?.clear();
  renderer!.clearDyingUnits();
  hostLastHashTick = -1;
  engine = new GameEngine(renderer!, onGameEvent, {
    aiMode: false,
    onlineHost: true,
    onPhaseChange(phase: TurnPhase) {
      let onlinePhase: OnlinePhase;
      if (phase === 'cover' || phase === 'red-planning') {
        onlinePhase = 'red-planning';
      } else if (phase === 'blue-planning') {
        onlinePhase = 'blue-planning';
        // Re-send game state so guest has updated unit positions for next round
        if (engine) onlineHost?.sendGameState(engine.getOnlineGameState());
      } else if (phase === 'playing') {
        onlinePhase = 'playing';
        // Send blue waypoints + seed to guest for lockstep simulation
        if (engine && onlineHost) {
          const blueUnits = engine.getUnits().filter(u => u.team === 'blue');
          onlineHost.sendWaypoints({
            bluePaths: blueUnits.map(u => ({ unitId: u.id, waypoints: [...u.waypoints] })),
            seed: engine.getSeed(),
          });
        }
      } else {
        onlinePhase = 'round-end';
      }
      onlineHost?.sendPhase(onlinePhase);
    },
  });
  showScreen('battle');
  speedToggle.classList.remove('active');
  speedToggle.dataset.speed = '1';
  speedToggle.textContent = '3x';
  roundCounterEl.textContent = 'Round 1';
  engine.startBattle();
  // Game state is already sent by the onPhaseChange('blue-planning') callback
  // inside startBattle(). Do NOT send it again here — a duplicate would replace
  // guestUnits on the guest side after PathDrawer already references them,
  // causing drawn waypoints to be lost.
}

/** Called from host's game update loop to periodically send sync hashes. */
function hostSendSyncHash(): void {
  if (!engine || !onlineHost) return;
  const tick = engine.getSimulationTick();
  if (tick > 0 && tick % SYNC_INTERVAL === 0 && tick !== hostLastHashTick) {
    hostLastHashTick = tick;
    const hash = hashGameState(engine.getUnits());
    onlineHost.sendSyncHash({ tick, hash });
  }
}

/** Guest ticker callback — drives headless engine and renders its state. */
function guestTickCallback(ticker: { deltaMS: number }): void {
  if (!guestEngine || !renderer) return;
  guestEngine.externalTick(ticker.deltaMS);

  const units = guestEngine.getUnits();
  const dt = ticker.deltaMS / 1000;
  renderer.renderUnits(units, dt, undefined, guestEngine.phase === 'playing');
  renderer.renderProjectiles(guestEngine.getProjectiles());

  // Dispatch visual effects from engine replay events
  const { events, nextIndex } = guestEngine.getReplayEventsSince(guestEffectIndex);
  if (events.length > 0) {
    renderer.effects?.dispatchEvents(events);
    guestEffectIndex = nextIndex;
  }
  renderer.effects?.update(dt);

  // Check all queued sync hashes the guest has reached
  const currentTick = guestEngine.getSimulationTick();
  while (pendingSyncHashes.length > 0 && currentTick >= pendingSyncHashes[0].tick) {
    const expected = pendingSyncHashes.shift()!;
    const guestHash = hashGameState(guestEngine.getUnits());
    if (guestHash !== expected.hash) {
      console.warn(`[lockstep] desync at tick ${expected.tick}: host=${expected.hash.toString(16)} guest=${guestHash.toString(16)}`);
    }
  }

  // Update HUD
  if (guestEngine.phase === 'playing') {
    const counts = guestEngine.getAliveCount();
    blueCountEl.textContent = `Blue: ${counts.blue}`;
    redCountEl.textContent = `Red: ${counts.red}`;
  }
}

function stopGuestEngine(): void {
  if (guestEngine) {
    guestEngine.stop();
    guestEngine = null;
  }
  renderer?.ticker.remove(guestTickCallback);
  renderer?.ticker.remove(asyncTickCallback);
  renderer?.renderProjectiles([]);
  pendingSyncHashes = [];
}

async function startOnlineGuestMode(roomId: string): Promise<void> {
  onlineActive = true;
  onlineRole = 'guest';
  requestNotificationPermission();

  await initRenderer();
  showScreen('battle');

  onlineLobby.style.display = 'flex';
  onlineShareContainer.style.display = 'none';
  showOnlineRecord();
  setOnlineStatus('Connecting to host...', true);

  onlineGuest = new OnlineGuest({
    onConnectionStateChange(state: OnlineConnectionState) {
      if (state === 'connected') {
        setOnlineStatus('Connected! Waiting for game...', true);
      } else if (state === 'connecting') {
        setOnlineStatus('Connecting...', true);
      } else if (state === 'reconnecting') {
        // Show reconnecting status — don't kill the game yet
        setOnlineStatus('Reconnecting...', true);
      } else if (state === 'disconnected') {
        stopGuestEngine();
        planningOverlay.classList.remove('active');
        confirmBtn.classList.remove('active');
        winnerTextEl.innerHTML = 'Opponent Disconnected';
        winnerTextEl.style.color = 'var(--color-hud-neutral)';
        resultStatsEl.innerHTML = '';
        rematchBtn.style.display = 'none';
        replayBtn.style.display = 'none';
        newBattleBtn.textContent = 'Back';
        showScreen('result');
      } else if (state === 'error') {
        setOnlineStatus('Could not connect. Ask host to create a new room.');
      }
    },

    onGameState(state: OnlineGameState) {
      onlineLobby.style.display = 'none';
      document.body.classList.toggle('day-mode', dayModeCb.checked);
      renderer!.setTheme(dayModeCb.checked ? DAY_THEME : NIGHT_THEME);
      renderer!.adaptToRemoteMap(state.mapWidth, state.mapHeight);

      // Store state for headless engine initialization
      guestLastGameState = state;
      guestElevationZones = state.elevationZones;
      guestObstacles = state.obstacles;

      // Update units in-place to preserve PathDrawer references.
      // On rematch/new game, unit IDs change — detect and recreate.
      const idsMatch = guestUnits.length === state.units.length
        && state.units.every(su => guestUnits.some(gu => gu.id === su.id));
      if (guestUnits.length === 0 || !idsMatch) {
        // First state or new game — create unit objects
        renderer!.effects?.clear();
        renderer!.clearDyingUnits();
        guestUnits = state.units.map(u => createUnitFromState(u));
      } else {
        // Same game, updated positions — update in-place to keep PathDrawer refs
        for (const su of state.units) {
          const existing = guestUnits.find(u => u.id === su.id);
          if (existing) {
            existing.pos.x = su.x;
            existing.pos.y = su.y;
            existing.gunAngle = su.gunAngle;
            existing.hp = su.hp;
            existing.maxHp = su.maxHp;
            existing.alive = su.hp > 0;
            existing.speed = su.speed;
            existing.range = su.range;
            existing.waypoints = [];
          }
        }
      }

      renderer!.renderElevationZones(state.elevationZones);
      renderer!.renderObstacles(state.obstacles);
      renderer!.renderUnits(guestUnits);

      showScreen('battle');
    },

    onPhaseChange(phase: OnlinePhase) {
      if (phase === 'blue-planning') {
        // Stop previous round's engine so its stale unit positions
        // don't overwrite the fresh guestUnits from onGameState
        stopGuestEngine();

        notify('7 Seconds', "It's your turn to plan!");
        guestPathDrawer = new PathDrawer(renderer!.stage, renderer!.canvas);
        guestPathDrawer.enable('red', guestUnits, guestElevationZones);
        planningLabel.textContent = 'Your Planning';
        planningLabel.style.color = 'var(--color-planning-red)';
        planningOverlay.classList.add('active');
        confirmBtn.classList.add('active');
        battleHud.style.display = 'none';
      } else if (phase === 'red-planning') {
        // Host confirmed but guest may still be planning — no change needed
      } else if (phase === 'playing') {
        if (guestPathDrawer) {
          guestPathDrawer.destroy();
          guestPathDrawer = null;
        }
        planningOverlay.classList.remove('active');
        confirmBtn.classList.remove('active');
        battleHud.style.display = '';
        // Simulation start is triggered by onWaypoints, not by phase change
      }
    },

    onWaypoints(data: OnlineWaypointData) {
      if (!guestLastGameState) return;

      // Stop any previous guest engine
      stopGuestEngine();

      // Clear stale sync hashes from previous round
      pendingSyncHashes = [];

      // Create headless engine with no-op event handler (host is authoritative)
      guestEngine = new GameEngine(null, () => {}, {
        seed: data.seed,
      });

      // Load the game state and apply waypoints from both sides
      guestEngine.loadOnlineGameState(guestLastGameState);
      guestEngine.setBluePaths(data.bluePaths);

      // Apply guest's red paths (from guestUnits which had paths drawn on them)
      const redPaths = guestUnits
        .filter(u => u.team === 'red')
        .map(u => ({ unitId: u.id, waypoints: [...u.waypoints] }));
      guestEngine.setRedPaths(redPaths);

      // Start simulation directly — bypasses planning phase machinery
      guestEngine.startPlaying();
      guestEffectIndex = 0;

      // Drive the headless engine from the renderer's ticker
      renderer!.ticker.add(guestTickCallback);
    },

    onSyncHash(data: OnlineSyncHash) {
      // Queue the hash — it will be checked in guestTickCallback when we reach that tick
      pendingSyncHashes.push(data);
    },

    onResult(result: OnlineRoundResult) {
      // Capture replay data before stopping the engine
      lastReplayData = guestEngine?.getReplayData() ?? null;
      stopGuestEngine();

      // Record score — guest is red (skip draws)
      if (opponentPlayerId) {
        if (result.winner === 'red') recordWin(opponentPlayerId);
        else if (result.winner === 'blue') recordLoss(opponentPlayerId);
      }

      const color = result.winner === 'blue' ? 'var(--color-result-blue)' : 'var(--color-result-red)';
      const winnerLabel = `${result.winner === 'blue' ? 'Blue' : 'Red'} Wins!`;
      winnerTextEl.innerHTML = `${winnerLabel}<br><span style="font-size:0.5em;opacity:0.7">Elimination!</span>`;
      winnerTextEl.style.color = color;

      const statsLines = [
        `Duration: ${result.duration.toFixed(1)}s`,
        `Blue survivors: ${result.blueAlive}`,
        `Red survivors: ${result.redAlive}`,
      ];
      if (opponentPlayerId) {
        const score = getScore(opponentPlayerId);
        statsLines.push(`Score: ${score.wins} - ${score.losses}`);
      }
      resultStatsEl.innerHTML = statsLines.join('<br>');

      localRematchRequested = false;
      rematchBtn.textContent = 'Rematch';
      rematchBtn.style.opacity = '1';
      rematchBtn.style.display = '';
      replayBtn.style.display = lastReplayData ? '' : 'none';
      newBattleBtn.textContent = 'Back';
      returnToScreen = 'result';

      showScreen('result');
    },
    onHostRematchRequested() {
      if (localRematchRequested) {
        // Both want rematch — host will start the game, guest just waits
        rematchBtn.textContent = 'Starting...';
      } else {
        rematchBtn.textContent = 'Rematch (opponent ready)';
      }
    },
    onHostIdentity(playerId: string) {
      opponentPlayerId = playerId;
    },
  });

  await onlineGuest.joinRoom(roomId);
}

/** Build OnlineHost callbacks. Customization points are passed as overrides. */
function createHostCallbacks(overrides: {
  onShareUrl: (url: string) => void;
  waitingStatus: string;
  errorStatus: string;
}): ConstructorParameters<typeof OnlineHost>[0] {
  return {
    onConnectionStateChange(state: OnlineConnectionState) {
      if (state === 'connected') {
        if (engine) {
          notify('7 Seconds', 'Reconnected!');
        } else {
          notify('7 Seconds', 'Your opponent has joined!');
          onlineLobby.style.display = 'none';
          startOnlineHostGame();
        }
      } else if (state === 'reconnecting') {
        setOnlineStatus('Reconnecting...', true);
      } else if (state === 'disconnected') {
        engine?.stop();
        planningOverlay.classList.remove('active');
        confirmBtn.classList.remove('active');
        winnerTextEl.innerHTML = 'Opponent Disconnected';
        winnerTextEl.style.color = 'var(--color-hud-neutral)';
        resultStatsEl.innerHTML = '';
        rematchBtn.style.display = 'none';
        replayBtn.style.display = 'none';
        newBattleBtn.textContent = 'Back';
        showScreen('result');
      } else if (state === 'waiting') {
        setOnlineStatus(overrides.waitingStatus, true);
      } else if (state === 'error') {
        setOnlineStatus(overrides.errorStatus);
      }
    },
    onShareUrl: overrides.onShareUrl,
    onGuestPathsReceived() {
      if (!engine || !onlineHost) return;
      if (engine.phase === 'red-planning') {
        const pathData = onlineHost.consumeGuestPaths();
        if (pathData) {
          engine.setRedPaths(pathData.paths);
          engine.confirmPlan();
          planningOverlay.classList.remove('active');
        }
      }
    },
    onGuestRematchRequested() {
      if (localRematchRequested) {
        startOnlineRematch();
      } else {
        rematchBtn.textContent = 'Rematch (opponent ready)';
      }
    },
    onGuestIdentity(playerId: string) {
      opponentPlayerId = playerId;
    },
  };
}

// --- Async ("play-by-mail") online matches -------------------------------

const ASYNC_ROUND_END_TICK = Math.round(ROUND_DURATION_S * 60);

/** Tear down any in-progress async match. */
function destroyAsync(): void {
  asyncController?.destroy();
  asyncController = null;
  renderer?.ticker.remove(asyncTickCallback);
  stopGuestEngine();
  asyncNotify.style.display = 'none';
}

/** Ticker callback that animates a resolved async round headlessly and, once
 *  it ends deterministically (a side eliminated, or the fixed round duration
 *  elapses), reports the authoritative end state back to the controller. */
function asyncTickCallback(ticker: { deltaMS: number }): void {
  if (!guestEngine || !renderer) return;
  guestEngine.externalTick(ticker.deltaMS);

  const units = guestEngine.getUnits();
  const dt = ticker.deltaMS / 1000;
  renderer.renderUnits(units, dt, undefined, guestEngine.phase === 'playing');
  renderer.renderProjectiles(guestEngine.getProjectiles());

  const { events, nextIndex } = guestEngine.getReplayEventsSince(guestEffectIndex);
  if (events.length > 0) {
    renderer.effects?.dispatchEvents(events);
    guestEffectIndex = nextIndex;
  }
  renderer.effects?.update(dt);

  const counts = guestEngine.getAliveCount();
  blueCountEl.textContent = `Blue: ${counts.blue}`;
  redCountEl.textContent = `Red: ${counts.red}`;

  if (asyncRoundFinished) return;
  const tick = guestEngine.getSimulationTick();
  // The animation's end timing is cosmetic; the persisted result is the
  // deterministic one computed in startAsyncRoundPlayback (frame-independent).
  if (asyncMatchEnded || tick >= ASYNC_ROUND_END_TICK) {
    asyncRoundFinished = true;
    renderer.ticker.remove(asyncTickCallback);
    lastReplayData = guestEngine.getReplayData() ?? lastReplayData;
    const round = asyncCurrentRound;
    const result = asyncResult;
    stopGuestEngine();
    if (result) void asyncController?.onRoundPlayed(round, result.endState, result.gameOver);
  }
}

/** Run a resolved round: compute the authoritative outcome deterministically,
 *  then animate the same round for the player to watch. */
function startAsyncRoundPlayback(input: PlayRoundInput): void {
  stopGuestEngine();
  pendingSyncHashes = [];
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
  guestEngine = new GameEngine(null, (type) => {
    if (type === 'end') asyncMatchEnded = true;
  }, { seed: roundSeed });
  guestEngine.loadOnlineGameState(input.startState);
  guestEngine.setBluePaths(input.bluePaths);
  guestEngine.setRedPaths(input.redPaths);
  guestEngine.startPlaying();
  guestEffectIndex = 0;
  roundCounterEl.textContent = `Round ${input.round}`;
  renderer!.ticker.add(asyncTickCallback);
}

/** Bridge the async protocol controller to the UI / playback engine. */
function asyncHooks(): AsyncGameHooks {
  return {
    onPlanTurn(round, startState, myTeam) {
      asyncCurrentRound = round;
      asyncMyTeam = myTeam;
      stopGuestEngine();
      onlineLobby.style.display = 'none';

      document.body.classList.toggle('day-mode', dayModeCb.checked);
      renderer!.setTheme(dayModeCb.checked ? DAY_THEME : NIGHT_THEME);
      renderer!.adaptToRemoteMap(startState.mapWidth, startState.mapHeight);
      renderer!.effects?.clear();
      renderer!.clearDyingUnits();

      guestUnits = startState.units.map(u => createUnitFromState(u));
      guestElevationZones = startState.elevationZones;
      guestObstacles = startState.obstacles;
      renderer!.renderElevationZones(startState.elevationZones);
      renderer!.renderObstacles(startState.obstacles);
      renderer!.renderUnits(guestUnits);

      guestPathDrawer?.destroy();
      guestPathDrawer = new PathDrawer(renderer!.stage, renderer!.canvas);
      guestPathDrawer.enable(myTeam, guestUnits, guestElevationZones);

      planningLabel.textContent = 'Your Planning';
      planningLabel.style.color = myTeam === 'blue'
        ? 'var(--color-planning-blue)' : 'var(--color-planning-red)';
      planningOverlay.classList.add('active');
      confirmBtn.classList.add('active');
      battleHud.style.display = 'none';
      roundCounterEl.textContent = `Round ${round}`;
      showScreen('battle');
    },

    onAwaitOpponent(round) {
      guestPathDrawer?.destroy();
      guestPathDrawer = null;
      planningOverlay.classList.remove('active');
      confirmBtn.classList.remove('active');
      onlineShareContainer.style.display = 'none';
      setOnlineStatus(`Turn submitted (round ${round}). Waiting for your friend — you can safely leave and return later.`, true);
      onlineLobby.style.display = 'flex';
      showScreen('battle');
    },

    onPlayRound(input) {
      onlineLobby.style.display = 'none';
      planningOverlay.classList.remove('active');
      confirmBtn.classList.remove('active');
      battleHud.style.display = '';
      showScreen('battle');
      startAsyncRoundPlayback(input);
    },

    onGameOver(status, finalState) {
      destroyAsync();
      if (status === 'abandoned') {
        winnerTextEl.innerHTML = `Match Abandoned<br><span style="font-size:0.5em;opacity:0.7">Your opponent left</span>`;
        winnerTextEl.style.color = ''; // neutral, not a win/loss color
      } else {
        const winner: Team = status === 'guest_won' ? 'red' : 'blue';
        const iWon = (asyncMyTeam === winner);
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

    onError(message) {
      onlineShareContainer.style.display = 'none';
      setOnlineStatus(message);
      onlineLobby.style.display = 'flex';
      showScreen('battle');
    },
  };
}

/** Start an async match: create a new one (host) or open/join an existing one. */
async function startAsyncGame(roomId: string | null): Promise<void> {
  await initRenderer();
  destroyAsync();
  showScreen('battle');
  onlineLobby.style.display = 'flex';
  onlineShareContainer.style.display = 'none';
  onlineStatus.style.display = '';
  document.getElementById('online-record')!.style.display = 'none';
  asyncNotify.style.display = 'flex';
  void registerTurnNotifications();

  let id = roomId;
  if (!id) {
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
    setOnlineStatus('Share this link with a friend. You can plan your first turn now.', true);
  } else {
    setOnlineStatus('Loading match...', true);
  }

  asyncController = new AsyncGameController(id, asyncHooks());
  const ok = await asyncController.start();
  if (!ok) { asyncController = null; }
}

// Online PvP button (host flow)
onlineBtn.addEventListener('click', async () => {
  onlineActive = true;
  onlineRole = 'host';
  requestNotificationPermission();

  await initRenderer();

  onlineLobby.style.display = 'flex';
  onlineShareContainer.style.display = 'none';
  showOnlineRecord();
  setOnlineStatus('Creating room...', true);

  onlineHost = new OnlineHost(createHostCallbacks({
    onShareUrl(url: string) {
      onlineShareContainer.style.display = '';
      onlineShareUrl.value = url;
    },
    waitingStatus: 'Waiting for opponent...',
    errorStatus: 'Timed out. No opponent joined. Try creating a new room.',
  }));

  await onlineHost.createRoom();
});

// Async vs Friend — create a play-by-mail match (turns persisted server-side)
onlineAsyncBtn.addEventListener('click', () => {
  requestNotificationPermission();
  void startAsyncGame(null);
});

// Async notification opt-in (email + web push)
asyncNotifyBtn.addEventListener('click', async () => {
  requestNotificationPermission();
  asyncNotifyBtn.textContent = 'Saving...';
  const ok = await registerTurnNotifications({ email: asyncEmail.value });
  asyncNotifyBtn.textContent = ok ? "You'll be notified ✓" : 'Notifications unavailable';
  setTimeout(() => { asyncNotifyBtn.textContent = 'Notify me'; }, 3000);
});

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

    if (result.role === 'host') {
      onlineRole = 'host';
      setOnlineStatus('Opponent found! Setting up game...', true);
      onlineHost = new OnlineHost(createHostCallbacks({
        onShareUrl() { /* no-op for random match */ },
        waitingStatus: 'Waiting for opponent to connect...',
        errorStatus: 'Connection failed. Try again.',
      }));
      await onlineHost.createRoomWithId(result.roomId);
    } else {
      // Guest flow — reuse existing startOnlineGuestMode
      startOnlineGuestMode(result.roomId);
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
  onlineHost?.destroy();
  onlineHost = null;
  onlineGuest?.destroy();
  onlineGuest = null;
  destroyAsync();
  onlineActive = false;
  onlineRole = null;
  onlineLobby.style.display = 'none';
  showScreen('prompt');
});

// Handle deferred join after age gate verification
window.addEventListener('age-verified-join', ((e: CustomEvent<string>) => {
  startOnlineGuestMode(e.detail);
}) as EventListener);

window.addEventListener('age-verified-async-join', ((e: CustomEvent<string>) => {
  void startAsyncGame(e.detail);
}) as EventListener);

// Clean up online connections on tab close to avoid zombie Supabase channels
window.addEventListener('beforeunload', () => {
  onlineHost?.destroy();
  onlineGuest?.destroy();
  asyncController?.destroy();
});

// Initialize renderer and show battlefield preview behind start screen
(async () => {
  await initRenderer();
  document.body.classList.toggle('day-mode', dayModeCb.checked);
  if (dayModeCb.checked) renderer!.setTheme(DAY_THEME);
  showPreview();
  showScreen('prompt');

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

  // Check URL for join param (works for both web links and Android deep links)
  const joinRoomId = getJoinRoomId();
  if (joinRoomId) {
    const cleanUrl = new URL(window.location.href);
    cleanUrl.searchParams.delete('join');
    window.history.replaceState({}, '', cleanUrl.toString());
    // Wait for age gate before starting guest flow
    if (localStorage.getItem('7s-age-verified')) {
      startOnlineGuestMode(joinRoomId);
    } else {
      // Store join room ID so the age gate can trigger it after verification
      sessionStorage.setItem('7s-pending-join', joinRoomId);
    }
  }
})();
