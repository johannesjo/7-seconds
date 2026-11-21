#!/usr/bin/env node
// Capture still screens that need no gameplay (the main menu) at 1080x1920.
//   node scripts/promo/capture-stills.mjs <outDir>
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { launch } from './browser.mjs';
import { createTape } from './scenes.mjs';

const [outDir = 'output/promo/stills'] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const { harness, errors, close } = await launch({ seed: 3, port: 4194 });
try {
  await createTape(harness).play(1500);
  writeFileSync(join(outDir, 'menu.png'), await harness.capture());
  if (errors.length > 0) throw new Error(`Page errors:\n${errors.join('\n')}`);
} finally {
  await close();
}
