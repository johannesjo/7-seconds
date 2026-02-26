import { Unit, Obstacle, Team, BattleResult, Projectile, TurnPhase, ElevationZone } from './types';
import { ARMY_COMPOSITION, ROUND_DURATION_S, COVER_SCREEN_DURATION_MS, MAP_WIDTH, MAP_HEIGHT } from './constants';
import { createArmy, moveUnit, separateUnits, findTarget, isInRange, tryFireProjectile, updateProjectiles, advanceWaypoint, updateGunAngle } from './units';
import { generateObstacles, generateElevationZones } from './battlefield';
import { PathDrawer } from './path-drawer';
import { Renderer } from './renderer';

export type GameEventCallback = (
  event: 'update' | 'end' | 'phase-change',
  data?: BattleResult | { phase: TurnPhase; timeLeft?: number; round?: number },
) => void;

export class GameEngine {
  private units: Unit[] = [];
  private obstacles: Obstacle[] = [];
  private elevationZones: ElevationZone[] = [];
  private projectiles: Projectile[] = [];
  private renderer: Renderer;
  private running = false;
  private speedMultiplier = 1;
  private elapsedTime = 0;
  private roundTimer = 0;
  private onEvent: GameEventCallback;
  private pathDrawer: PathDrawer | null = null;
  private _phase: TurnPhase = 'blue-planning';
  private roundNumber = 1;
  private aiMode = false;
  private idleTime = 0;

  constructor(renderer: Renderer, onEvent: GameEventCallback, aiMode = false) {
    this.renderer = renderer;
    this.onEvent = onEvent;
    this.aiMode = aiMode;
  }

  get phase(): TurnPhase {
    return this._phase;
  }

  startBattle(): void {
    this.units = [...createArmy('blue'), ...createArmy('red')];
    this.obstacles = generateObstacles();
    this.elevationZones = generateElevationZones();
    this.projectiles = [];
    this.elapsedTime = 0;
    this.roundTimer = 0;
    this.running = true;

    this.pathDrawer = new PathDrawer(this.renderer.stage, this.renderer.canvas);

    // Render initial state — hills under obstacles
    this.renderer.renderElevationZones(this.elevationZones);
    this.renderer.renderObstacles(this.obstacles);
    this.renderer.renderUnits(this.units);

    // Start ticker for rendering during planning
    this.renderer.ticker.add(this.tick, this);

    this.setPhase('blue-planning');
  }

  private coverTimeout: ReturnType<typeof setTimeout> | null = null;

  /** Called by the UI "Done" button to end the current planning phase. */
  confirmPlan(): void {
    if (this._phase === 'blue-planning') {
      this.setPhase('cover');
      // In AI mode, setPhase('cover') already transitions to playing
      if (!this.aiMode) {
        this.coverTimeout = setTimeout(() => {
          this.skipCover();
        }, COVER_SCREEN_DURATION_MS);
      }
    } else if (this._phase === 'red-planning') {
      this.setPhase('playing');
    }
  }

  /** Skip the cover screen early (e.g. on tap). */
  skipCover(): void {
    if (this._phase !== 'cover') return;
    if (this.coverTimeout) {
      clearTimeout(this.coverTimeout);
      this.coverTimeout = null;
    }
    this.setPhase('red-planning');
  }

  private setPhase(phase: TurnPhase): void {
    this._phase = phase;

    if (phase === 'blue-planning') {
      this.pathDrawer?.clearPaths('blue');
      this.pathDrawer?.enable('blue', this.units, this.elevationZones);
    } else if (phase === 'cover') {
      this.pathDrawer?.disable();
      if (this.aiMode) {
        // Skip cover screen, generate AI paths, go straight to playing
        this.generateAiPaths();
        this.onEvent('phase-change', { phase, round: this.roundNumber });
        this.setPhase('playing');
        return;
      }
    } else if (phase === 'red-planning') {
      this.pathDrawer?.clearPaths('red');
      this.pathDrawer?.enable('red', this.units, this.elevationZones);
    } else if (phase === 'playing') {
      this.pathDrawer?.disable();
      this.pathDrawer?.clearGraphics();
      this.roundTimer = ROUND_DURATION_S;
      this.idleTime = 0;
      this.renderer.effects?.addRoundStartFlash(MAP_WIDTH, MAP_HEIGHT);
    }

    this.onEvent('phase-change', { phase, round: this.roundNumber });
  }

  /** Generate simple AI paths for red units: head toward blue side with random spread. */
  private generateAiPaths(): void {
    const redUnits = this.units.filter(u => u.alive && u.team === 'red');
    for (const unit of redUnits) {
      const waypoints: { x: number; y: number }[] = [];
      const steps = 2 + Math.floor(Math.random() * 2); // 2-3 waypoints
      const targetY = MAP_HEIGHT * 0.85; // Head toward blue spawn side (bottom)
      const stepY = (targetY - unit.pos.y) / steps;

      for (let i = 1; i <= steps; i++) {
        const spreadX = (Math.random() - 0.5) * MAP_WIDTH * 0.3;
        waypoints.push({
          x: Math.max(20, Math.min(MAP_WIDTH - 20, unit.pos.x + spreadX)),
          y: Math.min(MAP_HEIGHT - 20, unit.pos.y + stepY * i),
        });
      }
      unit.waypoints = waypoints;
    }
  }

