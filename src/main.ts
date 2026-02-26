import { Renderer } from './renderer';
import { GameEngine } from './game';
import { createArmy } from './units';
import { generateObstacles, generateElevationZones } from './battlefield';
import { BattleResult, TurnPhase, MissionDef } from './types';
import { ARMY_COMPOSITION } from './constants';
import { MISSIONS } from './missions';

// DOM elements
const promptScreen = document.getElementById('prompt-screen')!;
const campaignScreen = document.getElementById('campaign-screen')!;
const battleScreen = document.getElementById('battle-screen')!;
const resultScreen = document.getElementById('result-screen')!;

const battleBtn = document.getElementById('battle-btn')!;
const aiBtn = document.getElementById('ai-btn')!;
const campaignBtn = document.getElementById('campaign-btn')!;

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

const missionListEl = document.getElementById('mission-list')!;
const campaignBackBtn = document.getElementById('campaign-back-btn')!;

const zoneControlCb = document.getElementById('zone-control-cb') as HTMLInputElement;
const oneShotCb = document.getElementById('one-shot-cb') as HTMLInputElement;
const bloodCb = document.getElementById('blood-cb') as HTMLInputElement;
const pixiContainer = document.getElementById('pixi-container')!;

// State
let renderer: Renderer | null = null;
let engine: GameEngine | null = null;
let aiMode = false;
let currentMission: MissionDef | null = null;
const completedMissions = new Set<number>();

function showScreen(screen: 'prompt' | 'campaign' | 'battle' | 'result') {
  promptScreen.classList.toggle('active', screen === 'prompt');
  campaignScreen.classList.toggle('active', screen === 'campaign');
  battleScreen.classList.add('active'); // always visible once initialized
  resultScreen.classList.toggle('active', screen === 'result');
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

  // Cover screen
  coverScreen.classList.toggle('active', phase === 'cover');
}

function onGameEvent(
  event: 'update' | 'end' | 'phase-change',
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

  if (event === 'end' && data && 'winner' in data) {
    const result = data as BattleResult;
    const color = result.winner === 'blue' ? '#4a9eff' : '#ff4a4a';
    const conditionLabel = result.winCondition === 'zone-control' ? 'Zone Control!' : 'Elimination!';
    winnerTextEl.innerHTML = `${result.winner === 'blue' ? 'Blue' : 'Red'} Wins!<br><span style="font-size:0.5em;opacity:0.7">${conditionLabel}</span>`;
    winnerTextEl.style.color = color;

    // Calculate army sizes based on mode
    const blueTotal = currentMission
      ? currentMission.blueArmy.reduce((s, c) => s + c.count, 0)
      : ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0);
    const redTotal = currentMission
      ? currentMission.redArmy.reduce((s, c) => s + c.count, 0)
      : ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0);

    resultStatsEl.innerHTML = [
      `Duration: ${result.duration.toFixed(1)}s`,
      `Blue survivors: ${result.blueAlive}/${blueTotal}`,
      `Red survivors: ${result.redAlive}/${redTotal}`,
    ].join('<br>');

    // Campaign: mark mission complete on win, show appropriate buttons
    if (currentMission) {
      if (result.winner === 'blue') {
        completedMissions.add(currentMission.id);
      }
      const nextMission = MISSIONS.find(m => m.id === currentMission!.id + 1);
      updateResultButtons(result.winner === 'blue' && nextMission != null);
    } else {
      updateResultButtons(false);
    }

    showScreen('result');
  }
}

function updateResultButtons(showNext: boolean): void {
  // Reset buttons to default state
  rematchBtn.textContent = 'Rematch';
  newBattleBtn.textContent = currentMission ? 'Back to Missions' : 'New Battle';

  // Remove old next-mission button if any
  const existingNext = document.getElementById('next-mission-btn');
  if (existingNext) existingNext.remove();

  if (showNext) {
    const nextBtn = document.createElement('button');
    nextBtn.id = 'next-mission-btn';
    nextBtn.textContent = 'Next Mission';
    nextBtn.addEventListener('click', () => {
      const next = MISSIONS.find(m => m.id === currentMission!.id + 1);
      if (next) {
        currentMission = next;
        startGame();
      }
    });
    rematchBtn.parentElement!.appendChild(nextBtn);
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
  engine?.stop();
  engine = new GameEngine(renderer!, onGameEvent, {
    aiMode,
    mission: currentMission ?? undefined,
    zoneControl: zoneControlCb.checked,
    oneShot: oneShotCb.checked,
    blood: bloodCb.checked,
  });
  showScreen('battle');
  speedButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.speed === '1'));
  roundCounterEl.textContent = 'Round 1';
  engine.startBattle();
}

function renderMissionList(): void {
  missionListEl.innerHTML = '';
  for (const mission of MISSIONS) {
    const btn = document.createElement('button');
    btn.className = 'mission-btn';

    const isCompleted = completedMissions.has(mission.id);
    const isUnlocked = mission.id === 1 || completedMissions.has(mission.id - 1);

    btn.disabled = !isUnlocked;

    const statusText = isCompleted ? 'Completed' : isUnlocked ? 'Available' : 'Locked';
    const statusColor = isCompleted ? '#66ff88' : isUnlocked ? '#4a9eff' : '#666';

    btn.innerHTML = `
      <div class="mission-name">${mission.name}</div>
      <div class="mission-desc">${mission.description}</div>
      <div class="mission-status" style="color:${statusColor}">${statusText}</div>
    `;

    btn.addEventListener('click', async () => {
      if (!isUnlocked) return;
      currentMission = mission;
      aiMode = true;
      await initRenderer();
      startGame();
    });

    missionListEl.appendChild(btn);
  }
}

// Event listeners
battleBtn.addEventListener('click', async () => {
  aiMode = false;
  currentMission = null;
  await initRenderer();
  startGame();
});

aiBtn.addEventListener('click', async () => {
  aiMode = true;
  currentMission = null;
  await initRenderer();
  startGame();
});

campaignBtn.addEventListener('click', async () => {
  await initRenderer();
  renderMissionList();
  showScreen('campaign');
});

campaignBackBtn.addEventListener('click', () => {
  showPreview();
  showScreen('prompt');
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
  startGame();
});

newBattleBtn.addEventListener('click', () => {
  engine?.stop();
  engine = null;
  planningOverlay.classList.remove('active');
  confirmBtn.classList.remove('active');
  coverScreen.classList.remove('active');
  roundTimerEl.textContent = '';

  if (currentMission) {
    // Return to campaign screen
    currentMission = null;
    renderMissionList();
    showPreview();
    showScreen('campaign');
  } else {
    showPreview();
    showScreen('prompt');
  }
});

// Initialize renderer and show battlefield preview behind start screen
(async () => {
  await initRenderer();
  showPreview();
  showScreen('prompt');
})();
