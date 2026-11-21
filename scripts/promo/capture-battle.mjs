#!/usr/bin/env node
// Record one vs-AI battle as 60 fps PNG frames: drawing the paths with a
// visible finger, the plan reveal, the 7-second fight and the round card.
//   node scripts/promo/capture-battle.mjs <seed> <outDir> [scale]
// The seed fixes map, armies and AI, so the same seed replays the same fight.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './browser.mjs';
import * as scene from './scenes.mjs';

const [seed = '49', outDir = 'output/promo/battle', scale = '3'] = process.argv.slice(2);
const { page, harness, errors, close } = await launch({ seed: Number(seed), scale: Number(scale), port: 4190 });
try {
  const quiet = scene.createTape(harness);
  await scene.openMenu(quiet);
  await scene.startAiBattle(page, quiet);
  const tape = scene.createTape(harness, outDir);
  const rig = { page, harness, tape };
  await tape.play(400);
  const { geo, blue, red } = await scene.readUnits(page);
  const paths = scene.pincerPaths(blue, geo);
  // Aim rockets where the enemy will meet the push: a third of the way in.
  const target = [red.reduce((sum, u) => sum + u.x, 0) / red.length, geo.mapHeight * 0.3];
  for (const [i, path] of paths.entries()) {
    await scene.drawPath(rig, path);
    if (blue[i].type !== 'rocketeer') continue;
    const handle = scene.rocketHandle(path);
    const bend = [(handle[0] + target[0]) / 2 + 40, (handle[1] + target[1]) / 2];
    await scene.drawPath(rig, scene.smooth([handle, bend, target]));
  }
  await tape.play(300);
  const confirmFrame = tape.frames;
  await scene.confirmPlan(page, tape);
  const banner = await scene.waitForRoundBanner(page, tape);
  const bannerFrame = tape.frames;
  await tape.play(1800);
  const marks = { seed: Number(seed), frames: tape.frames, confirmFrame, bannerFrame, banner };
  if (errors.length > 0) throw new Error(`Page errors:\n${errors.join('\n')}`);
  // Cut points for build-trailer.mjs.
  writeFileSync(join(outDir, 'marks.json'), JSON.stringify(marks));
  console.log(JSON.stringify(marks));
} finally {
  await close();
}
