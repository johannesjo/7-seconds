import { Graphics, Container, Text } from 'pixi.js';
import { Vec2, Team } from './types';

interface Effect {
  update(dt: number): boolean; // false = expired
}

class ImpactBurst implements Effect {
  private gfx: Graphics;
  private age = 0;
  private readonly duration = 0.3;

  constructor(container: Container, private pos: Vec2, private team: Team) {
    this.gfx = new Graphics();
    container.addChild(this.gfx);
  }

  update(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) {
      this.gfx.destroy();
      return false;
    }
    const t = this.age / this.duration;
    const radius = 8 + t * 20;
    const alpha = 1 - t;
    const color = this.team === 'blue' ? 0x88ccff : 0xff8888;

    this.gfx.clear();
    this.gfx.circle(this.pos.x, this.pos.y, radius);
    this.gfx.setStrokeStyle({ width: 2, color, alpha });
    this.gfx.stroke();
    return true;
  }
}

class DeathEffect implements Effect {
  private gfx: Graphics;
  private age = 0;
  private readonly duration = 0.5;

  constructor(
    container: Container,
    private pos: Vec2,
    private radius: number,
    private team: Team,
  ) {
    this.gfx = new Graphics();
    container.addChild(this.gfx);
  }

  update(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) {
      this.gfx.destroy();
      return false;
    }
    const t = this.age / this.duration;
    const r = this.radius + t * 30;
    const alpha = 1 - t;
    const color = this.team === 'blue' ? 0x4a9eff : 0xff4a4a;

    this.gfx.clear();
    this.gfx.circle(this.pos.x, this.pos.y, r);
    this.gfx.setStrokeStyle({ width: 3, color, alpha });
    this.gfx.stroke();
    return true;
  }
}

class HitFlash implements Effect {
  private age = 0;
  private readonly duration = 0.08;
  private originalTint: number;

  constructor(private target: Container) {
    const shape = target.getChildAt(0) as Graphics;
    this.originalTint = shape.tint as number;
    shape.tint = 0xffffff;
  }

  update(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) {
      const shape = this.target.getChildAt(0) as Graphics;
      shape.tint = this.originalTint;
      return false;
    }
    return true;
  }
}

class KillText implements Effect {
  private text: Text;
  private age = 0;
  private readonly duration = 0.8;
  private startY: number;

  constructor(container: Container, pos: Vec2, team: Team) {
    const color = team === 'blue' ? '#88ccff' : '#ff8888';
    this.text = new Text({
      text: 'KILL',
      style: {
        fontSize: 14,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        fill: color,
      },
    });
    this.text.anchor.set(0.5);
    this.text.x = pos.x;
    this.text.y = pos.y;
    this.startY = pos.y;
    container.addChild(this.text);
  }

  update(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) {
      this.text.destroy();
      return false;
    }
    const t = this.age / this.duration;
    this.text.y = this.startY - t * 30;
    this.text.alpha = 1 - t;
    return true;
  }
}

class MuzzleFlash implements Effect {
  private gfx: Graphics;
  private age = 0;
  private readonly duration = 0.1;

  constructor(container: Container, private pos: Vec2) {
    this.gfx = new Graphics();
    container.addChild(this.gfx);
  }

  update(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) {
      this.gfx.destroy();
      return false;
    }
    const t = this.age / this.duration;
    const radius = 4 + t * 6;
    const alpha = 1 - t;

    this.gfx.clear();
    this.gfx.circle(this.pos.x, this.pos.y, radius);
    this.gfx.fill({ color: 0xffffaa, alpha });
    this.gfx.circle(this.pos.x, this.pos.y, radius * 0.5);
    this.gfx.fill({ color: 0xffffff, alpha });
    return true;
  }
}

class RoundStartFlash implements Effect {
  private gfx: Graphics;
  private age = 0;
  private readonly duration = 0.3;

  constructor(container: Container, private width: number, private height: number) {
    this.gfx = new Graphics();
    this.gfx.rect(0, 0, width, height);
    this.gfx.fill({ color: 0xffffff, alpha: 0.6 });
    container.addChild(this.gfx);
  }

  update(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) {
      this.gfx.destroy();
      return false;
    }
    const t = this.age / this.duration;
    this.gfx.alpha = 0.6 * (1 - t);
    return true;
  }
}

class BloodParticle implements Effect {
  private gfx: Graphics;
  private stains: Graphics;
  private age = 0;
  private readonly duration: number;
  private vx: number;
  private vy: number;
  private x: number;
  private y: number;
  private readonly size: number;
  private readonly color: number;
  private readonly stainColor: number;
  private static readonly FRICTION = 5;

  constructor(
    container: Container,
    stains: Graphics,
    pos: Vec2,
    angle: number,
    spread: number,
    speed: number,
    team: Team,
    size: number,
    duration: number,
  ) {
    this.gfx = new Graphics();
    this.stains = stains;
    this.x = pos.x;
    this.y = pos.y;
    this.size = size;
    this.duration = duration;

    const a = angle + (Math.random() - 0.5) * spread;
    this.vx = Math.cos(a) * speed;
    this.vy = Math.sin(a) * speed;

    const blueColors = [0x3377dd, 0x2255bb, 0x5599ee];
    const redColors = [0xdd3333, 0xbb2222, 0xee4444];
    const colors = team === 'blue' ? blueColors : redColors;
    this.color = colors[Math.floor(Math.random() * colors.length)];
    this.stainColor = team === 'blue' ? 0x1a3366 : 0x661a1a;

    container.addChild(this.gfx);
  }

