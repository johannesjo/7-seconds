// The name a casual player shows their online opponents. Stored on this
// device and sent with each move; the referee cleans it (see cleanName).
const KEY = '7s-player-name';
export const MAX_NAME_LENGTH = 24;

export function getPlayerName(): string | null {
  try {
    const name = localStorage.getItem(KEY)?.trim();
    return name ? name.slice(0, MAX_NAME_LENGTH) : null;
  } catch { return null; }
}

export function setPlayerName(name: string): void {
  try {
    const trimmed = name.trim().slice(0, MAX_NAME_LENGTH);
    if (trimmed) localStorage.setItem(KEY, trimmed); else localStorage.removeItem(KEY);
  } catch { /* storage unavailable: the name lasts for this match only */ }
}
