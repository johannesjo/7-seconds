// Building blocks for promo scenes: open a mode, draw paths like a player
// would (with a visible finger), and play time forward while recording.
import { mkdirSync, writeFileSync } from 'node:fs';
import { mapGeometry } from './browser.mjs';

/** Frame sink: when `dir` is set every frame is written as a numbered PNG,
 *  otherwise time just runs (in coarse steps, for fast searches). */
export function createTape(harness, dir = null) {
  let frame = 0;
  if (dir) mkdirSync(dir, { recursive: true });
  return {
    get frames() { return frame; },
    /** Run `ms` of game time, capturing at 60 fps when recording. */
    async play(ms) {
      if (!dir) {
        // Pixi caps one tick at 100ms, so bigger steps would slow the game down.
        for (let left = ms; left > 0; left -= 100) await harness.advance(Math.min(100, left));
        return;
      }
      const count = Math.round(ms / harness.frameMs);
      for (let i = 0; i < count; i++) await this.step();
    },
    async step() {
      await harness.advance(harness.frameMs);
      if (dir) writeFileSync(`${dir}/${String(frame).padStart(5, '0')}.png`, await harness.capture());
      frame++;
    },
  };
}

/** Let the menu's intro animation settle before the first click. */
export async function openMenu(tape) {
  await tape.play(1500);
}

export async function startAiBattle(page, tape, difficulty = 'normal') {
  await page.click('#ai-btn');
  await tape.play(250);
  await page.click(`#difficulty-screen [data-difficulty="${difficulty}"]`);
  await tape.play(900);
}

/** Drag along map-coordinate waypoints at `speed` map px/s, one frame at a time.
 *  `rig` is { page, harness, tape }. */
export async function drawPath(rig, waypoints, speed = 520) {
  const { page, harness, tape } = rig;
  const geo = await mapGeometry(page);
  const points = waypoints.map(([x, y]) => geo.toPage(x, y));
  const stepPx = (speed / 60) * (geo.box.width / geo.mapWidth);
  await harness.setFinger(...points[0], true);
  await page.mouse.move(...points[0]);
  await page.mouse.down();
  await tape.step();
  for (let i = 1; i < points.length; i++) {
    const [ax, ay] = points[i - 1];
    const [bx, by] = points[i];
    const steps = Math.max(1, Math.round(Math.hypot(bx - ax, by - ay) / stepPx));
    for (let s = 1; s <= steps; s++) {
      const x = ax + ((bx - ax) * s) / steps;
      const y = ay + ((by - ay) * s) / steps;
      await page.mouse.move(x, y);
      await harness.setFinger(x, y, true);
      await tape.step();
    }
  }
  await page.mouse.up();
  await harness.setFinger(...points.at(-1), false);
  for (let i = 0; i < 8; i++) await tape.step();
}

/** Smooth a polyline (Chaikin) so drawn paths look hand-drawn, not jagged. */
export function smooth(points, rounds = 2) {
  let pts = points;
  for (let r = 0; r < rounds; r++) {
    const next = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      next.push([ax * 0.75 + bx * 0.25, ay * 0.75 + by * 0.25], [ax * 0.25 + bx * 0.75, ay * 0.25 + by * 0.75]);
    }
    next.push(pts.at(-1));
    pts = next;
  }
  return pts;
}

/** Live units from the engine (exposed by the promo patch in browser.mjs). */
export async function readUnits(page) {
  const geo = await mapGeometry(page);
  const units = await page.evaluate(() => window.promoEngine.units
    .filter(u => u.alive)
    .map(u => ({ id: u.id, team: u.team, type: u.type, x: u.pos.x, y: u.pos.y })));
  return { geo, blue: units.filter(u => u.team === 'blue'), red: units.filter(u => u.team === 'red') };
}

/** Where a rocketeer's rocket handle sits once its path is drawn: 38 map px
 *  past the path's end along its last leg (rocketHandle in path-drawer.ts). */
export function rocketHandle(path) {
  const [ax, ay] = path.at(-2);
  const [bx, by] = path.at(-1);
  const len = Math.hypot(bx - ax, by - ay) || 1;
  return [bx + ((bx - ax) / len) * 38, by + ((by - ay) / len) * 38];
}

/** Pincer plan: outer units sweep wide to flank, inner ones push the middle. */
export function pincerPaths(units, geo) {
  const mid = (units.length - 1) / 2;
  const clampX = x => Math.max(18, Math.min(geo.mapWidth - 18, x));
  return units.map(({ x, y }, i) => {
    const side = mid === 0 ? 0 : (i - mid) / mid; // -1 … 1
    const swing = side * geo.mapWidth * 0.3;
    return smooth([
      [x, y],
      [clampX(x + swing * 0.6), geo.mapHeight * 0.72],
      [clampX(x + swing), geo.mapHeight * 0.5],
      [clampX(x + swing * 0.4), geo.mapHeight * 0.3],
    ]);
  });
}

export async function confirmPlan(page, tape) {
  await page.click('#confirm-btn');
  await tape.play(100);
}

/** Text of the between-rounds card, once it shows. Throws after `maxMs`, since
 *  the trailer's cut points assume the round really ended. */
export async function waitForRoundBanner(page, tape, maxMs = 15000) {
  for (let waited = 0; waited < maxMs; waited += 100) {
    if (await page.isVisible('#round-banner.show')) {
      return page.evaluate(() => ({
        detail: document.getElementById('round-banner-detail')?.textContent ?? '',
        highlight: document.getElementById('round-banner-highlight')?.textContent ?? '',
      }));
    }
    await tape.play(100);
  }
  throw new Error(`round banner did not show within ${maxMs} ms`);
}
