import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { setMapSize } from './constants';
import { clampView, maxPlanZoom, pinchView, PinchZoom, PLAN_ZOOM_THRESHOLD } from './plan-zoom';

describe('maxPlanZoom', () => {
  it('stays off when the map is shown near full size', () => {
    expect(maxPlanZoom(1)).toBe(1);
    expect(maxPlanZoom(PLAN_ZOOM_THRESHOLD)).toBe(1);
    expect(maxPlanZoom(0)).toBe(1);
  });

  it('allows zooming back to native size, capped', () => {
    expect(maxPlanZoom(0.5)).toBe(2);
    expect(maxPlanZoom(0.1)).toBe(3);
  });
});

describe('clampView', () => {
  it('keeps the map covering the view', () => {
    expect(clampView({ zoom: 2, x: 50, y: -5000 }, 1000, 800, 3)).toEqual({ zoom: 2, x: 0, y: -800 });
  });

  it('pins the full map at zoom 1', () => {
    expect(clampView({ zoom: 0.5, x: -10, y: -10 }, 1000, 800, 3)).toEqual({ zoom: 1, x: 0, y: 0 });
  });
});

describe('pinchView', () => {
  it('keeps the map point under the fingers fixed while zooming', () => {
    const start = { zoom: 1, x: 0, y: 0 };
    const view = pinchView(start, { x: 400, y: 300 }, 100, { x: 400, y: 300 }, 200, 1000, 1000, 3);
    expect(view.zoom).toBe(2);
    // Map point (400, 300) is still at screen (400, 300).
    expect(400 * view.zoom + view.x).toBeCloseTo(400);
    expect(300 * view.zoom + view.y).toBeCloseTo(300);
  });

  it('pans with the fingers when zoomed', () => {
    const start = { zoom: 2, x: -500, y: -500 };
    const view = pinchView(start, { x: 500, y: 500 }, 100, { x: 450, y: 520 }, 100, 1000, 1000, 3);
    expect(view).toEqual({ zoom: 2, x: -550, y: -480 });
  });

  it('caps the zoom', () => {
    const view = pinchView({ zoom: 1, x: 0, y: 0 }, { x: 0, y: 0 }, 10, { x: 0, y: 0 }, 1000, 1000, 1000, 2);
    expect(view.zoom).toBe(2);
  });
});

describe('PinchZoom', () => {
  const savedWindow = (globalThis as { window?: unknown }).window;
  let win: EventTarget;
  let canvas: EventTarget & { getBoundingClientRect(): DOMRect };
  let stage: { zoom: number; x: number; y: number; scale: { set(v: number): void }; position: { set(x: number, y: number): void } };

  // Pointer 1 plays the first finger of a touch sequence.
  const pointer = (type: string, pointerId: number, clientX: number, clientY: number): Event =>
    Object.assign(new Event(type), { pointerId, clientX, clientY, isPrimary: pointerId === 1 });

  function makeCanvas(cssWidth: number): void {
    canvas = Object.assign(new EventTarget(), {
      getBoundingClientRect: () => ({ left: 0, top: 0, width: cssWidth, height: cssWidth } as DOMRect),
    });
  }

  beforeEach(() => {
    setMapSize(1000, 1000);
    win = new EventTarget();
    (globalThis as { window?: unknown }).window = win;
    stage = {
      zoom: 1, x: 0, y: 0,
      scale: { set: (v) => { stage.zoom = v; } },
      position: { set: (x, y) => { stage.x = x; stage.y = y; } },
    };
  });

  afterEach(() => {
    (globalThis as { window?: unknown }).window = savedWindow;
  });

  it('does nothing when the map is shown at full size', () => {
    makeCanvas(1000);
    const zoom = new PinchZoom(canvas as unknown as HTMLCanvasElement, stage);
    let available = false;
    zoom.onAvailable = () => { available = true; };
    zoom.attach();
    canvas.dispatchEvent(pointer('pointerdown', 1, 100, 100));
    canvas.dispatchEvent(pointer('pointerdown', 2, 200, 200));
    expect(available).toBe(false);
    expect(zoom.gesturing).toBe(false);
  });

  it('pinches the stage on a shrunk map and resets on detach', () => {
    makeCanvas(400); // 1000px map at 0.4×
    const zoom = new PinchZoom(canvas as unknown as HTMLCanvasElement, stage);
    let available = false;
    let gestureStarts = 0;
    zoom.onAvailable = () => { available = true; };
    zoom.onGestureStart = () => { gestureStarts++; };
    zoom.attach();
    expect(available).toBe(true);

    canvas.dispatchEvent(pointer('pointerdown', 1, 180, 200));
    expect(zoom.gesturing).toBe(false);
    canvas.dispatchEvent(pointer('pointerdown', 2, 220, 200));
    expect(zoom.gesturing).toBe(true);
    expect(gestureStarts).toBe(1);

    // Fingers spread from 40 to 80 CSS px apart: zoom doubles.
    win.dispatchEvent(pointer('pointermove', 1, 160, 200));
    win.dispatchEvent(pointer('pointermove', 2, 240, 200));
    expect(stage.zoom).toBeCloseTo(2);
    expect(stage.x).toBeCloseTo(-500);

    // Still gesturing until every finger is up.
    win.dispatchEvent(pointer('pointerup', 1, 160, 200));
    expect(zoom.gesturing).toBe(true);
    win.dispatchEvent(pointer('pointerup', 2, 240, 200));
    expect(zoom.gesturing).toBe(false);
    expect(stage.zoom).toBeCloseTo(2);

    zoom.detach();
    expect(stage).toMatchObject({ zoom: 1, x: 0, y: 0 });
  });

  it('does not count a finger whose pointerup was missed', () => {
    makeCanvas(400);
    const zoom = new PinchZoom(canvas as unknown as HTMLCanvasElement, stage);
    zoom.attach();
    canvas.dispatchEvent(pointer('pointerdown', 7, 100, 100)); // never lifted
    canvas.dispatchEvent(pointer('pointerdown', 1, 200, 200)); // new touch sequence
    expect(zoom.gesturing).toBe(false);
  });
});
