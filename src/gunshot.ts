/** Offline-rendered suppressed gunshots. Built sample by sample (rather than
 *  from live WebAudio nodes) so the shot can use a real pressure-pulse shape,
 *  resonant suppressor modes and early reflections — the parts that make a
 *  synthesized shot read as a gun instead of filtered hiss. */

export type GunKind = 'light' | 'heavy';

interface GunSpec {
  /** Length of the rendered buffer, seconds. */
  length: number;
  /** Duration of the muzzle pressure pulse, seconds (bigger round = longer). */
  pulse: number;
  /** Suppressor tube modes: [Hz, decay seconds, gain]. */
  modes: ReadonlyArray<readonly [number, number, number]>;
  /** Lowpass on the blast; the baffles strip most of the high end. */
  blastCutoff: number;
  chuffDecay: number;
  thump: { from: number; to: number; decay: number; gain: number };
  /** Supersonic bullet crack, which no suppressor removes. */
  crack: number;
  /** Times of the two action clacks after the shot, seconds. */
  clacks: readonly [number, number];
  clackGain: number;
}

const SPECS: Record<GunKind, GunSpec> = {
  // Suppressed carbine with subsonic ammo: a dense "thwap" with the bolt
  // carrier cycling right behind it.
  light: {
    length: 0.32, pulse: 0.0012, blastCutoff: 5000, chuffDecay: 0.035,
    modes: [[620, 0.004, 25], [1450, 0.003, 12], [2900, 0.002, 6]],
    thump: { from: 170, to: 70, decay: 0.022, gain: 0.25 },
    crack: 0, clacks: [0.018, 0.05], clackGain: 2,
  },
  // Suppressed bolt-action rifle: supersonic crack plus a heavy, longer
  // boom, and the bolt worked by hand afterwards.
  heavy: {
    length: 0.62, pulse: 0.002, blastCutoff: 5000, chuffDecay: 0.06,
    modes: [[420, 0.006, 36], [980, 0.004, 23], [2100, 0.003, 13]],
    thump: { from: 120, to: 48, decay: 0.045, gain: 0.4 },
    crack: 0.6, clacks: [0.3, 0.43], clackGain: 2.5,
  },
};

/** Render one mono shot, peak-normalized to 0.9. `rand` returns [0, 1). */
export function renderGunshot(kind: GunKind, sampleRate: number, rand: () => number): Float32Array {
  const spec = SPECS[kind];
  const out = new Float32Array(Math.ceil(spec.length * sampleRate));
  const blast = renderBlast(spec, sampleRate, rand);
  addReflections(out, blast, sampleRate);
  addThump(out, spec.thump, sampleRate);
  if (spec.crack > 0) addCrack(out, spec.crack, sampleRate);
  const jitter = () => (rand() - 0.5) * 0.012;
  addClack(out, { at: spec.clacks[0] + jitter(), pitch: 0.9 + rand() * 0.15, gain: spec.clackGain * 0.75, sampleRate, rand });
  addClack(out, { at: spec.clacks[1] + jitter(), pitch: 1.05 + rand() * 0.15, gain: spec.clackGain, sampleRate, rand });
  return saturateAndNormalize(out, sampleRate);
}

/** Muzzle pressure pulse + gas chuff, rung through the suppressor modes. */
function renderBlast(spec: GunSpec, sr: number, rand: () => number): Float32Array {
  const n = Math.ceil(Math.min(spec.length, 0.25) * sr);
  const excite = new Float32Array(n);
  const chuff = new Float32Array(n);
  const pulseN = spec.pulse * sr;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    // Friedlander waveform: the classic blast-wave shape (sharp positive
    // peak, then a longer negative suction phase)
    const x = i / pulseN;
    const pressure = (1 - x) * Math.exp(-2 * x) * (x < 6 ? 1 : 0);
    const turbulence = (rand() * 2 - 1) * Math.exp(-t / 0.006);
    excite[i] = pressure * 0.8 + turbulence;
    chuff[i] = (rand() * 2 - 1) * (1 - Math.exp(-t / 0.0015)) * Math.exp(-t / spec.chuffDecay) * 0.35;
  }
  // Only the sharp onset rings the tube; letting the slow gas chuff drive
  // the modes too makes them whistle
  const out = lowpass(Float32Array.from(excite, (s, i) => s + chuff[i]), spec.blastCutoff, sr);
  for (const [freq, decay, gain] of spec.modes) {
    const rung = resonate(excite, { freq, decay, sampleRate: sr });
    for (let i = 0; i < n; i++) out[i] += rung[i] * gain;
  }
  return out;
}

/** Direct sound plus a ground bounce and two darker wall slaps; these early
 *  echoes do most of the work of placing the shot in a real space. */
function addReflections(out: Float32Array, src: Float32Array, sr: number): void {
  const taps: ReadonlyArray<readonly [number, number, number]> = [
    [0, 1, 0], [0.0035, 0.45, 2500], [0.031, 0.22, 1400], [0.057, 0.13, 900],
  ];
  for (const [delay, gain, cutoff] of taps) {
    const sig = cutoff ? lowpass(src, cutoff, sr) : src;
    const offset = Math.round(delay * sr);
    for (let i = 0; i < sig.length && i + offset < out.length; i++) out[i + offset] += sig[i] * gain;
  }
}

