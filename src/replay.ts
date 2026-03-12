import { Renderer } from './renderer';
import { ReplayData, CtfState } from './types';
import { snapshotToUnit, snapshotToProjectile } from './units';

type ReplayEventCallback = (event: 'frame' | 'end', data?: { time: number; duration: number }) => void;

export class ReplayPlayer {
  private renderer: Renderer;
  private data: ReplayData;
  private onEvent: ReplayEventCallback;
  private frameIndex = 0;
  private accumulator = 0;
  private speed = 1;
  private paused = false;
  private running = false;
  private tickBound: (ticker: { deltaMS: number }) => void;
  private readonly fps = 60; // assumed recording rate

  constructor(renderer: Renderer, data: ReplayData, onEvent: ReplayEventCallback) {
    this.renderer = renderer;
    this.data = data;
    this.onEvent = onEvent;
    this.tickBound = this.tick.bind(this);
  }

  start(): void {
    this.renderer.renderElevationZones(this.data.elevationZones);
    this.renderer.renderObstacles(this.data.obstacles);
    if (this.data.ctfMode) {
      this.renderer.renderBaseZones();
    }
    this.frameIndex = 0;
    this.accumulator = 0;
    this.paused = false;
    this.running = true;
    this.renderFrame(0);
    this.renderer.ticker.add(this.tickBound);
  }

  private tick(ticker: { deltaMS: number }): void {
    if (!this.running || this.paused) return;

    const dt = (ticker.deltaMS / 1000) * this.speed;
    this.accumulator += dt;

    const frameDuration = 1 / this.fps;
    while (this.accumulator >= frameDuration && this.frameIndex < this.data.frames.length - 1) {
      this.frameIndex++;
      this.accumulator -= frameDuration;
      this.triggerEvents(this.frameIndex);
    }

    this.renderFrame(this.frameIndex);

    const time = this.frameIndex / this.fps;
    const duration = this.data.frames.length / this.fps;
    this.onEvent('frame', { time, duration });

    // Update effects
    this.renderer.effects?.update(ticker.deltaMS / 1000);

    if (this.frameIndex >= this.data.frames.length - 1) {
      this.onEvent('end', { time: duration, duration });
      this.paused = true;
    }
  }

  private renderFrame(index: number): void {
    const frame = this.data.frames[index];
    if (!frame) return;

    const units = frame.units.map(snapshotToUnit);
    const projectiles = frame.projectiles.map(snapshotToProjectile);

    const dt = 1 / this.fps;

    // Reconstruct CTF state for rendering if flag data exists
    if (frame.blueFlag && frame.redFlag) {
      const ctfState: CtfState = {
        blueFlag: {
          team: 'blue',
          pos: { x: frame.blueFlag.x, y: frame.blueFlag.y },
          homePos: { x: frame.blueFlag.homeX, y: frame.blueFlag.homeY },
          carrierId: frame.blueFlag.carrierId,
          dropped: frame.blueFlag.dropped,
        },
        redFlag: {
          team: 'red',
          pos: { x: frame.redFlag.x, y: frame.redFlag.y },
          homePos: { x: frame.redFlag.homeX, y: frame.redFlag.homeY },
          carrierId: frame.redFlag.carrierId,
          dropped: frame.redFlag.dropped,
        },
        winner: null,
      };
      this.renderer.renderUnits(units, dt, ctfState);
      this.renderer.renderFlags(ctfState);
    } else {
      this.renderer.renderUnits(units, dt);
    }

    this.renderer.renderProjectiles(projectiles);
  }

  private triggerEvents(frameIndex: number): void {
    const fx = this.renderer.effects;
    if (!fx) return;
    const frameEvents = this.data.events.filter(e => e.frame === frameIndex);
    fx.dispatchEvents(frameEvents);
  }

  pause(): void {
    this.paused = true;
  }

  resume(): void {
    this.paused = false;
  }

  togglePause(): void {
    this.paused = !this.paused;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setSpeed(n: number): void {
    this.speed = n;
  }

  restart(): void {
    this.frameIndex = 0;
    this.accumulator = 0;
    this.paused = false;
    this.renderer.effects?.clear();
    this.renderFrame(0);
  }

  stop(): void {
    this.running = false;
    this.renderer.ticker.remove(this.tickBound);
    this.renderer.effects?.clear();
    this.renderer.renderProjectiles([]);
    // Render empty units to clean up
    this.renderer.renderUnits([], 0);
  }
}
