import { Renderer } from './renderer';
import { GameEngine } from './game';
import { BattleResult } from './types';

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

const pixiContainer = document.getElementById('pixi-container')!;

// State
let renderer: Renderer | null = null;
let engine: GameEngine | null = null;
let lastBluePrompt = '';
let lastRedPrompt = '';

function showScreen(screen: 'prompt' | 'battle' | 'result') {
  promptScreen.classList.toggle('active', screen === 'prompt');
  battleScreen.classList.toggle('active', screen === 'battle' || screen === 'result');
  resultScreen.classList.toggle('active', screen === 'result');
}

function onGameEvent(event: 'update' | 'end', data?: BattleResult) {
  if (event === 'update' && engine) {
    const counts = engine.getAliveCount();
    blueCountEl.textContent = `Blue: ${counts.blue}`;
    redCountEl.textContent = `Red: ${counts.red}`;
  }

  if (event === 'end' && data) {
    const color = data.winner === 'blue' ? '#4a9eff' : '#ff4a4a';
    winnerTextEl.textContent = `${data.winner === 'blue' ? 'Blue' : 'Red'} Wins!`;
    winnerTextEl.style.color = color;
    resultStatsEl.innerHTML = [
      `Duration: ${data.duration.toFixed(1)}s`,
      `Blue survivors: ${data.blueAlive}/10`,
      `Red survivors: ${data.redAlive}/10`,
    ].join('<br>');
    showScreen('result');
  }
}

async function startBattle(bluePrompt: string, redPrompt: string) {
  loadingOverlay.classList.add('active');

  // Clean up previous
  engine?.stop();
  renderer?.destroy();

  renderer = new Renderer();
  await renderer.init(pixiContainer);

  engine = new GameEngine(renderer, onGameEvent);

  showScreen('battle');

  // Reset speed buttons
  speedButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.speed === '1'));

  await engine.startBattle(bluePrompt, redPrompt);
  loadingOverlay.classList.remove('active');
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
  renderer?.destroy();
  renderer = null;
  engine = null;
  showScreen('prompt');
});

// Check AI availability
(async () => {
  const statusEl = document.getElementById('ai-status')!;
  try {
    if (typeof LanguageModel === 'undefined') {
      statusEl.textContent = 'Chrome AI not available — using fallback AI (units will chase nearest enemy)';
      return;
    }
    const availability = await LanguageModel.availability();
    if (availability === 'unavailable') {
      statusEl.textContent = 'Language model unavailable — using fallback AI';
    } else if (availability === 'downloadable') {
      statusEl.textContent = 'Language model needs to download — first battle may be slow';
    } else {
      statusEl.textContent = 'Chrome AI ready';
    }
  } catch {
    statusEl.textContent = 'Could not check AI status — using fallback AI';
  }
})();

// Start on prompt screen
showScreen('prompt');
