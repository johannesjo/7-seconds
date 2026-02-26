import { Graphics, Container, Rectangle } from 'pixi.js';
import { Unit, Team, Vec2, ElevationZone } from './types';
import { PATH_SAMPLE_DISTANCE, UNIT_SELECT_RADIUS, MAP_WIDTH, MAP_HEIGHT, ELEVATION_RANGE_BONUS } from './constants';
import { isOnElevation } from './units';

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

export class PathDrawer {
  private stage: Container;
  private units: Unit[] = [];
  private elevationZones: ElevationZone[] = [];
  private team: Team | null = null;
  private gfx: Graphics;
  private hoverGfx: Graphics;
  private selectedUnit: Unit | null = null;
  private hoveredUnit: Unit | null = null;
  private rawPoints: Vec2[] = [];
  private enabled = false;
  private canvas: HTMLCanvasElement | null = null;

  constructor(stage: Container, canvas?: HTMLCanvasElement) {
    this.stage = stage;
    this.gfx = new Graphics();
    this.hoverGfx = new Graphics();
    this.stage.addChild(this.gfx);
    this.stage.addChild(this.hoverGfx);

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

  enable(team: Team, units: Unit[], elevationZones: ElevationZone[] = []): void {
    this.team = team;
    this.units = units;
    this.elevationZones = elevationZones;
    this.enabled = true;
    this.selectedUnit = null;
    this.hoveredUnit = null;
    this.rawPoints = [];
    this.renderPaths();
  }

  disable(): void {
    this.enabled = false;
    this.team = null;
    this.selectedUnit = null;
    this.hoveredUnit = null;
    this.rawPoints = [];
    this.hoverGfx.clear();
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
    }

    // Draw in-progress raw line (thicker)
    if (this.selectedUnit && this.rawPoints.length > 1) {
      const color = this.team === 'blue' ? 0x4a9eff : 0xff4a4a;
      this.gfx.setStrokeStyle({ width: 4, color, alpha: 0.7 });
      this.gfx.moveTo(this.rawPoints[0].x, this.rawPoints[0].y);
      for (let i = 1; i < this.rawPoints.length; i++) {
        this.gfx.lineTo(this.rawPoints[i].x, this.rawPoints[i].y);
      }
      this.gfx.stroke();
    }

    this.renderHoverLayer();
  }

  private renderHoverLayer(): void {
    this.hoverGfx.clear();
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
      return; // Don't show hover when drawing
    }

    // Hover highlight on nearest own-team unit
    if (this.hoveredUnit) {
      this.hoverGfx.circle(this.hoveredUnit.pos.x, this.hoveredUnit.pos.y, this.hoveredUnit.radius + 4);
      this.hoverGfx.setStrokeStyle({ width: 2, color: teamColor, alpha: 0.6 });
      this.hoverGfx.stroke();
      // Range circle at path endpoint (or current pos if no path)
      const hoverPos = this.hoveredUnit.waypoints.length > 0
        ? this.hoveredUnit.waypoints[this.hoveredUnit.waypoints.length - 1]
        : this.hoveredUnit.pos;
      this.drawRangeCircle(this.hoveredUnit, hoverPos, teamColor);
    }
  }

  /** Call each frame to animate pulsing indicators during planning. */
  updateHover(): void {
    if (this.enabled) this.renderHoverLayer();
  }

  private drawRangeCircle(unit: Unit, pos: Vec2, color: number): void {
    const elevated = isOnElevation(pos, this.elevationZones);
    const range = elevated
      ? unit.range * (1 + ELEVATION_RANGE_BONUS)
      : unit.range;
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
    this.gfx.destroy();
    this.hoverGfx.destroy();
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

  private onPointerDown = (e: { global: { x: number; y: number }; button?: number }): void => {
    if (!this.enabled || !this.team) return;
    // Ignore right clicks for path drawing
    if (e.button === 2) return;

    const closest = this.findNearestUnit(e.global.x, e.global.y);
    if (closest) {
      this.selectedUnit = closest;
      this.rawPoints = [{ x: closest.pos.x, y: closest.pos.y }];
      this.renderHoverLayer();
    }
  };

  private onPointerMove = (e: { global: { x: number; y: number } }): void => {
    if (!this.enabled) return;

    // Update hover state
    if (!this.selectedUnit) {
      const prev = this.hoveredUnit;
      this.hoveredUnit = this.findNearestUnit(e.global.x, e.global.y);
      if (this.hoveredUnit !== prev) this.renderHoverLayer();
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
