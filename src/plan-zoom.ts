import { MAP_WIDTH, MAP_HEIGHT } from './constants';
import type { Vec2 } from './types';

/** Pinch zoom only switches on when the map is shown below this CSS scale
 *  (e.g. a desktop host's 1000px map on a phone). At ~1× it stays off. */
export const PLAN_ZOOM_THRESHOLD = 0.75;
/** Never zoom past this, however small the map is shown. */
const MAX_PLAN_ZOOM = 3;

export interface ZoomView { zoom: number; x: number; y: number }

/** Highest useful zoom for a map shown at `cssScale`: enough to bring units
 *  back to native size. 1 means zoom is not needed. */
export function maxPlanZoom(cssScale: number): number {
  if (!(cssScale > 0) || cssScale >= PLAN_ZOOM_THRESHOLD) return 1;
  return Math.min(MAX_PLAN_ZOOM, 1 / cssScale);
}

/** Keep the zoomed map covering the whole view (no empty edges). */
export function clampView(view: ZoomView, mapW: number, mapH: number, maxZoom: number): ZoomView {
  const zoom = Math.max(1, Math.min(maxZoom, view.zoom));
  return {
    zoom,
    x: Math.min(0, Math.max(mapW * (1 - zoom), view.x)),
    y: Math.min(0, Math.max(mapH * (1 - zoom), view.y)),
  };
}

/** View for a pinch that started at `startMid`/`startDist` under `start` and is
 *  now at `mid`/`dist`: the map point first under the fingers stays under them. */
export function pinchView(
  start: ZoomView, startMid: Vec2, startDist: number, mid: Vec2, dist: number,
  mapW: number, mapH: number, maxZoom: number,
): ZoomView {
  const zoom = Math.max(1, Math.min(maxZoom, start.zoom * (dist / Math.max(1, startDist))));
  const localX = (startMid.x - start.x) / start.zoom;
  const localY = (startMid.y - start.y) / start.zoom;
  return clampView({ zoom, x: mid.x - localX * zoom, y: mid.y - localY * zoom }, mapW, mapH, maxZoom);
}

/** Share of the view's shorter side, at each edge, that scrolls a drawn path. */
const EDGE_BAND = 0.14;
/** Scroll speed at the very edge, in view widths per second. */
const EDGE_SPEED = 0.9;

/** The view after `dt` seconds of edge-scrolling with the pointer at `p`
 *  (canvas coordinates): the deeper into an edge band, the faster. */
export function edgePanView(view: ZoomView, p: Vec2, dt: number, mapW: number, mapH: number, maxZoom: number): ZoomView {
  const band = Math.min(mapW, mapH) * EDGE_BAND;
  const push = (v: number, size: number): number => {
    if (v < band) return Math.min(1, (band - v) / band);
    if (v > size - band) return -Math.min(1, (v - (size - band)) / band);
    return 0;
  };
  const speed = mapW * EDGE_SPEED * dt;
  return clampView({
    zoom: view.zoom,
    x: view.x + push(p.x, mapW) * speed,
    y: view.y + push(p.y, mapH) * speed,
  }, mapW, mapH, maxZoom);
}

interface Transformable {
  scale: { set(v: number): void };
  position: { set(x: number, y: number): void };
}

/**
 * Two-finger pinch/pan of the stage during planning, only when the map is
 * shown shrunk. One finger is left to the path drawer; while a gesture is
 * going (until every finger lifts) `gesturing` is true so it ignores input.
 */
export class PinchZoom {
  /** Fires the first time zoom becomes available in a planning phase. */
  onAvailable: (() => void) | null = null;
  /** Fires when a second finger lands, so a stroke in progress can be undone. */
  onGestureStart: (() => void) | null = null;

  private pointers = new Map<number, Vec2>();
  private view: ZoomView = { zoom: 1, x: 0, y: 0 };
  private maxZoom = 1;
  private gesture: { view: ZoomView; mid: Vec2; dist: number } | null = null;
  private attached = false;

  constructor(private canvas: HTMLCanvasElement, private stage: Transformable) {}

  /** True from a second finger landing until all fingers have lifted. */
  get gesturing(): boolean {
    return this.gesture !== null;
  }

  /** Start listening if the map is shown small enough to need zoom. */
  attach(): void {
    this.detach();
    const rect = this.canvas.getBoundingClientRect();
    this.maxZoom = maxPlanZoom(rect.width / MAP_WIDTH);
    if (this.maxZoom <= 1) return;
    this.attached = true;
    this.canvas.addEventListener('pointerdown', this.onDown, true);
    this.canvas.addEventListener('wheel', this.onWheel, { passive: false });
    window.addEventListener('pointermove', this.onMove, true);
    window.addEventListener('pointerup', this.onUp, true);
    window.addEventListener('pointercancel', this.onUp, true);
    this.onAvailable?.();
  }