  private tick = (ticker: { deltaMS: number }): void => {
    if (!this.running) return;

    const rawDt = ticker.deltaMS / 1000;
    const dt = this._phase === 'playing' ? rawDt * this.speedMultiplier : rawDt;

    // Always render units (even during planning, need dt for death fade)
    this.renderer.renderUnits(this.units, dt);

    // Animate pulsing indicators during planning
    this.pathDrawer?.updateHover();

    if (this._phase !== 'playing') return;
    this.elapsedTime += dt;
    this.roundTimer -= dt;

    // Advance waypoints and move
    for (const unit of this.units) {
      if (!unit.alive) continue;
      advanceWaypoint(unit);
      moveUnit(unit, dt, this.obstacles);
    }
    separateUnits(this.units);

    // Combat — auto-target nearest enemy, fire projectiles
    for (const unit of this.units) {
      if (!unit.alive) continue;

      const target = findTarget(unit, this.units, null);
      if (target && isInRange(unit, target, this.elevationZones)) {
        const desired = Math.atan2(target.pos.y - unit.pos.y, target.pos.x - unit.pos.x);
        updateGunAngle(unit, desired, dt);
        const projectile = tryFireProjectile(unit, target, dt, this.elevationZones);
        if (projectile) {
          this.projectiles.push(projectile);
          this.renderer.effects?.addMuzzleFlash(unit.pos, unit.gunAngle, unit.radius);
        }
      } else {
        unit.fireTimer = Math.max(0, unit.fireTimer - dt);
        const speed = Math.sqrt(unit.vel.x * unit.vel.x + unit.vel.y * unit.vel.y);
        if (speed > 1) {
          const desired = Math.atan2(unit.vel.y, unit.vel.x);
          updateGunAngle(unit, desired, dt);
        }
      }
    }

    const { alive: aliveProjectiles, hits } = updateProjectiles(this.projectiles, this.units, dt);
    this.projectiles = aliveProjectiles;

    // Trigger effects for hits
    const fx = this.renderer.effects;
    for (const hit of hits) {
      fx?.addImpactBurst(hit.pos, hit.team);
      const unitGfx = this.renderer.getUnitContainer(hit.targetId);
      if (unitGfx) fx?.addHitFlash(unitGfx);
      if (hit.killed) fx?.addKillText(hit.pos, hit.team);
    }

    this.renderer.renderProjectiles(this.projectiles);

    // Update effects
    this.renderer.effects?.update(dt);

    // HUD update with time left
    this.onEvent('update', { phase: 'playing', timeLeft: Math.max(0, this.roundTimer) });

    // Win condition
    const blueAlive = this.units.filter(u => u.alive && u.team === 'blue').length;
    const redAlive = this.units.filter(u => u.alive && u.team === 'red').length;

    if (blueAlive === 0 || redAlive === 0) {
      this.endBattle(blueAlive === 0 ? 'red' : 'blue');
      return;
    }

    // Check if action is complete — no movement, no combat, no projectiles
    const idle = this.projectiles.length === 0 && this.units.every(u => {
      if (!u.alive) return true;
      // Use actual velocity — moveTarget can be stuck on obstacles
      const speed = u.vel.x * u.vel.x + u.vel.y * u.vel.y;
      if (speed > 1 || u.waypoints.length > 0) return false;
      const target = findTarget(u, this.units, null);
      return !target || !isInRange(u, target, this.elevationZones);
    });

    // Require sustained idle for 0.5s to avoid transient false positives
    this.idleTime = idle ? this.idleTime + dt : 0;

    // Round over → back to planning
    if (this.roundTimer <= 0 || this.idleTime >= 0.5) {
      this.projectiles = [];
      this.renderer.renderProjectiles([]);
      this.roundNumber++;
      this.setPhase('blue-planning');
    }
  };

  private endBattle(winner: Team): void {
    this.running = false;
    this.renderer.ticker.remove(this.tick, this);
    this.pathDrawer?.disable();
    this.pathDrawer?.clearGraphics();
    this.renderer.effects?.clear();

    const blueAlive = this.units.filter(u => u.alive && u.team === 'blue').length;
    const redAlive = this.units.filter(u => u.alive && u.team === 'red').length;
    const armySize = ARMY_COMPOSITION.reduce((sum, c) => sum + c.count, 0);

    this.onEvent('end', {
      winner,
      blueAlive,
      redAlive,
      blueKilled: armySize - redAlive,
      redKilled: armySize - blueAlive,
      duration: this.elapsedTime,
    });
  }

  setSpeed(multiplier: number): void {
    this.speedMultiplier = multiplier;
  }

  getAliveCount(): { blue: number; red: number } {
    return {
      blue: this.units.filter(u => u.alive && u.team === 'blue').length,
      red: this.units.filter(u => u.alive && u.team === 'red').length,
    };
  }

  stop(): void {
    this.running = false;
    this.renderer.ticker.remove(this.tick, this);
    this.pathDrawer?.destroy();
    this.pathDrawer = null;
    this.renderer.effects?.clear();
  }
}
