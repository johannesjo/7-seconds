import { Graphics, Container, Rectangle, Text } from 'pixi.js';
import { Unit, Team, Vec2, ElevationZone } from './types';
import { PATH_SAMPLE_DISTANCE, UNIT_SELECT_RADIUS, MAP_WIDTH, MAP_HEIGHT, ELEVATION_RANGE_BONUS, ROUND_DURATION_S, ROCKET_MAX_PATH, ROCKET_BLAST_RADIUS, MORTAR_BLAST_RADIUS, MORTAR_MIN_RANGE, FLANK_ANGLE_THRESHOLD } from './constants';
import { samplePath, clampPathLength } from './path-orders';
import { getElevationLevel, mortarCanReach } from './units';
import { Theme, NIGHT_THEME } from './theme';
import { MAX_PREDICTION_TIME_S, predictPath, type PathPrediction } from './path-preview';
import { PinchZoom } from './plan-zoom';
import { pulse } from './haptics';

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

/** Grab radius around the end of a drawn path: dragging from it continues
 *  the path instead of redrawing it from the unit. */
const PATH_END_RADIUS = 24;
const PATH_END_DRAW_RADIUS = 5;

/** What a press on the map picks up: a unit (draw a new path), the end of
 *  its path (continue it) or a rocketeer's rocket handle. */
type Grab = { kind: 'unit' | 'end' | 'rocket'; unit: Unit };

/** Where a grab sits on the map. */
function grabPoint(grab: Grab): Vec2 {
  const { kind, unit } = grab;
  if (kind === 'rocket') return rocketHandle(unit);
  if (kind === 'end') return unit.waypoints[unit.waypoints.length - 1] ?? unit.pos;
  return unit.pos;
}

/** Map units over which a continued stroke eases from the path's end onto
 *  the finger, so grabbing the end off-centre leaves no hook at the join. */
const GRAB_EASE = 40;

/** The parts of a pixi pointer event the drawer reads. */
type PointerInput = { global: Vec2; client?: Vec2; pointerId?: number };

/** Pointer position in CSS pixels, so drag thresholds feel the same however
 *  the canvas is scaled. */
function screenPoint(e: PointerInput): Vec2 {
  const p = e.client ?? e.global;
  return { x: p.x, y: p.y };
}

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

/** Units whose auto-targeting a focus order steers: ranged gunners and
 *  mortars. Melee units (blade, shielder, zombie) fight whatever is next to
 *  them, and rocketeers and bombers have no auto weapon. */
function canFocus(unit: Unit): boolean {
  return unit.type === 'soldier' || unit.type === 'sniper' || unit.type === 'mortar';
}

const FOCUS_HINT_KEY = '7s-focus-hint-seen';
/** Taps that wander further than this (CSS pixels) are drags, not focus taps. */
const TAP_SLOP = 12;
/** However far the map is zoomed out, a unit, path end or rocket handle can
 *  be grabbed from this many CSS pixels away: about a fingertip. */
const MIN_GRAB_PX = 22;
/** Screen pixels a press on a unit, path end or rocket handle must travel
 *  before it starts drawing. Shorter presses are taps (inspect) or holds
 *  (clear), and leave the orders alone. */
const DRAG_START_PX = 8;
/** Hold this long without moving, then release, to clear the orders. */
const HOLD_CLEAR_MS = 500;
/** The hold ring only shows after this, so plain taps don't flash it. */
const HOLD_SHOW_MS = 150;

function focusHintSeen(): boolean {
  try { return localStorage.getItem(FOCUS_HINT_KEY) === '1'; } catch { return false; }
}

type Orders = Pick<Unit, 'waypoints' | 'moveTarget' | 'rocketPath' | 'rocketFired' | 'attackTargetId'>;

