import { Unit, Obstacle, Team, BattleResult, Projectile } from './types';
import { AI_POLL_INTERVAL_MS } from './constants';
import { createArmy, moveUnit, findTarget, isInRange, tryFireProjectile, updateProjectiles } from './units';
import { generateObstacles } from './battlefield';
import { AiCommander } from './ai-commander';
import { Renderer } from './renderer';

export type GameEventCallback = (event: 'update' | 'end', data?: BattleResult) => void;

export class GameEngine {
  private units: Unit[] = [];
  private obstacles: Obstacle[] = [];
  private projectiles: Projectile[] = [];
  private blueCommander: AiCommander | null = null;
  private redCommander: AiCommander | null = null;
  private renderer: Renderer;
  private running = false;
  private speedMultiplier = 1;
  private elapsedTime = 0;
  private lastAiPoll = 0;
  private onEvent: GameEventCallback;
  private aiReady = false;

  constructor(renderer: Renderer, onEvent: GameEventCallback) {
    this.renderer = renderer;
    this.onEvent = onEvent;
  }

  async startBattle(bluePrompt: string, redPrompt: string): Promise<void> {
    this.units = [...createArmy('blue'), ...createArmy('red')];
    this.obstacles = generateObstacles();
    this.projectiles = [];
    this.elapsedTime = 0;
    this.lastAiPoll = -AI_POLL_INTERVAL_MS; // trigger immediate first poll
    this.running = true;
    this.aiReady = false;

    this.renderer.renderObstacles(this.obstacles);

    // Init AI commanders
    this.blueCommander = new AiCommander('blue', bluePrompt);
    this.redCommander = new AiCommander('red', redPrompt);

    const [blueOk, redOk] = await Promise.all([
      this.blueCommander.init(),
      this.redCommander.init(),
    ]);

    if (!blueOk) console.warn('Blue AI using fallback');
    if (!redOk) console.warn('Red AI using fallback');
    this.aiReady = true;

    // Start game loop
    this.renderer.ticker.add(this.tick, this);
  }

  private tick = (ticker: { deltaMS: number }): void => {
    if (!this.running) return;

    const rawDt = ticker.deltaMS / 1000;
    const dt = rawDt * this.speedMultiplier;
    this.elapsedTime += dt;

    // AI polling
    if (this.aiReady && (this.elapsedTime - this.lastAiPoll) * 1000 >= AI_POLL_INTERVAL_MS) {
      this.lastAiPoll = this.elapsedTime;
      this.pollAi();
    }

    // Movement
    for (const unit of this.units) {
      if (!unit.alive) continue;
      moveUnit(unit, dt, this.obstacles);
    }

    // Combat — fire projectiles
    for (const unit of this.units) {
      if (!unit.alive) continue;

      const target = findTarget(unit, this.units, unit.attackTargetId);
      if (target && isInRange(unit, target)) {
        const projectile = tryFireProjectile(unit, target, dt);
        if (projectile) {
          this.projectiles.push(projectile);
        }
      } else {
        // Tick cooldown even when not firing so it's ready when in range
        unit.fireTimer = Math.max(0, unit.fireTimer - dt);
      }
    }

    // Update projectiles (move, hit detection, cleanup)
    this.projectiles = updateProjectiles(this.projectiles, this.units, dt);

    // Render
    this.renderer.renderUnits(this.units);
    this.renderer.renderProjectiles(this.projectiles);

    // HUD update
    this.onEvent('update');

    // Win condition
    const blueAlive = this.units.filter(u => u.alive && u.team === 'blue').length;
    const redAlive = this.units.filter(u => u.alive && u.team === 'red').length;

    if (blueAlive === 0 || redAlive === 0) {
      this.endBattle(blueAlive === 0 ? 'red' : 'blue');
    }
  };

  private async pollAi(): Promise<void> {
    if (!this.blueCommander || !this.redCommander) return;

    const [blueOrders, redOrders] = await Promise.all([
      this.blueCommander.getOrders(this.units, this.obstacles),
      this.redCommander.getOrders(this.units, this.obstacles),
    ]);

    // Apply orders
    for (const order of blueOrders.orders) {
      const unit = this.units.find(u => u.id === order.id && u.alive);
      if (unit) {
        unit.moveTarget = { x: order.move_to[0], y: order.move_to[1] };
        unit.attackTargetId = order.attack;
      }
    }

    for (const order of redOrders.orders) {
      const unit = this.units.find(u => u.id === order.id && u.alive);
      if (unit) {
        unit.moveTarget = { x: order.move_to[0], y: order.move_to[1] };
        unit.attackTargetId = order.attack;
      }
    }
  }

  private endBattle(winner: Team): void {
    this.running = false;
    this.renderer.ticker.remove(this.tick, this);

    const blueAlive = this.units.filter(u => u.alive && u.team === 'blue').length;
    const redAlive = this.units.filter(u => u.alive && u.team === 'red').length;

    this.onEvent('end', {
      winner,
      blueAlive,
      redAlive,
      blueKilled: 10 - redAlive,
      redKilled: 10 - blueAlive,
      duration: this.elapsedTime,
    });

    this.blueCommander?.destroy();
    this.redCommander?.destroy();
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
    this.blueCommander?.destroy();
    this.redCommander?.destroy();
  }
}
