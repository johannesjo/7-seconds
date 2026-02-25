import { Unit, Obstacle, Team, BattleResult, Projectile, TurnPhase } from './types';
import { ARMY_COMPOSITION, ROUND_DURATION_S, COVER_SCREEN_DURATION_MS } from './constants';
import { createArmy, moveUnit, separateUnits, findTarget, isInRange, tryFireProjectile, updateProjectiles, advanceWaypoint } from './units';
import { generateObstacles } from './battlefield';
import { PathDrawer } from './path-drawer';
import { Renderer } from './renderer';

export type GameEventCallback = (
  event: 'update' | 'end' | 'phase-change',
  data?: BattleResult | { phase: TurnPhase; timeLeft?: number },
) => void;

export class GameEngine {
  private units: Unit[] = [];
  private obstacles: Obstacle[] = [];
  private projectiles: Projectile[] = [];
  private renderer: Renderer;
  private running = false;
  private speedMultiplier = 1;
  private elapsedTime = 0;
  private roundTimer = 0;
  private onEvent: GameEventCallback;
  private pathDrawer: PathDrawer | null = null;
  private _phase: TurnPhase = 'blue-planning';

  constructor(renderer: Renderer, onEvent: GameEventCallback) {
    this.renderer = renderer;
    this.onEvent = onEvent;
  }

  get phase(): TurnPhase {
    return this._phase;
  }

  startBattle(): void {
    this.units = [...createArmy('blue'), ...createArmy('red')];
    this.obstacles = generateObstacles();
    this.projectiles = [];
    this.elapsedTime = 0;
    this.roundTimer = 0;
    this.running = true;

    this.pathDrawer = new PathDrawer(this.renderer.stage);

    // Render initial state
    this.renderer.renderObstacles(this.obstacles);
    this.renderer.renderUnits(this.units);

    // Start ticker for rendering during planning
    this.renderer.ticker.add(this.tick, this);

    this.setPhase('blue-planning');
  }

  /** Called by the UI "Done" button to end the current planning phase. */
  confirmPlan(): void {
    if (this._phase === 'blue-planning') {
      this.setPhase('cover');
      setTimeout(() => {
        this.setPhase('red-planning');
      }, COVER_SCREEN_DURATION_MS);
    } else if (this._phase === 'red-planning') {
      this.setPhase('playing');
    }
  }

  private setPhase(phase: TurnPhase): void {
    this._phase = phase;

    if (phase === 'blue-planning') {
      this.pathDrawer?.clearPaths('blue');
      this.pathDrawer?.enable('blue', this.units);
    } else if (phase === 'cover') {
      this.pathDrawer?.disable();
    } else if (phase === 'red-planning') {
      this.pathDrawer?.clearPaths('red');
      this.pathDrawer?.enable('red', this.units);
    } else if (phase === 'playing') {
      this.pathDrawer?.disable();
      this.pathDrawer?.clearGraphics();
      this.roundTimer = ROUND_DURATION_S;
    }

    this.onEvent('phase-change', { phase });
  }

  private tick = (ticker: { deltaMS: number }): void => {
    if (!this.running) return;

    // Always render units (even during planning)
    this.renderer.renderUnits(this.units);

    if (this._phase !== 'playing') return;

    const rawDt = ticker.deltaMS / 1000;
    const dt = rawDt * this.speedMultiplier;
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
      if (target && isInRange(unit, target)) {
        const projectile = tryFireProjectile(unit, target, dt);
        if (projectile) {
          this.projectiles.push(projectile);
        }
      } else {
        unit.fireTimer = Math.max(0, unit.fireTimer - dt);
      }
    }

    this.projectiles = updateProjectiles(this.projectiles, this.units, dt);
    this.renderer.renderProjectiles(this.projectiles);

    // HUD update with time left
    this.onEvent('update', { phase: 'playing', timeLeft: Math.max(0, this.roundTimer) });

    // Win condition
    const blueAlive = this.units.filter(u => u.alive && u.team === 'blue').length;
    const redAlive = this.units.filter(u => u.alive && u.team === 'red').length;

    if (blueAlive === 0 || redAlive === 0) {
      this.endBattle(blueAlive === 0 ? 'red' : 'blue');
      return;
    }

    // Round over → back to planning
    if (this.roundTimer <= 0) {
      this.projectiles = [];
      this.renderer.renderProjectiles([]);
      this.setPhase('blue-planning');
    }
  };

  private endBattle(winner: Team): void {
    this.running = false;
    this.renderer.ticker.remove(this.tick, this);
    this.pathDrawer?.disable();
    this.pathDrawer?.clearGraphics();

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
  }
}
