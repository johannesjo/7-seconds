import { MAP_WIDTH, MAP_HEIGHT } from './constants';
import { createUnit, getElevationLevel } from './units';
import type { Unit, ElevationZone, Obstacle, ReplayData } from './types';

export const TUTORIAL_LESSONS = [
  {
    title: '1/4 · Draw a move',
    instruction: 'Drag your blue soldier toward the red soldier, then press Fight. Redraw the path to change your plan.',
    success: 'Your soldier followed your path and aimed automatically. You control movement; units handle firing.',
    retry: 'Try a longer path toward the red soldier, then press Fight.',
  },
  {
    title: '2/4 · Take high ground',
    instruction: 'Move your blue sniper onto the shaded hill. Stop there and fire with 20% extra range.',
    success: 'Your sniper fired from high ground. Hills extend firing range by 20% per level.',
    retry: 'End the sniper’s path inside the shaded hill and let it fire from there.',
  },
  {
    title: '3/4 · Flank the shield',
    instruction: 'Leave the middle soldier in front. Draw the right soldier around the shield’s right side to attack from behind.',
    success: 'You landed a flanking hit! Side and rear shots bypass the frontal shield and deal 50% extra damage.',
    retry: 'Keep one soldier in front to hold the shield’s attention. Send the other around its side, staying a little farther away.',
  },
  {
    title: '4/4 · Rocket around cover',
    instruction: 'The rocketeer has no gun. Drag from the orange rocket icon ahead of it and draw a curve around the wall to the red soldier. The rocket flies your line.',
    success: 'Direct hit! Rockets fly exactly where you draw them, so they curve around cover, and the blast hurts every enemy in its circle.',
    retry: 'Start the drag on the orange rocket icon, not the unit, and route the line around the wall.',
  },
];

export function createTutorialEncounter(lesson: number): { units: Unit[]; elevationZones: ElevationZone[]; obstacles?: Obstacle[] } {
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
      units: [createUnit('blue_rocketeer', 'rocketeer', 'blue', { x, y: y + 170 }),
        createUnit('red_soldier', 'soldier', 'red', { x, y: y - 90 })],
      elevationZones: [],
      obstacles: [{ x: x - 70, y: y - 10, w: 140, h: 30 }],
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
  return !!replay?.events.some(event => event.team === 'blue'
    && (event.type === 'hit' || event.type === 'kill') && event.targetId === 'red_soldier');
}
