import { describe, expect, it } from 'vitest';
import { renderGunshot } from './gunshot';
import { createRng } from './rng';

const SR = 48000;

function rms(d: Float32Array, from: number, to: number): number {
  let sum = 0;
  for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) sum += d[i] * d[i];
  return Math.sqrt(sum / ((to - from) * SR));
}

describe('renderGunshot', () => {
  for (const kind of ['light', 'heavy'] as const) {
    it(`${kind}: finite, peak-normalized, sharp onset, silent end`, () => {
      const d = renderGunshot(kind, SR, createRng(7));
      expect(d.every(Number.isFinite)).toBe(true);
      const peak = d.reduce((m, s) => Math.max(m, Math.abs(s)), 0);
      expect(peak).toBeCloseTo(0.9, 2);
      // A gunshot hits full level within a few ms, not a swell
      const firstPeak = d.slice(0, 0.005 * SR).reduce((m, s) => Math.max(m, Math.abs(s)), 0);
      expect(firstPeak).toBeGreaterThan(0.5);
      expect(Math.abs(d[d.length - 1])).toBeLessThan(0.001);
    });
  }

  it('heavy works the bolt well after the shot', () => {
    const d = renderGunshot('heavy', SR, createRng(7));
    // Silence between the shot tail and the bolt, then an audible clack
    expect(rms(d, 0.26, 0.28)).toBeLessThan(0.002);
    expect(rms(d, 0.28, 0.34)).toBeGreaterThan(0.01);
  });

  it('sounds the same at any device sample rate', () => {
    // Same seed, so only the rate differs; compare loudness of the shot body
    const at = (sr: number) => {
      const d = renderGunshot('light', sr, createRng(3));
      let sum = 0;
      for (let i = 0; i < Math.round(0.05 * sr); i++) sum += d[i] * d[i];
      return Math.sqrt(sum / (0.05 * sr));
    };
    expect(at(44100) / at(96000)).toBeGreaterThan(0.8);
    expect(at(44100) / at(96000)).toBeLessThan(1.25);
  });

  it('variants differ', () => {
    const rng = createRng(1);
    const a = renderGunshot('light', SR, rng);
    const b = renderGunshot('light', SR, rng);
    expect(a).not.toEqual(b);
  });
});
