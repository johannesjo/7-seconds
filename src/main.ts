import { Renderer } from './renderer';
import { GameEngine } from './game';
import { createArmy, createMissionArmy } from './units';
import { generateObstacles, generateElevationZones, generateHordeObstacles, generateHordeElevationZones } from './battlefield';
import { BattleResult, TurnPhase, Unit, Projectile, Obstacle, ElevationZone, ReplayData, ReplayFrame, ReplayEvent, Team } from './types';
import { ARMY_COMPOSITION, HORDE_MAX_WAVES, FLANK_DAMAGE_MULTIPLIER } from './constants';
import { HORDE_WAVES, pickUpgrades, healAllBlue, repositionBlueUnits, randomHordeStartingArmy } from './horde';
import { ReplayPlayer } from './replay';
import { DAY_THEME, NIGHT_THEME } from './theme';
import { OnlineHost } from './online-host';
import { OnlineGuest } from './online-guest';
import { getJoinRoomId, getLocalPlayerId, prefetchIceServers } from './online';
import { findMatch } from './online-matchmaking';
import './online-debug'; // side-effect: shows debug overlay when ?debug=1
import { OnlineConnectionState, OnlineGameState, OnlinePhase, OnlineFrameData, OnlineRoundResult, OnlinePathData } from './online-types';
import { PathDrawer } from './path-drawer';
import { recordWin, recordLoss, getScore } from './online-score';

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
const onlineRandomBtn = document.getElementById('online-random-btn')!;
const onlineLobby = document.getElementById('online-lobby')!;
const onlineStatus = document.getElementById('online-status')!;
const onlineShareContainer = document.getElementById('online-share-container')!;
const onlineShareUrl = document.getElementById('online-share-url') as HTMLInputElement;
const onlineCopyBtn = document.getElementById('online-copy-btn')!;
const onlineCancelBtn = document.getElementById('online-cancel-btn')!;
const onlineSpinner = document.getElementById('online-spinner')!;

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
let hordeAppliedUpgrades = new Set<string>();

// Online state
let onlineHost: OnlineHost | null = null;
let onlineGuest: OnlineGuest | null = null;
let onlineActive = false;
let onlineRole: 'host' | 'guest' | null = null;
let guestPathDrawer: PathDrawer | null = null;
let guestUnits: Unit[] = [];
let guestElevationZones: ElevationZone[] = [];
let guestObstacles: Obstacle[] = [];
let guestReplayFrames: ReplayFrame[] = [];
let guestReplayEvents: ReplayEvent[] = [];
let guestReplayFrameIndex = 0;
let opponentPlayerId: string | null = null;
let localRematchRequested = false;
let cancelMatchmaking: (() => void) | null = null;

