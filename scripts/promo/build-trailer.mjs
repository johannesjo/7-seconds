#!/usr/bin/env node
// Cut the captured frames into a ~15 s silent trailer in three shapes:
// vertical 1080x1920 (Shorts, TikTok, Reddit mobile), square 1080x1080 (Reddit
// feed) and landscape 1920x1080 (YouTube, which the Play promo video links to).
//   node scripts/promo/build-trailer.mjs <battleDir> <hordeDir> <outDir>
// The frame dirs come from capture-battle.mjs and capture-horde.mjs.
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FPS } from './browser.mjs';
import { renderSlides } from './slides.mjs';
import { SHAPES, backdrop, caption, endCard } from './trailer-cards.mjs';

const [battleDir, hordeDir, outDir = 'store-assets/trailer'] = process.argv.slice(2);
if (!battleDir || !hordeDir) throw new Error('usage: build-trailer.mjs <battleDir> <hordeDir> [outDir]');
const marks = dir => ({ dir, ...JSON.parse(readFileSync(join(dir, 'marks.json'), 'utf8')) });
const framePath = (dir, n) => join(dir, `${String(n).padStart(5, '0')}.png`);
const battle = marks(battleDir);
const horde = marks(hordeDir);
const END_SECONDS = 3;
const ICON = fileURLToPath(new URL('../../public/icon-512.png', import.meta.url));
const FADE = 0.25;

/** The edit: frame ranges [from, to) with playback speed and an optional caption. */
const CLIPS = [
  // Cold open on the swarm at its peak, so the first second already moves.
  { src: horde, from: horde.confirmFrame + 190, to: horde.confirmFrame + 340, speed: 1, caption: { title: 'One plan.<br>7 seconds.' } },
  { src: battle, from: 0, to: battle.confirmFrame, speed: 2.5, caption: { title: 'Draw their paths', sub: 'Drag from each unit' } },
  { src: battle, from: battle.confirmFrame, to: battle.bannerFrame + 70, speed: 1, caption: { title: 'Then both sides<br>move at once', sub: 'Flank for +50% damage' }, captionSeconds: 2.6 },
];

// Offsets are tuned to seeds 49/7; another capture may end sooner.
for (const { src, to } of CLIPS) {
  if (!existsSync(framePath(src.dir, to - 1))) throw new Error(`clip needs frame ${to - 1} in ${src.dir}`);
}

const ffmpeg = args => execFileSync('ffmpeg', ['-y', '-loglevel', 'error', ...args], { stdio: 'inherit' });

/** Encode each clip and join them into one full-size gameplay video. */
function cutGameplay(work) {
  let start = 0;
  const timeline = CLIPS.map((clip, i) => {
    const file = join(work, `clip${i}.mp4`);
    ffmpeg(['-framerate', String(FPS), '-start_number', String(clip.from), '-i', join(clip.src.dir, '%05d.png'),
      // trim counts input frames; -frames:v would count sped-up output frames
      // and read `speed` times past the clip's end.
      '-vf', `trim=end_frame=${clip.to - clip.from},setpts=PTS/${clip.speed},fps=${FPS}`,
      '-c:v', 'libx264', '-crf', '10', '-preset', 'fast', '-pix_fmt', 'yuv420p', file]);
    const seconds = (clip.to - clip.from) / FPS / clip.speed;
    const entry = { file, start, seconds, ...clip };
    start += seconds;
    return entry;
  });
  writeFileSync(join(work, 'list.txt'), timeline.map(t => `file '${t.file}'`).join('\n'));
  const game = join(work, 'game.mp4');
  ffmpeg(['-f', 'concat', '-safe', '0', '-i', join(work, 'list.txt'), '-c', 'copy', game]);
  return { game, gameSeconds: start, timeline };
}

/** Render the shape's backdrop, captions and end card to PNGs. */
async function renderCards(work, shape, timeline) {
  const { width, height } = SHAPES[shape];
  const file = name => join(work, `${shape}-${name}.png`);
  const jobs = [{ html: endCard(shape, ICON), out: file('end') }];
  if (shape !== 'vertical') jobs.push({ html: backdrop(shape), out: file('bg') });
  timeline.forEach((t, i) => {
    if (t.caption) jobs.push({ html: caption(shape, t.caption), out: file(`cap${i}`), transparent: true });
  });
  await renderSlides(jobs, { width: width / 2, height: height / 2, scale: 2 });
  return file;
}

/** Layer gameplay, captions and the end card into one shape's final video. */
function compose(shape, { game, gameSeconds, timeline }, { file, out }) {
  const { width, height, game: slot } = SHAPES[shape];
  const total = gameSeconds + END_SECONDS;
  const inputs = ['-i', game];
  const still = (png, seconds) => { inputs.push('-loop', '1', '-framerate', String(FPS), '-t', String(seconds), '-i', png); return inputs.filter(a => a === '-i').length - 1; };
  const filters = [`[0:v]tpad=stop_mode=clone:stop_duration=${END_SECONDS},scale=${slot.width}:-2[g]`];
  if (shape === 'vertical') filters.push('[g]null[v0]');
  else filters.push(`[${still(file('bg'), total)}:v][g]overlay=${slot.x}:0[v0]`);
  let last = 'v0';
  const layer = (png, { at, seconds, fadeOut }) => {
    const idx = still(png, seconds);
    const fades = `fade=t=in:st=0:d=${FADE}:alpha=1${fadeOut ? `,fade=t=out:st=${seconds - FADE}:d=${FADE}:alpha=1` : ''}`;
    filters.push(`[${idx}:v]format=rgba,${fades},setpts=PTS-STARTPTS+${at}/TB[c${idx}]`);
    filters.push(`[${last}][c${idx}]overlay=0:0:eof_action=pass[v${idx}]`);
    last = `v${idx}`;
  };
  timeline.forEach((t, i) => {
    if (t.caption) layer(file(`cap${i}`), { at: t.start, seconds: Math.min(t.seconds, t.captionSeconds ?? t.seconds), fadeOut: true });
  });
  layer(file('end'), { at: gameSeconds, seconds: END_SECONDS, fadeOut: false });
  filters.push(`[${last}]format=yuv420p[out]`);
  ffmpeg([...inputs, '-filter_complex', filters.join(';'), '-map', '[out]', '-t', String(total), '-r', String(FPS),
    '-s', `${width}x${height}`, '-c:v', 'libx264', '-crf', '18', '-preset', 'slow', '-movflags', '+faststart', out]);
  console.log(`wrote ${out} (${total.toFixed(1)} s)`);
}

mkdirSync(outDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), 'promo-trailer-'));
try {
  const cut = cutGameplay(work);
  for (const shape of Object.keys(SHAPES)) {
    const file = await renderCards(work, shape, cut.timeline);
    compose(shape, cut, { file, out: join(outDir, `trailer-${shape}.mp4`) });
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}
