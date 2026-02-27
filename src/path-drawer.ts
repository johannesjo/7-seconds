import { Graphics, Container, Rectangle, Text } from 'pixi.js';
import { Unit, Team, Vec2, ElevationZone } from './types';
import { PATH_SAMPLE_DISTANCE, UNIT_SELECT_RADIUS, MAP_WIDTH, MAP_HEIGHT, ELEVATION_RANGE_BONUS, ZONE_DEPTH_RATIO, ROUND_DURATION_S } from './constants';
import { getElevationLevel } from './units';

/** Sample a polyline from raw pointer positions, keeping points >= minDist apart. */
export function samplePath(raw: Vec2[], minDist: number): Vec2[] {
  if (raw.length === 0) return [];
  const result: Vec2[] = [raw[0]];
  for (let i = 1; i < raw.length; i++) {
    const last = result[result.length - 1];
    const dx = raw[i].x - last.x;
    const dy = raw[i].y - last.y;
    if (dx * dx + dy * dy >= minDist * minDist) {
      result.push(raw[i]);
    }
  }
  return result;
}

function distancePt(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

/** Sum of all segment lengths in a polyline. */
function polylineLength(pts: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += distancePt(pts[i - 1], pts[i]);
  }
  return len;
}

/** Return position and angle at a given distance along a polyline. */
function pointAtDistance(pts: Vec2[], dist: number): { pos: Vec2; angle: number } {
  let remaining = dist;
  for (let i = 1; i < pts.length; i++) {
    const segLen = distancePt(pts[i - 1], pts[i]);
    if (remaining <= segLen && segLen > 0) {
      const t = remaining / segLen;
      return {
        pos: {
          x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t,
          y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t,
        },
        angle: Math.atan2(pts[i].y - pts[i - 1].y, pts[i].x - pts[i - 1].x),
      };
    }
    remaining -= segLen;
  }
  // Past the end — return last point
  const last = pts[pts.length - 1];
  const prev = pts.length >= 2 ? pts[pts.length - 2] : pts[0];
  return {
    pos: { x: last.x, y: last.y },
    angle: Math.atan2(last.y - prev.y, last.x - prev.x),
  };
}

export class PathDrawer {
  private stage: Container;
  private units: Unit[] = [];
  private elevationZones: ElevationZone[] = [];
  private team: Team | null = null;
  private gfx: Graphics;
  private hoverGfx: Graphics;
  private selectedUnit: Unit | null = null;
  private hoveredUnit: Unit | null = null;
  private hoveredEnemy: Unit | null = null;
  private rawPoints: Vec2[] = [];
  private enabled = false;
  private canvas: HTMLCanvasElement | null = null;
  private _zoneControl = false;
  private labelContainer: Container;
  private labelPool: Text[] = [];
  private labelIndex = 0;
  private hoverLabel: Text;

  constructor(stage: Container, canvas?: HTMLCanvasElement) {
    this.stage = stage;
    this.gfx = new Graphics();
    this.hoverGfx = new Graphics();
    this.labelContainer = new Container();
    this.hoverLabel = new Text({
      text: '',
      style: { fontSize: 11, fontFamily: 'monospace', fill: 0xffffff },
    });
    this.hoverLabel.anchor.set(0.5, 1);
    this.hoverLabel.visible = false;
    this.stage.addChild(this.gfx);
    this.stage.addChild(this.hoverGfx);
    this.stage.addChild(this.labelContainer);
    this.stage.addChild(this.hoverLabel);

    // Suppress context menu on canvas
    if (canvas) {
      this.canvas = canvas;
      this.canvas.addEventListener('contextmenu', this.onContextMenu);
    }

    // Make stage interactive for canvas-wide pointer events
    this.stage.eventMode = 'static';
    this.stage.hitArea = new Rectangle(0, 0, MAP_WIDTH, MAP_HEIGHT);

    this.stage.on('pointerdown', this.onPointerDown);
    this.stage.on('pointermove', this.onPointerMove);
    this.stage.on('pointerup', this.onPointerUp);
    this.stage.on('pointerupoutside', this.onPointerUp);
    this.stage.on('rightdown', this.onRightDown);
  }

  set zoneControl(value: boolean) {
    this._zoneControl = value;
  }

  private acquireLabel(): Text {
    if (this.labelIndex < this.labelPool.length) {
      const label = this.labelPool[this.labelIndex];
      label.visible = true;
      this.labelIndex++;
      return label;
    }
    const label = new Text({
      text: '',
      style: { fontSize: 11, fontFamily: 'monospace', fill: 0xffffff },
    });
    label.anchor.set(0.5, 1);
    this.labelContainer.addChild(label);
    this.labelPool.push(label);
    this.labelIndex++;
    return label;
  }

