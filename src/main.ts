import { Renderer } from './renderer';
import { GameEngine } from './game';
// import { generateObstacles } from './battlefield'; // obstacles disabled
import { createArmy } from './units';
import { setProgressCallback } from './ai-commander';
import { BattleResult } from './types';
import { ARMY_COMPOSITION } from './constants';

// DOM elements
const promptScreen = document.getElementById('prompt-screen')!;
const battleScreen = document.getElementById('battle-screen')!;
const resultScreen = document.getElementById('result-screen')!;
const loadingOverlay = document.getElementById('loading-overlay')!;

const bluePromptEl = document.getElementById('blue-prompt') as HTMLTextAreaElement;
const redPromptEl = document.getElementById('red-prompt') as HTMLTextAreaElement;
const battleBtn = document.getElementById('battle-btn')!;

const blueCountEl = document.getElementById('blue-count')!;
const redCountEl = document.getElementById('red-count')!;
const speedButtons = document.querySelectorAll<HTMLButtonElement>('.speed-controls button');

const winnerTextEl = document.getElementById('winner-text')!;
const resultStatsEl = document.getElementById('result-stats')!;
const rematchBtn = document.getElementById('rematch-btn')!;
const newBattleBtn = document.getElementById('new-battle-btn')!;

const loadingTextEl = document.getElementById('loading-text')!;
const loadingBarEl = document.getElementById('loading-bar')!;
const pixiContainer = document.getElementById('pixi-container')!;
const blueAiStatusEl = document.getElementById('blue-ai-status')!;
const redAiStatusEl = document.getElementById('red-ai-status')!;

// State
let renderer: Renderer | null = null;
let engine: GameEngine | null = null;
let lastBluePrompt = '';
let lastRedPrompt = '';
// let currentObstacles: Obstacle[] = []; // obstacles disabled

function showScreen(screen: 'prompt' | 'battle' | 'result') {
  promptScreen.classList.toggle('active', screen === 'prompt');
  battleScreen.classList.add('active'); // always visible once initialized
  resultScreen.classList.toggle('active', screen === 'result');
}

function onGameEvent(event: 'update' | 'end', data?: BattleResult) {
  if (event === 'update' && engine) {
    const counts = engine.getAliveCount();
    blueCountEl.textContent = `Blue: ${counts.blue}`;
    redCountEl.textContent = `Red: ${counts.red}`;
    const ai = engine.aiStatus;
    blueAiStatusEl.textContent = ai.blue;
    redAiStatusEl.textContent = ai.red;
  }

  if (event === 'end' && data) {
    const color = data.winner === 'blue' ? '#4a9eff' : '#ff4a4a';
    winnerTextEl.textContent = `${data.winner === 'blue' ? 'Blue' : 'Red'} Wins!`;
    winnerTextEl.style.color = color;
    resultStatsEl.innerHTML = [
      `Duration: ${data.duration.toFixed(1)}s`,
      `Blue survivors: ${data.blueAlive}/${ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0)}`,
      `Red survivors: ${data.redAlive}/${ARMY_COMPOSITION.reduce((s, c) => s + c.count, 0)}`,
    ].join('<br>');
    showScreen('result');
  }
}

async function initRenderer(): Promise<void> {
  if (renderer) return;
  renderer = new Renderer();
  await renderer.init(pixiContainer);
  battleScreen.classList.add('active');
}

function showPreview(): void {
  if (!renderer) return;
  // currentObstacles = generateObstacles(); // obstacles disabled
  // renderer.renderObstacles(currentObstacles); // obstacles disabled
  // Show spawn positions as ghost units
  const preview = [...createArmy('blue'), ...createArmy('red')];
  renderer.renderUnits(preview);
}

async function startBattle(bluePrompt: string, redPrompt: string) {
  loadingOverlay.classList.add('active');
  loadingTextEl.textContent = 'Loading AI model...';
  loadingBarEl.style.width = '0%';

  setProgressCallback((progress) => {
    loadingTextEl.textContent = progress.text;
    loadingBarEl.style.width = `${Math.round(progress.progress * 100)}%`;
  });

  engine?.stop();
  await initRenderer();

  engine = new GameEngine(renderer!, onGameEvent);

  showScreen('battle');

  // Reset speed buttons
  speedButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.speed === '1'));

  const result = await engine.startBattle(bluePrompt, redPrompt, []); // obstacles disabled
  loadingOverlay.classList.remove('active');

  if (!result.blueAi || !result.redAi) {
    engine.stop();
    engine = null;
    loadingTextEl.textContent = 'WebGPU not available — cannot start battle';
    loadingBarEl.style.width = '0%';
    loadingOverlay.classList.add('active');
    setTimeout(() => {
      loadingOverlay.classList.remove('active');
      showPreview();
      showScreen('prompt');
    }, 2000);
    return;
  }
}

// Event listeners
battleBtn.addEventListener('click', () => {
  lastBluePrompt = bluePromptEl.value.trim() || 'Attack the enemy aggressively.';
  lastRedPrompt = redPromptEl.value.trim() || 'Defend and counterattack.';
  startBattle(lastBluePrompt, lastRedPrompt);
});

speedButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const speed = Number(btn.dataset.speed);
    engine?.setSpeed(speed);
    speedButtons.forEach(b => b.classList.toggle('active', b === btn));
  });
});

rematchBtn.addEventListener('click', () => {
  startBattle(lastBluePrompt, lastRedPrompt);
});

newBattleBtn.addEventListener('click', () => {
  engine?.stop();
  engine = null;
  showPreview();
  showScreen('prompt');
});

// Check AI availability
(() => {
  const statusEl = document.getElementById('ai-status')!;
  if (!navigator.gpu) {
    statusEl.textContent = 'WebGPU not available — using fallback AI (units will chase nearest enemy)';
  } else {
    statusEl.textContent = 'WebLLM ready (model downloads on first battle)';
  }
})();

// Initialize renderer and show battlefield preview behind prompt screen
(async () => {
  await initRenderer();
  showPreview();
  showScreen('prompt');
})();
