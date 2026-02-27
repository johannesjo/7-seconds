# Cover Blocks Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add narrow cover blocks that reduce incoming projectile damage by 50% for nearby units when the shot passes through the cover.

**Architecture:** Cover blocks reuse the `Obstacle` shape but are tracked separately. They block movement but NOT line-of-sight and NOT projectiles. When a projectile hits a unit, we trace backward along the projectile's path to check if it crossed a cover block that the target is within 20px of. If so, damage is halved. Cover blocks are rendered with a distinct lighter style.

**Tech Stack:** TypeScript, PixiJS, Vitest

---

### Task 1: Add cover constants and type

**Files:**
- Modify: `src/constants.ts`
- Modify: `src/types.ts`

**Step 1: Add constants**

In `src/constants.ts`, add after `FLANK_DAMAGE_MULTIPLIER`:

```typescript
export const COVER_PROXIMITY = 20;
export const COVER_DAMAGE_REDUCTION = 0.5;
```

**Step 2: Add CoverBlock type alias**

In `src/types.ts`, add after the `ElevationZone` interface:

```typescript
export type CoverBlock = Obstacle;
```

**Step 3: Commit**

```bash
git add src/constants.ts src/types.ts
git commit -m "feat: add cover block type and constants"
```

---

### Task 2: Generate cover blocks in battlefield.ts

**Files:**
- Modify: `src/battlefield.ts`
- Test: `src/battlefield.test.ts`

**Step 1: Write failing tests**

Add to `src/battlefield.test.ts`:

```typescript
import { generateObstacles, generateElevationZones, generateCoverBlocks } from './battlefield';

describe('generateCoverBlocks', () => {
  it('generates 2-4 cover blocks (always even, mirrored pairs)', () => {
    for (let i = 0; i < 20; i++) {
      const covers = generateCoverBlocks();
      expect(covers.length).toBeGreaterThanOrEqual(2);
      expect(covers.length).toBeLessThanOrEqual(4);
      expect(covers.length % 2).toBe(0);
    }
  });

  it('cover blocks are narrow (one dimension <= 12)', () => {
    for (let i = 0; i < 20; i++) {
      const covers = generateCoverBlocks();
      for (const c of covers) {
        const narrow = Math.min(c.w, c.h);
        expect(narrow).toBeLessThanOrEqual(12);
      }
    }
  });

  it('cover blocks are symmetrical (mirrored top-bottom)', () => {
    const covers = generateCoverBlocks();
    for (const c of covers) {
      const centerY = c.y + c.h / 2;
      const mirrorCenterY = MAP_HEIGHT - centerY;
      const hasMirror = covers.some(other => {
        const otherCenterY = other.y + other.h / 2;
        return Math.abs(otherCenterY - mirrorCenterY) < 1 && other !== c;
      });
      expect(hasMirror).toBe(true);
    }
  });

  it('cover blocks are within map bounds', () => {
    for (let i = 0; i < 20; i++) {
      const covers = generateCoverBlocks();
      for (const c of covers) {
        expect(c.x).toBeGreaterThanOrEqual(50);
        expect(c.x + c.w).toBeLessThanOrEqual(MAP_WIDTH - 50);
        expect(c.y).toBeGreaterThanOrEqual(0);
        expect(c.y + c.h).toBeLessThanOrEqual(MAP_HEIGHT);
      }
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/battlefield.test.ts`
Expected: FAIL — `generateCoverBlocks` is not exported

**Step 3: Implement generateCoverBlocks**

In `src/battlefield.ts`, add import for `CoverBlock`:

```typescript
import { Obstacle, ElevationZone, CoverBlock } from './types';
```

Add the function after `generateElevationZones`:

```typescript
/** Generate 1-2 symmetric pairs of narrow cover blocks (2-4 total). */
export function generateCoverBlocks(): CoverBlock[] {
  const covers: CoverBlock[] = [];
  const pairCount = randomInRange(1, 3); // 1 or 2 pairs

  for (let i = 0; i < pairCount; i++) {
    // Randomly orient: horizontal or vertical
    const horizontal = Math.random() > 0.5;
    const long = randomInRange(40, 80);
    const narrow = randomInRange(8, 12);
    const w = horizontal ? long : narrow;
    const h = horizontal ? narrow : long;
    const x = randomInRange(50, MAP_WIDTH - 50 - w);
    const y = randomInRange(MAP_HEIGHT * 0.25, MAP_HEIGHT * 0.45 - h);

    covers.push({ x, y, w, h });
    covers.push({ x, y: MAP_HEIGHT - y - h, w, h });
  }

  return covers;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/battlefield.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/battlefield.ts src/battlefield.test.ts
git commit -m "feat: generate symmetric cover blocks"
```

