import { describe, expect, it, vi } from 'vitest';
import { ReplayPlayer } from './replay';
import type { Renderer } from './renderer';
import type { ReplayData, ReplayEvent } from './types';

function setup() {
  let tick: (ticker: { deltaMS: number }) => void = () => {};
  const renderer = {
    renderElevationZones: vi.fn(), renderObstacles: vi.fn(), renderUnits: vi.fn(),
    renderProjectiles: vi.fn(), clearDyingUnits: vi.fn(),
    effects: { dispatchEvents: vi.fn(), update: vi.fn(), clear: vi.fn() },
    ticker: { add: vi.fn(callback => { tick = callback; }), remove: vi.fn() },
  };
  const event: ReplayEvent = {
    frame: 0, type: 'hit', pos: { x: 100, y: 100 }, angle: 0,
    damage: 15, flanked: true, team: 'blue', targetId: 'red',
  };
  const data: ReplayData = {
    frames: Array.from({ length: 120 }, () => ({ units: [], projectiles: [] })),
    events: [event], obstacles: [], elevationZones: [],
  };
  const onEvent = vi.fn();
  const player = new ReplayPlayer(renderer as unknown as Renderer, data, onEvent);
  return { player, renderer, onEvent, event, tick: (deltaMS: number) => tick({ deltaMS }) };
}

describe('ReplayPlayer', () => {
  it('slows both recorded action and effects at 0.5× and freezes both when paused', () => {
    const { player, renderer, onEvent, tick } = setup();
    player.start();
    player.setSpeed(0.5);
    tick(100);
    expect(onEvent).toHaveBeenLastCalledWith('frame', { time: 0.05, duration: 2 });
    expect(renderer.effects.update).toHaveBeenLastCalledWith(0.05);
    expect(renderer.renderUnits).toHaveBeenLastCalledWith([], 0.05);
    player.pause();
    const updates = renderer.effects.update.mock.calls.length;
    tick(100);
    expect(renderer.effects.update).toHaveBeenCalledTimes(updates);
    player.resume();
    tick(100);
    expect(onEvent).toHaveBeenLastCalledWith('frame', { time: 0.1, duration: 2 });
    player.stop();
  });

  it('emphasizes decisive events and restores frame-zero cues when restarting', () => {
    const { player, renderer, event, tick } = setup();
    player.start();
    expect(renderer.effects.dispatchEvents).toHaveBeenCalledWith([event], true);
    tick(100);
    player.restart();
    expect(renderer.effects.clear).toHaveBeenCalledOnce();
    expect(renderer.clearDyingUnits).toHaveBeenCalledTimes(2);
    expect(renderer.effects.dispatchEvents).toHaveBeenLastCalledWith([event], true);
    expect(player.isPaused).toBe(false);
    player.stop();
  });
});