  enable(team: Team, units: Unit[], elevationZones: ElevationZone[] = []): void {
    this.team = team;
    this.units = units;
    this.elevationZones = elevationZones;
    this.enabled = true;
    this.selectedUnit = null;
    this.hoveredUnit = null;
    this.hoveredEnemy = null;
    this.rawPoints = [];
    this.renderPaths();
  }

  disable(): void {
    this.enabled = false;
    this.team = null;
    this.selectedUnit = null;
    this.hoveredUnit = null;
    this.hoveredEnemy = null;
    this.rawPoints = [];
    this.hoverGfx.clear();
    for (const label of this.labelPool) label.visible = false;
  }

  /** Clear all waypoints for a team (called at start of their planning phase). */
  clearPaths(team: Team): void {
    for (const unit of this.units) {
      if (unit.team === team && unit.alive) {
        unit.waypoints = [];
        unit.moveTarget = null;
      }
    }
    this.renderPaths();
  }

  renderPaths(): void {
    this.gfx.clear();
    this.labelIndex = 0;

    for (const unit of this.units) {
      if (!unit.alive || unit.waypoints.length === 0) continue;

      const color = unit.team === 'blue' ? 0x4a9eff : 0xff4a4a;
      const alpha = unit.team === this.team ? 0.8 : 0.3;

      this.gfx.setStrokeStyle({ width: 2, color, alpha });
      this.gfx.moveTo(unit.pos.x, unit.pos.y);
      for (const wp of unit.waypoints) {
        this.gfx.lineTo(wp.x, wp.y);
      }
      this.gfx.stroke();

      // Draw small circle at end of path
      const last = unit.waypoints[unit.waypoints.length - 1];
      this.gfx.circle(last.x, last.y, 4);
      this.gfx.fill({ color, alpha });

      // Tick marks at 1-second intervals + time label
      const fullPath: Vec2[] = [unit.pos, ...unit.waypoints];
      const pathLen = polylineLength(fullPath);
      const travelTime = pathLen / unit.speed;
      const tickAlpha = alpha * 0.5;
      const tickDist = unit.speed; // 1 second of travel
      for (let d = tickDist; d < pathLen; d += tickDist) {
        const { pos: tp, angle: ta } = pointAtDistance(fullPath, d);
        const nx = Math.cos(ta + Math.PI / 2) * 4;
        const ny = Math.sin(ta + Math.PI / 2) * 4;
        this.gfx.setStrokeStyle({ width: 1, color, alpha: tickAlpha });
        this.gfx.moveTo(tp.x - nx, tp.y - ny);
        this.gfx.lineTo(tp.x + nx, tp.y + ny);
        this.gfx.stroke();
      }

      const overLimit = travelTime > ROUND_DURATION_S;
      const timeLabel = this.acquireLabel();
      timeLabel.text = overLimit ? `${travelTime.toFixed(1)}s!` : `${travelTime.toFixed(1)}s`;
      timeLabel.style.fill = overLimit ? 0xff4444 : 0xffffff;
      timeLabel.position.set(last.x, last.y - 12);
      timeLabel.alpha = alpha;
    }

    // Draw in-progress raw line (thicker + brighter than finalized paths)
    if (this.selectedUnit && this.rawPoints.length > 1) {
      const color = this.team === 'blue' ? 0x8ac4ff : 0xff8a8a;
      this.gfx.setStrokeStyle({ width: 4, color, alpha: 1.0 });
      this.gfx.moveTo(this.rawPoints[0].x, this.rawPoints[0].y);
      for (let i = 1; i < this.rawPoints.length; i++) {
        this.gfx.lineTo(this.rawPoints[i].x, this.rawPoints[i].y);
      }
      this.gfx.stroke();

      // Tick marks + live time label for in-progress path
      const rawLen = polylineLength(this.rawPoints);
      const rawTime = rawLen / this.selectedUnit.speed;
      const tickDist = this.selectedUnit.speed;
      for (let d = tickDist; d < rawLen; d += tickDist) {
        const { pos: tp, angle: ta } = pointAtDistance(this.rawPoints, d);
        const nx = Math.cos(ta + Math.PI / 2) * 5;
        const ny = Math.sin(ta + Math.PI / 2) * 5;
        this.gfx.setStrokeStyle({ width: 1.5, color, alpha: 0.8 });
        this.gfx.moveTo(tp.x - nx, tp.y - ny);
        this.gfx.lineTo(tp.x + nx, tp.y + ny);
        this.gfx.stroke();
      }

      const endpoint = this.rawPoints[this.rawPoints.length - 1];
      const rawOverLimit = rawTime > ROUND_DURATION_S;
      const liveLabel = this.acquireLabel();
      liveLabel.text = rawOverLimit ? `${rawTime.toFixed(1)}s!` : `${rawTime.toFixed(1)}s`;
      liveLabel.style.fill = rawOverLimit ? 0xff4444 : 0xffffff;
      liveLabel.position.set(endpoint.x, endpoint.y - 12);
      liveLabel.alpha = 1.0;
    }

    // Hide unused pool labels
    for (let i = this.labelIndex; i < this.labelPool.length; i++) {
      this.labelPool[i].visible = false;
    }

    this.renderHoverLayer();
  }

