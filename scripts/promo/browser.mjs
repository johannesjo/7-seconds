// Shared browser harness for the promo captures: a Vite dev server, a phone-
// sized Chromium page on a fake clock, and frame-exact stepping so videos come
// out smooth at 60 fps however slowly the machine renders.
import { execSync, spawn } from 'node:child_process';
import { get } from 'node:http';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Playwright from the project or the global npm root, else the copy npx keeps
 *  for @playwright/cli (the tool scripts/capture-action-videos.sh already uses). */
export function loadPlaywright() {
  const attempts = [
    // e.g. PLAYWRIGHT_PATH=~/.npm/_npx/<hash>/node_modules/playwright-core
    () => createRequire(import.meta.url)(process.env.PLAYWRIGHT_PATH ?? 'playwright'),
    () => createRequire(import.meta.url)('playwright'),
    () => createRequire(join(execSync('npm root -g', { encoding: 'utf8' }).trim(), 'x.js'))('playwright'),
    () => {
      const bin = execSync('npx --yes --package @playwright/cli which playwright-cli', { encoding: 'utf8' }).trim();
      return createRequire(join(dirname(bin), '..', 'x.js'))('playwright-core');
    },
  ];
  for (const attempt of attempts) {
    try { return attempt(); } catch { /* try the next location */ }
  }
  throw new Error('Playwright not found. Run: npm i -g playwright && npx playwright install chromium');
}

export const FPS = 60;
const FRAME_MS = 1000 / FPS;
/** CSS size of the emulated phone; frames are captured at 3x (1080x1920). */
const PHONE = { width: 360, height: 640, scale: 3 };
/** Repo root, so the scripts work from any working directory. */
const ROOT = fileURLToPath(new URL('../../', import.meta.url));

/** Source edits served to the promo browser only (file → [from, to] pairs).
 *  The game caps its canvas at 2 device pixels per map pixel to save phone
 *  GPUs; promo frames render at the full 3x so they stay crisp. */
const PATCHES = {
  'renderer.ts': [['const MAX_RESOLUTION = 2;', 'const MAX_RESOLUTION = 3;']],
  // Expose the running engine so scenes can read unit positions and types.
  'main.ts': [['engine = new GameEngine(', 'engine = window.promoEngine = new GameEngine(']],
};

/** Start Vite and a Chromium page with the game's first-run prompts skipped.
 *  `patches` adds scene-specific source edits on top of PATCHES, same shape. */
export async function launch({ port = 4199, seed = 1, scale = PHONE.scale, patches = {} } = {}) {
  const server = await startVite(port);
  let browser;
  const close = async () => {
    try { await browser?.close(); } finally { server.kill(); }
  };
  try {
    const { chromium } = loadPlaywright();
    // ANGLE on EGL renders WebGL far faster on Linux than SwiftShader (about
    // 0.1s per 1080x1920 frame instead of 2s), even without a real GPU. macOS
    // uses ANGLE on Metal by default, which is fast already.
    const args = process.platform === 'linux' ? ['--enable-gpu', '--use-gl=angle', '--use-angle=gl-egl'] : [];
    browser = await chromium.launch({ args });
    const { page, errors } = await openPage(browser, { seed, scale, patches });
    await page.goto(`http://127.0.0.1:${port}/`);
    await page.evaluate(syncAnimationFrames);
    // Installed clocks keep flowing in real time; pause so only advance() moves
    // the game, however long a screenshot takes.
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    return { page, harness: createHarness(page), errors, close };
  } catch (err) {
    await close();
    throw err;
  }
}

/** Vite dev server on `port`; resolves once it answers HTTP. */
async function startVite(port) {
  const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: ROOT, stdio: 'ignore',
  });
  let exited = null;
  server.on('exit', code => { exited = code; });
  server.on('error', err => { exited = err.message; });
  for (let waited = 0; waited < 60_000; waited += 200) {
    if (exited !== null) throw new Error(`vite exited (${exited}); is port ${port} free?`);
    if (await answers(port)) return server;
    await new Promise(resolve => setTimeout(resolve, 200));
  }
  server.kill();
  throw new Error(`vite did not start on port ${port} within 60 s`);
}

/** Whether something serves HTTP on `port`. Plain http, not fetch: fetch
 *  refuses "unsafe" ports such as 4190. Refused connections mean not yet. */
function answers(port) {
  return new Promise(resolve => {
    get(`http://127.0.0.1:${port}/`, res => { res.resume(); resolve(res.statusCode === 200); })
      .on('error', () => resolve(false));
  });
}