  /** Stop listening and show the full map again. */
  detach(): void {
    if (this.attached) {
      this.canvas.removeEventListener('pointerdown', this.onDown, true);
      this.canvas.removeEventListener('wheel', this.onWheel);
      window.removeEventListener('pointermove', this.onMove, true);
      window.removeEventListener('pointerup', this.onUp, true);
      window.removeEventListener('pointercancel', this.onUp, true);
      this.attached = false;
    }
    this.pointers.clear();
    this.gesture = null;
    // Only touch the stage if we moved it: the battle camera may own it now.
    const v = this.view;
    if (v.zoom !== 1 || v.x !== 0 || v.y !== 0) this.apply({ zoom: 1, x: 0, y: 0 });
  }

  /** Highest zoom this planning phase allows (1 when zoom is off). */
  get zoomLimit(): number {
    return this.attached ? this.maxZoom : 1;
  }

  /** Show `view` (e.g. carried over from the battle camera), clamped. */
  setView(view: ZoomView): void {
    if (!this.attached) return;
    this.apply(clampView(view, MAP_WIDTH, MAP_HEIGHT, this.maxZoom));
  }

  /** Centre the view on a map point at `zoom` (clamped to what's allowed). */
  focusOn(center: Vec2, zoom: number): void {
    if (!this.attached) return;
    const z = Math.max(1, Math.min(this.maxZoom, zoom));
    this.setView({ zoom: z, x: MAP_WIDTH / 2 - center.x * z, y: MAP_HEIGHT / 2 - center.y * z });
  }

  /**
   * While a path is drawn with the finger (or mouse) held near an edge of the
   * zoomed view, scroll the view that way so the path can run off-screen.
   * `p` is in canvas coordinates. Returns true if the view moved.
   */
  edgePan(p: Vec2, dt: number): boolean {
    if (!this.attached || this.gesture || this.view.zoom <= 1.001) return false;
    const v = edgePanView(this.view, p, dt, MAP_WIDTH, MAP_HEIGHT, this.maxZoom);
    if (v.x === this.view.x && v.y === this.view.y) return false;
    this.apply(v);
    return true;
  }

  /** Mouse wheel / trackpad: zoom about the pointer. */
  private onWheel = (e: WheelEvent): void => {
    e.preventDefault();
    if (this.gesture) return;
    const p = this.toCanvas(e);
    const factor = Math.exp(-Math.max(-100, Math.min(100, e.deltaY)) * 0.004);
    this.apply(pinchView(this.view, p, 1, p, factor, MAP_WIDTH, MAP_HEIGHT, this.maxZoom));
  };

  /** Client coordinates → canvas (Pixi "global") coordinates. */
  private toCanvas(e: { clientX: number; clientY: number }): Vec2 {
    const rect = this.canvas.getBoundingClientRect();
    return {
      x: (e.clientX - rect.left) * (MAP_WIDTH / rect.width),
      y: (e.clientY - rect.top) * (MAP_HEIGHT / rect.height),
    };
  }

  private midAndDist(): { mid: Vec2; dist: number } {
    const [a, b] = [...this.pointers.values()];
    return {
      mid: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      dist: Math.hypot(a.x - b.x, a.y - b.y),
    };
  }

  private onDown = (e: PointerEvent): void => {
    // A primary pointer starts a fresh touch sequence: drop any finger whose
    // pointerup we somehow missed, so it can't turn a lone touch into a pinch.
    if (e.isPrimary) {
      this.pointers.clear();
      this.gesture = null;
    }
    this.pointers.set(e.pointerId, this.toCanvas(e));
    if (this.pointers.size === 2) {
      const { mid, dist } = this.midAndDist();
      this.gesture = { view: { ...this.view }, mid, dist };
      this.onGestureStart?.();
    }
  };

  private onMove = (e: PointerEvent): void => {
    if (!this.pointers.has(e.pointerId)) return;
    this.pointers.set(e.pointerId, this.toCanvas(e));
    if (!this.gesture || this.pointers.size !== 2) return;
    const { mid, dist } = this.midAndDist();
    const g = this.gesture;
    this.apply(pinchView(g.view, g.mid, g.dist, mid, dist, MAP_WIDTH, MAP_HEIGHT, this.maxZoom));
  };

  private onUp = (e: PointerEvent): void => {
    if (!this.pointers.delete(e.pointerId)) return;
    if (this.pointers.size === 0) {
      this.gesture = null;
    } else if (this.gesture && this.pointers.size === 2) {
      // A third finger lifted: carry on from the current two.
      const { mid, dist } = this.midAndDist();
      this.gesture = { view: { ...this.view }, mid, dist };
    }
  };

  private apply(view: ZoomView): void {
    this.view = view;
    this.stage.scale.set(view.zoom);
    this.stage.position.set(view.x, view.y);
  }
}
