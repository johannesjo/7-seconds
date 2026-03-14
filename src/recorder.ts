// Self-contained canvas recorder module.
// Loaded dynamically via `import('./recorder')` — never in the main bundle.
// Activate with `?record` URL parameter.

type RecorderState = 'idle' | 'recording' | 'processing';

class CanvasRecorder {
  state: RecorderState = 'idle';

  private canvas: HTMLCanvasElement;
  private maxDurationMs: number;
  private fps: number;

  private mediaRecorder: MediaRecorder | null = null;
  private chunks: Blob[] = [];

  private startTime = 0;
  private autoStopTimer: ReturnType<typeof setTimeout> | null = null;
  private onAutoStop: (() => void) | null = null;

  constructor(canvas: HTMLCanvasElement, onAutoStop?: () => void) {
    this.canvas = canvas;
    this.maxDurationMs = 15_000;
    this.fps = 30;
    this.onAutoStop = onAutoStop ?? null;
  }

  start(): void {
    if (this.state !== 'idle') return;
    this.state = 'recording';
    this.startTime = performance.now();

    this.chunks = [];
    let stream: MediaStream;
    try {
      stream = this.canvas.captureStream(this.fps);
    } catch {
      this.state = 'idle';
      return;
    }

    const mimeTypes = [
      'video/webm;codecs=vp9',
      'video/webm;codecs=vp8',
      'video/webm',
    ];
    const mimeType = mimeTypes.find(m => MediaRecorder.isTypeSupported(m));
    if (!mimeType) {
      this.state = 'idle';
      return;
    }

    this.mediaRecorder = new MediaRecorder(stream, { mimeType });
    this.mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) this.chunks.push(e.data);
    };
    this.mediaRecorder.start(100);

    this.autoStopTimer = setTimeout(() => {
      this.onAutoStop?.();
    }, this.maxDurationMs);
  }

  async stop(): Promise<Blob | undefined> {
    if (this.state !== 'recording') return undefined;
    this.state = 'processing';

    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }

    const blob = await new Promise<Blob | undefined>((resolve) => {
      if (!this.mediaRecorder || this.mediaRecorder.state === 'inactive') {
        resolve(undefined);
        return;
      }
      this.mediaRecorder.onstop = () => {
        const b = new Blob(this.chunks, { type: 'video/webm' });
        this.chunks = [];
        this.mediaRecorder = null;
        resolve(b);
      };
      this.mediaRecorder.stop();
    });

    this.state = 'idle';
    return blob;
  }

  cancel(): void {
    if (this.autoStopTimer) {
      clearTimeout(this.autoStopTimer);
      this.autoStopTimer = null;
    }
    if (this.mediaRecorder && this.mediaRecorder.state !== 'inactive') {
      this.mediaRecorder.stop();
    }
    this.mediaRecorder = null;
    this.chunks = [];
    this.state = 'idle';
  }
}

// --- UI & lifecycle (self-contained) ---

let recorder: CanvasRecorder | null = null;
let recordingStartTime = 0;
let timerInterval: ReturnType<typeof setInterval> | null = null;
let recordedWebm: Blob | undefined;

// DOM elements created by init()
let hudRecordBtn: HTMLButtonElement;
let replayRecordBtn: HTMLButtonElement;
let indicator: HTMLDivElement;
let timerEl: HTMLSpanElement;
let downloadPrompt: HTMLDivElement;

function getCanvas(): HTMLCanvasElement | null {
  return document.querySelector('#pixi-container canvas');
}

function injectStyles(): void {
  const style = document.createElement('style');
  style.textContent = `
    #record-indicator {
      position: absolute;
      top: calc(48px + var(--sat, 0px));
      right: 16px;
      display: flex;
      align-items: center;
      gap: 6px;
      z-index: 11;
      pointer-events: none;
      font-size: 14px;
      font-variant-numeric: tabular-nums;
    }
    .record-dot {
      display: inline-block;
      width: 10px;
      height: 10px;
      border-radius: 50%;
      background: #ff3333;
      animation: record-pulse 1s ease-in-out infinite;
    }
    @keyframes record-pulse {
      0%, 100% { opacity: 1; }
      50% { opacity: 0.3; }
    }
    #record-download {
      position: absolute;
      bottom: 60px;
      left: 50%;
      transform: translateX(-50%);
      display: flex;
      gap: 8px;
      z-index: 14;
      background: var(--color-overlay-heavy);
      padding: 12px 16px;
      border-radius: 8px;
      border: 1px solid var(--color-btn-border);
    }
    #record-download button {
      background: var(--color-btn-bg);
      color: var(--color-text);
      border: 1px solid var(--color-btn-border);
      padding: 6px 14px;
      cursor: pointer;
      font-size: 13px;
      border-radius: 3px;
      white-space: nowrap;
    }
    #record-download button:hover {
      background: var(--color-btn-hover-bg);
      border-color: var(--color-btn-hover-border);
    }
  `;
  document.head.appendChild(style);
}

function createButton(title: string): HTMLButtonElement {
  const btn = document.createElement('button');
  btn.title = title;
  btn.innerHTML = '&#x23FA;';
  return btn;
}

