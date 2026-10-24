/** Player preferences persisted across sessions (sound, music, vibration,
 *  theme, motion). */

export interface Settings {
  sound: boolean;
  music: boolean;
  haptics: boolean;
  dayMode: boolean;
  /** Screen shake, slow motion and camera zoom. */
  reducedMotion: boolean;
}

const KEY = '7s-settings';

function systemPrefersReducedMotion(): boolean {
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

function defaults(): Settings {
  return { sound: true, music: true, haptics: true, dayMode: true, reducedMotion: systemPrefersReducedMotion() };
}

function load(): Settings {
  const base = defaults();
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return base;
    const parsed = JSON.parse(raw) as Partial<Settings>;
    for (const key of Object.keys(base) as (keyof Settings)[]) {
      if (typeof parsed[key] === 'boolean') base[key] = parsed[key];
    }
  } catch { /* storage unavailable or corrupt — use defaults */ }
  return base;
}

const current: Settings = load();
const listeners: ((s: Readonly<Settings>) => void)[] = [];

export function getSettings(): Readonly<Settings> {
  return current;
}

export function updateSettings(patch: Partial<Settings>): void {
  Object.assign(current, patch);
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch { /* unavailable */ }
  for (const listener of listeners) listener(current);
}

export function onSettingsChange(listener: (s: Readonly<Settings>) => void): void {
  listeners.push(listener);
}
