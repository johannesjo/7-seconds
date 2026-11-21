#!/usr/bin/env node
// Compose the Play Store screenshots (1080x1920) and feature graphic
// (1024x500) from captured frames.
//   node scripts/promo/build-store.mjs <battleDir> <hordeDir> <stillsDir> [outDir]
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { INK, PAPER_CSS, phone, renderSlides, storeSlide } from './slides.mjs';

const [battleDir, hordeDir, stillsDir, outDir = 'store-assets/play'] = process.argv.slice(2);
if (!stillsDir) throw new Error('usage: build-store.mjs <battleDir> <hordeDir> <stillsDir> [outDir]');
const marks = dir => JSON.parse(readFileSync(join(dir, 'marks.json'), 'utf8'));
const b = marks(battleDir);
const h = marks(hordeDir);
/** A captured frame; throws if missing, since a slide would show a broken image. */
function frame(dir, n) {
  const file = join(dir, `${String(n).padStart(5, '0')}.png`);
  if (!existsSync(file)) throw new Error(`missing frame ${file}`);
  return file;
}

const SHOTS = {
  plan: frame(battleDir, b.confirmFrame - 2),
  reveal: frame(battleDir, b.confirmFrame + 40),
  fight: frame(battleDir, b.confirmFrame + 124),
  horde: frame(hordeDir, h.confirmFrame + 150),
  result: frame(hordeDir, h.bannerFrame + 40),
  menu: join(stillsDir, 'menu.png'),
};

const SLIDES = [
  { name: '01-draw', shot: SHOTS.plan, title: 'Draw their paths', subtitle: 'Plan every move in seconds',
    zoom: { cx: 0.42, cy: 0.88, left: 16, top: 330 } },
  { name: '02-watch', shot: SHOTS.reveal, title: 'Then watch 7 seconds', subtitle: 'Both plans play out at once' },
  { name: '03-flank', shot: SHOTS.fight, title: 'Outsmart, outflank', subtitle: 'Cover, high ground and timing matter',
    tag: { text: '+50% flank damage', style: 'right:-14px;top:130px' } },
  { name: '04-horde', shot: SHOTS.horde, title: 'Survive the horde', subtitle: '15 waves, upgrades, then endless',
    zoom: { cx: 0.21, cy: 0.79, mag: 1.9, left: 196, top: 120 } },
  { name: '05-modes', shot: SHOTS.menu, title: 'Play your way', subtitle: 'AI, daily map, horde, expedition, online' },
  { name: '06-free', shot: SHOTS.result, title: 'Free. No ads.', subtitle: 'No in-app purchases, on Android or the web' },
];

/** 1024x500 banner: logo and pitch left, two phones mid-battle right. */
function featureGraphic() {
  return `<!doctype html><html><head><style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { ${PAPER_CSS} width: 512px; height: 250px; overflow: hidden; position: relative;
      font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; color: ${INK}; -webkit-font-smoothing: antialiased;
      background-size: 100% 100%, 12px 12px, 12px 12px; }
    .text { position: absolute; left: 30px; top: 0; bottom: 0; width: 270px; display: flex; flex-direction: column; justify-content: center; }
    h1 { font-size: 40px; font-weight: 900; letter-spacing: 1.5px; line-height: 1; } h1 b { color: #2b7a3d; }
    p { margin-top: 10px; font-size: 17px; font-weight: 800; opacity: .78; line-height: 1.25; }
    .phone { position: absolute; padding: 5px; border-radius: 18px; background: linear-gradient(145deg, #3a3029, #1c1712);
      box-shadow: 0 14px 30px rgba(60,40,10,.35); }
  </style></head><body>
    <div class="text"><h1><b>7</b> SECONDS</h1><p>Draw the plan.<br>Watch the chaos.</p></div>
    ${phone(SHOTS.fight, 128, 'left:318px;top:46px;transform:rotate(-7deg)')}
    ${phone(SHOTS.horde, 128, 'left:404px;top:4px;transform:rotate(6deg)')}
  </body></html>`;
}

await renderSlides(SLIDES.map(s => ({ html: storeSlide(s), out: join(outDir, `screenshot-${s.name}.png`) })));
await renderSlides([{ html: featureGraphic(), out: join(outDir, 'feature-graphic.png') }], { width: 512, height: 250, scale: 2 });
