import { Graphics, Container, Rectangle } from 'pixi.js';
import { Unit, Team, Vec2 } from './types';
import { PATH_SAMPLE_DISTANCE, UNIT_SELECT_RADIUS, MAP_WIDTH, MAP_HEIGHT } from './constants';

/** Sample a polyline from raw pointer positions, keeping points ≥ minDist apart. */
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

export class PathDrawer {
  private stage: Container;
  private units: Unit[] = [];
  private team: Team | null = null;
  private gfx: Graphics;
  private selectedUnit: Unit | null = null;
  private rawPoints: Vec2[] = [];
  private enabled = false;

  constructor(stage: Container) {
    this.stage = stage;
    this.gfx = new Graphics();
    this.stage.addChild(this.gfx);

    // Make stage interactive for canvas-wide pointer events
    this.stage.eventMode = 'static';
    this.stage.hitArea = new Rectangle(0, 0, MAP_WIDTH, MAP_HEIGHT);

    this.stage.on('pointerdown', this.onPointerDown);
    this.stage.on('pointermove', this.onPointerMove);
    this.stage.on('pointerup', this.onPointerUp);
    this.stage.on('pointerupoutside', this.onPointerUp);
  }

  enable(team: Team, units: Unit[]): void {
    this.team = team;
    this.units = units;
    this.enabled = true;
    this.selectedUnit = null;
    this.rawPoints = [];
    this.renderPaths();
  }

  disable(): void {
    this.enabled = false;
    this.team = null;
    this.selectedUnit = null;
    this.rawPoints = [];
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

    // Draw in-progress raw line
    if (this.selectedUnit && this.rawPoints.length > 1) {
      const color = this.team === 'blue' ? 0x4a9eff : 0xff4a4a;
      this.gfx.setStrokeStyle({ width: 2, color, alpha: 0.5 });
      this.gfx.moveTo(this.rawPoints[0].x, this.rawPoints[0].y);
      for (let i = 1; i < this.rawPoints.length; i++) {
        this.gfx.lineTo(this.rawPoints[i].x, this.rawPoints[i].y);
      }
      this.gfx.stroke();
    }
  }

  clearGraphics(): void {
    this.gfx.clear();
  }

  destroy(): void {
    this.stage.off('pointerdown', this.onPointerDown);
    this.stage.off('pointermove', this.onPointerMove);
    this.stage.off('pointerup', this.onPointerUp);
    this.stage.off('pointerupoutside', this.onPointerUp);
    this.stage.removeChild(this.gfx);
    this.gfx.destroy();
  }

  private onPointerDown = (e: { global: { x: number; y: number } }): void => {
    if (!this.enabled || !this.team) return;

    const px = e.global.x;
    const py = e.global.y;

    // Find closest own-team unit within select radius
    let closest: Unit | null = null;
    let closestDist = UNIT_SELECT_RADIUS;

    for (const unit of this.units) {
      if (!unit.alive || unit.team !== this.team) continue;
      const dx = unit.pos.x - px;
      const dy = unit.pos.y - py;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist < closestDist) {
        closest = unit;
        closestDist = dist;
      }
    }

    if (closest) {
      this.selectedUnit = closest;
      this.rawPoints = [{ x: closest.pos.x, y: closest.pos.y }];
    }
  };

  private onPointerMove = (e: { global: { x: number; y: number } }): void => {
    if (!this.enabled || !this.selectedUnit) return;
    this.rawPoints.push({ x: e.global.x, y: e.global.y });
    this.renderPaths();
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
}
