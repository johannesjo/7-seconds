/** Procedural sound effects and music, synthesized with WebAudio so the game
 *  ships no audio assets. The context is created lazily and resumed on the
 *  first user gesture (browsers block audio until then). */

import { createRng } from './rng';

/** Own PRNG so sound variation never consumes Math.random, which the action
 *  video capture seeds to reproduce a battle exactly. */
const rand = createRng(Date.now());

export type Sfx =
  | 'ui' | 'draw' | 'confirm' | 'tick' | 'round-start' | 'round-end'
  | 'shot' | 'heavy-shot' | 'mortar' | 'rocket' | 'hit' | 'kill' | 'explosion'
  | 'shield-break' | 'victory' | 'defeat' | 'upgrade';

export type MusicMood = 'off' | 'calm' | 'tense';

/** Minimum gap between two plays of the same sound, so a volley of ten shots
 *  in one frame reads as a burst rather than a wall of noise. */
const MIN_GAP_S: Partial<Record<Sfx, number>> = {
  shot: 0.035, 'heavy-shot': 0.05, hit: 0.03, kill: 0.05, draw: 0.07, explosion: 0.06, tick: 0.2,
};
const SFX_VOLUME = 0.55;
const MUSIC_VOLUME = 0.16;

class AudioEngine {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private sfxBus: GainNode | null = null;
  private musicBus: GainNode | null = null;
  private noise: AudioBuffer | null = null;
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
      this.noise = ctx.createBuffer(1, length, ctx.sampleRate);
      const data = this.noise.getChannelData(0);
      for (let i = 0; i < length; i++) data[i] = rand() * 2 - 1;
      this.applyMood();
    }
    if (this.ctx.state === 'suspended') void this.ctx.resume().catch(() => {});
  }

  setSfxEnabled(on: boolean): void {
    this.sfxEnabled = on;
    this.fade(this.sfxBus, on ? SFX_VOLUME : 0);
  }

  setMusicEnabled(on: boolean): void {
    this.musicEnabled = on;
    this.fade(this.musicBus, on ? MUSIC_VOLUME : 0);
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
    const now = ctx.currentTime;
    const gap = MIN_GAP_S[sfx] ?? 0;
    if (now - (this.lastPlayed.get(sfx) ?? -1) < gap) return;
    this.lastPlayed.set(sfx, now);
    const v = Math.max(0.2, Math.min(1.5, intensity));
    switch (sfx) {
      case 'ui': this.tone(now, 'triangle', 660, 520, 0.06, 0.25); break;
      case 'draw': this.tone(now, 'sine', 900 + rand() * 200, 700, 0.04, 0.08); break;
      case 'confirm':
        this.tone(now, 'triangle', 440, 440, 0.08, 0.3);
        this.tone(now + 0.07, 'triangle', 660, 660, 0.12, 0.3);
        break;
      case 'tick': this.tone(now, 'square', 1200, 1200, 0.03, 0.12); break;
      case 'round-start':
        this.noiseBurst(now, 0.35, 'bandpass', 400, 2400, 0.35);
        this.tone(now, 'sawtooth', 110, 220, 0.3, 0.12);
        break;
      case 'round-end':
        this.tone(now, 'triangle', 523, 523, 0.12, 0.22);
        this.tone(now + 0.1, 'triangle', 392, 392, 0.2, 0.22);
        break;
      case 'shot':
        this.noiseBurst(now, 0.07, 'bandpass', 1800 + rand() * 600, 900, 0.5 * v);
        this.tone(now, 'square', 180, 60, 0.05, 0.12 * v);
        break;
      case 'heavy-shot':
        this.noiseBurst(now, 0.18, 'lowpass', 3000, 400, 0.8 * v);
        this.tone(now, 'sawtooth', 140, 40, 0.16, 0.3 * v);
        break;
      case 'mortar':
        this.tone(now, 'sine', 120, 50, 0.22, 0.6 * v);
        this.noiseBurst(now, 0.1, 'lowpass', 800, 200, 0.4 * v);
        break;
      case 'rocket': this.noiseBurst(now, 0.55, 'bandpass', 600, 2600, 0.45 * v); break;
      case 'hit': this.tone(now, 'sine', 220 + rand() * 60, 90, 0.06, 0.3 * v); break;
      case 'kill':
        this.tone(now, 'square', 320, 80, 0.14, 0.22 * v);
        this.noiseBurst(now, 0.12, 'lowpass', 1200, 300, 0.35 * v);
        break;
      case 'explosion':
        this.noiseBurst(now, 0.9, 'lowpass', 1400, 80, 1.1 * v);
        this.tone(now, 'sine', 90, 30, 0.6, 0.8 * v);
        break;
      case 'shield-break':
        this.tone(now, 'triangle', 1600, 1100, 0.18, 0.25);
        this.tone(now + 0.02, 'triangle', 2300, 1700, 0.14, 0.15);
        this.noiseBurst(now, 0.1, 'highpass', 3000, 3000, 0.25);
        break;
      case 'victory':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(now + i * 0.11, 'triangle', f, f, 0.28, 0.3));
        break;
      case 'defeat':
        [392, 349, 311, 262].forEach((f, i) => this.tone(now + i * 0.16, 'triangle', f, f * 0.98, 0.32, 0.26));
        break;
      case 'upgrade':
        [659, 880, 1175].forEach((f, i) => this.tone(now + i * 0.06, 'sine', f, f, 0.18, 0.25));
        break;
    }
  }

  private fade(bus: GainNode | null, to: number): void {
    if (!bus || !this.ctx) return;
    bus.gain.cancelScheduledValues(this.ctx.currentTime);
    bus.gain.setTargetAtTime(to, this.ctx.currentTime, 0.05);
  }

  private envelope(start: number, duration: number, peak: number): GainNode {
    const gain = this.ctx!.createGain();
    gain.gain.setValueAtTime(0.0001, start);
    gain.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), start + Math.min(0.01, duration / 4));
    gain.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    return gain;
  }

  private tone(start: number, type: OscillatorType, from: number, to: number, duration: number, peak: number): void {
    const ctx = this.ctx!;
    const osc = ctx.createOscillator();
    osc.type = type;
    osc.frequency.setValueAtTime(from, start);
    if (to !== from) osc.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);
    const gain = this.envelope(start, duration, peak);
    osc.connect(gain).connect(this.sfxBus!);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  }

  private noiseBurst(start: number, duration: number, filterType: BiquadFilterType, from: number, to: number, peak: number): void {
    const ctx = this.ctx!;
    const src = ctx.createBufferSource();
    src.buffer = this.noise;
    src.playbackRate.value = 0.8 + rand() * 0.4;
    const filter = ctx.createBiquadFilter();
    filter.type = filterType;
    filter.frequency.setValueAtTime(from, start);
    filter.frequency.exponentialRampToValueAtTime(Math.max(20, to), start + duration);
    const gain = this.envelope(start, duration, peak);
    src.connect(filter).connect(gain).connect(this.sfxBus!);
    src.start(start, rand() * 0.5);
    src.stop(start + duration + 0.02);
  }

  /** Calm: a soft two-note pad. Tense: the pad plus a heartbeat pulse that
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
    if (this.mood === 'off') return;

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

export const audio = new AudioEngine();
