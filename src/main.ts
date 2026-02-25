import { Renderer } from './renderer';
import { GameEngine } from './game';
import { createArmy } from './units';
import { generateObstacles } from './battlefield';
import { BattleResult, TurnPhase } from './types';
import { ARMY_COMPOSITION } from './constants';

// DOM elements
const promptScreen = document.getElementById('prompt-screen')!;
const battleScreen = document.getElementById('battle-screen')!;
const resultScreen = document.getElementById('result-screen')!;

const battleBtn = document.getElementById('battle-btn')!;
const aiBtn = document.getElementById('ai-btn')!;

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

const pixiContainer = document.getElementById('pixi-container')!;

// State
let renderer: Renderer | null = null;
let engine: GameEngine | null = null;
let aiMode = false;

function showScreen(screen: 'prompt' | 'battle' | 'result') {
  promptScreen.classList.toggle('active', screen === 'prompt');
  battleScreen.classList.add('active'); // always visible once initialized
  resultScreen.classList.toggle('active', screen === 'result');
}

function onPhaseChange(phase: TurnPhase): void {
  // Planning overlay
  if (phase === 'blue-planning' || phase === 'red-planning') {
    const team = phase === 'blue-planning' ? 'Blue' : 'Red';
    const color = phase === 'blue-planning' ? '#4a9eff' : '#ff4a4a';
    planningLabel.textContent = `${team} Planning`;
    planningLabel.style.color = color;
    planningOverlay.classList.add('active');
    roundTimerEl.textContent = '';
  } else {
    planningOverlay.classList.remove('active');
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
    winnerTextEl.textContent = `${result.winner === 'blue' ? 'Blue' : 'Red'} Wins!`;
    winnerTextEl.style.color = color;

    const armySize = ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0);
    resultStatsEl.innerHTML = [
      `Duration: ${result.duration.toFixed(1)}s`,
      `Blue survivors: ${result.blueAlive}/${armySize}`,
      `Red survivors: ${result.redAlive}/${armySize}`,
    ].join('<br>');
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
  renderer.renderObstacles(generateObstacles());
  const preview = [...createArmy('blue'), ...createArmy('red')];
  renderer.renderUnits(preview);
}

function startGame(): void {
  engine?.stop();
  engine = new GameEngine(renderer!, onGameEvent, aiMode);
  showScreen('battle');
  speedButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.speed === '1'));
  roundCounterEl.textContent = 'Round 1';
  engine.startBattle();
}

// Event listeners
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
  coverScreen.classList.remove('active');
  roundTimerEl.textContent = '';
  showPreview();
  showScreen('prompt');
});

// Initialize renderer and show battlefield preview behind start screen
(async () => {
  await initRenderer();
  showPreview();
  showScreen('prompt');
})();
