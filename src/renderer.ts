import { Application, Graphics, Container, Text } from 'pixi.js';
import { Unit, Obstacle, Projectile, ElevationZone } from './types';
import { MAP_WIDTH, MAP_HEIGHT, setMapSize, ZONE_DEPTH_RATIO } from './constants';
import { createEffectsManager, EffectsManager } from './effects';

export class Renderer {
  private app: Application;
  private unitGraphics: Map<string, Container> = new Map();
  private dyingUnits: Map<string, { container: Container; age: number }> = new Map();
  private elevationGraphics: Container | null = null;
  private obstacleGraphics: Graphics | null = null;
  private bgGraphics: Graphics | null = null;
  private projectileGraphics: Graphics | null = null;
  private _effects: EffectsManager | null = null;
  private zoneStatusGfx: Graphics | null = null;
  bloodEnabled = true;

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

  renderElevationZones(zones: ElevationZone[]): void {
    if (this.elevationGraphics) {
      this.app.stage.removeChild(this.elevationGraphics);
      this.elevationGraphics.destroy({ children: true });
    }
    const container = new Container();
    const gfx = new Graphics();

    for (const z of zones) {
      // Outer layer — blends with background
      gfx.roundRect(z.x, z.y, z.w, z.h, 6);
      gfx.fill({ color: 0x2e2e48, alpha: 0.5 });

      // Middle layer
      const m = 8;
      gfx.roundRect(z.x + m, z.y + m, z.w - m * 2, z.h - m * 2, 4);
      gfx.fill({ color: 0x333358, alpha: 0.35 });

      // Inner layer — lightest
      const m2 = 16;
      gfx.roundRect(z.x + m2, z.y + m2, z.w - m2 * 2, z.h - m2 * 2, 2);
      gfx.fill({ color: 0x3a3a68, alpha: 0.25 });


      // Label
      const label = new Text({
        text: '+20% Range',
        style: {
          fontSize: 10,
          fontFamily: 'monospace',
          fill: '#66ff88',
        },
      });
      label.alpha = 0.5;
      label.anchor.set(0.5, 0);
      label.x = z.x + z.w / 2;
      label.y = z.y + 4;
      container.addChild(label);
    }

    container.addChild(gfx);
    container.setChildIndex(gfx, 0);

    this.elevationGraphics = container;
    this.app.stage.addChildAt(this.elevationGraphics, 2);
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
    // Index 3: right after elevation (2)
    this.app.stage.addChildAt(this.obstacleGraphics, 3);
  }

  renderUnits(units: Unit[], dt = 0): void {
    const activeIds = new Set<string>();

    for (const unit of units) {
      if (!unit.alive) {
        const existing = this.unitGraphics.get(unit.id);
        if (existing) {
          if (!this.bloodEnabled) {
            this._effects?.addDeathEffect(
              { x: unit.pos.x, y: unit.pos.y },
              unit.radius,
              unit.team,
            );
          }
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

      // Rotate gun barrel
      (container.getChildAt(1) as Graphics).rotation = unit.gunAngle;
      // Rotate body with the gun for person-shaped units
      if (unit.type === 'scout' || unit.type === 'soldier' || unit.type === 'sniper') {
        (container.getChildAt(0) as Graphics).rotation = unit.gunAngle + Math.PI / 2;
      }

      // Idle breathing pulse when stationary
      const speed = Math.sqrt(unit.vel.x * unit.vel.x + unit.vel.y * unit.vel.y);
      if (speed < 1) {
        const breath = 1 + 0.015 * Math.sin(Date.now() / 400 + unit.pos.x);
        (container.getChildAt(0) as Graphics).scale.set(breath);
      } else {
        (container.getChildAt(0) as Graphics).scale.set(1);
      }

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
      // Scout / Soldier: oval (wider shoulders, person from above)
      shape.ellipse(0, 0, unit.radius, unit.radius * 0.7);
      shape.fill(color);
    }

    // Gun barrel — elongated shape pointing in +X direction
    const nose = new Graphics();
    if (unit.type === 'sniper') {
      // Sniper: thin straight barrel
      const nr = unit.radius * 1.4;
      nose.rect(unit.radius - 1, -1.5, nr + 1, 3);
      nose.fill({ color: 0xffffff, alpha: 0.6 });
    } else {
      const nr = unit.radius * 0.6;
      nose.poly([unit.radius + nr, 0, unit.radius - 1, -nr * 0.35, unit.radius - 1, nr * 0.35]);
      nose.fill({ color: 0xffffff, alpha: 0.6 });
    }

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

  renderZoneStatus(blueHolds: boolean, redHolds: boolean): void {
    if (!this.zoneStatusGfx) {
      this.zoneStatusGfx = new Graphics();
      this.app.stage.addChild(this.zoneStatusGfx);
    }
    this.zoneStatusGfx.clear();

    if (!blueHolds && !redHolds) return;

    const zoneHeight = MAP_HEIGHT * ZONE_DEPTH_RATIO;
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 400);

    if (blueHolds) {
      // Blue is holding the red zone (top) — brighten it
      this.zoneStatusGfx.rect(0, 0, MAP_WIDTH, zoneHeight);
      this.zoneStatusGfx.fill({ color: 0x4a9eff, alpha: 0.08 + 0.07 * pulse });
      this.zoneStatusGfx.rect(0, 0, MAP_WIDTH, zoneHeight);
      this.zoneStatusGfx.setStrokeStyle({ width: 2, color: 0x4a9eff, alpha: 0.4 + 0.3 * pulse });
      this.zoneStatusGfx.stroke();
    }

    if (redHolds) {
      // Red is holding the blue zone (bottom) — brighten it
      const y = MAP_HEIGHT - zoneHeight;
      this.zoneStatusGfx.rect(0, y, MAP_WIDTH, zoneHeight);
      this.zoneStatusGfx.fill({ color: 0xff4a4a, alpha: 0.08 + 0.07 * pulse });
      this.zoneStatusGfx.rect(0, y, MAP_WIDTH, zoneHeight);
      this.zoneStatusGfx.setStrokeStyle({ width: 2, color: 0xff4a4a, alpha: 0.4 + 0.3 * pulse });
      this.zoneStatusGfx.stroke();
    }
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
