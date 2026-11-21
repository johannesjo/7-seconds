/** What the Android Back button acts on, given which screens are showing.
 *  Gameplay (planning, battle, replay, Horde upgrades, the pass-device cover)
 *  maps to 'none': a stray Back press or edge swipe must never interrupt a
 *  round, and leaving a match stays behind the in-game ✕ and its confirm. */

export interface BackScreens {
  ageGate: boolean;
  settings: boolean;
  difficulty: boolean;
  matches: boolean;
  ranked: boolean;
  /** Online lobby: searching, waiting for an opponent, or a failed start. */
  lobby: boolean;
  result: boolean;
  /** Main menu with nothing open on top of it. */
  menu: boolean;
}

export type BackTarget = Exclude<keyof BackScreens, 'ageGate'> | 'none';

/** Topmost screen first: dialogs open over the menu, the lobby over the board. */
const ORDER: readonly Exclude<BackTarget, 'none'>[] = ['settings', 'difficulty', 'matches', 'ranked', 'lobby', 'result', 'menu'];

export function backTarget(screens: BackScreens): BackTarget {
  if (screens.ageGate) return 'none';
  return ORDER.find(target => screens[target]) ?? 'none';
}

/** Window in which a second Back press on the menu exits the app: as long as
 *  the "Press back again to exit" toast stays up (showToast in main.ts). */
const EXIT_CONFIRM_MS = 3500;

/** On the menu, the first Back press only warns; a second one soon after exits. */
export function shouldExit(now: number, lastMenuBack: number | null): boolean {
  return lastMenuBack !== null && now - lastMenuBack <= EXIT_CONFIRM_MS;
}
