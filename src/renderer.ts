import { Application, Graphics, Container } from 'pixi.js';
import { Unit, Obstacle } from './types';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';

export class Renderer {
  private app: Application;
  private unitGraphics: Map<string, Container> = new Map();
  private obstacleGraphics: Graphics | null = null;
  private bgGraphics: Graphics | null = null;

  constructor() {
    this.app = new Application();
  }

  async init(container: HTMLElement): Promise<void> {
    await this.app.init({
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      backgroundColor: 0x1a1a2e,
      antialias: true,
    });
    container.appendChild(this.app.canvas);
    this.drawBackground();
  }

  private drawBackground(): void {
    this.bgGraphics = new Graphics();
    this.bgGraphics.setStrokeStyle({ width: 1, color: 0x222244, alpha: 0.3 });
    for (let x = 0; x <= MAP_WIDTH; x += 100) {
      this.bgGraphics.moveTo(x, 0);
      this.bgGraphics.lineTo(x, MAP_HEIGHT);
      this.bgGraphics.stroke();
    }
    for (let y = 0; y <= MAP_HEIGHT; y += 100) {
      this.bgGraphics.moveTo(0, y);
      this.bgGraphics.lineTo(MAP_WIDTH, y);
      this.bgGraphics.stroke();
    }
    this.app.stage.addChild(this.bgGraphics);
  }

  renderObstacles(obstacles: Obstacle[]): void {
    if (this.obstacleGraphics) {
      this.app.stage.removeChild(this.obstacleGraphics);
    }
    this.obstacleGraphics = new Graphics();
    for (const obs of obstacles) {
      this.obstacleGraphics.rect(obs.x, obs.y, obs.w, obs.h);
      this.obstacleGraphics.fill({ color: 0x3a3a5a });
      this.obstacleGraphics.setStrokeStyle({ width: 1, color: 0x555577 });
      this.obstacleGraphics.stroke();
    }
    this.app.stage.addChild(this.obstacleGraphics);
  }

  renderUnits(units: Unit[]): void {
    const activeIds = new Set<string>();

    for (const unit of units) {
      if (!unit.alive) {
        const existing = this.unitGraphics.get(unit.id);
        if (existing) {
          this.app.stage.removeChild(existing);
          this.unitGraphics.delete(unit.id);
        }
        continue;
      }

      activeIds.add(unit.id);
      let container = this.unitGraphics.get(unit.id);

      if (!container) {
        container = this.createUnitGraphic(unit);
        this.unitGraphics.set(unit.id, container);
        this.app.stage.addChild(container);
      }

      container.x = unit.pos.x;
      container.y = unit.pos.y;

      // Update health bar
      const hpBar = container.getChildAt(1) as Graphics;
      this.updateHealthBar(hpBar, unit);
    }

    // Remove graphics for units no longer present
    for (const [id, container] of this.unitGraphics) {
      if (!activeIds.has(id)) {
        this.app.stage.removeChild(container);
        this.unitGraphics.delete(id);
      }
    }
  }

  private createUnitGraphic(unit: Unit): Container {
    const container = new Container();
    const shape = new Graphics();
    const color = unit.team === 'blue' ? 0x4a9eff : 0xff4a4a;

    if (unit.type === 'scout') {
      shape.circle(0, 0, unit.radius);
      shape.fill(color);
    } else if (unit.type === 'soldier') {
      const r = unit.radius;
      shape.rect(-r, -r, r * 2, r * 2);
      shape.fill(color);
    } else {
      // Tank: hexagon
      const r = unit.radius;
      const points: number[] = [];
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 6;
        points.push(r * Math.cos(angle), r * Math.sin(angle));
      }
      shape.poly(points);
      shape.fill(color);
    }

    container.addChild(shape);

    // Health bar (positioned above unit)
    const hpBar = new Graphics();
    this.updateHealthBar(hpBar, unit);
    container.addChild(hpBar);

    return container;
  }

  private updateHealthBar(bar: Graphics, unit: Unit): void {
    bar.clear();
    const w = unit.radius * 2.5;
    const h = 3;
    const yOff = -(unit.radius + 6);

    // Background
    bar.rect(-w / 2, yOff, w, h);
    bar.fill(0x333333);

    // HP fill
    const hpRatio = unit.hp / unit.maxHp;
    const hpColor = hpRatio > 0.5 ? 0x44ff44 : hpRatio > 0.25 ? 0xffaa00 : 0xff4444;
    bar.rect(-w / 2, yOff, w * hpRatio, h);
    bar.fill(hpColor);
  }

  get ticker() {
    return this.app.ticker;
  }

  destroy(): void {
    this.unitGraphics.clear();
    this.app.destroy(true);
  }
}
