import { Application, Graphics, Container } from 'pixi.js';
import { Unit, Obstacle, Projectile } from './types';
import { MAP_WIDTH, MAP_HEIGHT, setMapSize } from './constants';
import { createEffectsManager, EffectsManager } from './effects';

export class Renderer {
  private app: Application;
  private unitGraphics: Map<string, Container> = new Map();
  private dyingUnits: Map<string, { container: Container; age: number }> = new Map();
  private obstacleGraphics: Graphics | null = null;
  private bgGraphics: Graphics | null = null;
  private projectileGraphics: Graphics | null = null;
  private _effects: EffectsManager | null = null;

  constructor() {
    this.app = new Application();
  }

  async init(container: HTMLElement): Promise<void> {
    const w = container.clientWidth || window.innerWidth;
    const h = container.clientHeight || window.innerHeight;
    setMapSize(w, h);

    await this.app.init({
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      backgroundColor: 0x1a1a2e,
      antialias: true,
    });
    container.appendChild(this.app.canvas);
    this.drawBackground();
    this.drawSpawnZones();
    this._effects = createEffectsManager(this.app.stage);
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

  private drawSpawnZones(): void {
    const zones = new Graphics();
    const zoneHeight = MAP_HEIGHT * 0.15;

    // Red spawn zone (top)
    zones.rect(0, 0, MAP_WIDTH, zoneHeight);
    zones.fill({ color: 0xff4a4a, alpha: 0.05 });

    // Blue spawn zone (bottom)
    zones.rect(0, MAP_HEIGHT - zoneHeight, MAP_WIDTH, zoneHeight);
    zones.fill({ color: 0x4a9eff, alpha: 0.05 });

    this.app.stage.addChild(zones);
  }

  renderObstacles(obstacles: Obstacle[]): void {
    if (this.obstacleGraphics) {
      this.app.stage.removeChild(this.obstacleGraphics);
    }
    this.obstacleGraphics = new Graphics();
    for (const obs of obstacles) {
      this.obstacleGraphics.roundRect(obs.x, obs.y, obs.w, obs.h, 4);
      this.obstacleGraphics.fill({ color: 0x3a3a5a });
      this.obstacleGraphics.setStrokeStyle({ width: 1, color: 0x555577 });
      this.obstacleGraphics.stroke();
      // Inner highlight for depth
      this.obstacleGraphics.roundRect(obs.x + 2, obs.y + 2, obs.w - 4, obs.h - 4, 2);
      this.obstacleGraphics.setStrokeStyle({ width: 1, color: 0x666688, alpha: 0.3 });
      this.obstacleGraphics.stroke();
    }
    this.app.stage.addChild(this.obstacleGraphics);
  }

  renderUnits(units: Unit[], dt = 0): void {
    const activeIds = new Set<string>();

    for (const unit of units) {
      if (!unit.alive) {
        const existing = this.unitGraphics.get(unit.id);
        if (existing) {
          this._effects?.addDeathEffect(
            { x: unit.pos.x, y: unit.pos.y },
            unit.radius,
            unit.team,
          );
          // Move to dying pool instead of removing immediately
          this.unitGraphics.delete(unit.id);
          this.dyingUnits.set(unit.id, { container: existing, age: 0 });
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

      // Rotate only the nose (gun direction indicator), not the whole container
      (container.getChildAt(1) as Graphics).rotation = unit.gunAngle;

      // Update health bar — only show when damaged (child index 2: shape, nose, hpBar)
      const hpBar = container.getChildAt(2) as Graphics;
      if (unit.hp < unit.maxHp) {
        this.updateHealthBar(hpBar, unit);
      } else {
        hpBar.clear();
      }
    }

    // Update dying units — fade out over 0.3s
    const DEATH_DURATION = 0.3;
    for (const [id, dying] of this.dyingUnits) {
      dying.age += dt;
      const t = Math.min(dying.age / DEATH_DURATION, 1);
      dying.container.alpha = 1 - t;
      dying.container.scale.set(1 - 0.5 * t);
      if (t >= 1) {
        this.app.stage.removeChild(dying.container);
        this.dyingUnits.delete(id);
      }
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

    if (unit.type === 'sniper') {
      // Diamond: 4-point rotated square
      const r = unit.radius;
      shape.poly([-r, 0, 0, -r, r, 0, 0, r]);
      shape.fill(color);
    } else if (unit.type === 'tank') {
      // Tank: hexagon
      const r = unit.radius;
      const points: number[] = [];
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 6;
        points.push(r * Math.cos(angle), r * Math.sin(angle));
      }
      shape.poly(points);
      shape.fill(color);
    } else {
      // Scout / Soldier: circle
      shape.circle(0, 0, unit.radius);
      shape.fill(color);
    }

    // Directional nose — small triangle pointing in +X direction
    const nose = new Graphics();
    const nr = unit.radius * 0.4;
    nose.poly([unit.radius + nr, 0, unit.radius - 1, -nr * 0.6, unit.radius - 1, nr * 0.6]);
    nose.fill({ color: 0xffffff, alpha: 0.6 });

    container.addChild(shape);
    container.addChild(nose);

    // Health bar (positioned above unit) — child index 2
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

  renderProjectiles(projectiles: Projectile[]): void {
    if (this.projectileGraphics) {
      this.app.stage.removeChild(this.projectileGraphics);
    }
    this.projectileGraphics = new Graphics();

    for (const p of projectiles) {
      const color = p.team === 'blue' ? 0x88ccff : 0xff8888;

      // Draw trail
      if (p.trail && p.trail.length > 1) {
        for (let i = 1; i < p.trail.length; i++) {
          const alpha = (i / p.trail.length) * 0.4;
          this.projectileGraphics!.setStrokeStyle({ width: p.radius, color, alpha });
          this.projectileGraphics!.moveTo(p.trail[i - 1].x, p.trail[i - 1].y);
          this.projectileGraphics!.lineTo(p.trail[i].x, p.trail[i].y);
          this.projectileGraphics!.stroke();
        }
      }

      this.projectileGraphics.circle(p.pos.x, p.pos.y, p.radius);
      this.projectileGraphics.fill(color);
    }

    this.app.stage.addChild(this.projectileGraphics);
  }

  getUnitContainer(id: string): Container | undefined {
    return this.unitGraphics.get(id);
  }

  get effects(): EffectsManager | null {
    return this._effects;
  }

  get canvas(): HTMLCanvasElement {
    return this.app.canvas;
  }

  get stage() {
    return this.app.stage;
  }

  get ticker() {
    return this.app.ticker;
  }

  destroy(): void {
    this.unitGraphics.clear();
    this.app.destroy(true);
  }
}
