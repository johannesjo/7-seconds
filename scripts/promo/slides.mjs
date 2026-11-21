// Render designed slides (Play Store screenshots, feature graphic, video
// title cards) from HTML, so layout and type stay editable as plain CSS.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadPlaywright } from './browser.mjs';

export const INK = '#3b2a1a';
const BLUE = '#2266aa';
const RED = '#b8322a';
const PAPER = '#f4ecd8';

/** Notebook-paper background shared by every slide, matching the game. */
export const PAPER_CSS = `
  background-color: ${PAPER};
  background-image:
    radial-gradient(ellipse at 50% 40%, rgba(255,255,255,.55), rgba(0,0,0,0) 70%),
    linear-gradient(rgba(120,100,60,.13) 1px, transparent 1px),
    linear-gradient(90deg, rgba(120,100,60,.13) 1px, transparent 1px);
  background-size: 100% 100%, 24px 24px, 24px 24px;`;

const BASE_CSS = `
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  body { font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; color: ${INK}; -webkit-font-smoothing: antialiased; }
  .blue { color: ${BLUE}; } .red { color: ${RED}; }`;

/** A phone showing `src`, `width` CSS px wide, with a dark bezel and shadow. */
export function phone(src, width, extra = '') {
  return `<div class="phone" style="width:${width}px;${extra}">
    <img src="${pathToFileURL(resolve(src))}" style="display:block;width:100%;border-radius:${width * 0.055}px">
  </div>`;
}

const PHONE_CSS = `
  .phone { padding: 9px; border-radius: 34px; background: linear-gradient(145deg, #3a3029, #1c1712);
    box-shadow: 0 28px 60px rgba(60,40,10,.35), 0 6px 16px rgba(60,40,10,.25), inset 0 0 0 2px rgba(255,255,255,.08); }`;

const SHOT_ASPECT = 16 / 9;

/** A round magnifier over the phone: shows the shot around (cx, cy), given as
 *  fractions of the shot, `mag` times larger than the phone shows it. */
function zoomBubble(shot, screenWidth, { cx, cy, mag = 2.4, size = 190, left, top }) {
  const bgW = screenWidth * mag;
  const bgH = bgW * SHOT_ASPECT;
  return `<div class="zoom" style="left:${left}px;top:${top}px;width:${size}px;height:${size}px;
    background-image:url('${pathToFileURL(resolve(shot))}');background-size:${bgW}px ${bgH}px;
    background-position:${size / 2 - cx * bgW}px ${size / 2 - cy * bgH}px"></div>`;
}

/** Store screenshot: headline, subline and the game on a phone (540x960 CSS).
 *  Optional `tag` sticker ({text, style}) and `zoom` magnifier (see zoomBubble). */
export function storeSlide({ shot, title, subtitle, tag, zoom, width = 400 }) {
  const tagHtml = tag ? `<div class="tag" style="${tag.style ?? ''}">${tag.text}</div>` : '';
  const zoomHtml = zoom ? zoomBubble(shot, width - 18, zoom) : '';
  return `<!doctype html><html><head><style>${BASE_CSS}${PHONE_CSS}
    body { ${PAPER_CSS} display: flex; flex-direction: column; align-items: center; }
    h1 { margin-top: 50px; font-size: 50px; line-height: 1.02; font-weight: 900; text-align: center; letter-spacing: -0.5px; }
    p { margin-top: 12px; font-size: 21px; font-weight: 700; opacity: .72; text-align: center; letter-spacing: .2px; }
    .stage { position: relative; margin-top: 28px; }
    .tag { position: absolute; padding: 10px 18px; background: ${RED}; color: #fff; font-weight: 900; font-size: 22px;
      border-radius: 10px; box-shadow: 0 8px 20px rgba(120,30,20,.35); transform: rotate(-6deg); white-space: nowrap; }
    .zoom { position: absolute; border-radius: 50%; border: 6px solid #fff; background-color: ${PAPER};
      box-shadow: 0 14px 34px rgba(60,40,10,.4), 0 0 0 2px rgba(60,40,10,.25); }
  </style></head><body>
    <h1>${title}</h1><p>${subtitle}</p>
    <div class="stage">${phone(shot, width)}${zoomHtml}${tagHtml}</div>
  </body></html>`;
}

/** Render HTML to a PNG of `width`x`height` CSS px at `scale`. */
export async function renderSlides(jobs, { width = 540, height = 960, scale = 2 } = {}) {
  const { chromium } = loadPlaywright();
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: scale });
  // Loaded from a file (not setContent) so the slides may show local images.
  const dir = mkdtempSync(join(tmpdir(), 'promo-slide-'));
  try {
    for (const { html, out, transparent = false } of jobs) {
      writeFileSync(join(dir, 'slide.html'), html);
      await page.goto(pathToFileURL(join(dir, 'slide.html')).href, { waitUntil: 'load' });
      await page.screenshot({ path: out, omitBackground: transparent });
      console.log(`wrote ${out}`);
    }
  } finally {
    await browser.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