  private renderHoverLayer(): void {
    this.hoverGfx.clear();
    this.hoverLabel.visible = false;
    if (!this.enabled || !this.team) return;

    const teamColor = this.team === 'blue' ? 0x4a9eff : 0xff4a4a;
    const pulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);

    for (const unit of this.units) {
      if (!unit.alive || unit.team !== this.team || unit === this.selectedUnit) continue;

      if (unit.waypoints.length > 0) {
        // Units WITH paths: bright dot + ring
        this.hoverGfx.circle(unit.pos.x, unit.pos.y, 5);
        this.hoverGfx.fill({ color: teamColor, alpha: 0.8 });
        this.hoverGfx.circle(unit.pos.x, unit.pos.y, unit.radius + 3);
        this.hoverGfx.setStrokeStyle({ width: 1.5, color: teamColor, alpha: 0.4 });
        this.hoverGfx.stroke();
      } else {
        // Units WITHOUT paths: pulsing ring to attract attention
        const pulseRadius = unit.radius + 4 + pulse * 4;
        this.hoverGfx.circle(unit.pos.x, unit.pos.y, pulseRadius);
        this.hoverGfx.setStrokeStyle({ width: 2, color: teamColor, alpha: 0.3 + pulse * 0.4 });
        this.hoverGfx.stroke();
      }
    }

    // Enemy presence warning in own zone (only when zone control is enabled)
    const zoneDepth = MAP_HEIGHT * ZONE_DEPTH_RATIO;
    if (this._zoneControl) {
      const enemyTeam: Team = this.team === 'blue' ? 'red' : 'blue';
      const ownZoneY = this.team === 'blue' ? MAP_HEIGHT - zoneDepth : 0;
      const enemyInOurZone = this.units.some(u => {
        if (!u.alive || u.team !== enemyTeam) return false;
        return this.team === 'blue'
          ? u.pos.y > MAP_HEIGHT - zoneDepth
          : u.pos.y < zoneDepth;
      });

      if (enemyInOurZone) {
        const warnColor = enemyTeam === 'red' ? 0xff4a4a : 0x4a9eff;
        const warnPulse = 0.5 + 0.5 * Math.sin(Date.now() / 350);
        this.hoverGfx.rect(0, ownZoneY, MAP_WIDTH, zoneDepth);
        this.hoverGfx.setStrokeStyle({ width: 2, color: warnColor, alpha: 0.3 + 0.4 * warnPulse });
        this.hoverGfx.stroke();
      }
    }

    // Selection ring on actively drawn unit
    if (this.selectedUnit) {
      this.hoverGfx.circle(this.selectedUnit.pos.x, this.selectedUnit.pos.y, this.selectedUnit.radius + 5);
      this.hoverGfx.setStrokeStyle({ width: 2.5, color: teamColor, alpha: 1.0 });
      this.hoverGfx.stroke();
      // Range circle at path endpoint (live update while drawing)
      const endPos = this.rawPoints.length > 0
        ? this.rawPoints[this.rawPoints.length - 1]
        : this.selectedUnit.pos;
      this.drawRangeCircle(this.selectedUnit, endPos, teamColor);

      // Highlight enemy zone when dragging into it (only when zone control is enabled)
      if (this._zoneControl) {
        const enemyZoneY = this.team === 'blue' ? 0 : MAP_HEIGHT - zoneDepth;
        const inEnemyZone = this.team === 'blue'
          ? endPos.y < zoneDepth
          : endPos.y > MAP_HEIGHT - zoneDepth;
        if (inEnemyZone) {
          const capturePulse = 0.5 + 0.5 * Math.sin(Date.now() / 300);
          this.hoverGfx.rect(0, enemyZoneY, MAP_WIDTH, zoneDepth);
          this.hoverGfx.fill({ color: teamColor, alpha: 0.06 + 0.04 * capturePulse });
          this.hoverGfx.rect(0, enemyZoneY, MAP_WIDTH, zoneDepth);
          this.hoverGfx.setStrokeStyle({ width: 2, color: teamColor, alpha: 0.3 + 0.4 * capturePulse });
          this.hoverGfx.stroke();
        }
      }

      return; // Don't show hover when drawing
    }