---

### Task 3: Add cover protection logic to units.ts

**Files:**
- Modify: `src/units.ts`
- Test: `src/units.test.ts`

**Step 1: Write failing tests**

Add imports to `src/units.test.ts`:

```typescript
import { createUnit, createArmy, moveUnit, findTarget, applyDamage, tryFireProjectile, updateProjectiles, segmentHitsRect, detourWaypoints, hasLineOfSight, isFlanked, isProtectedByCover } from './units';
```

Add new describe block:

```typescript
describe('isProtectedByCover', () => {
  it('returns true when unit is near cover and shot passes through it', () => {
    // Cover block at x=150, unit at x=170 (within 20px), shot from left
    const cover = { x: 145, y: 90, w: 10, h: 20 };
    const targetPos = { x: 170, y: 100 };
    const projVel = { x: 300, y: 0 }; // traveling right
    const hitPos = { x: 170, y: 100 };
    expect(isProtectedByCover(hitPos, projVel, targetPos, [cover])).toBe(true);
  });

  it('returns false when unit is far from cover', () => {
    const cover = { x: 100, y: 90, w: 10, h: 20 };
    const targetPos = { x: 200, y: 100 }; // >20px away
    const projVel = { x: 300, y: 0 };
    const hitPos = { x: 200, y: 100 };
    expect(isProtectedByCover(hitPos, projVel, targetPos, [cover])).toBe(false);
  });

  it('returns false when shot does not pass through cover', () => {
    // Cover is off to the side, not in the projectile's path
    const cover = { x: 145, y: 200, w: 10, h: 20 };
    const targetPos = { x: 170, y: 100 };
    const projVel = { x: 300, y: 0 };
    const hitPos = { x: 170, y: 100 };
    expect(isProtectedByCover(hitPos, projVel, targetPos, [cover])).toBe(false);
  });

  it('returns false with no cover blocks', () => {
    const targetPos = { x: 170, y: 100 };
    const projVel = { x: 300, y: 0 };
    const hitPos = { x: 170, y: 100 };
    expect(isProtectedByCover(hitPos, projVel, targetPos, [])).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/units.test.ts`
Expected: FAIL — `isProtectedByCover` is not exported

**Step 3: Implement isProtectedByCover**

In `src/units.ts`, add imports:

```typescript
import { Unit, UnitType, Team, Vec2, Obstacle, Projectile, ElevationZone, CoverBlock } from './types';
```

```typescript
import { UNIT_STATS, ARMY_COMPOSITION, MAP_WIDTH, MAP_HEIGHT, ELEVATION_RANGE_BONUS, FLANK_ANGLE_THRESHOLD, FLANK_DAMAGE_MULTIPLIER, COVER_PROXIMITY, COVER_DAMAGE_REDUCTION } from './constants';
```

Add after `isFlanked`, before `applyDamage`:

```typescript
/** Check if a unit is protected by cover (near a cover block that the shot passes through). */
export function isProtectedByCover(
  hitPos: Vec2,
  projVel: Vec2,
  targetPos: Vec2,
  coverBlocks: CoverBlock[],
): boolean {
  const speed = Math.sqrt(projVel.x * projVel.x + projVel.y * projVel.y);
  if (speed < 1) return false;
  // Trace backward from hit along projectile path
  const traceBack = {
    x: hitPos.x - (projVel.x / speed) * 200,
    y: hitPos.y - (projVel.y / speed) * 200,
  };
  for (const cover of coverBlocks) {
    // Is the target within proximity of this cover?
    const cx = Math.max(cover.x, Math.min(cover.x + cover.w, targetPos.x));
    const cy = Math.max(cover.y, Math.min(cover.y + cover.h, targetPos.y));
    const dx = targetPos.x - cx;
    const dy = targetPos.y - cy;
    if (dx * dx + dy * dy > COVER_PROXIMITY * COVER_PROXIMITY) continue;
    // Did the projectile path cross this cover?
    if (segmentHitsRect(traceBack, hitPos, cover, 0)) return true;
  }
  return false;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/units.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/units.ts src/units.test.ts
git commit -m "feat: add isProtectedByCover helper"
```

---

