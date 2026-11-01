import { describe, it, expect } from 'vitest';
import { createUnit, findCombatTarget, focusTarget } from './units';
import { findMortarTarget } from './ordnance';
import type { Obstacle } from './types';

describe('focus fire', () => {
  const soldier = () => createUnit('b', 'soldier', 'blue', { x: 100, y: 300 });

  it('shoots the nearest enemy when no focus is set', () => {
    const me = soldier();
    const near = createUnit('near', 'soldier', 'red', { x: 100, y: 240 });
    const far = createUnit('far', 'sniper', 'red', { x: 160, y: 220 });
    expect(findCombatTarget(me, [me, near, far], [], [])?.id).toBe('near');
  });

  it('prefers the focused enemy when it can hit it', () => {
    const me = soldier();
    const near = createUnit('near', 'soldier', 'red', { x: 100, y: 240 });
    const far = createUnit('far', 'sniper', 'red', { x: 160, y: 220 });
    me.attackTargetId = 'far';
    expect(findCombatTarget(me, [me, near, far], [], [])?.id).toBe('far');
  });

  it('never holds fire: falls back to a hittable enemy when the focus is out of range', () => {
    const me = soldier();
    const near = createUnit('near', 'soldier', 'red', { x: 100, y: 240 });
    const far = createUnit('far', 'sniper', 'red', { x: 100, y: 20 });
    me.attackTargetId = 'far';
    expect(findCombatTarget(me, [me, near, far], [], [])?.id).toBe('near');
  });

  it('falls back when the focus is behind cover', () => {
    const me = soldier();
    const near = createUnit('near', 'soldier', 'red', { x: 40, y: 260 });
    const hidden = createUnit('hidden', 'sniper', 'red', { x: 100, y: 220 });
    const wall: Obstacle = { x: 80, y: 250, w: 40, h: 10 };
    me.attackTargetId = 'hidden';
    expect(findCombatTarget(me, [me, near, hidden], [wall], [])?.id).toBe('near');
  });

  it('turns toward a visible focus when nothing is in range', () => {
    const me = soldier();
    const nearer = createUnit('nearer', 'soldier', 'red', { x: 100, y: 100 });
    const focus = createUnit('focus', 'sniper', 'red', { x: 300, y: 60 });
    me.attackTargetId = 'focus';
    expect(findCombatTarget(me, [me, nearer, focus], [], [])?.id).toBe('focus');
  });

  it('clears a focus on a dead enemy', () => {
    const me = soldier();
    const dead = createUnit('dead', 'soldier', 'red', { x: 100, y: 240 });
    dead.alive = false;
    me.attackTargetId = 'dead';
    expect(focusTarget(me, [me, dead])).toBeNull();
    expect(me.attackTargetId).toBeNull();
  });

  it('ignores a focus on a friendly unit', () => {
    const me = soldier();
    const friend = createUnit('friend', 'soldier', 'blue', { x: 100, y: 240 });
    me.attackTargetId = 'friend';
    expect(focusTarget(me, [me, friend])).toBeNull();
    expect(me.attackTargetId).toBeNull();
  });

  it('mortar shells its focus when it is in the firing band', () => {
    const mortar = createUnit('m', 'mortar', 'blue', { x: 180, y: 500 });
    const near = createUnit('near', 'soldier', 'red', { x: 180, y: 350 });
    const far = createUnit('far', 'sniper', 'red', { x: 180, y: 250 });
    expect(findMortarTarget(mortar, [mortar, near, far], [])?.id).toBe('near');
    mortar.attackTargetId = 'far';
    expect(findMortarTarget(mortar, [mortar, near, far], [])?.id).toBe('far');
    // Inside the dead zone: falls back to what it can reach.
    far.pos = { x: 180, y: 450 };
    expect(findMortarTarget(mortar, [mortar, near, far], [])?.id).toBe('near');
  });
});
