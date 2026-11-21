// HTML for the trailer's overlays, one look per video shape. Every card is
// drawn at half the output size (rendered at 2x), so CSS px = output px / 2.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';
import { INK, PAPER_CSS } from './slides.mjs';

const GREEN = '#2b7a3d';
const FONT = `* { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { width: 100%; height: 100%; overflow: hidden; }
  body { font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; color: ${INK}; -webkit-font-smoothing: antialiased; }
  h1 { font-weight: 900; line-height: 1.02; letter-spacing: -0.5px; }
  p { font-weight: 700; opacity: .72; margin-top: 8px; }
  .logo { font-weight: 900; letter-spacing: 2px; } .logo b { color: ${GREEN}; }`;

/** Output size and where the 9:16 game sits in each shape (output px). */
export const SHAPES = {
  vertical: { width: 1080, height: 1920, game: { x: 0, width: 1080 } },
  square: { width: 1080, height: 1080, game: { x: 472, width: 608 } },
  landscape: { width: 1920, height: 1080, game: { x: 656, width: 608 } },
};

const logo = size => `<div class="logo" style="font-size:${size}px"><b>7</b> SECONDS</div>`;

/** Static backdrop behind the game for the wide shapes (none for vertical). */
export function backdrop(shape) {
  const side = shape === 'landscape'
    ? `<div style="position:absolute;left:${(656 + 608) / 2}px;right:0;top:0;bottom:0;display:flex;flex-direction:column;
         align-items:center;justify-content:center;text-align:center">${logo(46)}<p style="font-size:17px">Free on Google Play<br>and in your browser</p></div>`
    : `<div style="position:absolute;left:0;width:236px;bottom:26px;text-align:center">${logo(24)}</div>`;
  return page(`body { ${PAPER_CSS} }`, `${side}`);
}

/** A headline over the game: a paper card up top on vertical, the free side
 *  panel on the wide shapes. */
export function caption(shape, { title, sub = '' }) {
  if (shape === 'vertical') {
    return page(`.card { position:absolute; left:50%; top:62px; transform:translateX(-50%); padding:14px 26px 16px;
        background:rgba(250,244,228,.95); border-radius:18px; text-align:center; white-space:nowrap;
        box-shadow:0 10px 30px rgba(60,40,10,.3); } h1 { font-size:42px; } p { font-size:19px; }`,
      `<div class="card"><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>`);
  }
  const width = shape === 'square' ? 236 : 328;
  const size = shape === 'square' ? 34 : 44;
  return page(`.side { position:absolute; left:0; top:0; bottom:0; width:${width}px; padding:0 20px; display:flex;
      flex-direction:column; justify-content:center; text-align:center; } h1 { font-size:${size}px; } p { font-size:${size * 0.45}px; }`,
    `<div class="side"><h1>${title}</h1>${sub ? `<p>${sub}</p>` : ''}</div>`);
}

/** Closing card: logo, pitch and where to get it. */
export function endCard(shape, icon) {
  const big = shape === 'vertical' ? 64 : 52;
  return page(`body { ${PAPER_CSS} display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; }
      img { width:${big * 1.9}px; border-radius:${big * 0.42}px; box-shadow:0 12px 30px rgba(60,40,10,.3); margin-bottom:22px; }
      .pitch { font-size:${big * 0.4}px; font-weight:900; margin-top:14px; opacity:.85 }
      .where { font-size:${big * 0.3}px; margin-top:26px; } .small { font-size:${big * 0.24}px; margin-top:6px; }`,
    `<img src="${pathToFileURL(resolve(icon))}">${logo(big)}
     <div class="pitch">Draw the plan. Watch the chaos.</div>
     <p class="where">Free on Google Play · Play in your browser</p>
     <p class="small">No ads · No in-app purchases</p>`);
}

function page(css, body) {
  return `<!doctype html><html><head><style>${FONT}${css}</style></head><body>${body}</body></html>`;
}