    // Hover highlight on nearest own-team unit
    if (this.hoveredUnit) {
      this.hoverGfx.circle(this.hoveredUnit.pos.x, this.hoveredUnit.pos.y, this.hoveredUnit.radius + 4);
      this.hoverGfx.setStrokeStyle({ width: 2, color: teamColor, alpha: 0.6 });
      this.hoverGfx.stroke();

      // Highlight path + time label on hover
      if (this.hoveredUnit.waypoints.length > 0) {
        const brightColor = this.team === 'blue' ? 0x8ac4ff : 0xff8a8a;
        this.hoverGfx.setStrokeStyle({ width: 3, color: brightColor, alpha: 1.0 });
        this.hoverGfx.moveTo(this.hoveredUnit.pos.x, this.hoveredUnit.pos.y);
        for (const wp of this.hoveredUnit.waypoints) {
          this.hoverGfx.lineTo(wp.x, wp.y);
        }
        this.hoverGfx.stroke();

        const last = this.hoveredUnit.waypoints[this.hoveredUnit.waypoints.length - 1];
        this.hoverGfx.circle(last.x, last.y, 5);
        this.hoverGfx.fill({ color: brightColor, alpha: 1.0 });

        const fullPath: Vec2[] = [this.hoveredUnit.pos, ...this.hoveredUnit.waypoints];
        const pathLen = polylineLength(fullPath);
        const travelTime = pathLen / this.hoveredUnit.speed;
        const overLimit = travelTime > ROUND_DURATION_S;
        this.hoverLabel.text = overLimit ? `${travelTime.toFixed(1)}s!` : `${travelTime.toFixed(1)}s`;
        this.hoverLabel.style.fill = overLimit ? 0xff4444 : 0xffffff;
        this.hoverLabel.position.set(last.x, last.y - 12);
        this.hoverLabel.visible = true;
      }

      // Range circle at path endpoint (or current pos if no path)
      const hoverPos = this.hoveredUnit.waypoints.length > 0
        ? this.hoveredUnit.waypoints[this.hoveredUnit.waypoints.length - 1]
        : this.hoveredUnit.pos;
      this.drawRangeCircle(this.hoveredUnit, hoverPos, teamColor);
    }