function createUI(): void {
  const battleScreen = document.getElementById('battle-screen')!;

  // Record button in battle HUD speed controls
  const speedControls = document.querySelector('#battle-hud .speed-controls');
  if (speedControls) {
    hudRecordBtn = createButton('Record clip (R)');
    speedControls.appendChild(hudRecordBtn);
    hudRecordBtn.addEventListener('click', toggleRecording);
  }

  // Record button in replay overlay (before exit button)
  const replayOverlay = document.getElementById('replay-overlay');
  const replayExitBtn = document.getElementById('replay-exit-btn');
  if (replayOverlay && replayExitBtn) {
    replayRecordBtn = createButton('Record clip (R)');
    replayOverlay.insertBefore(replayRecordBtn, replayExitBtn);
    replayRecordBtn.addEventListener('click', toggleRecording);
  }

  // Recording indicator
  indicator = document.createElement('div');
  indicator.id = 'record-indicator';
  indicator.style.display = 'none';
  indicator.innerHTML = '<span class="record-dot"></span><span id="record-timer">0:00</span>';
  timerEl = indicator.querySelector('#record-timer')!;
  battleScreen.appendChild(indicator);

  // Download prompt
  downloadPrompt = document.createElement('div');
  downloadPrompt.id = 'record-download';
  downloadPrompt.style.display = 'none';

  const dlBtn = document.createElement('button');
  dlBtn.textContent = 'Save Video (.webm)';
  dlBtn.addEventListener('click', () => {
    if (recordedWebm) downloadBlob(recordedWebm, 'webm');
  });

  const dismissBtn = document.createElement('button');
  dismissBtn.textContent = 'Dismiss';
  dismissBtn.addEventListener('click', () => {
    downloadPrompt.style.display = 'none';
    recordedWebm = undefined;
  });

  downloadPrompt.appendChild(dlBtn);
  downloadPrompt.appendChild(dismissBtn);
  battleScreen.appendChild(downloadPrompt);
}

function updateTimer(): void {
  if (!recorder || recorder.state !== 'recording') return;
  const elapsed = performance.now() - recordingStartTime;
  const secs = Math.floor(elapsed / 1000);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  timerEl.textContent = `${mins}:${s < 10 ? '0' : ''}${s}`;
}

function setButtonColor(color: string): void {
  if (hudRecordBtn) hudRecordBtn.style.color = color;
  if (replayRecordBtn) replayRecordBtn.style.color = color;
}

async function startRecording(): Promise<void> {
  const canvas = getCanvas();
  if (!canvas) return;
  if (recorder?.state === 'recording') return;

  recorder = new CanvasRecorder(canvas, () => { stopRecording(); });
  recorder.start();
  recordingStartTime = performance.now();

  indicator.style.display = 'flex';
  downloadPrompt.style.display = 'none';
  timerEl.textContent = '0:00';
  timerInterval = setInterval(updateTimer, 200);

  setButtonColor('#ff3333');
}

async function stopRecording(): Promise<void> {
  if (!recorder || recorder.state !== 'recording') return;

  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  recordedWebm = await recorder.stop();
  recorder = null;

  indicator.style.display = 'none';
  setButtonColor('');

  if (recordedWebm) {
    downloadPrompt.style.display = 'flex';
  }
}

function toggleRecording(): void {
  if (recorder?.state === 'recording') {
    stopRecording();
  } else {
    startRecording();
  }
}

// --- Public API ---

/** Stop recording if active (called by main module on game end / replay exit). */
export function stopIfRecording(): void {
  if (recorder?.state === 'recording') stopRecording();
}

/** Cancel recording without saving (called on exit to menu). */
export function cancelIfRecording(): void {
  if (!recorder) return;
  if (timerInterval) {
    clearInterval(timerInterval);
    timerInterval = null;
  }
  recorder.cancel();
  recorder = null;
  indicator.style.display = 'none';
  downloadPrompt.style.display = 'none';
  setButtonColor('');
}

/** Bootstrap the recorder UI and keyboard shortcut. */
export function init(): void {
  injectStyles();
  createUI();

  const battleHud = document.getElementById('battle-hud')!;
  const battleScreen = document.getElementById('battle-screen')!;
  const replayOverlay = document.getElementById('replay-overlay');

  document.addEventListener('keydown', (e) => {
    if (e.key === 'r' || e.key === 'R') {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) return;
      const inBattle = battleHud.style.display !== 'none' && battleScreen.classList.contains('active');
      const inReplay = replayOverlay?.classList.contains('active');
      if (inBattle || inReplay) {
        toggleRecording();
      }
    }
  });
}

// --- Helpers ---

function pad2(n: number): string {
  return n < 10 ? '0' + n : String(n);
}

function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${pad2(d.getMonth() + 1)}${pad2(d.getDate())}-${pad2(d.getHours())}${pad2(d.getMinutes())}${pad2(d.getSeconds())}`;
}

function downloadBlob(blob: Blob, ext: string): void {
  const filename = `7seconds-${timestamp()}.${ext}`;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
