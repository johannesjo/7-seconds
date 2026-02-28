import { Application, Graphics, Container, Text, Texture, TilingSprite } from 'pixi.js';
import { Unit, Obstacle, Projectile, ElevationZone, Vec2 } from './types';
import { MAP_WIDTH, MAP_HEIGHT, setMapSize } from './constants';
import { createEffectsManager, EffectsManager } from './effects';
import { Theme, NIGHT_THEME } from './theme';

export class Renderer {
  private app: Application;
  private unitGraphics: Map<string, Container> = new Map();
  private dyingUnits: Map<string, { container: Container; age: number }> = new Map();
  private elevationGraphics: Container | null = null;
  private obstacleGraphics: Container | null = null;
  private bgGraphics: Graphics | null = null;
  private projectileGraphics: Graphics | null = null;
  private _effects: EffectsManager | null = null;
  private zoneLabels: { rect: Obstacle; label: Text; hovered: boolean; dragActive: boolean }[] = [];
  private theme: Theme = NIGHT_THEME;
  private noiseSprite: TilingSprite | null = null;
  private lastElevationZones: ElevationZone[] = [];
  private lastObstacles: Obstacle[] = [];
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
      backgroundColor: this.theme.bg,
      antialias: true,
    });
    container.appendChild(this.app.canvas);
    this.drawBackground();
    this._effects = createEffectsManager(this.app.stage);
  }

  private drawBackground(): void {
    if (this.bgGraphics) {
      this.app.stage.removeChild(this.bgGraphics);
      this.bgGraphics.destroy();
    }
    this.bgGraphics = new Graphics();
    // Scale grid spacing to screen size so density looks like real graph paper
    const gridSpacing = Math.min(30, Math.round(Math.min(MAP_WIDTH, MAP_HEIGHT) / 24));
    this.bgGraphics.setStrokeStyle({ width: 1, color: this.theme.grid, alpha: this.theme.gridAlpha });
    for (let x = 0; x <= MAP_WIDTH; x += gridSpacing) {
      this.bgGraphics.moveTo(x, 0);
      this.bgGraphics.lineTo(x, MAP_HEIGHT);
      this.bgGraphics.stroke();
    }
    for (let y = 0; y <= MAP_HEIGHT; y += gridSpacing) {
      this.bgGraphics.moveTo(0, y);
      this.bgGraphics.lineTo(MAP_WIDTH, y);
      this.bgGraphics.stroke();
    }
    this.app.stage.addChildAt(this.bgGraphics, 0);

    // Paper noise overlay
    if (this.noiseSprite) {
      this.app.stage.removeChild(this.noiseSprite);
      this.noiseSprite.destroy();
      this.noiseSprite = null;
    }
    if (this.theme.paperNoise) {
      const size = 128;
      const noiseCanvas = document.createElement('canvas');
      noiseCanvas.width = size;
      noiseCanvas.height = size;
      const ctx = noiseCanvas.getContext('2d')!;
      const imageData = ctx.createImageData(size, size);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        if (Math.random() < 0.4) {
          data[i] = 160;     // R
          data[i + 1] = 140; // G
          data[i + 2] = 100; // B
          data[i + 3] = Math.floor(5 + Math.random() * 10); // alpha 0.02–0.06
        }
      }
      ctx.putImageData(imageData, 0, 0);
      const texture = Texture.from(noiseCanvas);
      this.noiseSprite = new TilingSprite({ texture, width: MAP_WIDTH, height: MAP_HEIGHT });
      this.app.stage.addChildAt(this.noiseSprite, 1);
    }
  }

  renderElevationZones(zones: ElevationZone[]): void {
    this.lastElevationZones = zones;
    this.zoneLabels = [];
    if (this.elevationGraphics) {
      this.app.stage.removeChild(this.elevationGraphics);
      this.elevationGraphics.destroy({ children: true });
    }
    const container = new Container();
    const gfx = new Graphics();

    const eA = this.theme.elevationAlpha;
    for (const z of zones) {
      gfx.roundRect(z.x, z.y, z.w, z.h, 6);
      gfx.fill({ color: this.theme.elevationOuter, alpha: 0.5 * eA });

      const m = 8;
      gfx.roundRect(z.x + m, z.y + m, z.w - m * 2, z.h - m * 2, 4);
      gfx.fill({ color: this.theme.elevationMid, alpha: 0.35 * eA });

      const m2 = 16;
      gfx.roundRect(z.x + m2, z.y + m2, z.w - m2 * 2, z.h - m2 * 2, 2);
      gfx.fill({ color: this.theme.elevationInner, alpha: 0.25 * eA });

      const hitArea = new Graphics();
      hitArea.roundRect(z.x, z.y, z.w, z.h, 6);
      hitArea.fill({ color: 0x000000, alpha: 0.001 });
      hitArea.eventMode = 'static';
      hitArea.cursor = 'default';

      const label = new Text({
        text: '+20% Range',
        style: {
          fontSize: 14,
          fontFamily: 'monospace',
          fill: this.theme.elevationLabel,
          fontWeight: 'bold',
        },
      });
      label.alpha = 0;
      label.anchor.set(0.5, 0.5);
      label.x = z.x + z.w / 2;
      label.y = z.y + z.h / 2;

      const entry = { rect: z, label, hovered: false, dragActive: false };
      this.zoneLabels.push(entry);

      hitArea.on('pointerenter', () => { entry.hovered = true; label.alpha = 0.7; });
      hitArea.on('pointerleave', () => { entry.hovered = false; label.alpha = entry.dragActive ? 0.7 : 0; });

      container.addChild(label);
      container.addChild(hitArea);
    }

    container.addChild(gfx);
    container.setChildIndex(gfx, 0);

    this.elevationGraphics = container;
    this.app.stage.addChildAt(this.elevationGraphics, 2);
  }

  renderObstacles(obstacles: Obstacle[]): void {
    this.lastObstacles = obstacles;
    if (this.obstacleGraphics) {
      this.app.stage.removeChild(this.obstacleGraphics);
      this.obstacleGraphics.destroy({ children: true });
    }
    const wrapper = new Container();
    this.obstacleGraphics = wrapper;

    if (this.theme.sketchyObstacles) {
      this.renderSketchyObstacles(wrapper, obstacles);
    } else {
      this.renderCleanObstacles(wrapper, obstacles);
    }

    this.app.stage.addChildAt(this.obstacleGraphics, 3);
  }

  private renderCleanObstacles(wrapper: Container, obstacles: Obstacle[]): void {
    const borders = new Graphics();
    for (const obs of obstacles) {
      borders.roundRect(obs.x, obs.y, obs.w, obs.h, 4);
      borders.setStrokeStyle({ width: 2, color: this.theme.obstacleBorder });
      borders.stroke();
    }
    wrapper.addChild(borders);

    const fills = new Graphics();
    for (const obs of obstacles) {
      fills.roundRect(obs.x, obs.y, obs.w, obs.h, 4);
      fills.fill({ color: this.theme.obstacleFill });
    }
    for (const obs of obstacles) {
      fills.roundRect(obs.x + 2, obs.y + 2, obs.w - 4, obs.h - 4, 2);
      fills.setStrokeStyle({ width: 1, color: this.theme.obstacleHighlight, alpha: 0.3 });
      fills.stroke();
    }
    wrapper.addChild(fills);
  }

  private renderSketchyObstacles(wrapper: Container, obstacles: Obstacle[]): void {
    // Seeded random based on obstacle position for stable wobble
    const seededRandom = (x: number, y: number, i: number) => {
      const seed = (x * 7919 + y * 104729 + i * 31) | 0;
      return ((Math.sin(seed) * 43758.5453) % 1 + 1) % 1;
    };

    const fills = new Graphics();
    for (const obs of obstacles) {
      fills.roundRect(obs.x, obs.y, obs.w, obs.h, 4);
      fills.fill({ color: this.theme.obstacleFill });
    }
    wrapper.addChild(fills);

    // Two overlapping slightly wobbly outlines per obstacle
    const outlines = new Graphics();
    for (const obs of obstacles) {
      for (let pass = 0; pass < 2; pass++) {
        const j = (corner: number) => (seededRandom(obs.x, obs.y, pass * 4 + corner) - 0.5) * 1;

        outlines.setStrokeStyle({ width: 1.5, color: this.theme.obstacleBorder, alpha: 0.8 });
        outlines.moveTo(obs.x + j(0), obs.y + j(0));
        outlines.lineTo(obs.x + obs.w + j(1), obs.y + j(1));
        outlines.lineTo(obs.x + obs.w + j(2), obs.y + obs.h + j(2));
        outlines.lineTo(obs.x + j(3), obs.y + obs.h + j(3));
        outlines.lineTo(obs.x + j(0), obs.y + j(0));
        outlines.stroke();
      }
    }
    wrapper.addChild(outlines);
  }

  /** Show zone labels for zones containing pos; hide the rest (unless hovered). */
  highlightZonesAt(pos: Vec2 | null): void {
    for (const zl of this.zoneLabels) {
      const inside = pos !== null &&
        pos.x >= zl.rect.x && pos.x <= zl.rect.x + zl.rect.w &&
        pos.y >= zl.rect.y && pos.y <= zl.rect.y + zl.rect.h;
      zl.dragActive = inside;
      zl.label.alpha = (zl.hovered || zl.dragActive) ? 0.7 : 0;
    }
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
      if (unit.type === 'scout' || unit.type === 'soldier' || unit.type === 'sniper' || unit.type === 'zombie') {
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
    const isZombie = unit.type === 'zombie';
    const color = unit.team === 'blue'
      ? (isZombie ? this.theme.blueZombie : this.theme.blue)
      : (isZombie ? this.theme.redZombie : this.theme.red);

    if (unit.type === 'sniper') {
      const r = unit.radius;
      shape.poly([-r, 0, 0, -r, r, 0, 0, r]);
      shape.fill(color);
    } else if (unit.type === 'tank') {
      const r = unit.radius;
      const points: number[] = [];
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 6;
        points.push(r * Math.cos(angle), r * Math.sin(angle));
      }
      shape.poly(points);
      shape.fill(color);
    } else if (unit.type === 'zombie') {
      const darkColor = unit.team === 'blue' ? this.theme.blueDark : this.theme.redDark;
      shape.ellipse(0, 0, unit.radius * 1.3, unit.radius * 0.9);
      shape.fill({ color: darkColor, alpha: 0.5 });
      shape.ellipse(0, 0, unit.radius, unit.radius * 0.7);
      shape.fill(color);
    } else {
      shape.ellipse(0, 0, unit.radius, unit.radius * 0.7);
      shape.fill(color);
    }

    const nose = new Graphics();
    if (unit.type !== 'zombie') {
      if (unit.type === 'sniper') {
        const nr = unit.radius * 1.4;
        nose.rect(unit.radius - 1, -1.5, nr + 1, 3);
        nose.fill({ color: this.theme.barrel, alpha: this.theme.barrelAlpha });
      } else {
        const nr = unit.radius * 0.6;
        nose.poly([unit.radius + nr, 0, unit.radius - 1, -nr * 0.35, unit.radius - 1, nr * 0.35]);
        nose.fill({ color: this.theme.barrel, alpha: this.theme.barrelAlpha });
      }
    }

    container.addChild(shape);
    container.addChild(nose);

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

    bar.rect(-w / 2, yOff, w, h);
    bar.fill(this.theme.hpBg);

    const hpRatio = unit.hp / unit.maxHp;
    const hpColor = hpRatio > 0.5 ? this.theme.hpHigh : hpRatio > 0.25 ? this.theme.hpMid : this.theme.hpLow;
    bar.rect(-w / 2, yOff, w * hpRatio, h);
    bar.fill(hpColor);
  }

  renderProjectiles(projectiles: Projectile[]): void {
    if (this.projectileGraphics) {
      this.app.stage.removeChild(this.projectileGraphics);
    }
    this.projectileGraphics = new Graphics();

    for (const p of projectiles) {
      const color = p.team === 'blue' ? this.theme.blueProjectile : this.theme.redProjectile;

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

  get currentTheme(): Theme {
    return this.theme;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
    this.app.renderer.background.color = theme.bg;
    this.drawBackground();
    // Re-render terrain with new colors
    if (this.lastElevationZones.length > 0) this.renderElevationZones(this.lastElevationZones);
    if (this.lastObstacles.length > 0) this.renderObstacles(this.lastObstacles);
    // Rebuild unit graphics with new colors
    for (const [, container] of this.unitGraphics) {
      this.app.stage.removeChild(container);
    }
    this.unitGraphics.clear();
    // Update effects theme
    this._effects?.setTheme(theme);
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
