#!/usr/bin/env node
// Record a Horde wave as 60 fps PNG frames: a mid-run wave and a fuller squad
// than a fresh run gets, so the clip shows a swarm being held off.
//   node scripts/promo/capture-horde.mjs <seed> <outDir> [scale] [wave]
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './browser.mjs';
import * as scene from './scenes.mjs';

const [seed = '7', outDir = 'output/promo/horde', scale = '3', wave = '4'] = process.argv.slice(2);
const SQUAD = "[{type:'soldier',count:3},{type:'sniper',count:2},{type:'shielder',count:1},{type:'rocketeer',count:1}]";
const patches = {
  'main.ts': [
    ['startNextHordeWave(buildWavePlan(1));', `startNextHordeWave(buildWavePlan(${Number(wave)}));`],
    ['randomHordeStartingArmy()', SQUAD],
  ],
};
const average = (units, key) => units.reduce((sum, u) => sum + u[key], 0) / units.length;

const { page, harness, errors, close } = await launch({ seed: Number(seed), scale: Number(scale), port: 4193, patches });
try {
  const quiet = scene.createTape(harness);
  await scene.openMenu(quiet);
  await page.click('#horde-btn');
  await quiet.play(2500);
  // Round 1 only closes the distance; record round 2, when the swarm hits.
  await scene.confirmPlan(page, quiet);
  await scene.waitForRoundBanner(page, quiet);
  await quiet.play(1200);
  const tape = scene.createTape(harness, outDir);
  const rig = { page, harness, tape };
  await tape.play(300);
  const { blue, red } = await scene.readUnits(page);
  const swarm = [average(red, 'x'), average(red, 'y')];
  for (const u of blue.filter(v => v.type === 'shielder' || v.type === 'rocketeer')) {
    const path = scene.smooth([[u.x, u.y], [u.x, u.y - 25], [u.x + (swarm[0] - u.x) * 0.15, u.y - 50]]);
    await scene.drawPath(rig, path, 420);
    if (u.type !== 'rocketeer') continue;
    const handle = scene.rocketHandle(path);
    const bend = [(handle[0] + swarm[0]) / 2 - 30, (handle[1] + swarm[1]) / 2];
    await scene.drawPath(rig, scene.smooth([handle, bend, swarm]), 420);
  }
  await tape.play(200);
  const confirmFrame = tape.frames;
  await scene.confirmPlan(page, tape);
  const banner = await scene.waitForRoundBanner(page, tape);
  const bannerFrame = tape.frames;
  await tape.play(1500);
  const marks = { seed: Number(seed), frames: tape.frames, confirmFrame, bannerFrame, banner, blue: blue.length, red: red.length };
  if (errors.length > 0) throw new Error(`Page errors:\n${errors.join('\n')}`);
  // Cut points for build-trailer.mjs.
  writeFileSync(join(outDir, 'marks.json'), JSON.stringify(marks));
  console.log(JSON.stringify(marks));
} finally {
  await close();
}
