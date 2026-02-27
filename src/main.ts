import { Renderer } from './renderer';
import { GameEngine } from './game';
import { createArmy, createMissionArmy } from './units';
import { generateObstacles, generateElevationZones, generateCoverBlocks } from './battlefield';
import { BattleResult, TurnPhase, Unit, Obstacle, ElevationZone, CoverBlock, ReplayData } from './types';
import { ARMY_COMPOSITION, HORDE_MAX_WAVES, HORDE_STARTING_ARMY } from './constants';
import { HORDE_WAVES, pickUpgrades, healAllBlue, repositionBlueUnits } from './horde';
import { ReplayPlayer } from './replay';

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
const speedButtons = document.querySelectorAll<HTMLButtonElement>('.speed-controls button');

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

const zoneControlCb = document.getElementById('zone-control-cb') as HTMLInputElement;
const oneShotCb = document.getElementById('one-shot-cb') as HTMLInputElement;
const bloodCb = document.getElementById('blood-cb') as HTMLInputElement;
const pixiContainer = document.getElementById('pixi-container')!;

// Replay controls
const replayOverlay = document.getElementById('replay-overlay')!;
const replayRestartBtn = document.getElementById('replay-restart-btn')!;
const replayPauseBtn = document.getElementById('replay-pause-btn')!;
const replayExitBtn = document.getElementById('replay-exit-btn')!;
const replayProgress = document.getElementById('replay-progress')!;
const replaySpeedButtons = document.querySelectorAll<HTMLButtonElement>('[data-replay-speed]');

// State
let renderer: Renderer | null = null;
let engine: GameEngine | null = null;
let aiMode = false;

// Horde state
let hordeActive = false;
let hordeWave = 0;
let hordeUnits: Unit[] = [];
let hordeMap: { obstacles: Obstacle[]; elevationZones: ElevationZone[]; coverBlocks: CoverBlock[] } | null = null;

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
  const planning = phase === 'blue-planning' || phase === 'red-planning';

  // Hide HUD during planning so the Done button doesn't overlap
  battleHud.style.display = planning ? 'none' : '';

  // Planning overlay
  if (planning) {
    const team = phase === 'blue-planning' ? 'Blue' : 'Red';
    const color = phase === 'blue-planning' ? '#4a9eff' : '#ff4a4a';
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
      waveCounterEl.textContent = `Wave ${hordeWave}/${HORDE_MAX_WAVES} — ${counts.red} enemies`;
    }

    if (data && 'timeLeft' in data && data.timeLeft !== undefined) {
      const timeLeft = data.timeLeft;
      roundTimerEl.textContent = `${Math.ceil(timeLeft)}s`;

      if (timeLeft <= 3) {
        roundTimerEl.style.color = '#ff4444';
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

    // Horde defeat
    if (hordeActive) {
      showHordeResult(false);
      return;
    }

    const color = result.winner === 'blue' ? '#4a9eff' : '#ff4a4a';
    const conditionLabel = result.winCondition === 'zone-control' ? 'Zone Control!' : 'Elimination!';
    winnerTextEl.innerHTML = `${result.winner === 'blue' ? 'Blue' : 'Red'} Wins!<br><span style="font-size:0.5em;opacity:0.7">${conditionLabel}</span>`;
    winnerTextEl.style.color = color;

    const blueTotal = ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0);
    const redTotal = ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0);

    resultStatsEl.innerHTML = [
      `Duration: ${result.duration.toFixed(1)}s`,
      `Blue survivors: ${result.blueAlive}/${blueTotal}`,
      `Red survivors: ${result.redAlive}/${redTotal}`,
    ].join('<br>');

    rematchBtn.textContent = 'Rematch';
    newBattleBtn.textContent = 'New Battle';
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
  engine = new GameEngine(renderer!, onGameEvent, {
    aiMode,
    zoneControl: zoneControlCb.checked,
    oneShot: oneShotCb.checked,
    blood: bloodCb.checked,
  });
  showScreen('battle');
  speedButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.speed === '1'));
  roundCounterEl.textContent = 'Round 1';
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
  replayPauseBtn.textContent = 'Pause';
  replaySpeedButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.replaySpeed === '1'));

  replayPlayer = new ReplayPlayer(renderer!, data, (event, eventData) => {
    if (event === 'frame' && eventData) {
      replayProgress.textContent = `${eventData.time.toFixed(1)}s / ${eventData.duration.toFixed(1)}s`;
    }
    if (event === 'end') {
      replayPauseBtn.textContent = 'Play';
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
  lastReplayData = null;

  // Generate map once for the whole run (before spawning so units avoid blocks)
  const obstacles = generateObstacles();
  const elevationZones = generateElevationZones();
  const coverBlocks = generateCoverBlocks(obstacles);
  hordeMap = { obstacles, elevationZones, coverBlocks };

  const allBlocks = [...obstacles, ...coverBlocks];
  hordeUnits = createMissionArmy('blue', HORDE_STARTING_ARMY, allBlocks);

  waveCounterEl.style.display = '';
  startNextHordeWave();
}

function startNextHordeWave(): void {
  hordeWave++;
  const waveDef = HORDE_WAVES[hordeWave - 1];
  if (!waveDef) return;

  engine?.stop();
  engine = new GameEngine(renderer!, onGameEvent, {
    aiMode: true,
    horde: true,
    hordeBlueUnits: hordeUnits,
    hordeRedArmy: waveDef.enemies,
    hordeMap: hordeMap!,
    blood: bloodCb.checked,
  });

  showScreen('battle');
  speedButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.speed === '1'));
  roundCounterEl.textContent = 'Round 1';
  waveCounterEl.textContent = `Wave ${hordeWave}/${HORDE_MAX_WAVES}`;
  engine.startBattle();
}