/** A pitch-dropping body thump, with a 2x partial so phone speakers (which
 *  can't reproduce much below ~100 Hz) still feel it. */
function addThump(out: Float32Array, th: GunSpec['thump'], sr: number): void {
  const n = Math.min(out.length, Math.ceil(th.decay * 6 * sr));
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const t = i / sr;
    const f = th.to + (th.from - th.to) * Math.exp(-t / (th.decay * 0.6));
    phase += (2 * Math.PI * f) / sr;
    const env = (1 - Math.exp(-t / 0.0008)) * Math.exp(-t / th.decay);
    out[i] += (Math.sin(phase) + 0.45 * Math.sin(2 * phase)) * env * th.gain;
  }
}

/** A supersonic bullet's N-wave: near-instant rise, ~0.4 ms linear swing to
 *  negative, fast return to zero. */
function addCrack(out: Float32Array, gain: number, sr: number): void {
  const swing = Math.max(2, Math.round(sr * 0.0004));
  const n = Math.min(out.length, Math.ceil(sr * 0.004));
  for (let i = 0; i < n; i++) {
    out[i] += gain * (i < swing ? 1 - (2 * i) / swing : -Math.exp(-(i - swing) / (sr * 0.0006)));
  }
}

interface ClackOpts { at: number; pitch: number; gain: number; sampleRate: number; rand: () => number }

/** Steel-on-steel impact: a click rung through inharmonic part modes. */
function addClack(out: Float32Array, o: ClackOpts): void {
  const sr = o.sampleRate;
  const n = Math.ceil(0.05 * sr);
  const start = Math.round(Math.max(0, o.at) * sr);
  const excite = new Float32Array(n);
  for (let i = 0; i < n; i++) excite[i] = (o.rand() * 2 - 1) * Math.exp(-i / (sr * 0.001));
  const modes: ReadonlyArray<readonly [number, number, number]> = [
    [1900, 0.009, 8], [3100, 0.007, 6.3], [4700, 0.005, 3], [7300, 0.003, 1.5],
  ];
  const sum = Float32Array.from(excite, (s) => s * 0.15);
  for (const [freq, decay, g] of modes) {
    const rung = resonate(excite, { freq: freq * o.pitch, decay, sampleRate: sr });
    for (let i = 0; i < n; i++) sum[i] += rung[i] * g;
  }
  for (let i = 0; i < n && start + i < out.length; i++) out[start + i] += sum[i] * o.gain;
}

interface ResonatorOpts { freq: number; decay: number; sampleRate: number }

/** Two-pole resonator ringing at `freq` with a 1/e decay of `decay` seconds,
 *  normalized to unity gain at resonance so the tone is the same at any
 *  device sample rate. */
function resonate(input: Float32Array, o: ResonatorOpts): Float32Array {
  const r = Math.exp(-1 / (o.decay * o.sampleRate));
  const theta = (2 * Math.PI * o.freq) / o.sampleRate;
  const a1 = 2 * r * Math.cos(theta);
  const a2 = -r * r;
  const norm = (1 - r) * 2 * Math.sin(theta);
  const out = new Float32Array(input.length);
  let y1 = 0;
  let y2 = 0;
  for (let i = 0; i < input.length; i++) {
    const y = norm * input[i] + a1 * y1 + a2 * y2;
    out[i] = y;
    y2 = y1;
    y1 = y;
  }
  return out;
}

/** Two cascaded one-pole lowpasses (12 dB/oct). */
function lowpass(input: Float32Array, cutoff: number, sr: number): Float32Array {
  const k = 1 - Math.exp((-2 * Math.PI * cutoff) / sr);
  const out = new Float32Array(input.length);
  let a = 0;
  let b = 0;
  for (let i = 0; i < input.length; i++) {
    a += k * (input[i] - a);
    b += k * (a - b);
    out[i] = b;
  }
  return out;
}

/** Soft-clip for density (real shots are loud enough to compress in any
 *  mic), then scale the peak to 0.9 and fade the last 5 ms to avoid a click. */
function saturateAndNormalize(buf: Float32Array, sr: number): Float32Array {
  let peak = 0;
  for (const s of buf) peak = Math.max(peak, Math.abs(s));
  if (peak === 0) return buf;
  let outPeak = 0;
  for (let i = 0; i < buf.length; i++) {
    buf[i] = Math.tanh((buf[i] / peak) * 2.2);
    outPeak = Math.max(outPeak, Math.abs(buf[i]));
  }
  const fade = Math.min(buf.length, Math.round(0.005 * sr));
  for (let i = 0; i < buf.length; i++) {
    const tail = buf.length - i;
    buf[i] = (buf[i] / outPeak) * 0.9 * (tail < fade ? tail / fade : 1);
  }
  return buf;
}
