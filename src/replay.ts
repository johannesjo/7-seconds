import { Renderer } from './renderer';
import { ReplayData, ReplayEvent, Unit, Projectile, Team, Vec2 } from './types';
import { FLANK_DAMAGE_MULTIPLIER } from './constants';

export type ReplayEventCallback = (event: 'frame' | 'end', data?: { time: number; duration: number }) => void;

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
    this.renderer.bloodEnabled = true;
    this.renderer.renderElevationZones(this.data.elevationZones);
    this.renderer.renderObstacles(this.data.obstacles);
    this.renderer.renderDefenseZones(this.data.defenseZones);
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

    // Convert snapshots to Unit objects for the renderer
    const units: Unit[] = frame.units.map(s => ({
      id: s.id,
      type: s.type,
      team: s.team,
      pos: { x: s.x, y: s.y },
      vel: { x: s.vx, y: s.vy },
      gunAngle: s.gunAngle,
      hp: s.hp,
      maxHp: s.maxHp,
      alive: s.alive,
      radius: s.radius,
      speed: 0,
      damage: 0,
      range: 0,
      moveTarget: null,
      waypoints: [],
      attackTargetId: null,
      fireCooldown: 0,
      fireTimer: 0,
      projectileSpeed: 0,
      projectileRadius: 0,
      turnSpeed: 0,
    }));

    const projectiles: Projectile[] = frame.projectiles.map(s => ({
      pos: { x: s.x, y: s.y },
      vel: { x: s.vx, y: s.vy },
      target: { x: 0, y: 0 },
      damage: s.damage,
      radius: s.radius,
      team: s.team,
      maxRange: s.maxRange,
      distanceTraveled: s.distanceTraveled,
      trail: s.trail,
    }));

    const dt = 1 / this.fps;
    this.renderer.renderUnits(units, dt);
    this.renderer.renderProjectiles(projectiles);
  }

  private triggerEvents(frameIndex: number): void {
    const fx = this.renderer.effects;
    if (!fx) return;

    for (const event of this.data.events) {
      if (event.frame !== frameIndex) continue;

      if (event.type === 'fire') {
        fx.addMuzzleFlash(event.pos, event.angle, 6);
      } else if (event.type === 'hit') {
        const victimTeam: Team = event.team === 'blue' ? 'red' : 'blue';
        const effectDamage = event.flanked ? event.damage * FLANK_DAMAGE_MULTIPLIER : event.damage;
        fx.addBloodSpray(event.pos, event.angle, victimTeam, effectDamage);
        fx.addImpactBurst(event.pos, event.team);
      } else if (event.type === 'kill') {
        const victimTeam: Team = event.team === 'blue' ? 'red' : 'blue';
        const effectDamage = event.flanked ? event.damage * FLANK_DAMAGE_MULTIPLIER : event.damage;
        fx.addBloodSpray(event.pos, event.angle, victimTeam, effectDamage);
        fx.addBloodBurst(event.pos, event.angle, victimTeam, effectDamage);
        fx.addKillText(event.pos, event.team);
      }
    }
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
