import { Application, Graphics, Container, Text, Texture, TilingSprite } from 'pixi.js';
import { Unit, Obstacle, Projectile, ElevationZone, Vec2, CtfState } from './types';
import { MAP_WIDTH, MAP_HEIGHT, setMapSize, CTF_BASE_ZONE_WIDTH, SHIELD_MAX_HITS } from './constants';
import { createEffectsManager, EffectsManager } from './effects';
import { mergeObstacles } from './obstacle-merge';
import { Theme, NIGHT_THEME } from './theme';

export class Renderer {
  private app: Application;
  private unitGraphics: Map<string, Container> = new Map();
  private dyingUnits: Map<string, { container: Container; age: number }> = new Map();
  private bladeSpinAngles: Map<string, number> = new Map();
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
  private flagGraphics: Container | null = null;
  private baseZoneGraphics: Graphics | null = null;


  constructor() {
    this.app = new Application();
  }

  async init(container: HTMLElement): Promise<void> {
    const containerW = container.clientWidth || window.innerWidth;
    const containerH = container.clientHeight || window.innerHeight;
    setMapSize(Math.min(containerW, 1000), Math.min(containerH, 1000));

    await this.app.init({
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      backgroundColor: this.theme.bg,
      antialias: true,
    });
    container.appendChild(this.app.canvas);
    const scale = Math.min(containerW / MAP_WIDTH, containerH / MAP_HEIGHT);
    const canvas = this.app.canvas;
    canvas.style.width = `${MAP_WIDTH * scale}px`;
    canvas.style.height = `${MAP_HEIGHT * scale}px`;
    this.drawBackground();
    this._effects = createEffectsManager(this.app.stage);
  }