function showUpgradeSelection(): void {
  const upgrades = pickUpgrades(hordeUnits, hordeWave);
  upgradeCardsEl.innerHTML = '';

  for (const upgrade of upgrades) {
    const card = document.createElement('div');
    card.className = 'upgrade-card';
    card.innerHTML = `
      <div class="card-label">${upgrade.label}</div>
      <div class="card-desc">${upgrade.description}</div>
      <div class="card-category">${upgrade.category}</div>
    `;
    card.addEventListener('click', () => {
      const allBlocks = [...hordeMap!.obstacles, ...hordeMap!.coverBlocks];
      hordeUnits = upgrade.apply(hordeUnits, allBlocks);
      repositionBlueUnits(hordeUnits, allBlocks);
      showScreen('battle');
      startNextHordeWave();
    });
    upgradeCardsEl.appendChild(card);
  }

  // Add Watch Replay button to upgrade screen if replay data exists
  if (lastReplayData) {
    const replayCard = document.createElement('div');
    replayCard.className = 'upgrade-card';
    replayCard.style.borderColor = '#666';
    replayCard.style.opacity = '0.8';
    replayCard.innerHTML = `
      <div class="card-label">Watch Replay</div>
      <div class="card-desc">Rewatch the last wave</div>
      <div class="card-category">replay</div>
    `;
    replayCard.addEventListener('click', () => {
      returnToScreen = 'horde-upgrade';
      startReplay(lastReplayData!);
    });
    upgradeCardsEl.appendChild(replayCard);
  }

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
  newBattleBtn.textContent = 'Main Menu';
  replayBtn.style.display = lastReplayData ? '' : 'none';
  returnToScreen = 'result';

  showScreen('result');
}

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

confirmBtn.addEventListener('click', () => {
  engine?.confirmPlan();
});

coverScreen.addEventListener('click', () => {
  engine?.skipCover();
});

speedButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const speed = Number(btn.dataset.speed);
    engine?.setSpeed(speed);
    speedButtons.forEach(b => b.classList.toggle('active', b === btn));
  });
});

rematchBtn.addEventListener('click', async () => {
  await initRenderer();
  if (hordeActive) {
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

  // Reset horde state
  hordeActive = false;
  hordeWave = 0;
  hordeUnits = [];
  hordeMap = null;
  waveCounterEl.style.display = 'none';

  showPreview();
  showScreen('prompt');
});

// Replay button on result screen
replayBtn.addEventListener('click', () => {
  if (lastReplayData) {
    startReplay(lastReplayData);
  }
});

// Replay control buttons
replayRestartBtn.addEventListener('click', () => {
  replayPlayer?.restart();
  replayPauseBtn.textContent = 'Pause';
});

replayPauseBtn.addEventListener('click', () => {
  if (!replayPlayer) return;
  replayPlayer.togglePause();
  replayPauseBtn.textContent = replayPlayer.isPaused ? 'Play' : 'Pause';
});

replayExitBtn.addEventListener('click', () => {
  stopReplay();
});

replaySpeedButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const speed = Number(btn.dataset.replaySpeed);
    replayPlayer?.setSpeed(speed);
    replaySpeedButtons.forEach(b => b.classList.toggle('active', b === btn));
  });
});

// Initialize renderer and show battlefield preview behind start screen
(async () => {
  await initRenderer();
  showPreview();
  showScreen('prompt');
})();
