import { afterEach, describe, expect, it } from 'vitest';
import { MAP_HEIGHT, MAP_WIDTH, setMapSize } from './constants';
import { GameEngine } from './game';
import { createTutorialEncounter, tutorialObjectiveMet } from './tutorial';
import type { PathList } from './online-async-core';

const originalMapSize = { width: MAP_WIDTH, height: MAP_HEIGHT };

afterEach(() => setMapSize(originalMapSize.width, originalMapSize.height));

function intendedPlan(lesson: number): PathList {
  const x = MAP_WIDTH / 2;
  const y = MAP_HEIGHT / 2;
  if (lesson === 0) return [{ unitId: 'blue_soldier', waypoints: [{ x, y: y + 60 }] }];
  if (lesson === 1) return [{ unitId: 'blue_sniper', waypoints: [{ x, y: y + 125 }] }];
  if (lesson === 3) return [{ unitId: 'blue_soldier', waypoints: [{ x, y: y + 150, wait: 1 }, { x, y: y + 60 }] }];
  if (lesson === 4) return [{ unitId: 'blue_sniper', waypoints: [{ x: x - 60, y: y - 110 }], targetId: 'red_bomber' }];
  return [{ unitId: 'blue_flanker', waypoints: [
    { x: x + 110, y: y + 40 }, { x: x + 100, y: y - 50 },
  ] }];
}

function playLesson(lesson: number, width: number, height: number, planned: boolean) {
  setMapSize(width, height);
  const practice = createTutorialEncounter(lesson);
  const redStart = practice.units.filter(unit => unit.team === 'red')
    .map(unit => ({ id: unit.id, pos: { ...unit.pos } }));
  let ended = false;
  const engine = new GameEngine(null, event => { if (event === 'end') ended = true; },
    { practice, seed: 1 });
  engine.startBattle();
  if (planned) engine.setBluePaths(intendedPlan(lesson));
  engine.confirmPlan();
  expect(engine.phase).toBe('playing');

  // Stop after the first round or a completed battle, including the end delay.
  let firstRedHit = false;
  for (let tick = 0; tick < 480 && !ended && engine.phase === 'playing'; tick++) {
    engine.externalTick(1000 / 60);
    firstRedHit ||= engine.getReplayEventsSince(0).events.some(event =>
      event.team === 'blue' && (event.type === 'hit' || event.type === 'kill')
      && redStart.some(red => red.id === event.targetId));
    // Opponents may be pushed by hits, but they should never move on their own.
    if (!firstRedHit) {
      expect(engine.getUnits().filter(unit => unit.team === 'red')
        .map(unit => ({ id: unit.id, pos: { ...unit.pos } }))).toEqual(redStart);
    }
    expect(engine.getUnits().filter(unit => unit.team === 'red')
      .every(unit => unit.waypoints.length === 0 && unit.moveTarget === null)).toBe(true);
  }
  expect(ended || engine.phase === 'blue-planning').toBe(true);
  const outcome = {
    met: tutorialObjectiveMet(lesson, engine.getUnits(), engine.getReplayData()),
    redStart,
    redEnd: engine.getUnits().filter(unit => unit.team === 'red')
      .map(unit => ({ id: unit.id, pos: { ...unit.pos } })),
  };
  engine.stop();
  return outcome;
}

describe.each([
  [360, 620],
  [1000, 1000],
])('tutorial encounter at %ix%i', (width, height) => {
  it.each([0, 1, 2, 3, 4])('lesson %i succeeds with its intended plan and stationary red opponents', lesson => {
    const result = playLesson(lesson, width, height, true);
    expect(result.met).toBe(true);
  });

  it.each([0, 1, 2, 3, 4])('lesson %i does not pass with an empty plan', lesson => {
    const result = playLesson(lesson, width, height, false);
    expect(result.met).toBe(false);
    // In the focus lesson both enemies start in range, so an idle sniper
    // still fires (at the closer decoy).
    if (lesson !== 4) expect(result.redEnd).toEqual(result.redStart);
  });

  it('hold lesson does not pass with a plain path', () => {
    setMapSize(width, height);
    const plan = intendedPlan(3).map(p => ({ ...p, waypoints: p.waypoints.map(({ x, y }) => ({ x, y })) }));
    const practice = createTutorialEncounter(3);
    const engine = new GameEngine(null, () => {}, { practice, seed: 1 });
    engine.startBattle();
    engine.setBluePaths(plan);
    engine.confirmPlan();
    for (let tick = 0; tick < 480 && engine.phase === 'playing'; tick++) engine.externalTick(1000 / 60);
    expect(tutorialObjectiveMet(3, engine.getUnits(), engine.getReplayData())).toBe(false);
    engine.stop();
  });

  it('focus lesson does not pass without the focus order', () => {
    setMapSize(width, height);
    const practice = createTutorialEncounter(4);
    const engine = new GameEngine(null, () => {}, { practice, seed: 1 });
    engine.startBattle();
    engine.setBluePaths(intendedPlan(4).map(({ unitId, waypoints }) => ({ unitId, waypoints })));
    engine.confirmPlan();
    for (let tick = 0; tick < 480 && engine.phase === 'playing'; tick++) engine.externalTick(1000 / 60);
    expect(tutorialObjectiveMet(4, engine.getUnits(), engine.getReplayData())).toBe(false);
    engine.stop();
  });

  it.each([{ direction: 'away', dx: 0, dy: 80 }, { direction: 'sideways', dx: 80, dy: 0 }])(
    'movement lesson does not pass when moving $direction', ({ dx, dy }) => {
      setMapSize(width, height);
      const practice = createTutorialEncounter(0);
      const soldier = practice.units[0];
      const engine = new GameEngine(null, () => {}, { practice, seed: 1 });
      engine.startBattle();
      engine.setBluePaths([{ unitId: soldier.id, waypoints: [{ x: soldier.pos.x + dx, y: soldier.pos.y + dy }] }]);
      engine.confirmPlan();
      for (let tick = 0; tick < 480 && engine.phase === 'playing'; tick++) engine.externalTick(1000 / 60);
      expect(tutorialObjectiveMet(0, engine.getUnits(), engine.getReplayData())).toBe(false);
      engine.stop();
    },
  );
});