### Task 4: Integrate cover into updateProjectiles

**Files:**
- Modify: `src/units.ts` (updateProjectiles signature + damage calculation)
- Test: `src/units.test.ts`

**Step 1: Write failing tests**

Add to `src/units.test.ts` inside the `updateProjectiles` describe block:

```typescript
  it('applies 50% damage reduction when target is in cover', () => {
    const target = createUnit('e1', 'soldier', 'red', { x: 170, y: 100 });
    target.gunAngle = Math.PI; // face left (head-on, no flank bonus)
    const cover = { x: 145, y: 90, w: 10, h: 20 };
    const proj = {
      pos: { x: 100, y: 100 },
      vel: { x: 300, y: 0 },
      target: { x: 170, y: 100 },
      damage: 10,
      radius: 5,
      team: 'blue' as const,
      maxRange: 500,
      distanceTraveled: 0,
    };
    const { hits } = updateProjectiles([proj], [target], 0.5, [], [cover]);
    expect(hits).toHaveLength(1);
    expect(hits[0].damage).toBe(5); // 10 * 0.5
    expect(target.hp).toBe(55); // 60 - 5
  });

  it('applies both flanking and cover modifiers', () => {
    const target = createUnit('e1', 'soldier', 'red', { x: 170, y: 100 });
    target.gunAngle = 0; // face right — shot from left is from behind = flanked
    const cover = { x: 145, y: 90, w: 10, h: 20 };
    const proj = {
      pos: { x: 100, y: 100 },
      vel: { x: 300, y: 0 },
      target: { x: 170, y: 100 },
      damage: 10,
      radius: 5,
      team: 'blue' as const,
      maxRange: 500,
      distanceTraveled: 0,
    };
    const { hits } = updateProjectiles([proj], [target], 0.5, [], [cover]);
    expect(hits).toHaveLength(1);
    // Flanked: 10 * 1.5 = 15, then cover: 15 * 0.5 = 7.5
    expect(hits[0].damage).toBe(7.5);
    expect(target.hp).toBe(52.5);
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/units.test.ts`
Expected: FAIL — updateProjectiles doesn't accept 5th parameter

**Step 3: Modify updateProjectiles**

Change the signature and add cover logic:

```typescript
export function updateProjectiles(
  projectiles: Projectile[],
  units: Unit[],
  dt: number,
  obstacles: Obstacle[] = [],
  coverBlocks: CoverBlock[] = [],
): { alive: Projectile[]; hits: ProjectileHit[] } {
```

In the hit detection block, after the flanking damage calculation and before `applyDamage`, add cover check:

```typescript
      if (dx * dx + dy * dy <= hitDist * hitDist) {
        const projAngle = Math.atan2(p.vel.y, p.vel.x);
        const flanked = isFlanked(projAngle, unit.gunAngle);
        let actualDamage = flanked ? p.damage * FLANK_DAMAGE_MULTIPLIER : p.damage;
        // Cover reduction
        const inCover = isProtectedByCover(p.pos, p.vel, unit.pos, coverBlocks);
        if (inCover) actualDamage *= COVER_DAMAGE_REDUCTION;
        const wasBefore = unit.hp;
        applyDamage(unit, actualDamage);
        hits.push({
          pos: { x: p.pos.x, y: p.pos.y },
          targetId: unit.id,
          killed: wasBefore > 0 && !unit.alive,
          team: p.team,
          angle: projAngle,
          flanked,
          damage: actualDamage,
        });
        hit = true;
        break;
      }
```