  update(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) {
      const stainSize = this.size * (0.5 + Math.random() * 0.5);
      this.stains.circle(this.x, this.y, stainSize);
      this.stains.fill({ color: this.stainColor, alpha: 0.3 + Math.random() * 0.3 });
      this.gfx.destroy();
      return false;
    }

    const t = this.age / this.duration;
    const decay = Math.exp(-BloodParticle.FRICTION * dt);
    this.vx *= decay;
    this.vy *= decay;
    this.x += this.vx * dt;
    this.y += this.vy * dt;

    const currentSize = this.size * (1 - t * 0.5);
    const alpha = 1 - t * 0.6;

    this.gfx.clear();
    this.gfx.circle(this.x, this.y, currentSize);
    this.gfx.fill({ color: this.color, alpha });
    return true;
  }
}

export class EffectsManager {
  private container: Container;
  private groundStains: Graphics;
  private effects: Effect[] = [];

  constructor(stage: Container) {
    this.groundStains = new Graphics();
    stage.addChild(this.groundStains);
    this.container = new Container();
    stage.addChild(this.container);
  }

  addImpactBurst(pos: Vec2, team: Team): void {
    this.effects.push(new ImpactBurst(this.container, pos, team));
  }

  addDeathEffect(pos: Vec2, radius: number, team: Team): void {
    this.effects.push(new DeathEffect(this.container, pos, radius, team));
  }

  addHitFlash(unitContainer: Container): void {
    this.effects.push(new HitFlash(unitContainer));
  }

  addKillText(pos: Vec2, team: Team): void {
    this.effects.push(new KillText(this.container, pos, team));
  }

  addMuzzleFlash(pos: Vec2, angle: number, radius: number): void {
    const tipX = pos.x + Math.cos(angle) * (radius + 4);
    const tipY = pos.y + Math.sin(angle) * (radius + 4);
    this.effects.push(new MuzzleFlash(this.container, { x: tipX, y: tipY }));
  }

  addRoundStartFlash(width: number, height: number): void {
    this.effects.push(new RoundStartFlash(this.container, width, height));
  }

  addBloodSpray(pos: Vec2, angle: number, team: Team, damage: number): void {
    const count = Math.min(Math.floor(damage * 0.5) + 2, 15) + Math.floor(Math.random() * 3);
    const dmgScale = Math.min(damage / 10, 3);
    for (let i = 0; i < count; i++) {
      const speed = 80 + Math.random() * 120 * dmgScale;
      const size = (1.5 + Math.random() * 1.5) * Math.min(dmgScale, 1.5);
      const duration = 0.25 + Math.random() * 0.2;
      this.effects.push(new BloodParticle(
        this.container, this.groundStains, pos, angle,
        Math.PI * 0.7, speed, team, size, duration,
      ));
    }
  }

  addBloodBurst(pos: Vec2, angle: number, team: Team, damage: number): void {
    const count = Math.min(Math.floor(damage * 1.2) + 8, 35) + Math.floor(Math.random() * 6);
    const dmgScale = Math.min(damage / 10, 3);
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * Math.PI * 1.2;
      const speed = 60 + Math.random() * 160 * dmgScale;
      const size = (2 + Math.random() * 2) * Math.min(dmgScale, 1.5);
      const duration = 0.3 + Math.random() * 0.3;
      this.effects.push(new BloodParticle(
        this.container, this.groundStains, pos, a,
        0, speed, team, size, duration,
      ));
    }

    // Immediate blood pool at death site — scales with damage
    const stainColor = team === 'blue' ? 0x1a3366 : 0x661a1a;
    const poolSize = (5 + Math.random() * 4) * Math.min(dmgScale, 2);
    this.groundStains.circle(pos.x, pos.y, poolSize);
    this.groundStains.fill({ color: stainColor, alpha: 0.5 + Math.random() * 0.2 });

    // Smaller satellite stains around the pool
    const satellites = Math.min(3 + Math.floor(damage * 0.2), 8);
    for (let i = 0; i < satellites; i++) {
      const spread = 12 * dmgScale;
      const ox = (Math.random() - 0.5) * spread;
      const oy = (Math.random() - 0.5) * spread;
      const s = (2 + Math.random() * 2) * Math.min(dmgScale, 1.5);
      this.groundStains.circle(pos.x + ox, pos.y + oy, s);
      this.groundStains.fill({ color: stainColor, alpha: 0.3 + Math.random() * 0.2 });
    }
  }

  update(dt: number): void {
    this.effects = this.effects.filter(e => e.update(dt));
  }

  clear(): void {
    this.container.removeChildren();
    this.groundStains.clear();
    this.effects = [];
  }

  destroy(): void {
    this.clear();
    this.container.destroy();
    this.groundStains.destroy();
  }
}

export function createEffectsManager(stage: Container): EffectsManager {
  return new EffectsManager(stage);
}
