import { MAP_WIDTH, MAP_HEIGHT } from './constants';
import { createUnit, getElevationLevel } from './units';
import type { Unit, ElevationZone, ReplayData } from './types';

export const TUTORIAL_LESSONS = [
  {
    title: '1/5 · Draw a move',
    instruction: 'Drag your blue soldier toward the red soldier, then press Fight. Redraw the path to change your plan.',
    success: 'Your soldier followed your path and aimed automatically. You control movement; units handle firing.',
    retry: 'Try a longer path toward the red soldier, then press Fight.',
  },
  {
    title: '2/5 · Take high ground',
    instruction: 'Move your blue sniper onto the shaded hill. Stop there and fire with 20% extra range.',
    success: 'Your sniper fired from high ground. Hills extend firing range by 20% per level.',
    retry: 'End the sniper’s path inside the shaded hill and let it fire from there.',
  },
  {
    title: '3/5 · Flank the shield',
    instruction: 'Leave the middle soldier in front. Draw the right soldier around the shield’s right side to attack from behind.',
    success: 'You landed a flanking hit! Side and rear shots bypass the frontal shield and deal 50% extra damage.',
    retry: 'Keep one soldier in front to hold the shield’s attention. Send the other around its side, staying a little farther away.',
  },
  {
    title: '4/5 · Wait, then go',
    instruction: 'Start drawing the soldier’s path, then rest your finger a moment: a wait marker appears and grows. Keep drawing to continue. Units hold at markers, still firing.',
    success: 'Your soldier held, then moved on. Use waits to time pushes, let a shield lead, or ambush from cover.',
    retry: 'While drawing, keep your finger still until the wait marker appears, then keep drawing past it.',
  },
  {
    title: '5/5 · Focus fire',
    instruction: 'Both enemies are in range, and the soldier is closer. Drag from your sniper and release on the red bomber to focus it: the sniper holds position and shoots the bomber first.',
    success: 'Focused shot! The bomber blew up among its own team. Focus picks your target; without it, units shoot the closest enemy.',
    retry: 'Release the sniper’s path right on the bomber. A crosshair shows the focus order.',
  },
];

export function createTutorialEncounter(lesson: number): { units: Unit[]; elevationZones: ElevationZone[] } {
  const x = MAP_WIDTH / 2;
  const y = MAP_HEIGHT / 2;
  if (lesson === 0) {
    return {
      units: [createUnit('blue_soldier', 'soldier', 'blue', { x, y: y + 140 }),
        createUnit('red_soldier', 'soldier', 'red', { x, y: y - 180 })],
      elevationZones: [],
    };
  }
  if (lesson === 1) {
    return {
      units: [createUnit('blue_sniper', 'sniper', 'blue', { x: x - 90, y: y + 170 }),
        createUnit('red_soldier', 'soldier', 'red', { x, y: y - 210 })],
      elevationZones: [{ x: x - 50, y: y + 90, w: 100, h: 70 }],
    };
  }
  if (lesson === 3) {
    return {
      units: [createUnit('blue_soldier', 'soldier', 'blue', { x, y: y + 200 }),
        createUnit('red_soldier', 'soldier', 'red', { x, y: y - 250 })],
      elevationZones: [],
    };
  }
  if (lesson === 4) {
    return {
      units: [createUnit('blue_sniper', 'sniper', 'blue', { x, y: y + 150 }),
        createUnit('red_decoy', 'soldier', 'red', { x: x + 60, y: y - 40 }),
        createUnit('red_bomber', 'bomber', 'red', { x: x - 60, y: y - 110 }),
        createUnit('red_left', 'soldier', 'red', { x: x - 95, y: y - 130 }),
        createUnit('red_right', 'soldier', 'red', { x: x - 25, y: y - 135 })],
      elevationZones: [],
    };
  }
  return {
    units: [createUnit('blue_front', 'soldier', 'blue', { x, y: y + 60 }),
      createUnit('blue_flanker', 'soldier', 'blue', { x: x + 100, y: y + 120 }),
      createUnit('red_shielder', 'shielder', 'red', { x, y })],
    elevationZones: [],
  };
}

export function tutorialObjectiveMet(lesson: number, units: Unit[], replay: ReplayData | null): boolean {
  if (lesson === 0) {
    const soldier = units.find(u => u.id === 'blue_soldier');
    const [start, target] = createTutorialEncounter(0).units;
    const initialDistance = Math.hypot(start.pos.x - target.pos.x, start.pos.y - target.pos.y);
    return !!soldier && initialDistance - Math.hypot(soldier.pos.x - target.pos.x, soldier.pos.y - target.pos.y) >= 60;
  }
  if (lesson === 1) {
    return !!replay?.events.some(event => event.type === 'fire' && event.team === 'blue'
      && getElevationLevel(event.pos, replay.elevationZones) > 0);
  }
  if (lesson === 2) return !!replay?.events.some(event => event.team === 'blue' && event.flanked);
  if (lesson === 3) return !!replay && heldThenMoved(replay, 'blue_soldier');
  const firstHit = replay?.events.find(event => event.team === 'blue' && (event.type === 'hit' || event.type === 'kill'));
  return firstHit?.targetId === 'red_bomber';
}

/** True when the unit stood still mid-plan (a hold) and then moved on. */
function heldThenMoved(replay: ReplayData, unitId: string): boolean {
  const HOLD_FRAMES = 30; // shortest hold is 0.5s at 60 fps
  let still = 0;
  let heldAt: { x: number; y: number } | null = null;
  let prev: { x: number; y: number } | null = null;
  for (const frame of replay.frames) {
    const u = frame.units.find(unit => unit.id === unitId);
    if (!u) continue;
    if (prev && Math.hypot(u.x - prev.x, u.y - prev.y) < 0.01) {
      if (++still >= HOLD_FRAMES) heldAt ??= { x: u.x, y: u.y };
    } else {
      still = 0;
    }
    if (heldAt && Math.hypot(u.x - heldAt.x, u.y - heldAt.y) >= 20) return true;
    prev = { x: u.x, y: u.y };
  }
  return false;
}
