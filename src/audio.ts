/** Procedural sound effects and music, synthesized with WebAudio so the game
 *  ships no audio assets. The context is created lazily and resumed on the
 *  first user gesture (browsers block audio until then). */

import { renderGunshot, type GunKind } from './gunshot';
import { createRng } from './rng';

/** Own PRNG so sound variation never consumes Math.random, which the action
 *  video capture seeds to reproduce a battle exactly. */
const rand = createRng(Date.now());

export type Sfx =
  | 'ui' | 'draw' | 'confirm' | 'tick' | 'round-start' | 'round-end'
  | 'shot' | 'heavy-shot' | 'mortar' | 'rocket' | 'hit' | 'kill' | 'explosion'
  | 'shield-break' | 'victory' | 'defeat' | 'upgrade' | 'multi-kill';

export type MusicMood = 'off' | 'calm' | 'tense';

/** Minimum gap between two plays of the same sound, so a volley of ten shots
 *  in one frame reads as a burst rather than a wall of noise. */
const MIN_GAP_S: Partial<Record<Sfx, number>> = {
  shot: 0.035, 'heavy-shot': 0.05, hit: 0.03, kill: 0.05, draw: 0.07, explosion: 0.06, tick: 0.2,
};
const SFX_VOLUME = 0.55;
const MUSIC_VOLUME = 0.16;
const GUN_VARIANTS = 3;

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noiseBuf: AudioBuffer | null = null;
  private reverbIn: GainNode | null = null;
  private driveCurve: Float32Array | null = null;
  /** Pre-rendered shot variants per gun, picked at random per play. */
  private gunBufs: Record<GunKind, AudioBuffer[]> = { light: [], heavy: [] };
  /** Explosions still ringing, to cap their polyphony (and node count). */
  private activeExplosions = 0;
  private lastPlayed = new Map<Sfx, number>();
  private recordTap: MediaStreamAudioDestinationNode | null = null;
  private sfxEnabled = true;
  private musicEnabled = true;
  private mood: MusicMood = 'off';
  private musicNodes: AudioNode[] = [];
  private musicTimer: number | undefined;
  private nextBeat = 0;

  /** Create (or resume) the context. Call from a user gesture handler. */
  unlock(): void {
    if (!this.ctx) {
      const Ctor = window.AudioContext
        ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      if (!Ctor) return;
      try {
        this.ctx = new Ctor();
      } catch {
        return;
      }
      const ctx = this.ctx;
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -14;
      compressor.ratio.value = 6;
      compressor.knee.value = 6;
      compressor.release.value = 0.12;
      this.master = ctx.createGain();
      this.master.connect(compressor);
      compressor.connect(ctx.destination);
      this.sfxBus = ctx.createGain();
      this.sfxBus.gain.value = this.sfxEnabled ? SFX_VOLUME : 0;
      this.sfxBus.connect(this.master);
      this.musicBus = ctx.createGain();
      this.musicBus.gain.value = this.musicEnabled ? MUSIC_VOLUME : 0;
      this.musicBus.connect(this.master);
      this.recordTap = ctx.createMediaStreamDestination?.() ?? null;
      if (this.recordTap) compressor.connect(this.recordTap);
      const length = ctx.sampleRate;
      this.noiseBuf = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = this.noiseBuf.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = rand() * 2 - 1;
      this.reverbIn = this.createReverb(ctx);
      this.driveCurve = saturationCurve();
      // Deferred so rendering doesn't delay the tap that unlocked audio
      window.setTimeout(() => this.renderGuns(ctx), 0);
      this.applyMood();
    }
    // iOS can also leave the context 'interrupted' (after a call or Siri)
    if (this.ctx.state !== 'running') void this.ctx.resume().catch(() => {});
  }

  /** A short, dark room reverb from a synthesized impulse response. Returns
   *  the send input; its output feeds the SFX bus. */
  private createReverb(ctx: AudioContext): GainNode | null {
    if (!ctx.createConvolver) return null;
    const seconds = 0.6;
    const len = Math.floor(ctx.sampleRate * seconds);
    const ir = ctx.createBuffer(2, len, ctx.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = ir.getChannelData(ch);
      let lp = 0;
      for (let i = 0; i < len; i++) {
        const t = i / len;
        // One-pole lowpass that closes over time: the tail darkens as it fades
        const k = 0.6 - 0.5 * t;
        lp += k * ((rand() * 2 - 1) - lp);
        d[i] = lp * Math.pow(1 - t, 3);
      }
    }
    const convolver = ctx.createConvolver();
    convolver.buffer = ir;
    const input = ctx.createGain();
    const ret = ctx.createGain();
    ret.gain.value = 0.5;
    input.connect(convolver).connect(ret).connect(this.sfxBus!);
    return input;
  }

  setSfxEnabled(on: boolean): void {
    this.sfxEnabled = on;
    this.fade(this.sfxBus, on ? SFX_VOLUME : 0);
  }

  setMusicEnabled(on: boolean): void {
    if (on === this.musicEnabled) return;
    this.musicEnabled = on;
    this.fade(this.musicBus, on ? MUSIC_VOLUME : 0);
    this.applyMood();
  }

  /** Pause all audio while the page is hidden (backgrounded tab or app). */
  setPageHidden(hidden: boolean): void {
    if (!this.ctx) return;
    if (hidden) void this.ctx.suspend().catch(() => {});
    else void this.ctx.resume().catch(() => {});
  }

  /** Audio of everything the game plays, for recording replay clips. */
  get stream(): MediaStream | null {
    return this.recordTap?.stream ?? null;
  }

  setMood(mood: MusicMood): void {
    if (mood === this.mood) return;
    this.mood = mood;
    this.applyMood();
  }

  play(sfx: Sfx, intensity = 1): void {
    const ctx = this.ctx;
    if (!ctx || !this.sfxBus || !this.sfxEnabled || ctx.state !== 'running') return;
    const now = ctx.currentTime + 0.005;
    const gap = MIN_GAP_S[sfx] ?? 0;
    if (now - (this.lastPlayed.get(sfx) ?? -1) < gap) return;
    this.lastPlayed.set(sfx, now);
    const v = Math.max(0.2, Math.min(1.5, intensity));
    /** Per-play pitch jitter so repeated sounds never machine-gun identically. */
    const j = 0.93 + rand() * 0.14;
    switch (sfx) {
      case 'ui':
        this.osc(now, { type: 'sine', freq: 1250 * j, freqEnd: 900, dur: 0.045, peak: 0.09 });
        this.noise(now, { type: 'bandpass', freq: 3800, q: 3, dur: 0.012, peak: 0.12 });
        break;
      case 'draw':
        // A soft pencil-like scratch rather than a beep
        this.noise(now, { type: 'bandpass', freq: 2600 * j, freqEnd: 3400 * j, q: 2.5, dur: 0.035, peak: 0.08, attack: 0.006 });
        break;
      case 'confirm':
        this.chime(now, 587, 0.16, 0.1);
        this.chime(now + 0.075, 880, 0.26, 0.1);
        break;
      case 'tick':
        // Woody clock tick
        this.osc(now, { type: 'sine', freq: 1700, freqEnd: 1300, dur: 0.03, peak: 0.09 });
        this.noise(now, { type: 'bandpass', freq: 3200, q: 5, dur: 0.018, peak: 0.16 });
        break;
      case 'round-start':
        // Reverse-swell whoosh into a low impact with a metallic ring
        this.noise(now, { type: 'bandpass', freq: 300, freqEnd: 3200, q: 1.2, dur: 0.32, peak: 0.16, attack: 0.28, reverb: 0.3 });
        this.thump(now + 0.28, 110, 45, 0.45, 0.22);
        this.noise(now + 0.28, { type: 'lowpass', freq: 1800, freqEnd: 120, dur: 0.4, peak: 0.18, reverb: 0.4 });
        this.metal(now + 0.28, [520, 1310, 2120], 0.6, 0.05);
        break;
      case 'round-end':
        this.chime(now, 784, 0.4, 0.1);
        this.chime(now + 0.12, 523, 0.6, 0.1);
        break;
      case 'shot':
        this.gunshot(now, 'light', 0.4 * v);
        break;
      case 'heavy-shot':
        this.gunshot(now, 'heavy', 0.55 * v);
        break;
      case 'mortar':
        // Hollow tube "thoomp"
        this.thump(now, 190 * j, 55, 0.28, 0.7 * v);
        this.osc(now, { type: 'triangle', freq: 380 * j, freqEnd: 140, dur: 0.08, peak: 0.15 * v });
        this.noise(now, { type: 'lowpass', freq: 1400, freqEnd: 180, dur: 0.22, peak: 0.45 * v, reverb: 0.25 });
        this.noise(now, { type: 'highpass', freq: 2500, dur: 0.015, peak: 0.15 * v });
        break;
      case 'rocket':
        // Ignition pop, then a rushing whoosh that drifts off
        this.noise(now, { type: 'bandpass', freq: 900 * j, q: 1.5, dur: 0.05, peak: 0.4 * v });
        this.osc(now, { type: 'sine', freq: 160, freqEnd: 70, dur: 0.1, peak: 0.3 * v });
        this.noise(now + 0.02, { type: 'bandpass', freq: 500 * j, freqEnd: 2800 * j, q: 0.9, dur: 0.7, peak: 0.42 * v, attack: 0.06, reverb: 0.3 });
        this.noise(now + 0.02, { type: 'lowpass', freq: 600, freqEnd: 200, dur: 0.5, peak: 0.25 * v, attack: 0.04 });
        break;
      case 'hit':
        // Dull fleshy impact: low thud plus a short wet slap
        this.thump(now, 170 * j, 75, 0.07, 0.32 * v);
        this.noise(now, { type: 'lowpass', freq: 1500 * j, freqEnd: 300, dur: 0.06, peak: 0.3 * v });
        this.noise(now, { type: 'bandpass', freq: 900 * j, q: 2, dur: 0.025, peak: 0.12 * v });
        break;
      case 'kill':
        // Heavier body drop
        this.thump(now, 130 * j, 50, 0.2, 0.5 * v);
        this.noise(now, { type: 'lowpass', freq: 1100, freqEnd: 150, dur: 0.18, peak: 0.4 * v, reverb: 0.15 });
        this.osc(now + 0.03, { type: 'triangle', freq: 240 * j, freqEnd: 110, dur: 0.12, peak: 0.08 * v });
        break;
      case 'explosion':
        this.explosion(now, j, v);
        break;
      case 'shield-break':
        // Glassy shatter: a crack plus scattered high pings
        this.noise(now, { type: 'highpass', freq: 2500, dur: 0.14, peak: 0.28, reverb: 0.3 });
        for (let i = 0; i < 6; i++) {
          const t = now + rand() * 0.09;
          this.osc(t, { type: 'sine', freq: 2200 + rand() * 3200, dur: 0.08 + rand() * 0.14, peak: 0.05 + rand() * 0.04, reverb: 0.4 });
        }
        this.osc(now, { type: 'triangle', freq: 1500, freqEnd: 900, dur: 0.16, peak: 0.12 });
        break;
      case 'victory':
        [523, 659, 784, 1047].forEach((f, i) => this.chime(now + i * 0.11, f, i === 3 ? 0.9 : 0.35, 0.11));
        break;
      case 'defeat':
        [392, 349, 311, 262].forEach((f, i) => this.chime(now + i * 0.17, f, i === 3 ? 0.9 : 0.4, 0.1, 'triangle'));
        break;
      case 'upgrade':
        [659, 880, 1175, 1568].forEach((f, i) => this.chime(now + i * 0.055, f, 0.3, 0.08));
        break;
      case 'multi-kill': {
        // A rising stab, one note per kill in the chain (intensity = chain length)
        const notes = Math.min(5, Math.max(2, Math.round(intensity)));
        [392, 494, 587, 740, 880].slice(0, notes).forEach((f, i) => {
          const t = now + i * 0.05;
          this.osc(t, { type: 'square', freq: f, dur: 0.11, peak: 0.07, lowpass: 2400 });
          this.osc(t, { type: 'sawtooth', freq: f * 1.005, dur: 0.11, peak: 0.05, lowpass: 2400, reverb: 0.25 });
        });
        break;
      }
    }
  }

  /** Render a few variants of each gun so rapid fire never repeats exactly.
   *  One buffer per task, alternating guns, so a slow phone gets both guns
   *  quickly and never freezes for the whole batch. */
  // shortcut: renders on the main thread — move to a worker if low-end phones stutter
  private renderGuns(ctx: AudioContext, step = 0): void {
    if (step >= GUN_VARIANTS * 2) return;
    const kind: GunKind = step % 2 === 0 ? 'light' : 'heavy';
    try {
      const data = renderGunshot(kind, ctx.sampleRate, rand);
      const buf = ctx.createBuffer(1, data.length, ctx.sampleRate);
      buf.getChannelData(0).set(data);
      this.gunBufs[kind].push(buf);
    } catch (err) {
      console.error('Gunshot render failed; using the fallback shot', err);
      return;
    }
    window.setTimeout(() => this.renderGuns(ctx, step + 1), 0);
  }

  /** Play a pre-rendered suppressed shot (see gunshot.ts) with slight pitch
   *  variation; a plain thump stands in until the buffers are rendered. */
  private gunshot(t: number, kind: GunKind, gain: number): void {
    const bufs = this.gunBufs[kind];
    if (bufs.length === 0) {
      // Plain muffled thump until the real shots are rendered (or if that failed)
      this.thump(t, 150, 60, 0.06, gain * 0.6);
      this.noise(t, { type: 'lowpass', freq: 1800, freqEnd: 400, dur: 0.07, peak: gain * 0.7 });
      return;
    }
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = bufs[Math.floor(rand() * bufs.length)];
    src.playbackRate.value = 0.94 + rand() * 0.12;
    const g = ctx.createGain();
    g.gain.value = gain;
    this.route(src.connect(g), kind === 'heavy' ? 0.25 : 0.15);
    src.start(t);
  }

  /** A pitch-dropping low thump with a 2x partial so it still has body on
   *  phone speakers, which can't reproduce much below ~100 Hz. */
  private thump(t: number, from: number, to: number, dur: number, peak: number): void {
    this.osc(t, { type: 'sine', freq: from, freqEnd: to, dur, peak });
    this.osc(t, { type: 'sine', freq: from * 2, freqEnd: to * 2, dur: dur * 0.8, peak: peak * 0.4 });
  }

  /** Crack, deep boom, rolling rumble and scattered debris. Capped at a few
   *  overlapping explosions; extras play only a light boom. */
  private explosion(t: number, j: number, v: number): void {
    const big = Math.min(1.4, v) * 0.75;
    if (this.activeExplosions >= 3) {
      this.thump(t, 90 * j, 35, 0.4, 0.5 * big);
      return;
    }
    this.activeExplosions++;
    this.noise(t, { type: 'highpass', freq: 1800, dur: 0.04, peak: 0.45 * big, attack: 0.0005 });
    this.thump(t, 95 * j, 32, 0.7 * big + 0.2, 0.95 * big);
    const rumbleDur = 1.1 * big + 0.3;
    const rumble = this.noise(t, { type: 'lowpass', freq: 2600, freqEnd: 70, dur: rumbleDur, peak: 1.0 * big, reverb: 0.45, drive: true, rate: 0.6 });
    rumble.onended = () => { this.activeExplosions = Math.max(0, this.activeExplosions - 1); };
    this.noise(t + 0.05, { type: 'lowpass', freq: 400, freqEnd: 60, dur: 1.4 * big, peak: 0.5 * big, attack: 0.08, rate: 0.4 });
    for (let i = 0; i < 3; i++) {
      const dt = 0.1 + rand() * 0.5 * big;
      this.noise(t + dt, {
        type: 'bandpass', freq: 1200 + rand() * 3000, q: 3, dur: 0.02 + rand() * 0.025,
        peak: (0.18 + rand() * 0.12) * big, reverb: 0.3,
      });
    }
  }

  /** A soft bell-like tone (fundamental + gentle inharmonic partial). */
  private chime(t: number, f: number, dur: number, peak: number, type: OscillatorType = 'sine'): void {
    this.osc(t, { type, freq: f, dur, peak, attack: 0.004, reverb: 0.35 });
    this.osc(t, { type: 'sine', freq: f * 2.01, dur: dur * 0.6, peak: peak * 0.3, attack: 0.002, reverb: 0.35 });
    this.osc(t, { type: 'sine', freq: f * 3.98, dur: dur * 0.25, peak: peak * 0.1, attack: 0.001 });
  }

  /** Resonant metallic ring from a few inharmonic partials. */
  private metal(t: number, freqs: number[], dur: number, peak: number): void {
    freqs.forEach((f, i) => this.osc(t, { type: 'sine', freq: f, freqEnd: f * 0.99, dur: dur / (1 + i * 0.4), peak: peak / (1 + i * 0.5), reverb: 0.5 }));
  }

  private fade(bus: GainNode | null, to: number): void {
    if (!bus || !this.ctx) return;
    bus.gain.cancelScheduledValues(this.ctx.currentTime);
    bus.gain.setTargetAtTime(to, this.ctx.currentTime, 0.05);
  }

  /** Attack then exponential decay to silence. */
  private envelope(start: number, duration: number, peak: number, attack = Math.min(0.004, duration / 4)): GainNode {
    const gain = this.ctx!.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + attack);
    gain.gain.exponentialRampToValueAtTime(0.0001, start + Math.max(attack + 0.002, duration));
    return gain;
  }

  /** Route a voice to the dry bus and, optionally, the reverb send. */
  private route(node: AudioNode, reverb = 0): void {
    node.connect(this.sfxBus!);
    if (reverb > 0 && this.reverbIn) {
      const send = this.ctx!.createGain();
      send.gain.value = reverb;
      node.connect(send).connect(this.reverbIn);
    }
  }

  private osc(start: number, o: { type: OscillatorType; freq: number; freqEnd?: number; dur: number; peak: number; attack?: number; reverb?: number; lowpass?: number }): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = o.type;
    osc.frequency.setValueAtTime(o.freq, start);
    if (o.freqEnd !== undefined && o.freqEnd !== o.freq) {
      osc.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), start + o.dur);
    }
    const gain = this.envelope(start, o.dur, o.peak, o.attack);
    let head: AudioNode = osc;
    if (o.lowpass) {
      const lp = ctx.createBiquadFilter();
      lp.type = 'lowpass';
      lp.frequency.value = o.lowpass;
      head = head.connect(lp);
    }
    this.route(head.connect(gain), o.reverb);
    osc.start(start);
    osc.stop(start + o.dur + 0.03);
  }

  private noise(start: number, o: { type: BiquadFilterType; freq: number; freqEnd?: number; q?: number; dur: number; peak: number; attack?: number; reverb?: number; drive?: boolean; rate?: number }): AudioBufferSourceNode {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noiseBuf;
    src.loop = true;
    src.playbackRate.value = (o.rate ?? 1) * (0.85 + rand() * 0.3);
    const filter = ctx.createBiquadFilter();
    filter.type = o.type;
    filter.frequency.setValueAtTime(o.freq, start);
    if (o.freqEnd !== undefined && o.freqEnd !== o.freq) {
      filter.frequency.exponentialRampToValueAtTime(Math.max(20, o.freqEnd), start + o.dur);
    }
    if (o.q !== undefined) filter.Q.value = o.q;
    const gain = this.envelope(start, o.dur, o.peak, o.attack);
    let head: AudioNode = src.connect(filter);
    if (o.drive && this.driveCurve) {
      // Pre-scale: the curve's small-signal slope (~2.5) would otherwise act
      // as make-up gain
      const pre = ctx.createGain();
      pre.gain.value = 0.4;
      const shaper = ctx.createWaveShaper();
      shaper.curve = this.driveCurve as Float32Array<ArrayBuffer>;
      head = head.connect(pre).connect(shaper);
    }
    this.route(head.connect(gain), o.reverb);
    src.start(start, rand() * 0.5);
    src.stop(start + o.dur + 0.03);
    return src;
  }

  /** Calm: a soft three-note pad. Tense: the pad plus a heartbeat pulse that
   *  fits the 7-second rounds. Stopped entirely when the mood is 'off'. */
  private applyMood(): void {
    const ctx = this.ctx;
    if (!ctx || !this.musicBus) return;
    for (const node of this.musicNodes) {
      try { (node as OscillatorNode).stop?.(); } catch { /* already stopped */ }
      node.disconnect();
    }
    this.musicNodes = [];
    window.clearInterval(this.musicTimer);
    this.musicTimer = undefined;
    if (this.mood === 'off' || !this.musicEnabled) return;

    const tense = this.mood === 'tense';
    const padGain = ctx.createGain();
    padGain.gain.value = 0;
    padGain.gain.setTargetAtTime(tense ? 0.35 : 0.5, ctx.currentTime, 0.6);
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = tense ? 900 : 600;
    filter.connect(padGain).connect(this.musicBus);
    const lfo = ctx.createOscillator();
    const lfoDepth = ctx.createGain();
    lfo.frequency.value = 0.12;
    lfoDepth.gain.value = 250;
    lfo.connect(lfoDepth).connect(filter.frequency);
    lfo.start();
    this.musicNodes.push(lfo, lfoDepth, filter, padGain);
    const notes = tense ? [110, 116.5, 164.8] : [110, 164.8, 220];
    for (const f of notes) {
      for (const detune of [-6, 6]) {
        const osc = ctx.createOscillator();
        osc.type = 'sawtooth';
        osc.frequency.value = f;
        osc.detune.value = detune;
        const g = ctx.createGain();
        g.gain.value = 0.08;
        osc.connect(g).connect(filter);
        osc.start();
        this.musicNodes.push(osc, g);
      }
    }

    if (tense) {
      // Schedule heartbeat thumps slightly ahead of time on a coarse timer.
      this.nextBeat = ctx.currentTime + 0.1;
      const beat = (t: number, peak: number) => {
        const osc = ctx.createOscillator();
        osc.frequency.setValueAtTime(70, t);
        osc.frequency.exponentialRampToValueAtTime(40, t + 0.15);
        const g = ctx.createGain();
        g.gain.setValueAtTime(0.0001, t);
        g.gain.exponentialRampToValueAtTime(peak, t + 0.01);
        g.gain.exponentialRampToValueAtTime(0.0001, t + 0.18);
        osc.connect(g).connect(this.musicBus!);
        osc.start(t);
        osc.stop(t + 0.2);
      };
      this.musicTimer = window.setInterval(() => {
        while (this.nextBeat < ctx.currentTime + 0.3) {
          beat(this.nextBeat, 0.9);
          beat(this.nextBeat + 0.22, 0.5);
          this.nextBeat += 0.75;
        }
      }, 100);
    }
  }
}

/** Soft-clip curve used to give explosions a little grit. */
function saturationCurve(): Float32Array {
  const n = 1024;
  const curve = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const x = (i / (n - 1)) * 2 - 1;
    curve[i] = Math.tanh(x * 2.5) / Math.tanh(2.5);
  }
  return curve;
}

export const audio = new AudioEngine();