// Replay state
let replayPlayer: ReplayPlayer | null = null;
let lastReplayData: ReplayData | null = null;
let returnToScreen: 'result' | 'horde-upgrade' = 'result';

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
    const isDayMode = dayModeCb.checked;
    const color = phase === 'blue-planning'
      ? (isDayMode ? '#2266aa' : '#4a9eff')
      : (isDayMode ? '#aa3333' : '#ff4a4a');
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
        roundTimerEl.style.color = dayModeCb.checked ? '#aa3333' : '#ff4444';
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
      const color = result.winner === 'blue' ? '#4a9eff' : '#ff4a4a';
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

    const color = result.winner === 'blue' ? '#4a9eff' : '#ff4a4a';
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
  hordeAppliedUpgrades = new Set();
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
      hordeAppliedUpgrades.add(upgrade.id);
      hordeUnits = upgrade.apply(hordeUnits, allBlocks);
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
    winnerTextEl.style.color = '#ff8844';
  } else {
    winnerTextEl.innerHTML = `Defeated!<br><span style="font-size:0.5em;opacity:0.7">Fallen on Wave ${hordeWave}</span>`;
    winnerTextEl.style.color = '#ff4a4a';
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
  hordeAppliedUpgrades = new Set();
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

function startOnlineHostGame(): void {
  lastReplayData = null;
  engine?.stop();
  document.body.classList.toggle('day-mode', dayModeCb.checked);
  renderer!.setTheme(dayModeCb.checked ? DAY_THEME : NIGHT_THEME);
  renderer!.effects?.clear();
  renderer!.clearDyingUnits();
  engine = new GameEngine(renderer!, onGameEvent, {
    aiMode: false,
    onlineHost: true,
    onFrame(frame: OnlineFrameData) {
      onlineHost?.sendFrame(frame);
    },
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
  onlineHost?.sendGameState(engine.getOnlineGameState());
}

async function startOnlineGuestMode(roomId: string): Promise<void> {
  onlineActive = true;
  onlineRole = 'guest';

  await initRenderer();
  showScreen('battle');

  onlineLobby.style.display = 'flex';
  onlineShareContainer.style.display = 'none';
  setOnlineStatus('Connecting to host...', true);

  onlineGuest = new OnlineGuest({
    onConnectionStateChange(state: OnlineConnectionState) {
      if (state === 'connected') {
        setOnlineStatus('Connected! Waiting for game...', true);
      } else if (state === 'connecting') {
        setOnlineStatus('Connecting...', true);
      } else if (state === 'disconnected') {
        // Show disconnect on result screen so player can go back
        planningOverlay.classList.remove('active');
        confirmBtn.classList.remove('active');
        winnerTextEl.innerHTML = 'Opponent Disconnected';
        winnerTextEl.style.color = '#888';
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
      // Adapt to host's map size — scales stage, adds black letterbox bars
      // Called after setTheme so background grid uses correct theme colors
      renderer!.adaptToRemoteMap(state.mapWidth, state.mapHeight);

      // Update units in-place to preserve PathDrawer references.
      // If PathDrawer holds refs to guestUnits objects and we replace the
      // array, drawn waypoints go to stale objects and get lost.
      // On rematch/new game, unit IDs change — detect and recreate.
      guestElevationZones = state.elevationZones;
      guestObstacles = state.obstacles;
      const idsMatch = guestUnits.length === state.units.length
        && state.units.every(su => guestUnits.some(gu => gu.id === su.id));
      if (guestUnits.length === 0 || !idsMatch) {
        // New game — reset replay buffer and clear effects
        guestReplayFrames = [];
        guestReplayEvents = [];
        guestReplayFrameIndex = 0;
        renderer!.effects?.clear();
        // First state or new game — create unit objects
        guestUnits = state.units.map(u => ({
          id: u.id,
          type: u.type,
          team: u.team,
          pos: { x: u.x, y: u.y },
          vel: { x: 0, y: 0 },
          gunAngle: u.gunAngle,
          hp: u.hp,
          maxHp: u.maxHp,
          alive: true,
          radius: u.radius,
          speed: u.speed,
          damage: 0,
          range: u.range,
          moveTarget: null,
          waypoints: [],
          attackTargetId: null,
          fireCooldown: 0,
          fireTimer: 0,
          projectileSpeed: 0,
          projectileRadius: 0,
          turnSpeed: 0,
        } as Unit));
      } else {
        // Subsequent states — update existing objects in-place
        for (const su of state.units) {
          const existing = guestUnits.find(u => u.id === su.id);
          if (existing) {
            existing.pos.x = su.x;
            existing.pos.y = su.y;
            existing.hp = su.hp;
            existing.maxHp = su.maxHp;
            existing.alive = su.hp > 0;
            existing.speed = su.speed;
            existing.range = su.range;
            existing.waypoints = [];
          }
        }
      }

      renderer!.clearDyingUnits();
      renderer!.renderElevationZones(state.elevationZones);
      renderer!.renderObstacles(state.obstacles);
      renderer!.renderUnits(guestUnits);

      showScreen('battle');
    },

    onPhaseChange(phase: OnlinePhase) {
      if (phase === 'blue-planning') {
        // Both players plan simultaneously — guest draws red paths right away
        guestPathDrawer = new PathDrawer(renderer!.stage, renderer!.canvas);
        guestPathDrawer.enable('red', guestUnits, guestElevationZones);
        planningLabel.textContent = 'Your Planning';
        planningLabel.style.color = dayModeCb.checked ? '#aa3333' : '#ff4a4a';
        planningOverlay.classList.add('active');
        confirmBtn.classList.add('active');
        battleHud.style.display = 'none';
      } else if (phase === 'red-planning') {
        // Host confirmed but guest may still be planning — no change needed
        // (guest is already drawing, or already submitted)
      } else if (phase === 'playing') {
        // Clean up any remaining path drawer if guest was slow
        if (guestPathDrawer) {
          guestPathDrawer.destroy();
          guestPathDrawer = null;
        }
        planningOverlay.classList.remove('active');
        confirmBtn.classList.remove('active');
        battleHud.style.display = '';
      }
    },

    onFrame(frame: OnlineFrameData) {
      // Buffer frame for replay
      guestReplayFrames.push({ units: frame.units, projectiles: frame.projectiles });
      for (const event of frame.events) {
        guestReplayEvents.push({ ...event, frame: guestReplayFrameIndex });
      }
      guestReplayFrameIndex++;

      // Convert frame data to Unit/Projectile objects (same as ReplayPlayer)
      const units: Unit[] = frame.units.map(s => ({
        id: s.id,
        type: s.type,
        team: s.team,
        pos: { x: s.x, y: s.y },
        vel: { x: s.vx, y: s.vy },
        gunAngle: s.gunAngle,
        hp: s.hp,
        maxHp: s.maxHp,
        alive: s.alive,
        radius: s.radius,
        speed: 0,
        damage: 0,
        range: 0,
        moveTarget: null,
        waypoints: [],
        attackTargetId: null,
        fireCooldown: 0,
        fireTimer: 0,
        projectileSpeed: 0,
        projectileRadius: 0,
        turnSpeed: 0,
      }));

      const projectiles: Projectile[] = frame.projectiles.map(s => ({
        pos: { x: s.x, y: s.y },
        vel: { x: s.vx, y: s.vy },
        target: { x: 0, y: 0 },
        damage: s.damage,
        radius: s.radius,
        team: s.team,
        maxRange: s.maxRange,
        distanceTraveled: s.distanceTraveled,
        trail: s.trail,
      }));

      renderer!.renderUnits(units, 1 / 60);
      renderer!.renderProjectiles(projectiles);

      // Tick effects so particles animate (blood, muzzle flash, kill text)
      renderer!.effects?.update(1 / 60);

      // Trigger effects for events (match host logic)
      const fx = renderer!.effects;
      if (fx) {
        for (const event of frame.events) {
          if (event.type === 'fire') {
            fx.addMuzzleFlash(event.pos, event.angle, 6);
          } else if (event.type === 'hit') {
            const victimTeam: Team = event.team === 'blue' ? 'red' : 'blue';
            const effectDamage = event.flanked ? event.damage * FLANK_DAMAGE_MULTIPLIER : event.damage;
            fx.addBloodSpray(event.pos, event.angle, victimTeam, effectDamage);
          } else if (event.type === 'kill') {
            const victimTeam: Team = event.team === 'blue' ? 'red' : 'blue';
            const effectDamage = event.flanked ? event.damage * FLANK_DAMAGE_MULTIPLIER : event.damage;
            fx.addBloodSpray(event.pos, event.angle, victimTeam, effectDamage);
            fx.addBloodBurst(event.pos, event.angle, victimTeam, effectDamage);
            fx.addKillText(event.pos, event.team);
          }
        }
      }

      // Update round timer
      const timeLeft = frame.timeLeft;
      roundTimerEl.textContent = `${Math.ceil(timeLeft)}s`;
      if (timeLeft <= 3) {
        roundTimerEl.style.color = dayModeCb.checked ? '#aa3333' : '#ff4444';
        const pulse = 1 + 0.1 * Math.sin(Date.now() / 150);
        roundTimerEl.style.transform = `scale(${pulse})`;
      } else {
        roundTimerEl.style.color = '';
        roundTimerEl.style.transform = '';
      }

      // Update HUD counts
      const blueAlive = units.filter(u => u.team === 'blue' && u.alive).length;
      const redAlive = units.filter(u => u.team === 'red' && u.alive).length;
      blueCountEl.textContent = `Blue: ${blueAlive}`;
      redCountEl.textContent = `Red: ${redAlive}`;
    },

    onResult(result: OnlineRoundResult) {
      // Record score — guest is red (skip draws)
      if (opponentPlayerId) {
        if (result.winner === 'red') recordWin(opponentPlayerId);
        else if (result.winner === 'blue') recordLoss(opponentPlayerId);
      }

      const color = result.winner === 'blue' ? '#4a9eff' : result.winner === 'red' ? '#ff4a4a' : '#888';
      const winnerLabel = result.winner === 'draw' ? 'Draw!' : `${result.winner === 'blue' ? 'Blue' : 'Red'} Wins!`;
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

      // Build replay data from buffered frames
      lastReplayData = {
        frames: guestReplayFrames,
        events: guestReplayEvents,
        obstacles: guestObstacles,
        elevationZones: guestElevationZones,
      };

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

// Online PvP button (host flow)
onlineBtn.addEventListener('click', async () => {
  onlineActive = true;
  onlineRole = 'host';

  await initRenderer();

  onlineLobby.style.display = 'flex';
  onlineShareContainer.style.display = 'none';
  setOnlineStatus('Creating room...', true);

  onlineHost = new OnlineHost({
    onConnectionStateChange(state: OnlineConnectionState) {
      if (state === 'connected') {
        onlineLobby.style.display = 'none';
        startOnlineHostGame();
      } else if (state === 'disconnected') {
        // Show disconnect on result screen so host can go back
        engine?.stop();
        planningOverlay.classList.remove('active');
        confirmBtn.classList.remove('active');
        winnerTextEl.innerHTML = 'Opponent Disconnected';
        winnerTextEl.style.color = '#888';
        resultStatsEl.innerHTML = '';
        rematchBtn.style.display = 'none';
        replayBtn.style.display = 'none';
        newBattleBtn.textContent = 'Back';
        showScreen('result');
      } else if (state === 'waiting') {
        setOnlineStatus('Waiting for opponent...', true);
      } else if (state === 'error') {
        setOnlineStatus('Timed out. No opponent joined. Try creating a new room.');
      }
    },
    onShareUrl(url: string) {
      onlineShareContainer.style.display = '';
      onlineShareUrl.value = url;
    },
    onGuestPathsReceived() {
      if (!engine || !onlineHost) return;
      // If host already confirmed and engine is waiting in red-planning, start battle
      if (engine.phase === 'red-planning') {
        const pathData = onlineHost.consumeGuestPaths();
        if (pathData) {
          engine.setRedPaths(pathData.paths);
          engine.confirmPlan();
          planningOverlay.classList.remove('active');
        }
      }
      // Otherwise paths are stored — will be consumed when host confirms
    },
    onGuestRematchRequested() {
      if (localRematchRequested) {
        // Both want rematch — start!
        startOnlineRematch();
      } else {
        // Show that opponent wants rematch
        rematchBtn.textContent = 'Rematch (opponent ready)';
      }
    },
    onGuestIdentity(playerId: string) {
      opponentPlayerId = playerId;
    },
  });

  await onlineHost.createRoom();
});

// Online vs Random — client-side matchmaking via Supabase Realtime
onlineRandomBtn.addEventListener('click', async () => {
  onlineActive = true;

  await initRenderer();

  onlineLobby.style.display = 'flex';
  onlineShareContainer.style.display = 'none';
  setOnlineStatus('Searching for opponent...', true);

  const { promise, cancel } = findMatch();
  cancelMatchmaking = cancel;

  try {
    const result = await promise;
    cancelMatchmaking = null;

    if (result.role === 'host') {
      onlineRole = 'host';
      setOnlineStatus('Opponent found! Setting up game...', true);
      // Reuse the existing host flow but with the matched roomId
      onlineHost = new OnlineHost({
        onConnectionStateChange(state: OnlineConnectionState) {
          if (state === 'connected') {
            onlineLobby.style.display = 'none';
            startOnlineHostGame();
          } else if (state === 'disconnected') {
            engine?.stop();
            planningOverlay.classList.remove('active');
            confirmBtn.classList.remove('active');
            winnerTextEl.innerHTML = 'Opponent Disconnected';
            winnerTextEl.style.color = '#888';
            resultStatsEl.innerHTML = '';
            rematchBtn.style.display = 'none';
            replayBtn.style.display = 'none';
            newBattleBtn.textContent = 'Back';
            showScreen('result');
          } else if (state === 'waiting') {
            setOnlineStatus('Waiting for opponent to connect...', true);
          } else if (state === 'error') {
            setOnlineStatus('Connection failed. Try again.');
          }
        },
        onShareUrl() { /* no-op for random match */ },
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
      });
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
  onlineActive = false;
  onlineRole = null;
  onlineLobby.style.display = 'none';
  showScreen('prompt');
});

// Handle deferred join after age gate verification
window.addEventListener('age-verified-join', ((e: CustomEvent<string>) => {
  startOnlineGuestMode(e.detail);
}) as EventListener);

// Clean up online connections on tab close to avoid zombie Supabase channels
window.addEventListener('beforeunload', () => {
  onlineHost?.destroy();
  onlineGuest?.destroy();
});

// Pre-fetch TURN credentials so they're ready when creating/joining rooms
prefetchIceServers();

// Initialize renderer and show battlefield preview behind start screen
(async () => {
  await initRenderer();
  document.body.classList.toggle('day-mode', dayModeCb.checked);
  if (dayModeCb.checked) renderer!.setTheme(DAY_THEME);
  showPreview();
  showScreen('prompt');

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
