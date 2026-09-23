import { Graphics, Container, Rectangle, Text } from 'pixi.js';
import { Unit, Team, Vec2, ElevationZone } from './types';
import { PATH_SAMPLE_DISTANCE, UNIT_SELECT_RADIUS, MAP_WIDTH, MAP_HEIGHT, ELEVATION_RANGE_BONUS, ROUND_DURATION_S, ROCKET_MAX_PATH, ROCKET_BLAST_RADIUS, MORTAR_BLAST_RADIUS, MORTAR_MIN_RANGE } from './constants';
import { samplePath, clampPathLength } from './path-orders';
import { getElevationLevel, mortarCanReach } from './units';
import { Theme, NIGHT_THEME } from './theme';
import { MAX_PREDICTION_TIME_S, predictPath, type PathPrediction } from './path-preview';

function polylineLength(points: Vec2[]): number {
  let length = 0;
  for (let i = 1; i < points.length; i++) length += distancePt(points[i - 1], points[i]);
  return length;
}

function distancePt(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
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

/** Where a rocketeer's rocket launches from: the end of its move path. */
function launchPoint(unit: Unit): Vec2 {
  return unit.waypoints[unit.waypoints.length - 1] ?? unit.pos;
}

// Big enough to grab with a thumb, and far enough out not to cover the unit.
const ROCKET_HANDLE_OFFSET = 38;
const ROCKET_HANDLE_RADIUS = 26;
const ROCKET_HANDLE_DRAW_RADIUS = 15;

/** The grab point for drawing a rocket: just ahead of the launch point, along
 *  the last leg of the move path (or toward the enemy side when standing). */
function rocketHandle(unit: Unit): Vec2 {
  const launch = launchPoint(unit);
  const prev = unit.waypoints.length >= 2 ? unit.waypoints[unit.waypoints.length - 2] : unit.pos;
  let dx = launch.x - prev.x;
  let dy = launch.y - prev.y;
  const len = Math.hypot(dx, dy);
  if (len < 1) {
    dx = 0;
    dy = unit.team === 'blue' ? -1 : 1;
  } else {
    dx /= len;
    dy /= len;
  }
  const margin = ROCKET_HANDLE_RADIUS;
  return {
    x: Math.max(margin, Math.min(MAP_WIDTH - margin, launch.x + dx * ROCKET_HANDLE_OFFSET)),
    y: Math.max(margin, Math.min(MAP_HEIGHT - margin, launch.y + dy * ROCKET_HANDLE_OFFSET)),
  };
}

/** Clear a unit's orders. The rocket launches from the end of the move path,
 *  so a new move voids it. */
function resetOrders(unit: Unit): void {
  unit.waypoints = [];
  unit.moveTarget = null;
  unit.rocketPath = [];
  unit.rocketFired = false;
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
  /** Rocketeer whose rocket flight is being drawn, and the raw stroke. */
  private rocketUnit: Unit | null = null;
  private rawRocket: Vec2[] = [];
  private enabled = false;
  private canvas: HTMLCanvasElement | null = null;
  theme: Theme = NIGHT_THEME;
  private labelContainer: Container;
  private labelPool: Text[] = [];
  private labelIndex = 0;
  private hoverLabel: Text;
  private onZoneHighlight: ((pos: Vec2 | null) => void) | null = null;
  onInspectUnit: ((unit: Unit | null) => void) | null = null;
  private inspectedUnit: Unit | null = null;
  private predictionCache = new WeakMap<Unit, {
    points: Vec2[];
    pos: Vec2;
    vel: Vec2;
    momentum: number | undefined;
    knockbackVel: Vec2 | undefined;
    stuckTime: number | undefined;
    speed: number;
    prediction: PathPrediction;
  }>();

  constructor(stage: Container, canvas?: HTMLCanvasElement, onZoneHighlight?: (pos: Vec2 | null) => void) {
    this.stage = stage;
    this.onZoneHighlight = onZoneHighlight ?? null;
    this.gfx = new Graphics();
    this.hoverGfx = new Graphics();
    this.labelContainer = new Container();
    const hoverStyle: Record<string, unknown> = { fontSize: 11, fontFamily: 'monospace', fill: this.theme.hoverLabelFill, fontWeight: 'bold' };
    if (this.theme.labelStroke !== null) {
      hoverStyle.stroke = { color: this.theme.labelStroke, width: this.theme.labelStrokeWidth };
    }
    this.hoverLabel = new Text({ text: '', style: hoverStyle });
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

  private acquireLabel(): Text {
    if (this.labelIndex < this.labelPool.length) {
      const label = this.labelPool[this.labelIndex];
      label.visible = true;
      this.labelIndex++;
      return label;
    }
    const style: Record<string, unknown> = { fontSize: 11, fontFamily: 'monospace', fill: this.theme.labelFill, fontWeight: 'bold' };
    if (this.theme.labelStroke !== null) {
      style.stroke = { color: this.theme.labelStroke, width: this.theme.labelStrokeWidth };
    }
    const label = new Text({ text: '', style });
    label.anchor.set(0.5, 1);
    this.labelContainer.addChild(label);
    this.labelPool.push(label);
    this.labelIndex++;
    return label;
  }

  private strokePath(gfx: Graphics, points: Vec2[], color: number, width: number, alpha: number): void {
    if (points.length < 2) return;
    gfx.setStrokeStyle({ width, color, alpha });
    gfx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) gfx.lineTo(points[i].x, points[i].y);
    gfx.stroke();
  }

  /** Translucent unit outline marks an approximate position after this round. */
  private drawGhost(gfx: Graphics, unit: Unit, pos: Vec2, color: number, alpha: number): void {
    gfx.circle(pos.x, pos.y, unit.radius);
    gfx.fill({ color, alpha: alpha * 0.13 });
    gfx.circle(pos.x, pos.y, unit.radius);
    gfx.setStrokeStyle({ width: 1.5, color, alpha: alpha * 0.8 });
    gfx.stroke();
    gfx.circle(pos.x, pos.y, 2);
    gfx.fill({ color, alpha: alpha * 0.8 });
  }

  /** Rocket orders for the active team: each rocketeer's handle, its drawn
   *  flight path and the blast at the end. */
  private renderRockets(): void {
    const color = this.theme.bomber;
    for (const unit of this.units) {
      if (!unit.alive || unit.team !== this.team || unit.type !== 'rocketeer') continue;
      const launch = launchPoint(unit);
      const drawing = unit === this.rocketUnit;
      // Sample the live stroke as on release, so the preview and its "max"
      // cut-off match what gets saved.
      const drawn = drawing
        ? samplePath(this.rawRocket, PATH_SAMPLE_DISTANCE).slice(1)
        : unit.rocketPath ?? [];
      const path = clampPathLength(drawn, launch, ROCKET_MAX_PATH);
      if (drawing && path.length > 0 && polylineLength([launch, ...drawn]) > ROCKET_MAX_PATH) {
        // Past the rocket's reach: show the stroke faintly so the cut-off reads.
        this.strokePath(this.gfx, [launch, ...drawn], color, 1.5, 0.25);
        const cut = path[path.length - 1];
        const label = this.acquireLabel();
        label.text = 'max';
        label.style.fill = this.theme.labelWarn;
        label.position.set(cut.x, cut.y - 8);
        label.alpha = 1;
      }
      if (path.length > 0) {
        this.dashPath([launch, ...path], color, drawing ? 3 : 2, drawing ? 1 : 0.8);
        const end = path[path.length - 1];
        // When it blasts: after the move to the launch point, plus flight time.
        const move = unit.waypoints.length > 0
          ? this.prediction(unit, [unit.pos, ...unit.waypoints]).travelTime
          : 0;
        const at = move === null ? null : move + polylineLength([launch, ...path]) / unit.projectileSpeed;
        const late = at === null || at > ROUND_DURATION_S;
        const text = late ? 'too late' : `blast ~${at.toFixed(1)}s`;
        this.drawBlast(this.gfx, end, ROCKET_BLAST_RADIUS, color, drawing ? 1 : 0.8, text, late);
      }
      if (!drawing) this.drawRocketHandle(rocketHandle(unit), color, path.length === 0);
    }
  }

  /** Blast area: filled disc with a solid rim and a label, so players can
   *  judge what it will catch. */
  private drawBlast(gfx: Graphics, at: Vec2, radius: number, color: number, alpha: number, text = 'blast', warn = false): void {
    gfx.circle(at.x, at.y, radius);
    gfx.fill({ color, alpha: 0.16 * alpha });
    gfx.circle(at.x, at.y, radius);
    gfx.setStrokeStyle({ width: 2, color, alpha: 0.85 * alpha });
    gfx.stroke();
    gfx.circle(at.x, at.y, 2.5);
    gfx.fill({ color, alpha });
    if (gfx === this.gfx) {
      const label = this.acquireLabel();
      label.text = text;
      label.style.fill = warn ? this.theme.labelWarn : this.theme.labelFill;
      label.position.set(at.x, at.y + radius + 14);
      label.alpha = alpha;
    }
  }

  /** Mortar dead zone: dashed ring inside which it cannot lob shells. */
  private drawMortarDeadZone(gfx: Graphics, mortar: Unit): void {
    const color = this.theme.labelWarn;
    const { x, y } = mortar.pos;
    gfx.circle(x, y, MORTAR_MIN_RANGE);
    gfx.fill({ color, alpha: 0.08 });
    const ring: Vec2[] = [];
    for (let i = 0; i <= 48; i++) {
      const a = (i / 48) * Math.PI * 2;
      ring.push({ x: x + Math.cos(a) * MORTAR_MIN_RANGE, y: y + Math.sin(a) * MORTAR_MIN_RANGE });
    }
    this.dashPath(ring, color, 2, 0.8, gfx);
  }

  private dashPath(points: Vec2[], color: number, width: number, alpha: number, gfx: Graphics = this.gfx): void {
    const DASH = 8;
    const GAP = 5;
    gfx.setStrokeStyle({ width, color, alpha });
    let on = true;
    let left = DASH;
    for (let i = 1; i < points.length; i++) {
      let from = points[i - 1];
      const to = points[i];
      let seg = Math.hypot(to.x - from.x, to.y - from.y);
      while (seg > 0) {
        const step = Math.min(left, seg);
        const t = step / seg;
        const next = { x: from.x + (to.x - from.x) * t, y: from.y + (to.y - from.y) * t };
        if (on) {
          gfx.moveTo(from.x, from.y);
          gfx.lineTo(next.x, next.y);
        }
        seg -= step;
        left -= step;
        from = next;
        if (left <= 0) {
          on = !on;
          left = on ? DASH : GAP;
        }
      }
    }
    gfx.stroke();
  }

  /** Rocket glyph players drag from; lighter while no rocket is drawn. */
  private drawRocketHandle(at: Vec2, color: number, empty: boolean): void {
    const r = ROCKET_HANDLE_DRAW_RADIUS;
    this.gfx.circle(at.x, at.y, r);
    this.gfx.fill({ color, alpha: empty ? 0.2 : 0.35 });
    this.gfx.circle(at.x, at.y, r);
    this.gfx.setStrokeStyle({ width: 2, color, alpha: 0.95 });
    this.gfx.stroke();
    this.gfx.poly([at.x, at.y - 9, at.x + 4.5, at.y + 3, at.x, at.y + 7, at.x - 4.5, at.y + 3]);
    this.gfx.fill({ color, alpha: 0.95 });
  }

  private findRocketHandle(px: number, py: number): Unit | null {
    for (const unit of this.units) {
      if (!unit.alive || unit.team !== this.team || unit.type !== 'rocketeer') continue;
      const toHandle = distancePt(rocketHandle(unit), { x: px, y: py });
      if (toHandle > ROCKET_HANDLE_RADIUS) continue;
      // The handle overlaps units' tap areas: it only wins when the pointer
      // is nearer to it than to any of our units.
      const nearerUnit = this.units.some(u => u.alive && u.team === this.team
        && distancePt(u.pos, { x: px, y: py }) <= toHandle);
      if (!nearerUnit) return unit;
    }
    return null;
  }

  /** Baseline for the time label at a path's end: above it, except for our
   *  rocketeers, whose rocket handle sits there; theirs goes below. */
  private endLabelY(unit: Unit, end: Vec2, overLimit: boolean): number {
    const gap = overLimit ? 12 : unit.radius + 6;
    return unit.type === 'rocketeer' && unit.team === this.team ? end.y + gap + 14 : end.y - gap;
  }

  private prediction(unit: Unit, points: Vec2[]): PathPrediction {
    const cached = this.predictionCache.get(unit);
    if (cached && cached.speed === unit.speed && cached.momentum === unit.momentum &&
      cached.stuckTime === unit.stuckTime &&
      cached.knockbackVel?.x === unit.knockbackVel?.x &&
      cached.knockbackVel?.y === unit.knockbackVel?.y &&
      cached.pos.x === unit.pos.x && cached.pos.y === unit.pos.y &&
      cached.vel.x === unit.vel.x && cached.vel.y === unit.vel.y &&
      cached.points.length === points.length &&
      cached.points.every((p, i) => p.x === points[i].x && p.y === points[i].y)) {
      return cached.prediction;
    }
    const prediction = predictPath(unit, points);
    this.predictionCache.set(unit, {
      points: points.map(p => ({ ...p })), pos: { ...unit.pos }, vel: { ...unit.vel },
      momentum: unit.momentum, knockbackVel: unit.knockbackVel ? { ...unit.knockbackVel } : undefined,
      stuckTime: unit.stuckTime, speed: unit.speed, prediction,
    });
    return prediction;
  }

  private timeText(time: number | null): string {
    return time === null ? `>${MAX_PREDICTION_TIME_S}s` : `~${time.toFixed(1)}s`;
  }

  private syncInspectedUnit(): void {
    const inspected = this.enabled ? this.selectedUnit ?? this.hoveredUnit ?? this.hoveredEnemy : null;
    if (inspected !== this.inspectedUnit) {
      this.inspectedUnit = inspected;
      this.onInspectUnit?.(inspected);
    }
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
    this.predictionCache = new WeakMap();
    this.renderPaths();
  }

  disable(): void {
    this.enabled = false;
    this.team = null;
    this.selectedUnit = null;
    this.hoveredUnit = null;
    this.hoveredEnemy = null;
    this.rawPoints = [];
    this.rocketUnit = null;
    this.rawRocket = [];
    this.inspectedUnit = null;
    this.onInspectUnit?.(null);
    this.hoverGfx.clear();
    for (const label of this.labelPool) label.visible = false;
    this.onZoneHighlight?.(null);
  }

  /** Clear all waypoints for a team (called at start of their planning phase). */
  clearPaths(team: Team): void {
    for (const unit of this.units) {
      if (unit.team === team && unit.alive) resetOrders(unit);
    }
    this.renderPaths();
  }

  renderPaths(): void {
    this.gfx.clear();
    this.labelIndex = 0;

    for (const unit of this.units) {
      if (!unit.alive || unit.waypoints.length === 0) continue;
      // Only show the active team's movement lines during planning
      if (unit.team !== this.team) continue;

      const color = unit.team === 'blue' ? this.theme.bluePath : this.theme.redPath;
      const alpha = 0.8;
      const fullPath: Vec2[] = [unit.pos, ...unit.waypoints];
      const { reached, remainder, position, travelTime, tickDistances } = this.prediction(unit, fullPath);
      this.strokePath(this.gfx, reached, color, 2, alpha);
      this.strokePath(this.gfx, remainder, color, 2, alpha * 0.22);
      this.drawGhost(this.gfx, unit, position, color, alpha);

      const last = unit.waypoints[unit.waypoints.length - 1];
      if (remainder.length > 0) {
        this.gfx.circle(last.x, last.y, 3);
        this.gfx.fill({ color, alpha: alpha * 0.25 });
      }

      // Ticks mark seconds reachable within this round.
      const tickAlpha = alpha * 0.5;
      for (const d of tickDistances) {
        const { pos: tp, angle: ta } = pointAtDistance(fullPath, d);
        const nx = Math.cos(ta + Math.PI / 2) * 4;
        const ny = Math.sin(ta + Math.PI / 2) * 4;
        this.gfx.setStrokeStyle({ width: 1, color, alpha: tickAlpha });
        this.gfx.moveTo(tp.x - nx, tp.y - ny);
        this.gfx.lineTo(tp.x + nx, tp.y + ny);
        this.gfx.stroke();
      }

      const overLimit = travelTime === null || travelTime > ROUND_DURATION_S;
      const timeLabel = this.acquireLabel();
      timeLabel.text = this.timeText(travelTime);
      timeLabel.style.fill = overLimit ? this.theme.labelWarn : this.theme.labelFill;
      timeLabel.position.set(last.x, this.endLabelY(unit, last, overLimit));
      timeLabel.alpha = alpha;
      if (overLimit) {
        const roundLabel = this.acquireLabel();
        roundLabel.text = `~${ROUND_DURATION_S}s`;
        roundLabel.style.fill = this.theme.labelFill;
        roundLabel.position.set(position.x, position.y - unit.radius - 6);
        roundLabel.alpha = alpha;
      }
    }

    // Draw in-progress raw line (thicker + brighter than finalized paths)
    if (this.selectedUnit && this.rawPoints.length > 1) {
      const color = this.team === 'blue' ? this.theme.bluePathBright : this.theme.redPathBright;
      const { reached, remainder, position, travelTime, tickDistances } = this.prediction(this.selectedUnit, this.rawPoints);
      this.strokePath(this.gfx, reached, color, 4, 1);
      this.strokePath(this.gfx, remainder, color, 3, 0.22);
      this.drawGhost(this.gfx, this.selectedUnit, position, color, 1);

      // Tick marks + live time label for in-progress path
      for (const d of tickDistances) {
        const { pos: tp, angle: ta } = pointAtDistance(this.rawPoints, d);
        const nx = Math.cos(ta + Math.PI / 2) * 5;
        const ny = Math.sin(ta + Math.PI / 2) * 5;
        this.gfx.setStrokeStyle({ width: 1.5, color, alpha: 0.8 });
        this.gfx.moveTo(tp.x - nx, tp.y - ny);
        this.gfx.lineTo(tp.x + nx, tp.y + ny);
        this.gfx.stroke();
      }

      const endpoint = this.rawPoints[this.rawPoints.length - 1];
      this.onZoneHighlight?.(position);
      const rawOverLimit = travelTime === null || travelTime > ROUND_DURATION_S;
      const liveLabel = this.acquireLabel();
      liveLabel.text = this.timeText(travelTime);
      liveLabel.style.fill = rawOverLimit ? this.theme.labelWarn : this.theme.labelFill;
      liveLabel.position.set(endpoint.x, this.endLabelY(this.selectedUnit, endpoint, rawOverLimit));
      liveLabel.alpha = 1.0;
      if (rawOverLimit) {
        const roundLabel = this.acquireLabel();
        roundLabel.text = `~${ROUND_DURATION_S}s`;
        roundLabel.style.fill = this.theme.labelFill;
        roundLabel.position.set(position.x, position.y - this.selectedUnit.radius - 6);
      }
    } else {
      this.onZoneHighlight?.(null);
    }

    this.renderRockets();

    // Hide unused pool labels
    for (let i = this.labelIndex; i < this.labelPool.length; i++) {
      this.labelPool[i].visible = false;
    }

    this.renderHoverLayer();
  }

  private renderHoverLayer(): void {
    this.syncInspectedUnit();
    this.hoverGfx.clear();
    this.hoverLabel.visible = false;
    if (!this.enabled || !this.team) return;

    const teamColor = this.team === 'blue' ? this.theme.bluePath : this.theme.redPath;
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

      if (unit.type === 'rocketeer' && unit !== this.rocketUnit && !(unit.rocketPath?.length)) {
        // No rocket drawn yet: pulse its handle the same way.
        const handle = rocketHandle(unit);
        this.hoverGfx.circle(handle.x, handle.y, ROCKET_HANDLE_DRAW_RADIUS + 3 + pulse * 4);
        this.hoverGfx.setStrokeStyle({ width: 2, color: this.theme.bomber, alpha: 0.25 + pulse * 0.45 });
        this.hoverGfx.stroke();
      }
    }

    // Selection ring on actively drawn unit
    if (this.selectedUnit) {
      this.hoverGfx.circle(this.selectedUnit.pos.x, this.selectedUnit.pos.y, this.selectedUnit.radius + 5);
      this.hoverGfx.setStrokeStyle({ width: 2.5, color: teamColor, alpha: 1.0 });
      this.hoverGfx.stroke();
      // Range preview follows the estimated round-end position.
      const endPos = this.rawPoints.length > 0
        ? this.prediction(this.selectedUnit, this.rawPoints).position
        : this.selectedUnit.pos;
      this.drawRangeCircle(this.selectedUnit, endPos, teamColor);

      return; // Don't show hover when drawing
    }

    // Hover highlight on nearest own-team unit
    if (this.hoveredUnit) {
      this.hoverGfx.circle(this.hoveredUnit.pos.x, this.hoveredUnit.pos.y, this.hoveredUnit.radius + 4);
      this.hoverGfx.setStrokeStyle({ width: 2, color: teamColor, alpha: 0.6 });
      this.hoverGfx.stroke();

      // Highlight path + time label on hover
      if (this.hoveredUnit.waypoints.length > 0) {
        const brightColor = this.team === 'blue' ? this.theme.bluePathBright : this.theme.redPathBright;
        const fullPath: Vec2[] = [this.hoveredUnit.pos, ...this.hoveredUnit.waypoints];
        const { reached, remainder, position, travelTime } = this.prediction(this.hoveredUnit, fullPath);
        this.strokePath(this.hoverGfx, reached, brightColor, 3, 1);
        this.strokePath(this.hoverGfx, remainder, brightColor, 2, 0.22);
        this.drawGhost(this.hoverGfx, this.hoveredUnit, position, brightColor, 1);

        const last = this.hoveredUnit.waypoints[this.hoveredUnit.waypoints.length - 1];
        const overLimit = travelTime === null || travelTime > ROUND_DURATION_S;
        this.hoverLabel.text = this.timeText(travelTime);
        this.hoverLabel.style.fill = overLimit ? this.theme.labelWarn : this.theme.hoverLabelFill;
        this.hoverLabel.position.set(last.x, this.endLabelY(this.hoveredUnit, last, overLimit));
        this.hoverLabel.alpha = 1;
        this.hoverLabel.visible = true;
      }

      // Range circle at estimated round end (or current pos if no path)
      const hoverPos = this.hoveredUnit.waypoints.length > 0
        ? this.prediction(this.hoveredUnit, [this.hoveredUnit.pos, ...this.hoveredUnit.waypoints]).position
        : this.hoveredUnit.pos;
      this.drawRangeCircle(this.hoveredUnit, hoverPos, teamColor);
    }

    // Enemy unit range preview (tap or hover)
    if (this.hoveredEnemy && !this.selectedUnit) {
      const enemyColor = this.hoveredEnemy.team === 'red' ? this.theme.redPath : this.theme.bluePath;
      this.hoverGfx.circle(this.hoveredEnemy.pos.x, this.hoveredEnemy.pos.y, this.hoveredEnemy.radius + 4);
      this.hoverGfx.setStrokeStyle({ width: 2, color: enemyColor, alpha: 0.6 });
      this.hoverGfx.stroke();

      // Show enemy path + time on hover
      if (this.hoveredEnemy.waypoints.length > 0) {
        const fullPath: Vec2[] = [this.hoveredEnemy.pos, ...this.hoveredEnemy.waypoints];
        const { reached, remainder, position, travelTime } = this.prediction(this.hoveredEnemy, fullPath);
        this.strokePath(this.hoverGfx, reached, enemyColor, 2, 0.5);
        this.strokePath(this.hoverGfx, remainder, enemyColor, 2, 0.13);
        this.drawGhost(this.hoverGfx, this.hoveredEnemy, position, enemyColor, 0.6);

        const last = this.hoveredEnemy.waypoints[this.hoveredEnemy.waypoints.length - 1];
        const overLimit = travelTime === null || travelTime > ROUND_DURATION_S;
        this.hoverLabel.text = this.timeText(travelTime);
        this.hoverLabel.style.fill = overLimit ? this.theme.labelWarn : this.theme.hoverLabelFill;
        this.hoverLabel.position.set(last.x, this.endLabelY(this.hoveredEnemy, last, overLimit));
        this.hoverLabel.alpha = 0.6;
        this.hoverLabel.visible = true;
      }

      const enemyEndPos = this.hoveredEnemy.waypoints.length > 0
        ? this.prediction(this.hoveredEnemy, [this.hoveredEnemy.pos, ...this.hoveredEnemy.waypoints]).position
        : this.hoveredEnemy.pos;
      this.drawRangeCircle(this.hoveredEnemy, enemyEndPos, enemyColor);
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
    const ringColor = elevated ? this.theme.elevationBonus : color;

    if (elevated) {
      for (const z of this.elevationZones) {
        if (pos.x >= z.x && pos.x <= z.x + z.w && pos.y >= z.y && pos.y <= z.y + z.h) {
          this.hoverGfx.roundRect(z.x, z.y, z.w, z.h, 6);
          this.hoverGfx.setStrokeStyle({ width: 1.5, color: this.theme.elevationBonus, alpha: 0.4 });
          this.hoverGfx.stroke();
        }
      }
    }

    this.hoverGfx.circle(pos.x, pos.y, range + unit.radius);
    this.hoverGfx.setStrokeStyle({ width: 1, color: ringColor, alpha: this.theme.rangeStrokeAlpha });
    this.hoverGfx.stroke();
    this.hoverGfx.circle(pos.x, pos.y, range + unit.radius);
    this.hoverGfx.fill({ color: ringColor, alpha: this.theme.rangeFillAlpha });

    if (unit.type === 'mortar') {
      // Highlight where it can't fire, and preview a shell's blast on the
      // enemy it would target from here.
      this.drawMortarDeadZone(this.hoverGfx, { ...unit, pos });
      const probe = { ...unit, pos };
      let nearest: Unit | null = null;
      for (const u of this.units) {
        if (!u.alive || u.team === unit.team || !mortarCanReach(probe, u, this.elevationZones)) continue;
        if (!nearest || distancePt(pos, u.pos) < distancePt(pos, nearest.pos)) nearest = u;
      }
      if (nearest) this.drawBlast(this.hoverGfx, nearest.pos, MORTAR_BLAST_RADIUS, color, 0.9);
    }
  }

  clearGraphics(): void {
    this.gfx.clear();
    this.hoverGfx.clear();
    for (const label of this.labelPool) label.visible = false;
  }

  destroy(): void {
    this.enabled = false;
    this.inspectedUnit = null;
    this.onInspectUnit?.(null);
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

  /** Convert global (screen) coordinates to stage-local coordinates (handles stage scale/offset). */
  private toLocal(global: { x: number; y: number }): { x: number; y: number } {
    return this.stage.toLocal(global);
  }

  private onPointerDown = (e: { global: { x: number; y: number }; button?: number }): void => {
    if (!this.enabled || !this.team) return;
    // Ignore right clicks for path drawing
    if (e.button === 2) return;
    const pos = this.toLocal(e.global);

    const rocketeer = this.findRocketHandle(pos.x, pos.y);
    if (rocketeer) {
      this.hoveredEnemy = null;
      this.hoveredUnit = rocketeer;
      this.rocketUnit = rocketeer;
      rocketeer.rocketPath = [];
      rocketeer.rocketFired = false;
      this.rawRocket = [{ ...launchPoint(rocketeer) }];
      this.renderPaths();
      return;
    }

    const closest = this.findNearestUnit(pos.x, pos.y);
    if (closest) {
      this.hoveredEnemy = null;
      this.hoveredUnit = closest;
      this.selectedUnit = closest;
      resetOrders(closest);
      this.rawPoints = [{ x: closest.pos.x, y: closest.pos.y }];
      this.renderPaths();
      return;
    }

    // Tap on enemy → show their range
    const enemy = this.findNearestEnemy(pos.x, pos.y);
    this.hoveredUnit = null;
    this.hoveredEnemy = enemy;
    this.renderHoverLayer();
  };

  private onPointerMove = (e: { global: { x: number; y: number } }): void => {
    if (!this.enabled) return;
    const pos = this.toLocal(e.global);

    // Update hover state
    if (!this.selectedUnit && !this.rocketUnit) {
      const prev = this.hoveredUnit;
      this.hoveredUnit = this.findNearestUnit(pos.x, pos.y);
      // If not hovering own unit, check for enemy
      const prevEnemy = this.hoveredEnemy;
      if (!this.hoveredUnit) {
        this.hoveredEnemy = this.findNearestEnemy(pos.x, pos.y);
      } else {
        this.hoveredEnemy = null;
      }
      if (this.hoveredUnit !== prev || this.hoveredEnemy !== prevEnemy) this.renderHoverLayer();
    }

    if (this.rocketUnit) {
      this.rawRocket.push({ x: pos.x, y: pos.y });
      this.renderPaths();
      return;
    }

    // Drawing mode
    if (this.selectedUnit) {
      this.rawPoints.push({ x: pos.x, y: pos.y });
      this.renderPaths();
    }
  };

  private onPointerUp = (): void => {
    if (!this.enabled) return;
    if (this.rocketUnit) {
      const unit = this.rocketUnit;
      const sampled = samplePath(this.rawRocket, PATH_SAMPLE_DISTANCE).slice(1);
      unit.rocketPath = clampPathLength(sampled, launchPoint(unit), ROCKET_MAX_PATH);
      unit.rocketFired = false;
      this.rocketUnit = null;
      this.rawRocket = [];
      this.renderPaths();
      return;
    }
    if (!this.selectedUnit) return;

    const waypoints = samplePath(this.rawPoints, PATH_SAMPLE_DISTANCE);
    // Skip the first point (unit's current position)
    this.selectedUnit.waypoints = waypoints.slice(1);

    this.hoveredUnit = this.selectedUnit;
    this.selectedUnit = null;
    this.rawPoints = [];
    this.renderPaths();
  };

  private onRightDown = (e: { global: { x: number; y: number } }): void => {
    if (!this.enabled || !this.team) return;
    const pos = this.toLocal(e.global);
    const unit = this.findNearestUnit(pos.x, pos.y);
    if (unit) {
      resetOrders(unit);
      this.renderPaths();
    }
  };
}
