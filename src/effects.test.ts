import { describe, it, expect, afterEach } from 'vitest';
import { Container, Graphics, Sprite } from 'pixi.js';
import type { Renderer, RenderOptions } from 'pixi.js';
import { EffectsManager } from './effects';
import { setMapSize, MAP_WIDTH, MAP_HEIGHT } from './constants';

interface Bake { stains: number; target: unknown; clear: unknown }

/** Records every bake: how many stains it drew, onto what, and whether it wiped the target. */
function fakeRenderer(): { renderer: Renderer; bakes: Bake[] } {
  const bakes: Bake[] = [];
  const renderer = {
    resolution: 1,
    render({ container, target, clear }: RenderOptions) {
      bakes.push({ stains: (container as Graphics).context.instructions.length, target, clear });
    },
  } as unknown as Renderer;
  return { renderer, bakes };
}

/** One kill per frame, then let every particle land and leave its stain. */
function bleed(fx: EffectsManager, kills: number): void {
  for (let i = 0; i < kills; i++) {
    fx.addBloodSpray({ x: 100 + i, y: 100 }, 0, 'red', 30);
    fx.addBloodBurst({ x: 100 + i, y: 100 }, 0, 'red', 30);
    fx.update(1 / 60);
  }
  for (let t = 0; t < 2; t += 1 / 60) fx.update(1 / 60);
}

const stainLayer = (stage: Container) => stage.children[0] as Container;
const stainSprite = (stage: Container) => stainLayer(stage).children[0] as Sprite;

describe('EffectsManager ground stains', () => {
  const initialSize = { w: MAP_WIDTH, h: MAP_HEIGHT };
  afterEach(() => setMapSize(initialSize.w, initialSize.h));

  it('bakes only new stains each frame, so frame cost does not grow with battle length', () => {
    const stage = new Container();
    const { renderer, bakes } = fakeRenderer();
    const fx = new EffectsManager(stage, renderer);
    bleed(fx, 100);

    const total = bakes.reduce((a, b) => a + b.stains, 0);
    expect(total).toBeGreaterThan(3000);
    // A single kill leaves well under 100 stains; the whole history is never re-drawn
    expect(Math.max(...bakes.map(b => b.stains))).toBeLessThan(100);
    // Everything already baked lives in one sprite, drawn onto without wiping it
    expect(stainLayer(stage).children).toHaveLength(1);
    const sprite = stainSprite(stage);
    expect(sprite).toBeInstanceOf(Sprite);
    expect(bakes.every(b => b.target === sprite.texture && b.clear === false)).toBe(true);
  });

  it('removes baked stains on clear and keeps working afterwards', () => {
    const stage = new Container();
    const { renderer, bakes } = fakeRenderer();
    const fx = new EffectsManager(stage, renderer);
    bleed(fx, 5);
    fx.clear();
    expect(stainLayer(stage).children).toHaveLength(0);

    bakes.length = 0;
    bleed(fx, 1);
    expect(bakes.length).toBeGreaterThan(0);
    expect(stainLayer(stage).children).toHaveLength(1);
  });

  it('recreates the stain texture at the new size when the map is resized', () => {
    setMapSize(1000, 1000);
    const stage = new Container();
    const { renderer } = fakeRenderer();
    const fx = new EffectsManager(stage, renderer);
    bleed(fx, 1);

    setMapSize(400, 700);
    bleed(fx, 1);
    expect(stainLayer(stage).children).toHaveLength(1);
    const { width, height } = stainSprite(stage).texture;
    expect({ width, height }).toEqual({ width: 400, height: 700 });
  });

  it('keeps stains as visible Graphics when there is no renderer to bake with', () => {
    const stage = new Container();
    const fx = new EffectsManager(stage);
    bleed(fx, 1);
    const stains = stainLayer(stage).children[0] as Graphics;
    expect(stains.context.instructions.length).toBeGreaterThan(0);
  });
});
