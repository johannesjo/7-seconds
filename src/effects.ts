import { Graphics, Container, Text } from 'pixi.js';
import { Vec2, Team, ReplayEvent } from './types';
import { Theme, NIGHT_THEME } from './theme';
import { FLANK_DAMAGE_MULTIPLIER, MAP_WIDTH, MAP_HEIGHT } from './constants';

interface Effect {
  update(dt: number): boolean; // false = expired
}

class ImpactBurst implements Effect {
  private gfx: Graphics;
  private age = 0;
  private readonly duration = 0.3;

  constructor(container: Container, private pos: Vec2, private color: number) {
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

    this.gfx.clear();
    this.gfx.circle(this.pos.x, this.pos.y, radius);
    this.gfx.setStrokeStyle({ width: 2, color: this.color, alpha });
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
    private color: number,
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

    this.gfx.clear();
    this.gfx.circle(this.pos.x, this.pos.y, r);
    this.gfx.setStrokeStyle({ width: 3, color: this.color, alpha });
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

  constructor(container: Container, pos: Vec2, cssColor: string) {
    this.text = new Text({
      text: 'KILL',
      style: {
        fontSize: 14,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        fill: cssColor,
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

/** Small directional marks keep the cue beside the unit rather than over it. */
class CombatCue implements Effect {
  private gfx = new Graphics();
  private label: Text;
  private age = 0;
  private readonly duration = 0.65;

  constructor(
    container: Container,
    private pos: Vec2,
    private angle: number,
    private kind: 'flank' | 'shield-break',
    private color: number,
    labelColor: string,
    outline: number,
  ) {
    this.label = new Text({
      text: kind === 'flank' ? 'FLANK' : 'SHIELD BREAK',
      style: {
        fontSize: 11,
        fontFamily: 'monospace',
        fontWeight: 'bold',
        letterSpacing: 0.5,
        fill: labelColor,
        stroke: { color: outline, width: 3 },
      },
    });
    this.label.anchor.set(0.5);
    container.addChild(this.gfx, this.label);
    this.draw();
  }

  private draw(): void {
    const t = this.age / this.duration;
    const alpha = 1 - t;
    this.gfx.clear();
    if (this.kind === 'flank') {
      // A chevron advances along the projectile's path toward the impact.
      const forward = { x: Math.cos(this.angle), y: Math.sin(this.angle) };
      const side = { x: -forward.y, y: forward.x };
      const tip = 16 - t * 5;
      const tail = tip + 10;
      for (const sign of [-1, 1]) {
        this.gfx.moveTo(this.pos.x - forward.x * tail + side.x * sign * 7,
          this.pos.y - forward.y * tail + side.y * sign * 7);
        this.gfx.lineTo(this.pos.x - forward.x * tip, this.pos.y - forward.y * tip);
        this.gfx.stroke({ width: 2.5, color: this.color, alpha });
      }
    } else {
      // Three broken shield segments fly outward from the unit's facing arc.
      for (const offset of [-0.56, 0, 0.56]) {
        const center = this.angle + offset;
        const radius = 18 + t * 15;
        this.gfx.moveTo(this.pos.x + Math.cos(center - 0.19) * radius,
          this.pos.y + Math.sin(center - 0.19) * radius);
        this.gfx.arc(this.pos.x, this.pos.y, radius, center - 0.19, center + 0.19);
        this.gfx.stroke({ width: 3.5 - t * 1.5, color: this.color, alpha });
        const rayStart = radius + 3;
        const rayEnd = rayStart + 5 + t * 5;
        this.gfx.moveTo(this.pos.x + Math.cos(center) * rayStart,
          this.pos.y + Math.sin(center) * rayStart);
        this.gfx.lineTo(this.pos.x + Math.cos(center) * rayEnd,
          this.pos.y + Math.sin(center) * rayEnd);
        this.gfx.stroke({ width: 1.5, color: this.color, alpha: alpha * 0.8 });
      }
    }
    const margin = this.label.width / 2 + 4;
    this.label.x = Math.max(margin, Math.min(MAP_WIDTH - margin, this.pos.x));
    const above = this.pos.y - (this.kind === 'shield-break' ? 46 : 31) - t * 12;
    this.label.y = above >= 12 ? above : Math.min(MAP_HEIGHT - 12, this.pos.y + 36 + t * 12);
    this.label.alpha = alpha;
  }

  update(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) {
      this.gfx.destroy();
      this.label.destroy();
      return false;
    }
    this.draw();
    return true;
  }
}

/** Replay-only focus around a decisive kill; leaves the unit center clear. */
class KillFocus implements Effect {
  private gfx = new Graphics();
  private age = 0;
  private readonly duration = 0.55;

  constructor(container: Container, private pos: Vec2, private color: number) {
    container.addChild(this.gfx);
    this.draw();
  }

  private draw(): void {
    const t = this.age / this.duration;
    const radius = 19 + t * 12;
    this.gfx.clear();
    for (let i = 0; i < 4; i++) {
      const angle = i * Math.PI / 2 + Math.PI / 4;
      this.gfx.moveTo(this.pos.x + Math.cos(angle - 0.22) * radius,
        this.pos.y + Math.sin(angle - 0.22) * radius);
      this.gfx.arc(this.pos.x, this.pos.y, radius, angle - 0.22, angle + 0.22);
      this.gfx.stroke({ width: 2, color: this.color, alpha: 0.9 * (1 - t) });
    }
  }

  update(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) {
      this.gfx.destroy();
      return false;
    }
    this.draw();
    return true;
  }
}

class MuzzleFlash implements Effect {
  private gfx: Graphics;
  private age = 0;
  private readonly duration = 0.1;

  constructor(container: Container, private pos: Vec2, private flash: number, private core: number) {
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
    this.gfx.fill({ color: this.flash, alpha });
    this.gfx.circle(this.pos.x, this.pos.y, radius * 0.5);
    this.gfx.fill({ color: this.core, alpha });
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

class ExplosionEffect implements Effect {
  private gfx: Graphics;
  private age = 0;
  private readonly duration = 0.55;
  // Pre-computed random spark directions so each frame is deterministic per-instance
  private readonly sparks: { angle: number; dist: number; size: number }[];

  constructor(
    container: Container,
    private pos: Vec2,
    private radius: number,
    private color: number,
    private coreColor: number,
  ) {
    this.gfx = new Graphics();
    container.addChild(this.gfx);

    const SPARK_COUNT = 12;
    this.sparks = Array.from({ length: SPARK_COUNT }, () => ({
      angle: Math.random() * Math.PI * 2,
      dist: 0.5 + Math.random() * 0.5,   // fraction of max radius
      size: 2 + Math.random() * 3,
    }));
  }

  update(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) {
      this.gfx.destroy();
      return false;
    }

    const t = this.age / this.duration;
    // Ease-out expansion: fast start, slow end
    const expand = 1 - Math.pow(1 - t, 2);
    const currentRadius = this.radius * expand;

    this.gfx.clear();

    // Outer ring (fades out early)
    const outerAlpha = Math.max(0, 1 - t * 2);
    if (outerAlpha > 0) {
      this.gfx.circle(this.pos.x, this.pos.y, currentRadius);
      this.gfx.setStrokeStyle({ width: 3, color: this.color, alpha: outerAlpha });
      this.gfx.stroke();
    }

    // Inner shockwave ring (trails slightly behind)
    const innerT = Math.max(0, t - 0.05);
    const innerExpand = 1 - Math.pow(1 - innerT, 2);
    const innerRadius = this.radius * 0.6 * innerExpand;
    const innerAlpha = Math.max(0, 0.8 - t * 1.6);
    if (innerAlpha > 0) {
      this.gfx.circle(this.pos.x, this.pos.y, innerRadius);
      this.gfx.setStrokeStyle({ width: 5, color: this.coreColor, alpha: innerAlpha });
      this.gfx.stroke();
    }

    // Bright core fill (fades quickly in first third)
    const coreAlpha = Math.max(0, 1 - t * 3);
    if (coreAlpha > 0) {
      const coreRadius = this.radius * 0.25 * (1 - t * 0.5);
      this.gfx.circle(this.pos.x, this.pos.y, coreRadius);
      this.gfx.fill({ color: this.coreColor, alpha: coreAlpha });
    }

    // Sparks flying outward
    const sparkAlpha = Math.max(0, 1 - t * 2.2);
    if (sparkAlpha > 0) {
      for (const spark of this.sparks) {
        const d = currentRadius * spark.dist;
        const sx = this.pos.x + Math.cos(spark.angle) * d;
        const sy = this.pos.y + Math.sin(spark.angle) * d;
        const sparkSize = spark.size * (1 - t * 0.6);
        this.gfx.circle(sx, sy, sparkSize);
        this.gfx.fill({ color: this.color, alpha: sparkAlpha });
      }
    }

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
  private readonly alphaMul: number;
  private readonly fadeMul: number;
  private static readonly FRICTION = 5;

  constructor(
    container: Container,
    stains: Graphics,
    pos: Vec2,
    angle: number,
    spread: number,
    speed: number,
    bloodColors: number[],
    stainColor: number,
    size: number,
    duration: number,
    alphaMul: number,
    fadeMul: number,
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

    this.color = bloodColors[Math.floor(Math.random() * bloodColors.length)];
    this.stainColor = stainColor;
    this.alphaMul = alphaMul;
    this.fadeMul = fadeMul;

    container.addChild(this.gfx);
  }

  update(dt: number): boolean {
    this.age += dt;
    if (this.age >= this.duration) {
      const stainSize = this.size * (0.5 + Math.random() * 0.5);
      this.stains.circle(this.x, this.y, stainSize);
      const stainAlpha = this.alphaMul * (1 - this.fadeMul * 0.7);
      this.stains.fill({ color: this.stainColor, alpha: (0.3 + Math.random() * 0.3) * stainAlpha });
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
    const alpha = (1 - t * this.fadeMul) * this.alphaMul;

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
  private theme: Theme = NIGHT_THEME;
  private cueTime = 0;
  private flankCueTimes = new Map<string, number>();

  constructor(stage: Container) {
    this.groundStains = new Graphics();
    stage.addChild(this.groundStains);
    this.container = new Container();
    stage.addChild(this.container);
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  addImpactBurst(pos: Vec2, team: Team): void {
    const color = team === 'blue' ? this.theme.blueImpact : this.theme.redImpact;
    this.effects.push(new ImpactBurst(this.container, pos, color));
  }

  addDeathEffect(pos: Vec2, radius: number, team: Team): void {
    const color = team === 'blue' ? this.theme.blue : this.theme.red;
    this.effects.push(new DeathEffect(this.container, pos, radius, color));
  }

  addHitFlash(unitContainer: Container): void {
    this.effects.push(new HitFlash(unitContainer));
  }

  addKillText(pos: Vec2, team: Team): void {
    const color = team === 'blue' ? this.theme.blueKill : this.theme.redKill;
    this.effects.push(new KillText(this.container, pos, color));
  }

  addFlankCue(pos: Vec2, projectileAngle: number, targetId?: string): void {
    if (targetId) {
      const last = this.flankCueTimes.get(targetId);
      if (last !== undefined && this.cueTime - last < 0.7) return;
      this.flankCueTimes.set(targetId, this.cueTime);
    }
    this.effects.push(new CombatCue(this.container, pos, projectileAngle, 'flank',
      this.theme.flankCue, this.theme.flankCueText, this.theme.bg));
  }

  addShieldBreakCue(pos: Vec2, facingAngle: number): void {
    this.effects.push(new CombatCue(this.container, pos, facingAngle, 'shield-break',
      this.theme.shieldBreakCue, this.theme.shieldBreakText, this.theme.bg));
  }

  addMuzzleFlash(pos: Vec2, angle: number, radius: number): void {
    const tipX = pos.x + Math.cos(angle) * (radius + 4);
    const tipY = pos.y + Math.sin(angle) * (radius + 4);
    this.effects.push(new MuzzleFlash(this.container, { x: tipX, y: tipY }, this.theme.muzzleFlash, this.theme.muzzleCore));
  }

  addRoundStartFlash(width: number, height: number): void {
    this.effects.push(new RoundStartFlash(this.container, width, height));
  }

  addExplosion(pos: Vec2, radius: number): void {
    this.effects.push(new ExplosionEffect(
      this.container, pos, radius,
      this.theme.bomber,
      this.theme.muzzleCore,
    ));
  }

  addBloodSpray(pos: Vec2, angle: number, team: Team, damage: number): void {
    const bloodColors = team === 'blue' ? this.theme.blueBlood : this.theme.redBlood;
    const stainColor = team === 'blue' ? this.theme.blueStain : this.theme.redStain;
    const aMul = this.theme.bloodAlpha;
    const fMul = this.theme.bloodFade;
    const count = Math.min(Math.floor(damage * 0.5) + 2, 15) + Math.floor(Math.random() * 3);
    const dmgScale = Math.min(damage / 10, 3);
    for (let i = 0; i < count; i++) {
      const speed = 80 + Math.random() * 120 * dmgScale;
      const size = (1.5 + Math.random() * 1.5) * Math.min(dmgScale, 1.5);
      const duration = 0.25 + Math.random() * 0.2;
      this.effects.push(new BloodParticle(
        this.container, this.groundStains, pos, angle,
        Math.PI * 0.35, speed, bloodColors, stainColor, size, duration, aMul, fMul,
      ));
    }
  }

  addBloodBurst(pos: Vec2, angle: number, team: Team, damage: number): void {
    const bloodColors = team === 'blue' ? this.theme.blueBlood : this.theme.redBlood;
    const stainColor = team === 'blue' ? this.theme.blueStain : this.theme.redStain;
    const aMul = this.theme.bloodAlpha;
    const fMul = this.theme.bloodFade;
    const count = Math.min(Math.floor(damage * 1.2) + 8, 35) + Math.floor(Math.random() * 6);
    const dmgScale = Math.min(damage / 10, 3);
    for (let i = 0; i < count; i++) {
      const a = angle + (Math.random() - 0.5) * Math.PI * 0.6;
      const speed = 60 + Math.random() * 160 * dmgScale;
      const size = (2 + Math.random() * 2) * Math.min(dmgScale, 1.5);
      const duration = 0.3 + Math.random() * 0.3;
      this.effects.push(new BloodParticle(
        this.container, this.groundStains, pos, a,
        0, speed, bloodColors, stainColor, size, duration, aMul, fMul,
      ));
    }

    const stainMul = aMul * (1 - fMul * 0.7);
    const poolSize = (5 + Math.random() * 4) * Math.min(dmgScale, 2);
    this.groundStains.circle(pos.x, pos.y, poolSize);
    this.groundStains.fill({ color: stainColor, alpha: (0.5 + Math.random() * 0.2) * stainMul });

    const satellites = Math.min(3 + Math.floor(damage * 0.2), 8);
    for (let i = 0; i < satellites; i++) {
      const spread = 12 * dmgScale;
      const ox = (Math.random() - 0.5) * spread;
      const oy = (Math.random() - 0.5) * spread;
      const s = (2 + Math.random() * 2) * Math.min(dmgScale, 1.5);
      this.groundStains.circle(pos.x + ox, pos.y + oy, s);
      this.groundStains.fill({ color: stainColor, alpha: (0.3 + Math.random() * 0.2) * stainMul });
    }
  }

  update(dt: number): void {
    this.cueTime += dt;
    this.effects = this.effects.filter(e => e.update(dt));
  }

  clear(): void {
    this.container.removeChildren();
    this.groundStains.clear();
    this.effects = [];
    this.cueTime = 0;
    this.flankCueTimes.clear();
  }

  destroy(): void {
    this.clear();
    this.container.destroy();
    this.groundStains.destroy();
  }

  /** Dispatch visual effects for replay/online frame events. */
  dispatchEvents(events: ReplayEvent[], highlightDecisiveHits = false): void {
    for (const event of events) {
      if (event.type === 'fire') {
        this.addMuzzleFlash(event.pos, event.angle, 6);
      } else if (event.type === 'hit') {
        const victimTeam: Team = event.team === 'blue' ? 'red' : 'blue';
        const effectDamage = event.flanked ? event.damage * FLANK_DAMAGE_MULTIPLIER : event.damage;
        this.addBloodSpray(event.pos, event.angle, victimTeam, effectDamage);
        this.addImpactBurst(event.pos, event.team);
        if (event.flanked) this.addFlankCue(event.pos, event.angle, event.targetId);
      } else if (event.type === 'kill') {
        const victimTeam: Team = event.team === 'blue' ? 'red' : 'blue';
        const effectDamage = event.flanked ? event.damage * FLANK_DAMAGE_MULTIPLIER : event.damage;
        this.addBloodSpray(event.pos, event.angle, victimTeam, effectDamage);
        this.addBloodBurst(event.pos, event.angle, victimTeam, effectDamage);
        this.addKillText(event.pos, event.team);
        if (event.flanked) this.addFlankCue(event.pos, event.angle, event.targetId);
        if (highlightDecisiveHits) {
          this.effects.push(new KillFocus(this.container, event.pos,
            victimTeam === 'blue' ? this.theme.blue : this.theme.red));
        }
      } else if (event.type === 'shield-break') {
        this.addShieldBreakCue(event.pos, event.facingAngle ?? event.angle + Math.PI);
      } else if (event.type === 'explosion') {
        this.addExplosion(event.pos, event.radius ?? 40);
      }
    }
  }
}