/** Phone-sized page with init script, source patches and a fake clock. */
async function openPage(browser, { seed, scale, patches }) {
  const context = await browser.newContext({
    viewport: { width: PHONE.width, height: PHONE.height }, deviceScaleFactor: scale, isMobile: true, hasTouch: true,
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', err => errors.push(err.message));
  await page.addInitScript(initPage, seed);
  const files = new Set([...Object.keys(PATCHES), ...Object.keys(patches)]);
  for (const file of files) {
    const edits = [...(PATCHES[file] ?? []), ...(patches[file] ?? [])];
    await page.route(`**/src/${file}*`, route => patchRoute(route, file, edits, errors));
  }
  await page.clock.install();
  return { page, errors };
}

/** Serve `file` with `edits` applied; a stale edit is reported in `errors`
 *  (checked by every capture script) instead of failing silently. */
async function patchRoute(route, file, edits, errors) {
  const response = await route.fetch();
  let body = await response.text();
  const stale = edits.filter(([from]) => !body.includes(from));
  if (stale.length > 0) {
    errors.push(`promo patch no longer matches src/${file}: ${stale.map(([from]) => from).join(' | ')}`);
    await route.fulfill({ response });
    return;
  }
  for (const [from, to] of edits) body = body.split(from).join(to);
  await route.fulfill({ response, body });
}

/** Runs in the page before the game: skip first-run prompts, silence audio,
 *  seed Math.random so maps and armies repeat, and add a finger marker. */
function initPage(seed) {
  localStorage.setItem('7s-age-verified', '1');
  localStorage.setItem('7s-tutorial-seen', '1');
  localStorage.setItem('7s-settings', JSON.stringify({ sound: false, music: false }));
  let state = seed >>> 0;
  Math.random = () => {
    state = (state + 0x6D2B79F5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  addEventListener('DOMContentLoaded', () => {
    const style = document.createElement('style');
    style.textContent = `#promo-finger{position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;
      background:rgba(255,255,255,.55);border:3px solid rgba(40,40,40,.55);box-shadow:0 2px 8px rgba(0,0,0,.25);
      pointer-events:none;z-index:99999;opacity:0;transition:none}
      #unit-info{display:none!important}`;
    document.head.append(style);
    const finger = document.createElement('div');
    finger.id = 'promo-finger';
    document.body.append(finger);
  });
}

/** Playwright's fake clock hands rAF callbacks a timestamp on another time
 *  base than performance.now, which made Pixi see 100ms per frame and play
 *  the game ~6x too fast. Pass performance.now instead. */
function syncAnimationFrames() {
  const raf = window.requestAnimationFrame.bind(window);
  window.requestAnimationFrame = callback => raf(() => callback(performance.now()));
}

function createHarness(page) {
  /** Advance the fake clock and keep CSS animations on the same clock. */
  const advance = async ms => {
    await page.clock.runFor(ms);
    await page.evaluate(() => {
      const now = performance.now();
      for (const anim of document.getAnimations()) {
        if (anim.promoStart === undefined) {
          anim.promoStart = now - (anim.currentTime ?? 0);
          anim.pause();
        }
        anim.currentTime = now - anim.promoStart;
      }
    });
  };
  // Playwright's own screenshot: CDP captures here come back at CSS size, and
  // a scaled clip drops the phone emulation for every later frame.
  const capture = () => page.screenshot({ type: 'png', scale: 'device', animations: 'allow', caret: 'initial' });
  const setFinger = (x, y, visible) => page.evaluate(([fx, fy, show]) => {
    const el = document.getElementById('promo-finger');
    if (!el) return;
    el.style.transform = `translate(${fx}px, ${fy}px) scale(${show ? 1 : 0.6})`;
    el.style.opacity = show ? '1' : '0';
  }, [x, y, visible]);
  return { advance, capture, setFinger, frameMs: FRAME_MS };
}

/** Map size (live from the game's own module) and a map→page mapper. */
export async function mapGeometry(page) {
  const box = await page.locator('#pixi-container canvas').boundingBox();
  const { mapWidth, mapHeight } = await page.evaluate(async () => {
    const constants = await import('/src/constants.ts');
    return { mapWidth: constants.MAP_WIDTH, mapHeight: constants.MAP_HEIGHT };
  });
  const scale = box.width / mapWidth;
  return { box, mapWidth, mapHeight, toPage: (mx, my) => [box.x + mx * scale, box.y + my * scale] };
}