function copyOrders(unit: Unit): Orders {
  return {
    waypoints: [...unit.waypoints],
    moveTarget: unit.moveTarget,
    rocketPath: unit.rocketPath && [...unit.rocketPath],
    rocketFired: unit.rocketFired,
    attackTargetId: unit.attackTargetId,
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
  /** How many of the selected unit's existing waypoints the stroke keeps:
   *  0 for a fresh path, all of them when continuing from its end. */
  private keptWaypoints = 0;
  /** Pointer is over the end of the hovered unit's path (desktop hover). */
  private hoveredEnd = false;
  /** A press that hasn't moved far enough to draw yet: lifting it is a tap
   *  (inspect), or, once `ready` after a hold, clears the grabbed orders. */
  private press: { grab: Grab; client: Vec2; local: Vec2; at: number; ready: boolean } | null = null;
  /** Continuing a path grabbed off-centre: the gap from the finger to the
   *  path's end, faded out as the finger travels from where it pressed. */
  private grabOffset: { dx: number; dy: number; from: Vec2; travel: number } | null = null;
  /** Rocketeer whose rocket flight is being drawn, and the raw stroke. */
  private rocketUnit: Unit | null = null;
  private rawRocket: Vec2[] = [];
  private enabled = false;
  private canvas: HTMLCanvasElement | null = null;
  private _theme: Theme = NIGHT_THEME;
  get theme(): Theme { return this._theme; }
  set theme(theme: Theme) {
    this._theme = theme;
    this.styleFocusHint();
  }
  private labelContainer: Container;
  private labelPool: Text[] = [];
  private labelIndex = 0;
  private hoverLabel: Text;
  private onZoneHighlight: ((pos: Vec2 | null) => void) | null = null;
  onInspectUnit: ((unit: Unit | null) => void) | null = null;
  /** Night battles: only enemies this returns true for can be inspected or
   *  previewed; null (day) shows every enemy. */
  canSeeEnemy: ((unit: Unit) => boolean) | null = null;
  /** A movement or rocket path was just finished (for UI feedback). */
  onPathDrawn: (() => void) | null = null;
  /** Allow focus-fire orders: tap an enemy right after giving a unit its
   *  path to make that unit prefer shooting it. Off where the orders can't be
   *  sent along (online play). */
  focusFire = false;
  /** The own unit whose orders were given last; tapping an enemy now sets its focus. */
  private armedUnit: Unit | null = null;
  /** An enemy tap that sets the armed unit's focus once the finger lifts
   *  without dragging or pinching. */
  private pendingFocus: { unit: Unit; enemy: Unit; client: Vec2 } | null = null;
  /** A press on open ground (or an enemy) on a zoomed map: dragging it pans
   *  the view; `panning` once it has moved far enough. */
  private panPress: { client: Vec2; panning: boolean } | null = null;
  private focusHint: Text;
  /** The hint teaches the gesture; once used, it stays hidden. */
  private focusHintDone = focusHintSeen();
  /** Pinch zoom became available for this planning phase (map shown small). */
  onZoomAvailable: (() => void) | null = null;
  private zoom: PinchZoom | null = null;
  /** The pointer drawing the current stroke, and the orders it replaced. */
  private strokePointer: number | null = null;
  private strokeBackup: { unit: Unit; orders: Orders } | null = null;
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
    this.focusHint = new Text({ text: 'tap an enemy to focus fire', style: { fontSize: 10, fontFamily: 'monospace', fontWeight: 'bold' } });
    this.focusHint.anchor.set(0.5, 0);
    this.focusHint.visible = false;
    this.styleFocusHint();
    this.stage.addChild(this.gfx);
    this.stage.addChild(this.hoverGfx);
    this.stage.addChild(this.labelContainer);
    this.stage.addChild(this.hoverLabel);
    this.stage.addChild(this.focusHint);

    // Suppress context menu on canvas
    if (canvas) {
      this.canvas = canvas;
      this.canvas.addEventListener('contextmenu', this.onContextMenu);
      this.zoom = new PinchZoom(canvas, stage);
      this.zoom.onAvailable = () => this.onZoomAvailable?.();
      this.zoom.onGestureStart = this.cancelStroke;
      window.addEventListener('pointercancel', this.onPointerCancel);
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

  private markFocusHintDone(): void {
    if (this.focusHintDone) return;
    this.focusHintDone = true;
    try { localStorage.setItem(FOCUS_HINT_KEY, '1'); } catch { /* unavailable */ }
  }

  private styleFocusHint(): void {
    if (!this.focusHint) return; // theme set before construction finished
    this.focusHint.style.fill = this._theme.labelFill;
    this.focusHint.style.stroke = this._theme.labelStroke === null
      ? { width: 0 }
      : { color: this._theme.labelStroke, width: this._theme.labelStrokeWidth };
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

  /** Focus-fire orders for the active team: a dashed line from where each
   *  unit ends its move to the enemy it will prefer, and a reticle on it. */
  private renderFocus(): void {
    if (!this.focusFire) return;
    const color = this.team === 'blue' ? this.theme.bluePath : this.theme.redPath;
    for (const unit of this.units) {
      if (!unit.alive || unit.team !== this.team || !unit.attackTargetId) continue;
      const target = this.units.find(u => u.id === unit.attackTargetId && u.alive);
      // Night: don't draw a reticle on where a hidden enemy really is.
      if (!target || (this.canSeeEnemy && !this.canSeeEnemy(target))) continue;
      const from = unit === this.selectedUnit && this.rawPoints.length > 1
        ? this.prediction(unit, this.rawPoints).position
        : unit.waypoints.length > 0
          ? this.prediction(unit, [unit.pos, ...unit.waypoints]).position
          : unit.pos;
      const len = distancePt(from, target.pos);
      if (len > target.radius + 8) {
        const k = (len - target.radius - 8) / len;
        const to = { x: from.x + (target.pos.x - from.x) * k, y: from.y + (target.pos.y - from.y) * k };
        this.dashPath([from, to], color, 1.5, 0.55);
      }
      this.drawReticle(this.gfx, target, color, 0.95);
    }
  }

  /** Crosshair ring around a focused enemy. */
  private drawReticle(gfx: Graphics, target: Unit, color: number, alpha: number): void {
    const { x, y } = target.pos;
    const r = target.radius + 6;
    gfx.circle(x, y, r);
    gfx.setStrokeStyle({ width: 2, color, alpha });
    gfx.stroke();
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      gfx.moveTo(x + dx * (r - 3), y + dy * (r - 3));
      gfx.lineTo(x + dx * (r + 5), y + dy * (r + 5));
    }
    gfx.stroke();
  }

  /** "Move here and defend": a soldier that reaches the end of its path in
   *  time hunkers there, so mark the end with the frontal arc it will hold,
   *  facing the way it arrives (its gun still turns to the nearest enemy). */
  private drawHoldMarker(unit: Unit, path: Vec2[], color: number, alpha: number): void {
    if (unit.type !== 'soldier' || path.length < 2) return;
    const end = path[path.length - 1];
    const prev = path[path.length - 2];
    const facing = Math.atan2(end.y - prev.y, end.x - prev.x);
    const radius = unit.radius * 1.5;
    const from = facing - FLANK_ANGLE_THRESHOLD;
    this.gfx.moveTo(end.x + Math.cos(from) * radius, end.y + Math.sin(from) * radius);
    this.gfx.arc(end.x, end.y, radius, from, facing + FLANK_ANGLE_THRESHOLD);
    this.gfx.stroke({ width: 2.5, color, alpha: alpha * 0.9 });
  }

  /** Rocket orders for the active team: each rocketeer's handle, its drawn
   *  flight path and the blast at the end. */
  private renderRockets(): void {
    const color = this.theme.bomber;
    for (const unit of this.units) {
      if (!unit.alive || unit.team !== this.team || unit.type !== 'rocketeer') continue;
      // Its move is being drawn: the launch point is still moving.
      if (unit === this.selectedUnit) continue;
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

  /** Map units per CSS pixel at the current canvas size and zoom. */
  private mapUnitsPerPx(): number {
    const width = this.canvas?.getBoundingClientRect().width ?? 0;
    const zoom = this.stage.scale.x;
    if (!(width > 0) || !(zoom > 0)) return 0;
    return MAP_WIDTH / (width * zoom);
  }

  /** A grab radius in map units that never shrinks under a fingertip. */
  private reach(radius: number): number {
    return Math.max(radius, MIN_GRAB_PX * this.mapUnitsPerPx());
  }

  /** What a press here would pick up. The nearest grab point wins, so
   *  units, path ends and rocket handles that overlap stay reachable; on a
   *  tie a unit beats its path end, which beats a rocket handle. */
  private findGrab(px: number, py: number): Grab | null {
    if (!this.team) return null;
    const at = { x: px, y: py };
    let best: Grab | null = null;
    let bestDist = Infinity;
    const consider = (kind: Grab['kind'], unit: Unit, point: Vec2, radius: number): void => {
      const d = distancePt(point, at);
      if (d <= this.reach(radius) && d < bestDist) {
        best = { kind, unit };
        bestDist = d;
      }
    };
    for (const unit of this.units) {
      if (!unit.alive || unit.team !== this.team) continue;
      consider('unit', unit, unit.pos, UNIT_SELECT_RADIUS);
      const end = unit.waypoints[unit.waypoints.length - 1];
      if (end) consider('end', unit, end, PATH_END_RADIUS);
      if (unit.type === 'rocketeer') consider('rocket', unit, rocketHandle(unit), ROCKET_HANDLE_RADIUS);
    }
    return best;
  }

  /** Baseline for the time label at a path's end: above it, unless one of
   *  our rocketeers has its rocket handle there, then on the other side. */
  private endLabelY(unit: Unit, end: Vec2, overLimit: boolean): number {
    const gap = overLimit ? 12 : unit.radius + 6;
    const launch = launchPoint(unit);
    const handleAbove = unit.type === 'rocketeer' && unit.team === this.team
      && launch.x === end.x && launch.y === end.y && rocketHandle(unit).y < end.y;
    return handleAbove ? end.y + gap + 14 : end.y - gap;
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
    this.armedUnit = null;
    this.pendingFocus = null;
    // Forget focus on enemies that died last round.
    for (const u of units) {
      if (u.attackTargetId && !units.some(t => t.id === u.attackTargetId && t.alive)) u.attackTargetId = null;
    }
    this.selectedUnit = null;
    this.hoveredUnit = null;
    this.hoveredEnemy = null;
    this.rawPoints = [];
    this.keptWaypoints = 0;
    this.hoveredEnd = false;
    this.press = null;
    this.grabOffset = null;
    this.panPress = null;
    this.zoom?.cancelPan();
    this.strokePointer = null;
    this.strokeBackup = null;
    this.strokeGlobal = null;
    this.predictionCache = new WeakMap();
    this.zoom?.attach();
    this.renderPaths();
  }

  disable(): void {
    this.enabled = false;
    this.zoom?.detach();
    this.strokePointer = null;
    this.strokeBackup = null;
    this.strokeGlobal = null;
    this.team = null;
    this.armedUnit = null;
    this.pendingFocus = null;
    this.focusHint.visible = false;
    this.selectedUnit = null;
    this.hoveredUnit = null;
    this.hoveredEnemy = null;
    this.rawPoints = [];
    this.keptWaypoints = 0;
    this.hoveredEnd = false;
    this.press = null;
    this.grabOffset = null;
    this.panPress = null;
    this.zoom?.cancelPan();
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
      // Being continued: the live stroke below draws it.
      if (unit === this.selectedUnit) continue;

      const color = unit.team === 'blue' ? this.theme.bluePath : this.theme.redPath;
      const alpha = 0.8;
      const fullPath: Vec2[] = [unit.pos, ...unit.waypoints];
      const { reached, remainder, position, travelTime, tickDistances } = this.prediction(unit, fullPath);
      this.strokePath(this.gfx, reached, color, 2, alpha);
      this.strokePath(this.gfx, remainder, color, 2, alpha * 0.22);
      this.drawGhost(this.gfx, unit, position, color, alpha);

      // Ring at the end: drag from it to continue the path.
      const last = unit.waypoints[unit.waypoints.length - 1];
      this.gfx.circle(last.x, last.y, PATH_END_DRAW_RADIUS);
      this.gfx.fill({ color, alpha: remainder.length > 0 ? alpha * 0.15 : alpha * 0.3 });
      this.gfx.circle(last.x, last.y, PATH_END_DRAW_RADIUS);
      this.gfx.setStrokeStyle({ width: 1.5, color, alpha: remainder.length > 0 ? alpha * 0.4 : alpha });
      this.gfx.stroke();

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
      if (!overLimit) this.drawHoldMarker(unit, fullPath, color, alpha);
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
      if (!rawOverLimit) this.drawHoldMarker(this.selectedUnit, this.rawPoints, color, 1);
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

    this.renderFocus();
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
    this.focusHint.visible = false;
    if (!this.enabled || !this.team) return;

    const armed = this.armedUnit;
    if (this.focusFire && armed && armed.alive && !this.selectedUnit && !this.rocketUnit) {
      const at = armed.waypoints.length > 0
        ? this.prediction(armed, [armed.pos, ...armed.waypoints]).position
        : armed.pos;
      if (!armed.attackTargetId && !this.focusHintDone) {
        this.focusHint.position.set(
          Math.max(70, Math.min(MAP_WIDTH - 70, at.x)),
          Math.min(MAP_HEIGHT - 14, at.y + armed.radius + 6),
        );
        this.focusHint.visible = true;
      }
      // Faint pulsing reticles show which enemies can be picked.
      const enemyColor = this.team === 'blue' ? this.theme.redPath : this.theme.bluePath;
      const p = 0.5 + 0.5 * Math.sin(Date.now() / 300);
      for (const u of this.units) {
        if (!u.alive || u.team === this.team || u.id === armed.attackTargetId) continue;
        this.hoverGfx.circle(u.pos.x, u.pos.y, u.radius + 5 + p * 2);
        this.hoverGfx.setStrokeStyle({ width: 1, color: enemyColor, alpha: 0.25 + p * 0.25 });
        this.hoverGfx.stroke();
      }
    }

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
        if (this.hoveredEnd) {
          this.hoverGfx.circle(last.x, last.y, PATH_END_DRAW_RADIUS + 3);
          this.hoverGfx.setStrokeStyle({ width: 2, color: brightColor, alpha: 1 });
          this.hoverGfx.stroke();
        }
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

    this.drawHold();
  }

  /** Ring that fills while a press is held on something with orders; once
   *  full, releasing clears them. */
  private drawHold(): void {
    const press = this.press;
    if (!press || !this.canClear(press.grab)) return;
    const held = performance.now() - press.at;
    if (held < HOLD_SHOW_MS) return;
    const { kind, unit } = press.grab;
    const at = grabPoint(press.grab);
    const r = kind === 'rocket' ? ROCKET_HANDLE_DRAW_RADIUS + 7
      : kind === 'end' ? PATH_END_DRAW_RADIUS + 10
      : unit.radius + 10;
    const color = this.theme.labelWarn;
    const t = Math.min(1, (held - HOLD_SHOW_MS) / (HOLD_CLEAR_MS - HOLD_SHOW_MS));
    const start = -Math.PI / 2;
    this.hoverGfx.circle(at.x, at.y, r);
    this.hoverGfx.setStrokeStyle({ width: 3, color, alpha: 0.2 });
    this.hoverGfx.stroke();
    this.hoverGfx.moveTo(at.x + Math.cos(start) * r, at.y + Math.sin(start) * r);
    this.hoverGfx.arc(at.x, at.y, r, start, start + t * Math.PI * 2);
    this.hoverGfx.setStrokeStyle({ width: 3, color, alpha: 0.9 });
    this.hoverGfx.stroke();
    if (press.ready) {
      this.hoverLabel.text = kind === 'rocket' ? 'release to clear rocket' : 'release to clear';
      this.hoverLabel.style.fill = color;
      // Below a path's end, where its time label isn't; above anything else.
      const below = at.y + r + 16;
      const y = kind === 'end' && below <= MAP_HEIGHT - 4 ? below : Math.max(16, at.y - r - 6);
      this.hoverLabel.position.set(Math.max(80, Math.min(MAP_WIDTH - 80, at.x)), y);
      this.hoverLabel.alpha = 1;
      this.hoverLabel.visible = true;
      this.focusHint.visible = false;
    }
  }

  /** Call each frame to animate pulsing indicators during planning. */
  updateHover(): void {
    if (!this.enabled) return;
    const press = this.press;
    if (press && !press.ready && performance.now() - press.at >= HOLD_CLEAR_MS && this.canClear(press.grab)) {
      press.ready = true;
      pulse('light');
    }
    this.edgeScroll();
    this.renderHoverLayer();
  }

  /** Where the drawing pointer last was (canvas coordinates), for edge-scroll. */
  private strokeGlobal: Vec2 | null = null;
  private lastFrameAt = 0;

  /** Held near an edge of a zoomed view while drawing: scroll, and keep the
   *  path going under the (still) pointer as the map slides beneath it. */
  private edgeScroll(): void {
    const now = performance.now();
    const dt = Math.min(0.05, (now - (this.lastFrameAt || now)) / 1000);
    this.lastFrameAt = now;
    this.zoom?.tick(dt);
    const drawing = this.selectedUnit !== null || this.rocketUnit !== null;
    if (!drawing || !this.strokeGlobal || !this.zoom || dt <= 0) return;
    if (!this.zoom.edgePan(this.strokeGlobal, dt)) return;
    const pos = this.toLocal(this.strokeGlobal);
    if (this.rocketUnit) this.rawRocket.push({ x: pos.x, y: pos.y });
    else this.rawPoints.push(this.strokePoint(pos));
    this.renderPaths();
  }

  /** A pointer position as a point of the stroke being drawn. */
  private strokePoint(pos: Vec2): Vec2 {
    const g = this.grabOffset;
    if (!g) return { x: pos.x, y: pos.y };
    g.travel = Math.max(g.travel, distancePt(pos, g.from));
    const k = Math.max(0, 1 - g.travel / GRAB_EASE);
    if (k === 0) this.grabOffset = null;
    return { x: pos.x + g.dx * k, y: pos.y + g.dy * k };
  }

  /** Highest zoom available this planning phase (1 when the map fits). */
  get zoomLimit(): number {
    return this.zoom?.zoomLimit ?? 1;
  }

  /** Show a given view of the map (e.g. carried over from the battle). */
  setView(view: { zoom: number; x: number; y: number }): void {
    this.zoom?.setView(view);
  }

  /** Centre the planning view on a map point. */
  focusOn(center: Vec2, zoom: number, ms = 0): void {
    this.zoom?.focusOn(center, zoom, ms);
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
        if (this.canSeeEnemy && !this.canSeeEnemy(u)) continue;
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
    this.zoom?.detach();
    this.inspectedUnit = null;
    this.onInspectUnit?.(null);
    this.stage.off('pointerdown', this.onPointerDown);
    this.stage.off('pointermove', this.onPointerMove);
    this.stage.off('pointerup', this.onPointerUp);
    this.stage.off('pointerupoutside', this.onPointerUp);
    this.stage.off('rightdown', this.onRightDown);
    if (this.canvas) {
      this.canvas.removeEventListener('contextmenu', this.onContextMenu);
      window.removeEventListener('pointercancel', this.onPointerCancel);
    }
    this.stage.removeChild(this.gfx);
    this.stage.removeChild(this.hoverGfx);
    this.stage.removeChild(this.labelContainer);
    this.stage.removeChild(this.hoverLabel);
    this.stage.removeChild(this.focusHint);
    this.focusHint.destroy();
    this.gfx.destroy();
    this.hoverGfx.destroy();
    this.labelContainer.destroy();
    this.hoverLabel.destroy();
  }

  private onContextMenu = (e: Event): void => {
    e.preventDefault();
  };

  private findNearestEnemy(px: number, py: number): Unit | null {
    if (!this.team) return null;
    let closest: Unit | null = null;
    let closestDist = this.reach(UNIT_SELECT_RADIUS);

    for (const unit of this.units) {
      if (!unit.alive || unit.team === this.team) continue;
      if (this.canSeeEnemy && !this.canSeeEnemy(unit)) continue;
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

  /** A second finger landed mid-stroke (a pinch): drop the stroke and give
   *  the unit back the orders it had before. */
  private cancelStroke = (): void => {
    const backup = this.strokeBackup;
    if (backup) Object.assign(backup.unit, backup.orders);
    this.strokeBackup = null;
    this.strokeGlobal = null;
    this.strokePointer = null;
    this.selectedUnit = null;
    this.armedUnit = null;
    this.pendingFocus = null;
    this.hoveredUnit = null;
    this.hoveredEnemy = null;
    this.rocketUnit = null;
    this.rawPoints = [];
    this.keptWaypoints = 0;
    this.hoveredEnd = false;
    this.press = null;
    this.grabOffset = null;
    this.panPress = null;
    this.zoom?.cancelPan();
    this.rawRocket = [];
    this.renderPaths();
  };

  /** The OS took the drawing finger away (e.g. a system gesture). */
  private onPointerCancel = (e: PointerEvent): void => {
    if (this.enabled && e.pointerId === this.strokePointer) this.cancelStroke();
  };

  /** Pointer input the drawer should skip: a pinch, or another finger than
   *  the one drawing. */
  private ignorePointer(pointerId: number | undefined): boolean {
    if (this.zoom?.gesturing) return true;
    return this.strokePointer !== null && pointerId !== this.strokePointer;
  }

  private onPointerDown = (e: PointerInput & { button?: number }): void => {
    if (!this.enabled || !this.team) return;
    // Ignore right clicks for path drawing
    if (e.button === 2) return;
    if (this.ignorePointer(e.pointerId)) return;
    const pos = this.toLocal(e.global);

    const enemy = this.findNearestEnemy(pos.x, pos.y);
    const armed = this.armedUnit;
    const canFocusTap = this.focusFire && enemy !== null && !!armed?.alive;
    const grab = this.findGrab(pos.x, pos.y);
    // Paths often end right by an enemy: with a unit waiting for a focus
    // target, an enemy nearer than the grab point takes the tap.
    const enemyWins = canFocusTap && grab !== null && enemy !== null
      && distancePt(enemy.pos, pos) < distancePt(grabPoint(grab), pos);
    if (grab && !enemyWins) {
      // Nothing changes until the press turns out to be a drag or a hold.
      this.press = { grab, client: screenPoint(e), local: { x: pos.x, y: pos.y }, at: performance.now(), ready: false };
      this.strokePointer = e.pointerId ?? null;
      this.hoveredEnemy = null;
      this.hoveredUnit = grab.unit;
      this.hoveredEnd = grab.kind === 'end';
      // Pressing the armed unit itself (to look at it) keeps it armed.
      if (grab.unit !== armed) this.armedUnit = null;
      this.renderHoverLayer();
      return;
    }

    // Tap on enemy → show their range, and focus it if a unit was just ordered.
    if (canFocusTap && enemy && armed) {
      this.pendingFocus = { unit: armed, enemy, client: screenPoint(e) };
      this.strokePointer = e.pointerId ?? null;
    }
    // On a zoomed map, dragging open ground (or an enemy) moves the view.
    if (this.zoomLimit > 1) {
      this.panPress = { client: screenPoint(e), panning: false };
      this.strokePointer = e.pointerId ?? null;
    }
    // Tapping open ground (or an enemy) ends the unit's turn for orders.
    this.armedUnit = null;
    this.hoveredUnit = null;
    this.hoveredEnemy = enemy;
    this.renderHoverLayer();
  };

  /** A press became a drag: start drawing the grabbed path or rocket. */
  private beginStroke(grab: Grab, pressedAt: Vec2): void {
    const unit = grab.unit;
    this.strokeBackup = { unit, orders: copyOrders(unit) };
    this.hoveredEnd = false;
    this.armedUnit = null;
    if (grab.kind === 'rocket') {
      this.rocketUnit = unit;
      unit.rocketPath = [];
      unit.rocketFired = false;
      this.rawRocket = [{ ...launchPoint(unit) }];
      return;
    }
    this.selectedUnit = unit;
    if (grab.kind === 'end') {
      // Continue the path: keep its waypoints and focus. The rocket
      // launches from the path's end, which is about to move.
      this.keptWaypoints = unit.waypoints.length;
      this.rawPoints = [{ x: unit.pos.x, y: unit.pos.y }, ...unit.waypoints.map(p => ({ x: p.x, y: p.y }))];
      const end = unit.waypoints[unit.waypoints.length - 1];
      this.grabOffset = { dx: end.x - pressedAt.x, dy: end.y - pressedAt.y, from: pressedAt, travel: 0 };
      unit.rocketPath = [];
      unit.rocketFired = false;
    } else {
      this.keptWaypoints = 0;
      resetOrders(unit);
      // New orders start clean, as with right-click: the focus goes too.
      unit.attackTargetId = null;
      this.rawPoints = [{ x: unit.pos.x, y: unit.pos.y }];
    }
  }

  /** Clear what a grab points at: a rocket handle drops just the rocket. */
  private clearGrab(grab: Grab): void {
    const unit = grab.unit;
    if (grab.kind === 'rocket') {
      unit.rocketPath = [];
      unit.rocketFired = false;
    } else {
      resetOrders(unit);
      unit.attackTargetId = null;
      if (this.armedUnit === unit) this.armedUnit = null;
    }
    this.renderPaths();
  }

  /** Whether holding on this grab would clear anything. */
  private canClear(grab: Grab): boolean {
    const unit = grab.unit;
    if (grab.kind === 'rocket') return (unit.rocketPath?.length ?? 0) > 0;
    return unit.waypoints.length > 0 || (unit.rocketPath?.length ?? 0) > 0 || !!unit.attackTargetId;
  }

  private onPointerMove = (e: PointerInput): void => {
    if (!this.enabled) return;
    if (this.ignorePointer(e.pointerId)) return;
    const pos = this.toLocal(e.global);
    const press = this.press;
    if (press) {
      // Still a tap or a hold until the pointer travels far enough.
      const now = screenPoint(e);
      if (Math.hypot(now.x - press.client.x, now.y - press.client.y) < DRAG_START_PX) return;
      this.press = null;
      this.beginStroke(press.grab, press.local);
    }
    const panPress = this.panPress;
    if (panPress) {
      const now = screenPoint(e);
      if (!panPress.panning) {
        // A focus tap on an enemy keeps its usual wobble allowance.
        const slop = this.pendingFocus ? Math.max(TAP_SLOP, DRAG_START_PX) : DRAG_START_PX;
        if (Math.hypot(now.x - panPress.client.x, now.y - panPress.client.y) < slop) return;
        panPress.panning = true;
        this.pendingFocus = null;
        this.hoveredEnemy = null;
        this.renderHoverLayer();
        // Pan from here, so the map neither jumps nor reads the threshold
        // as a flick.
        this.zoom?.beginPan(now);
        return;
      }
      this.zoom?.movePan(now);
      return;
    }
    if (this.strokePointer !== null || this.selectedUnit || this.rocketUnit) {
      this.strokeGlobal = { x: e.global.x, y: e.global.y };
    }

    const focusAt = this.pendingFocus?.client;
    if (focusAt) {
      const now = screenPoint(e);
      if (Math.hypot(now.x - focusAt.x, now.y - focusAt.y) > TAP_SLOP) this.pendingFocus = null;
    }

    // Update hover state
    if (!this.selectedUnit && !this.rocketUnit) {
      const prev = this.hoveredUnit;
      const prevEnd = this.hoveredEnd;
      const grab = this.findGrab(pos.x, pos.y);
      this.hoveredUnit = grab?.unit ?? null;
      this.hoveredEnd = grab?.kind === 'end';
      // If not hovering own unit, check for enemy
      const prevEnemy = this.hoveredEnemy;
      if (!this.hoveredUnit) {
        this.hoveredEnemy = this.findNearestEnemy(pos.x, pos.y);
      } else {
        this.hoveredEnemy = null;
      }
      if (this.hoveredUnit !== prev || this.hoveredEnemy !== prevEnemy || this.hoveredEnd !== prevEnd) this.renderHoverLayer();
    }

    if (this.rocketUnit) {
      this.rawRocket.push({ x: pos.x, y: pos.y });
      this.renderPaths();
      return;
    }

    // Drawing mode
    if (this.selectedUnit) {
      this.rawPoints.push(this.strokePoint(pos));
      this.renderPaths();
    }
  };

  private onPointerUp = (e: { pointerId?: number }): void => {
    if (!this.enabled) return;
    if (this.strokePointer !== null && e.pointerId !== this.strokePointer) return;
    this.strokePointer = null;
    const backup = this.strokeBackup;
    this.strokeBackup = null;
    this.strokeGlobal = null;
    const panPress = this.panPress;
    this.panPress = null;
    if (panPress?.panning) {
      this.zoom?.endPan();
      return;
    }
    const press = this.press;
    this.press = null;
    if (press) {
      // Never became a drag: a tap just inspects (the unit stays hovered);
      // a long enough hold clears. Touch has no hover to drop the end ring.
      this.hoveredEnd = false;
      if (press.ready && this.canClear(press.grab)) {
        this.clearGrab(press.grab);
        pulse('medium');
      } else {
        this.renderHoverLayer();
      }
      return;
    }
    const pending = this.pendingFocus;
    this.pendingFocus = null;
    if (pending) {
      if (pending.unit.alive && pending.enemy.alive) {
        pending.unit.attackTargetId = pending.enemy.id;
        this.markFocusHintDone();
        this.onPathDrawn?.();
        this.renderPaths();
      }
      return;
    }
    if (this.rocketUnit) {
      const unit = this.rocketUnit;
      const sampled = samplePath(this.rawRocket, PATH_SAMPLE_DISTANCE).slice(1);
      unit.rocketPath = clampPathLength(sampled, launchPoint(unit), ROCKET_MAX_PATH);
      unit.rocketFired = false;
      this.rocketUnit = null;
      this.rawRocket = [];
      this.renderPaths();
      if (unit.rocketPath.length > 0) this.onPathDrawn?.();
      return;
    }
    const unit = this.selectedUnit;
    if (!unit) return;

    // The kept waypoints stay exactly as they were; only the new stroke,
    // starting from the last kept point (or the unit), is sampled.
    const kept = this.keptWaypoints;
    const stroke = this.rawPoints.slice(kept);
    const added = samplePath(stroke, PATH_SAMPLE_DISTANCE).slice(1);
    // A drag that ends back where it began adds nothing: keep the orders.
    const extended = added.length > 0;
    if (kept > 0 && !extended) {
      if (backup?.unit === unit) Object.assign(unit, backup.orders);
    } else {
      unit.waypoints = [...this.rawPoints.slice(1, kept + 1), ...added];
    }
    if (extended) this.onPathDrawn?.();

    this.hoveredUnit = unit;
    // Only a drawn path arms the unit: a plain tap on it is an inspect.
    if (this.focusFire && canFocus(unit) && extended) {
      this.armedUnit = unit;
    }
    this.selectedUnit = null;
    this.rawPoints = [];
    this.keptWaypoints = 0;
    this.grabOffset = null;
    this.renderPaths();
  };

  private onRightDown = (e: { global: { x: number; y: number } }): void => {
    if (!this.enabled || !this.team) return;
    const pos = this.toLocal(e.global);
    const grab = this.findGrab(pos.x, pos.y);
    if (grab) this.clearGrab(grab);
  };
}
