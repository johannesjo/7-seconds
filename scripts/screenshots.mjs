#!/usr/bin/env node
// Capture every main screen at phone and desktop sizes for a visual check
// before a release: npm run screenshots  →  output/screenshots/*.png
// Needs Playwright with Chromium (`npm i -g playwright && npx playwright install chromium`).
// Exits non-zero if the page logs an uncaught error.
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require('playwright'));
} catch {
  console.error('Playwright is not installed. Run: npm i -g playwright && npx playwright install chromium');
  process.exit(1);
}

const PORT = Number(process.env.SCREENSHOT_PORT ?? 4174);
const URL = `http://127.0.0.1:${PORT}/`;
const OUT = 'output/screenshots';
const VIEWPORTS = [
  { name: 'phone', viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true },
  { name: 'desktop', viewport: { width: 1280, height: 800 } },
];

mkdirSync(OUT, { recursive: true });
const server = spawn(process.execPath, ['node_modules/vite/bin/vite.js', '--host', '127.0.0.1', '--port', String(PORT), '--strictPort'], {
  stdio: ['ignore', 'pipe', 'inherit'],
});
await new Promise((resolve, reject) => {
  server.stdout.on('data', chunk => { if (String(chunk).includes('Local:')) resolve(); });
  server.on('exit', code => reject(new Error(`vite exited with ${code}`)));
});

const errors = [];
const browser = await chromium.launch();
try {
  for (const { name, ...options } of VIEWPORTS) {
    const context = await browser.newContext(options);
    const page = await context.newPage();
    page.on('pageerror', err => errors.push(`${name}: ${err.message}`));
    await page.addInitScript(() => {
      localStorage.setItem('7s-age-verified', '1');
      // Silence audio so captures don't depend on an audio device.
      localStorage.setItem('7s-settings', JSON.stringify({ sound: false, music: false }));
    });
    const shot = file => page.screenshot({ path: `${OUT}/${name}-${file}.png` });

    await page.goto(URL);
    await page.waitForTimeout(1200);
    await shot('01-menu');

    await page.click('#ai-btn');
    await page.waitForTimeout(800);
    await shot('02-planning');
    await drawPaths(page);
    await shot('03-paths');
    await page.click('#confirm-btn');
    await page.waitForTimeout(2500);
    await shot('04-battle');

    // Play rounds at 3x speed until the battle ends.
    await page.click('#speed-toggle').catch(() => {});
    let bannerShot = false;
    for (let poll = 0; poll < 300 && !(await page.isVisible('#result-screen.active')); poll++) {
      if (!bannerShot && await page.isVisible('#round-banner.show')) {
        await shot('05-round-banner');
        bannerShot = true;
      }
      if (await page.isVisible('#confirm-btn.active')) await page.click('#confirm-btn');
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(800);
    await shot('06-result');

    for (const [id, file] of [['#tutorial-btn', '07-tutorial'], ['#horde-btn', '08-horde'], ['#daily-btn', '09-daily']]) {
      await page.goto(URL);
      await page.waitForTimeout(800);
      await page.click(id);
      await page.waitForTimeout(1000);
      await shot(file);
    }
    await context.close();
  }
} finally {
  await browser.close();
  server.kill();
}

if (errors.length > 0) {
  console.error(`Page errors:\n${errors.join('\n')}`);
  process.exit(1);
}
console.log(`Screenshots written to ${OUT}/`);
process.exit(0);

/** Drag each blue unit toward the enemy. Armies of 3–5 stand in a centred row
 *  60 map px apart, so every slot sits on a 30px grid around the centre. */
async function drawPaths(page) {
  const canvas = page.locator('#pixi-container canvas');
  const box = await canvas.boundingBox();
  const { mapWidth, mapHeight } = await canvas.evaluate(c => ({ mapWidth: c.width, mapHeight: c.height }));
  const scale = box.width / mapWidth;
  for (let slot = -4; slot <= 4; slot++) {
    const x = box.x + (mapWidth / 2 + slot * 30) * scale;
    const y = box.y + mapHeight * 0.92 * scale;
    await page.mouse.move(x, y);
    await page.mouse.down();
    for (let step = 1; step <= 6; step++) {
      await page.mouse.move(x + slot * 3 * step, y - mapHeight * 0.06 * step * scale, { steps: 4 });
    }
    await page.mouse.up();
  }
}
