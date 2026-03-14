import type { Unit } from './types';

/** FNV-1a — mix a 32-bit integer into a running hash. */
function fnv1a(hash: number, value: number): number {
  hash ^= value & 0xff;
  hash = Math.imul(hash, 0x01000193);
  hash ^= (value >>> 8) & 0xff;
  hash = Math.imul(hash, 0x01000193);
  hash ^= (value >>> 16) & 0xff;
  hash = Math.imul(hash, 0x01000193);
  hash ^= (value >>> 24) & 0xff;
  return Math.imul(hash, 0x01000193);
}

/** Hash game state into a 32-bit integer for desync detection.
 *  Both peers iterate units in the same insertion order (from OnlineGameState),
 *  so no sorting is needed. */
export function hashGameState(units: Unit[]): number {
  let h = 0x811c9dc5; // FNV offset basis

  for (const u of units) {
    // Round positions to 2 decimal places to absorb float noise
    h = fnv1a(h, Math.round(u.pos.x * 100));
    h = fnv1a(h, Math.round(u.pos.y * 100));
    h = fnv1a(h, Math.round(u.hp * 100));
    h = fnv1a(h, u.alive ? 1 : 0);
  }

  return h >>> 0; // unsigned 32-bit
}
