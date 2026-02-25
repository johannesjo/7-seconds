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

export class EffectsManager {
  private container: Container;
  private effects: Effect[] = [];

  constructor(stage: Container) {
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

  addRoundStartFlash(width: number, height: number): void {
    this.effects.push(new RoundStartFlash(this.container, width, height));
  }

  update(dt: number): void {
    this.effects = this.effects.filter(e => e.update(dt));
  }

  clear(): void {
    this.container.removeChildren();
    this.effects = [];
  }

  destroy(): void {
    this.clear();
    this.container.destroy();
  }
}

export function createEffectsManager(stage: Container): EffectsManager {
  return new EffectsManager(stage);
}