  private drawBackground(): void {
    if (this.bgGraphics) {
      this.app.stage.removeChild(this.bgGraphics);
      this.bgGraphics.destroy();
    }
    this.bgGraphics = new Graphics();
    // Fill background with theme color (needed when stage is scaled for letterboxing)
    this.bgGraphics.rect(0, 0, MAP_WIDTH, MAP_HEIGHT);
    this.bgGraphics.fill(this.theme.bg);
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

  /** Draw a rectilinear polygon with rounded corners using arcTo. */
  private drawRoundedPolygon(g: Graphics, points: Vec2[], radius: number): void {
    const n = points.length;
    if (n < 3) return;

    const last = points[n - 1];
    const first = points[0];
    const mx = (last.x + first.x) / 2;
    const my = (last.y + first.y) / 2;
    g.moveTo(mx, my);

    for (let i = 0; i < n; i++) {
      const curr = points[i];
      const next = points[(i + 1) % n];
      g.arcTo(curr.x, curr.y, next.x, next.y, radius);
    }
    g.closePath();
  }

  private renderCleanObstacles(wrapper: Container, obstacles: Obstacle[]): void {
    const polygons = mergeObstacles(obstacles);

    const borders = new Graphics();
    for (const poly of polygons) {
      this.drawRoundedPolygon(borders, poly, 4);
      borders.setStrokeStyle({ width: 2, color: this.theme.obstacleBorder });
      borders.stroke();
    }
    wrapper.addChild(borders);

    const fills = new Graphics();
    for (const poly of polygons) {
      this.drawRoundedPolygon(fills, poly, 4);
      fills.fill({ color: this.theme.obstacleFill });
    }
    wrapper.addChild(fills);
  }

  private renderSketchyObstacles(wrapper: Container, obstacles: Obstacle[]): void {
    const polygons = mergeObstacles(obstacles);

    // Seeded random based on first vertex for stable wobble
    const seededRandom = (x: number, y: number, i: number) => {
      const seed = (x * 7919 + y * 104729 + i * 31) | 0;
      return ((Math.sin(seed) * 43758.5453) % 1 + 1) % 1;
    };

    // Fill using rounded polygon path
    const fills = new Graphics();
    for (const poly of polygons) {
      this.drawRoundedPolygon(fills, poly, 4);
      fills.fill({ color: this.theme.obstacleFill });
    }
    wrapper.addChild(fills);

    // Two wobbly outline passes per polygon
    const outlines = new Graphics();
    for (const poly of polygons) {
      const seed0 = poly[0];
      for (let pass = 0; pass < 2; pass++) {
        outlines.setStrokeStyle({ width: 1.5, color: this.theme.obstacleBorder, alpha: 0.8 });

        for (let i = 0; i < poly.length; i++) {
          const pt = poly[i];
          const jitter = (seededRandom(seed0.x, seed0.y, pass * poly.length + i) - 0.5) * 1;
          const wx = pt.x + jitter;
          const wy = pt.y + jitter;

          if (i === 0) outlines.moveTo(wx, wy);
          else outlines.lineTo(wx, wy);
        }

        // Close back to first vertex with jitter
        const j0 = (seededRandom(seed0.x, seed0.y, pass * poly.length) - 0.5) * 1;
        outlines.lineTo(poly[0].x + j0, poly[0].y + j0);
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

  clearCtfGraphics(): void {
    if (this.flagGraphics) {
      this.app.stage.removeChild(this.flagGraphics);
      this.flagGraphics.destroy({ children: true });
      this.flagGraphics = null;
    }
    if (this.baseZoneGraphics) {
      this.app.stage.removeChild(this.baseZoneGraphics);
      this.baseZoneGraphics.destroy();
      this.baseZoneGraphics = null;
    }
  }

  renderBaseZones(): void {
    if (this.baseZoneGraphics) {
      this.app.stage.removeChild(this.baseZoneGraphics);
      this.baseZoneGraphics.destroy();
    }
    this.baseZoneGraphics = new Graphics();
    const zoneH = CTF_BASE_ZONE_WIDTH;

    // Blue base (bottom)
    this.baseZoneGraphics.rect(0, MAP_HEIGHT - zoneH, MAP_WIDTH, zoneH);
    this.baseZoneGraphics.fill({ color: 0x4a9eff, alpha: 0.08 });
    this.baseZoneGraphics.rect(0, MAP_HEIGHT - zoneH, MAP_WIDTH, zoneH);
    this.baseZoneGraphics.stroke({ width: 2, color: 0x4a9eff, alpha: 0.2 });

    // Red base (top)
    this.baseZoneGraphics.rect(0, 0, MAP_WIDTH, zoneH);
    this.baseZoneGraphics.fill({ color: 0xff4a4a, alpha: 0.08 });
    this.baseZoneGraphics.rect(0, 0, MAP_WIDTH, zoneH);
    this.baseZoneGraphics.stroke({ width: 2, color: 0xff4a4a, alpha: 0.2 });

    this.app.stage.addChildAt(this.baseZoneGraphics, 2);
  }

  renderFlags(ctfState: CtfState): void {
    if (this.flagGraphics) {
      this.app.stage.removeChild(this.flagGraphics);
      this.flagGraphics.destroy({ children: true });
    }
    this.flagGraphics = new Container();

    for (const flag of [ctfState.blueFlag, ctfState.redFlag]) {
      const color = flag.team === 'blue' ? 0x4a9eff : 0xff4a4a;
      const g = new Graphics();

      if (flag.carrierId) {
        // Carried — draw small flag above carrier position
        g.rect(-2, -20, 2, 20);
        g.fill({ color: 0xcccccc });
        g.poly([-2, -20, 12, -15, -2, -10]);
        g.fill({ color, alpha: 0.9 });
      } else {
        // At base or dropped
        const pulse = flag.dropped ? 0.6 + 0.4 * Math.sin(Date.now() / 200) : 1;
        g.rect(-2, -24, 2, 24);
        g.fill({ color: 0xcccccc, alpha: pulse });
        g.poly([-2, -24, 16, -18, -2, -12]);
        g.fill({ color, alpha: pulse * 0.9 });
        // Small circle pedestal
        g.circle(0, 0, 4);
        g.fill({ color, alpha: 0.3 });
      }

      g.x = flag.pos.x;
      g.y = flag.pos.y;
      this.flagGraphics.addChild(g);
    }

    this.app.stage.addChild(this.flagGraphics);
  }

  renderUnits(units: Unit[], dt = 0, ctfState?: CtfState, playing = true): void {
    const activeIds = new Set<string>();

    for (const unit of units) {
      if (!unit.alive) {
        const existing = this.unitGraphics.get(unit.id);
        if (existing) {
          // Move to dying pool instead of removing immediately
          this.unitGraphics.delete(unit.id);
          this.bladeSpinAngles.delete(unit.id);
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

      // CTF carrier glow
      if (ctfState) {
        const carrying = ctfState.blueFlag.carrierId === unit.id || ctfState.redFlag.carrierId === unit.id;
        container.alpha = carrying ? 0.8 + 0.2 * Math.sin(Date.now() / 200) : 1;
      }

      // Rotate gun barrel
      (container.getChildAt(1) as Graphics).rotation = unit.gunAngle;
      // Rotate body with the gun for person-shaped units
      if (unit.type === 'soldier' || unit.type === 'sniper' || unit.type === 'zombie' || unit.type === 'shielder' || unit.type === 'bomber') {
        (container.getChildAt(0) as Graphics).rotation = unit.gunAngle + Math.PI / 2;
      }
      if (unit.type === 'blade') {
        // During play: spin rate driven by smoothed speed (0.3..5 rot/s).
        // When paused/planning: always use slow idle spin regardless of stored momentum.
        const BLADE_BASE_SPEED = 120;
        const IDLE_SPIN_RATE = Math.PI * 2 * 0.3; // ~0.3 rot/s — slow crawl
        let spinRate: number;
        if (playing) {
          const speedRatio = Math.min(1, (unit.momentum ?? 0) / BLADE_BASE_SPEED);
          spinRate = Math.PI * 2 * (0.3 + speedRatio * 4.7);
        } else {
          spinRate = IDLE_SPIN_RATE;
        }
        const prev = this.bladeSpinAngles.get(unit.id) ?? 0;
        const next = prev + spinRate * dt;
        this.bladeSpinAngles.set(unit.id, next);
        (container.getChildAt(0) as Graphics).rotation = next;
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
    } else if (unit.type === 'blade') {
      const r = unit.radius;
      const inner = r * 0.5;
      const points: number[] = [];
      for (let i = 0; i < 6; i++) {
        const outerAngle = (Math.PI / 3) * i - Math.PI / 2;
        points.push(r * Math.cos(outerAngle), r * Math.sin(outerAngle));
        const innerAngle = outerAngle + Math.PI / 6;
        points.push(inner * Math.cos(innerAngle), inner * Math.sin(innerAngle));
      }
      shape.poly(points);
      shape.fill(color);
    } else if (unit.type === 'shielder') {
      // Wider ellipse body in team color
      shape.ellipse(0, 0, unit.radius * 1.4, unit.radius * 0.9);
      shape.fill(color);
      // Golden shield arc on front (120° cone) — fades as shield takes hits
      const shieldIntegrity = 1 - (unit.shieldHits ?? 0) / SHIELD_MAX_HITS;
      const arcRadius = unit.radius * 1.6;
      if (shieldIntegrity > 0) {
        shape.arc(0, 0, arcRadius, -Math.PI / 2 - Math.PI / 3, -Math.PI / 2 + Math.PI / 3);
        shape.stroke({ width: 3, color: this.theme.shieldGold, alpha: 0.9 * shieldIntegrity });
        // Inner shield glow
        shape.arc(0, 0, arcRadius - 1.5, -Math.PI / 2 - Math.PI / 3, -Math.PI / 2 + Math.PI / 3);
        shape.stroke({ width: 1.5, color: this.theme.shieldGoldBright, alpha: 0.4 * shieldIntegrity });
      }
    } else if (unit.type === 'bomber') {
      // Pulsing circle — pulse speed increases as HP drops
      const hpRatio = unit.hp / unit.maxHp;
      const pulseSpeed = 2 + (1 - hpRatio) * 8; // faster as HP drops
      const pulseScale = 1 + Math.sin(Date.now() / 1000 * pulseSpeed * Math.PI * 2) * 0.15;
      const r = unit.radius * pulseScale;
      shape.circle(0, 0, r);
      shape.fill(this.theme.bomber);
      // Inner glow
      shape.circle(0, 0, r * 0.5);
      shape.fill({ color: 0xffff00, alpha: 0.3 + (1 - hpRatio) * 0.4 });
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
    if (unit.type !== 'zombie' && unit.type !== 'blade' && unit.type !== 'shielder' && unit.type !== 'bomber') {
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

  /** Remove all dying-unit sprites immediately (used by guest on new round/rematch). */
  clearDyingUnits(): void {
    for (const [, dying] of this.dyingUnits) {
      this.app.stage.removeChild(dying.container);
    }
    this.dyingUnits.clear();
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
    this.bladeSpinAngles.clear();
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

  /**
   * Adapt the renderer to display a remote map size (e.g. host's map on guest's screen).
   * Scales the stage to fit the remote map, centers it, and shows black bars for extra space.
   */
  adaptToRemoteMap(remoteWidth: number, remoteHeight: number): void {
    const canvasW = this.app.canvas.width;
    const canvasH = this.app.canvas.height;

    // Scale to fit the remote map within the local canvas
    const scale = Math.min(canvasW / remoteWidth, canvasH / remoteHeight);
    const offsetX = (canvasW - remoteWidth * scale) / 2;
    const offsetY = (canvasH - remoteHeight * scale) / 2;

    this.app.stage.scale.set(scale);
    this.app.stage.position.set(offsetX, offsetY);

    // Black canvas background for letterbox bars; theme bg is drawn as a
    // filled rect inside the stage so the playable area keeps its color.
    this.app.renderer.background.color = 0x000000;

    // Update MAP_WIDTH/MAP_HEIGHT so PathDrawer and other systems use the remote dimensions
    setMapSize(remoteWidth, remoteHeight);

    // Redraw background grid at correct size
    this.drawBackground();
  }

  destroy(): void {
    this.unitGraphics.clear();
    this.bladeSpinAngles.clear();
    this.app.destroy(true);
  }
}
