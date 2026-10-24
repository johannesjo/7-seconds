import { Capacitor } from '@capacitor/core';
import { Haptics, ImpactStyle } from '@capacitor/haptics';

export type HapticStrength = 'light' | 'medium' | 'heavy';

const STYLE: Record<HapticStrength, ImpactStyle> = {
  light: ImpactStyle.Light,
  medium: ImpactStyle.Medium,
  heavy: ImpactStyle.Heavy,
};
const VIBRATE_MS: Record<HapticStrength, number> = { light: 10, medium: 20, heavy: 40 };
/** Android merges rapid pulses into one long buzz; space them out instead. */
const MIN_GAP_MS = 60;

let enabled = true;
let lastPulse = 0;

export function setHapticsEnabled(on: boolean): void {
  enabled = on;
}

export function pulse(strength: HapticStrength): void {
  if (!enabled) return;
  const now = performance.now();
  if (now - lastPulse < MIN_GAP_MS) return;
  lastPulse = now;
  if (Capacitor.isNativePlatform()) {
    void Haptics.impact({ style: STYLE[strength] }).catch(() => {});
  } else if (typeof navigator.vibrate === 'function') {
    try { navigator.vibrate(VIBRATE_MS[strength]); } catch { /* blocked */ }
  }
}