Note: change `const actualDamage` to `let actualDamage` since it's now conditionally modified.

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/units.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/units.ts src/units.test.ts
git commit -m "feat: apply cover damage reduction in updateProjectiles"
```

---

### Task 5: Wire cover blocks into GameEngine

**Files:**
- Modify: `src/game.ts`
- Modify: `src/battlefield.ts` (already done in Task 2)

**Step 1: Update game.ts imports**

Add `CoverBlock` to the types import:

```typescript
import { Unit, Obstacle, Team, BattleResult, Projectile, TurnPhase, ElevationZone, MissionDef, CoverBlock } from './types';
```

Add `generateCoverBlocks` to the battlefield import:

```typescript
import { generateObstacles, generateElevationZones, generateCoverBlocks } from './battlefield';
```

**Step 2: Add coverBlocks field and generate them**

Add property to `GameEngine` class (after `elevationZones`):

```typescript
private coverBlocks: CoverBlock[] = [];
```

In `startBattle()`, after `this.elevationZones = generateElevationZones();`:

```typescript
this.coverBlocks = generateCoverBlocks();
```

**Step 3: Render cover blocks**

After `this.renderer.renderObstacles(this.obstacles);` in `startBattle()`:

```typescript
this.renderer.renderCoverBlocks(this.coverBlocks);
```

**Step 4: Use cover blocks for movement (treat as obstacles)**

In `moveUnit` calls, combine obstacles and cover blocks. In the `tick` method, change:

```typescript
moveUnit(unit, dt, this.obstacles, this.units);
```
to:
```typescript
moveUnit(unit, dt, [...this.obstacles, ...this.coverBlocks], this.units);
```

And change:
```typescript
separateUnits(this.units, this.obstacles);
```
to:
```typescript
separateUnits(this.units, [...this.obstacles, ...this.coverBlocks]);
```

**Step 5: Pass cover blocks to updateProjectiles**

Change the call:
```typescript
const { alive: aliveProjectiles, hits } = updateProjectiles(this.projectiles, this.units, dt, this.obstacles);
```
to:
```typescript
const { alive: aliveProjectiles, hits } = updateProjectiles(this.projectiles, this.units, dt, this.obstacles, this.coverBlocks);
```

**Step 6: Pass combined blockers to pathfinding/AI**

In `generateAiPaths()`, the detour waypoints use `this.obstacles`. Change to include cover:

```typescript
const allBlockers = [...this.obstacles, ...this.coverBlocks];
```

Use `allBlockers` in place of `this.obstacles` in the AI path generation method (for `onObstacle` check and `detourWaypoints` call).

Also in the `PathDrawer` setup, pass cover blocks so path planning routes around them. The `PathDrawer.enable()` method receives obstacles — check if it needs updating.

**Step 7: Commit**

```bash
git add src/game.ts
git commit -m "feat: wire cover blocks into game engine"
```

---

### Task 6: Render cover blocks

**Files:**
- Modify: `src/renderer.ts`

**Step 1: Add renderCoverBlocks method**

Add a new property:

```typescript
private coverGraphics: Graphics | null = null;
```

Add method after `renderObstacles`:

```typescript
  renderCoverBlocks(covers: CoverBlock[]): void {
    if (this.coverGraphics) {
      this.app.stage.removeChild(this.coverGraphics);
    }
    this.coverGraphics = new Graphics();
    for (const c of covers) {
      this.coverGraphics.roundRect(c.x, c.y, c.w, c.h, 2);
      this.coverGraphics.fill({ color: 0x5a5a7a });
      this.coverGraphics.setStrokeStyle({ width: 1, color: 0x7777aa });
      this.coverGraphics.stroke();
    }
    // Index 4: after bg(0), spawn zones(1), elevation(2), obstacles(3)
    this.app.stage.addChildAt(this.coverGraphics, 4);
  }
```

Add `CoverBlock` to the types import:

```typescript
import { Unit, Obstacle, Projectile, ElevationZone, CoverBlock } from './types';
```

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/renderer.ts
git commit -m "feat: render cover blocks with distinct style"
```

---

### Task 7: Update PathDrawer to route around cover blocks

**Files:**
- Modify: `src/path-drawer.ts`
- Modify: `src/game.ts`

Check `PathDrawer.enable()` signature and where obstacles are used for path routing. Cover blocks need to be included so units path around them during planning.

**Step 1: Check PathDrawer constructor and enable method**

Read `src/path-drawer.ts` to find where obstacles are stored and used. The PathDrawer likely receives obstacles for detour waypoint calculation. Add cover blocks by combining them with obstacles when passed to the PathDrawer.

In `game.ts`, where `PathDrawer` is used, update the obstacle references to include cover blocks. The simplest approach: store a combined `allBlockers` array and pass that wherever obstacles are used for movement/pathfinding.

**Step 2: Add allBlockers helper in game.ts**

In `startBattle()`, after generating cover blocks, create a combined array:

```typescript
private get allBlockers(): Obstacle[] {
  return [...this.obstacles, ...this.coverBlocks];
}
```

Then use `this.allBlockers` in:
- `moveUnit` calls
- `separateUnits` calls
- `detourWaypoints` calls in AI path generation
- Any `PathDrawer` obstacle references

**Step 3: Commit**

```bash
git add src/path-drawer.ts src/game.ts
git commit -m "feat: route unit paths around cover blocks"
```