    // Enemy unit range preview (tap or hover)
    if (this.hoveredEnemy && !this.selectedUnit) {
      const enemyColor = this.hoveredEnemy.team === 'red' ? 0xff4a4a : 0x4a9eff;
      this.hoverGfx.circle(this.hoveredEnemy.pos.x, this.hoveredEnemy.pos.y, this.hoveredEnemy.radius + 4);
      this.hoverGfx.setStrokeStyle({ width: 2, color: enemyColor, alpha: 0.6 });
      this.hoverGfx.stroke();
      this.drawRangeCircle(this.hoveredEnemy, this.hoveredEnemy.pos, enemyColor);
    }
  }

  /** Call each frame to animate pulsing indicators during planning. */
  updateHover(): void {
    if (this.enabled) this.renderHoverLayer();
  }

  private drawRangeCircle(unit: Unit, pos: Vec2, color: number): void {
    const level = getElevationLevel(pos, this.elevationZones);
    const elevated = level > 0;
    const range = unit.range * (1 + ELEVATION_RANGE_BONUS * level);
    const ringColor = elevated ? 0x66ff88 : color;

    // Highlight the elevation zone the position sits on
    if (elevated) {
      for (const z of this.elevationZones) {
        if (pos.x >= z.x && pos.x <= z.x + z.w && pos.y >= z.y && pos.y <= z.y + z.h) {
          this.hoverGfx.roundRect(z.x, z.y, z.w, z.h, 6);
          this.hoverGfx.setStrokeStyle({ width: 1.5, color: 0x66ff88, alpha: 0.4 });
          this.hoverGfx.stroke();
        }
      }
    }

    this.hoverGfx.circle(pos.x, pos.y, range + unit.radius);
    this.hoverGfx.setStrokeStyle({ width: 1, color: ringColor, alpha: 0.2 });
    this.hoverGfx.stroke();
    this.hoverGfx.circle(pos.x, pos.y, range + unit.radius);
    this.hoverGfx.fill({ color: ringColor, alpha: 0.03 });
  }

  clearGraphics(): void {
    this.gfx.clear();
    this.hoverGfx.clear();
    for (const label of this.labelPool) label.visible = false;
  }

  destroy(): void {
    this.stage.off('pointerdown', this.onPointerDown);
    this.stage.off('pointermove', this.onPointerMove);
    this.stage.off('pointerup', this.onPointerUp);
    this.stage.off('pointerupoutside', this.onPointerUp);
    this.stage.off('rightdown', this.onRightDown);
    if (this.canvas) {
      this.canvas.removeEventListener('contextmenu', this.onContextMenu);
    }
    this.stage.removeChild(this.gfx);
    this.stage.removeChild(this.hoverGfx);
    this.stage.removeChild(this.labelContainer);
    this.stage.removeChild(this.hoverLabel);
    this.gfx.destroy();
    this.hoverGfx.destroy();
    this.labelContainer.destroy();
    this.hoverLabel.destroy();
  }

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private findNearestUnit(px: number, py: number): Unit | null {
    if (!this.team) return null;
    let closest: Unit | null = null;
    let closestDist = UNIT_SELECT_RADIUS;

    for (const unit of this.units) {
      if (!unit.alive || unit.team !== this.team) continue;
      const dist = distancePt(unit.pos, { x: px, y: py });
      if (dist < closestDist) {
        closest = unit;
        closestDist = dist;
      }
    }
    return closest;
  }

  private findNearestEnemy(px: number, py: number): Unit | null {
    if (!this.team) return null;
    let closest: Unit | null = null;
    let closestDist = UNIT_SELECT_RADIUS;

    for (const unit of this.units) {
      if (!unit.alive || unit.team === this.team) continue;
      const dist = distancePt(unit.pos, { x: px, y: py });
      if (dist < closestDist) {
        closest = unit;
        closestDist = dist;
      }
    }
    return closest;
  }

  private onPointerDown = (e: { global: { x: number; y: number }; button?: number }): void => {
    if (!this.enabled || !this.team) return;
    // Ignore right clicks for path drawing
    if (e.button === 2) return;

    const closest = this.findNearestUnit(e.global.x, e.global.y);
    if (closest) {
      this.hoveredEnemy = null;
      this.selectedUnit = closest;
      this.rawPoints = [{ x: closest.pos.x, y: closest.pos.y }];
      this.renderHoverLayer();
      return;
    }

    // Tap on enemy → show their range
    const enemy = this.findNearestEnemy(e.global.x, e.global.y);
    this.hoveredEnemy = enemy;
    this.renderHoverLayer();
  };

  private onPointerMove = (e: { global: { x: number; y: number } }): void => {
    if (!this.enabled) return;

    // Update hover state
    if (!this.selectedUnit) {
      const prev = this.hoveredUnit;
      this.hoveredUnit = this.findNearestUnit(e.global.x, e.global.y);
      // If not hovering own unit, check for enemy
      const prevEnemy = this.hoveredEnemy;
      if (!this.hoveredUnit) {
        this.hoveredEnemy = this.findNearestEnemy(e.global.x, e.global.y);
      } else {
        this.hoveredEnemy = null;
      }
      if (this.hoveredUnit !== prev || this.hoveredEnemy !== prevEnemy) this.renderHoverLayer();
    }

    // Drawing mode
    if (this.selectedUnit) {
      this.rawPoints.push({ x: e.global.x, y: e.global.y });
      this.renderPaths();
    }
  };

  private onPointerUp = (): void => {
    if (!this.enabled || !this.selectedUnit) return;

    const waypoints = samplePath(this.rawPoints, PATH_SAMPLE_DISTANCE);
    // Skip the first point (unit's current position)
    this.selectedUnit.waypoints = waypoints.slice(1);

    this.selectedUnit = null;
    this.rawPoints = [];
    this.renderPaths();
  };

  private onRightDown = (e: { global: { x: number; y: number } }): void => {
    if (!this.enabled || !this.team) return;

    const unit = this.findNearestUnit(e.global.x, e.global.y);
    if (unit) {
      unit.waypoints = [];
      unit.moveTarget = null;
      this.renderPaths();
    }
  };
}
