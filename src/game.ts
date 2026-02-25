import { Unit, Obstacle, Team, BattleResult, Projectile, AiResponse, AiUnitOrder } from './types';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';
import { AI_POLL_INTERVAL_MS, ARMY_COMPOSITION } from './constants';
import { createArmy, moveUnit, separateUnits, findTarget, isInRange, tryFireProjectile, updateProjectiles } from './units';
// import { generateObstacles } from './battlefield'; // obstacles disabled
import { AiCommander } from './ai-commander';
import { Renderer } from './renderer';

function describeDirection(x: number, y: number): string {
  const horizontal = x < MAP_WIDTH * 0.33 ? 'left' : x > MAP_WIDTH * 0.66 ? 'right' : 'center';
  const vertical = y < MAP_HEIGHT * 0.33 ? 'top' : y > MAP_HEIGHT * 0.66 ? 'bottom' : 'mid';
  if (vertical === 'mid') return `→ ${horizontal}`;
  if (horizontal === 'center') return `→ ${vertical}`;
  return `→ ${vertical}-${horizontal}`;
}

export interface AiStatus {
  blue: string;
  red: string;
}

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
  private aiPolling = false;
  private _aiStatus: AiStatus = { blue: 'Waiting...', red: 'Waiting...' };

  constructor(renderer: Renderer, onEvent: GameEventCallback) {
    this.renderer = renderer;
    this.onEvent = onEvent;
  }

  async startBattle(bluePrompt: string, redPrompt: string, obstacles?: Obstacle[]): Promise<{ blueAi: boolean; redAi: boolean }> {
    this.units = [...createArmy('blue'), ...createArmy('red')];
    this.obstacles = []; // obstacles disabled (was: obstacles ?? generateObstacles())
    this.projectiles = [];
    this.elapsedTime = 0;
    this.lastAiPoll = -AI_POLL_INTERVAL_MS; // trigger immediate first poll
    this.running = true;
    this.aiReady = false;

    // this.renderer.renderObstacles(this.obstacles); // obstacles disabled

    // Init AI commanders
    this.blueCommander = new AiCommander('blue', bluePrompt);
    this.redCommander = new AiCommander('red', redPrompt);

    const [blueOk, redOk] = await Promise.all([
      this.blueCommander.init(),
      this.redCommander.init(),
    ]);

    if (!blueOk || !redOk) {
      this.running = false;
      return { blueAi: blueOk, redAi: redOk };
    }

    this.aiReady = true;

    // Start game loop
    this.renderer.ticker.add(this.tick, this);

    return { blueAi: blueOk, redAi: redOk };
  }

  private tick = (ticker: { deltaMS: number }): void => {
    if (!this.running) return;

    const rawDt = ticker.deltaMS / 1000;
    const dt = rawDt * this.speedMultiplier;
    this.elapsedTime += dt;

    // AI polling (skip if previous poll still in progress)
    if (this.aiReady && !this.aiPolling && (this.elapsedTime - this.lastAiPoll) * 1000 >= AI_POLL_INTERVAL_MS) {
      this.lastAiPoll = this.elapsedTime;
      this.aiPolling = true;
      this.pollAi().finally(() => { this.aiPolling = false; });
    }

    // Movement
    for (const unit of this.units) {
      if (!unit.alive) continue;
      moveUnit(unit, dt, []); // obstacles disabled
    }
    separateUnits(this.units);

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

    this._aiStatus = { blue: 'Thinking...', red: 'Thinking...' };

    const [blueOrders, redOrders] = await Promise.all([
      this.blueCommander.getOrders(this.units, this.obstacles),
      this.redCommander.getOrders(this.units, this.obstacles),
    ]);

    // Apply orders and summarize
    this._aiStatus.blue = this.applyAndSummarize(blueOrders, 'blue');
    this._aiStatus.red = this.applyAndSummarize(redOrders, 'red');
  }

  private applyAndSummarize(response: AiResponse, team: Team): string {
    const attacking: string[] = [];
    const moving: string[] = [];

    for (const order of response.orders) {
      const unit = this.units.find(u => u.id === order.id && u.alive);
      if (!unit) continue;

      unit.moveTarget = { x: order.move_to[0], y: order.move_to[1] };
      unit.attackTargetId = order.attack;

      if (order.attack) {
        attacking.push(order.id);
      } else {
        moving.push(order.id);
      }
    }

    const parts: string[] = [];
    if (attacking.length > 0) parts.push(`${attacking.length} attacking`);
    if (moving.length > 0) parts.push(`${moving.length} moving`);

    // Summarize general direction
    const targets = response.orders
      .filter(o => this.units.find(u => u.id === o.id && u.alive))
      .map(o => o.move_to);
    if (targets.length > 0) {
      const avgX = targets.reduce((s, t) => s + t[0], 0) / targets.length;
      const avgY = targets.reduce((s, t) => s + t[1], 0) / targets.length;
      const dir = describeDirection(avgX, avgY);
      parts.push(dir);
    }

    return parts.join(', ') || 'No orders';
  }

  private endBattle(winner: Team): void {
    this.running = false;
    this.renderer.ticker.remove(this.tick, this);

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

    this.blueCommander?.destroy();
    this.redCommander?.destroy();
  }

  setSpeed(multiplier: number): void {
    this.speedMultiplier = multiplier;
  }

  get aiStatus(): AiStatus {
    return this._aiStatus;
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
