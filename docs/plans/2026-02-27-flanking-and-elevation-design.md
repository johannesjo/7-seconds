# Flanking Damage & Elevation Visual Improvements — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add 1.5x flanking damage multiplier with visual feedback, and improve elevation zone visuals with gradient fill and "+20% Range" labels.

**Architecture:** Flanking is calculated in `updateProjectiles()` by comparing projectile incoming angle against target's `gunAngle`. A 120° front cone (±60°) determines if a hit is flanked. Elevation zones get concentric gradient rectangles and PixiJS Text labels in the renderer.

**Tech Stack:** TypeScript, PixiJS (Graphics, Text, Container), Vitest

---

### Task 1: Add flanking constants

**Files:**
- Modify: `src/constants.ts:30` (after ELEVATION_RANGE_BONUS)

**Step 1: Add constants**

Add to end of `src/constants.ts`:

```typescript
export const FLANK_ANGLE_THRESHOLD = Math.PI / 3; // 60° half-cone = 120° front
export const FLANK_DAMAGE_MULTIPLIER = 1.5;
```

**Step 2: Commit**

```bash
git add src/constants.ts
git commit -m "feat: add flanking damage constants"
```

---

### Task 2: Add `isFlanked` helper and `flanked` field to ProjectileHit

**Files:**
- Modify: `src/units.ts:1-11` (ProjectileHit interface + new import)
- Test: `src/units.test.ts`

**Step 1: Write failing tests for `isFlanked`**

Add to `src/units.test.ts`:

```typescript
import { isFlanked } from './units';
import { FLANK_ANGLE_THRESHOLD } from './constants';

describe('isFlanked', () => {
  it('returns true when projectile hits from behind (same direction as target facing)', () => {
    // Target faces right (0), projectile travels right (0) = hitting from behind
    expect(isFlanked(0, 0)).toBe(true);
  });

  it('returns false when projectile hits head-on (opposite direction to target facing)', () => {
    // Target faces right (0), projectile travels left (PI) = head-on
    expect(isFlanked(Math.PI, 0)).toBe(false);
  });

  it('returns true when projectile hits from the side at 90°', () => {
    // Target faces right (0), projectile travels down (PI/2) = side hit
    expect(isFlanked(Math.PI / 2, 0)).toBe(true);
  });

  it('returns false when projectile is just inside front cone', () => {
    // Target faces right (0), projectile comes from just within 60° of front
    // Front is at PI (opposite of gunAngle), so within ±60° of PI
    const justInside = Math.PI - FLANK_ANGLE_THRESHOLD + 0.05;
    expect(isFlanked(justInside, 0)).toBe(false);
  });

  it('returns true when projectile is just outside front cone', () => {
    const justOutside = Math.PI - FLANK_ANGLE_THRESHOLD - 0.05;
    expect(isFlanked(justOutside, 0)).toBe(false); // still within threshold from front
    // Actually, let's test at exactly beyond the threshold
    // Target faces up (-PI/2), projectile traveling right (0) = hitting from side
    expect(isFlanked(0, -Math.PI / 2)).toBe(true);
  });

  it('handles negative angles correctly', () => {
    // Target faces left (PI), projectile travels right (0) = from behind
    expect(isFlanked(0, Math.PI)).toBe(true);
    // Target faces left (PI), projectile travels left (PI) = head-on
    expect(isFlanked(Math.PI, Math.PI)).toBe(false);
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/units.test.ts`
Expected: FAIL — `isFlanked` is not exported

**Step 3: Implement `isFlanked` and update `ProjectileHit`**

In `src/units.ts`, add import for the new constants:

```typescript
import { UNIT_STATS, ARMY_COMPOSITION, MAP_WIDTH, MAP_HEIGHT, ELEVATION_RANGE_BONUS, FLANK_ANGLE_THRESHOLD } from './constants';
```

Add `flanked` to the `ProjectileHit` interface:

```typescript
export interface ProjectileHit {
  pos: Vec2;
  targetId: string;
  killed: boolean;
  team: Team;
  angle: number;
  damage: number;
  flanked: boolean;
}
```

Add the `isFlanked` function (after the `isInRange` function, before `applyDamage`):

```typescript
/** Check if a projectile hit is a flank (outside the target's 120° front cone). */
export function isFlanked(projectileVelAngle: number, targetGunAngle: number): boolean {
  // Direction the projectile is coming FROM = reverse of its travel direction
  const incomingAngle = projectileVelAngle + Math.PI;
  // Angle difference between incoming direction and target's facing
  let diff = incomingAngle - targetGunAngle;
  diff = ((diff + Math.PI) % (2 * Math.PI)) - Math.PI;
  if (diff < -Math.PI) diff += 2 * Math.PI;
  // If incoming direction is within ±threshold of target's facing → front hit (not flanked)
  return Math.abs(diff) > FLANK_ANGLE_THRESHOLD;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/units.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/units.ts src/units.test.ts
git commit -m "feat: add isFlanked helper and flanked field to ProjectileHit"
```

---

### Task 3: Apply flanking damage multiplier in `updateProjectiles`

**Files:**
- Modify: `src/units.ts:573-630` (updateProjectiles function)
- Test: `src/units.test.ts`

**Step 1: Write failing test for flanking damage**

Add to `src/units.test.ts` inside the `updateProjectiles` describe block:

```typescript
  it('applies 1.5x damage on flanking hit', () => {
    const target = createUnit('e1', 'soldier', 'red', { x: 105, y: 100 });
    target.gunAngle = Math.PI; // facing left
    const proj = {
      pos: { x: 100, y: 100 },
      vel: { x: 300, y: 0 }, // traveling right — hitting from behind
      target: { x: 105, y: 100 },
      damage: 10,
      radius: 5,
      team: 'blue' as const,
      maxRange: 200,
      distanceTraveled: 0,
    };
    const { hits } = updateProjectiles([proj], [target], 0.016);
    expect(hits).toHaveLength(1);
    expect(hits[0].flanked).toBe(true);
    expect(hits[0].damage).toBe(15); // 10 * 1.5
    expect(target.hp).toBe(45); // 60 - 15
  });

  it('applies normal damage on head-on hit', () => {
    const target = createUnit('e1', 'soldier', 'red', { x: 105, y: 100 });
    target.gunAngle = Math.PI; // facing left (toward the projectile)
    const proj = {
      pos: { x: 100, y: 100 },
      vel: { x: -300, y: 0 }, // traveling left — head-on
      target: { x: 95, y: 100 },
      damage: 10,
      radius: 5,
      team: 'blue' as const,
      maxRange: 200,
      distanceTraveled: 0,
    };
    // Place target in the path of the leftward projectile
    target.pos = { x: 95, y: 100 };
    const { hits } = updateProjectiles([proj], [target], 0.016);
    expect(hits).toHaveLength(1);
    expect(hits[0].flanked).toBe(false);
    expect(hits[0].damage).toBe(10);
    expect(target.hp).toBe(50); // 60 - 10
  });
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run src/units.test.ts`
Expected: FAIL — `hits[0].flanked` is undefined, damage is not multiplied

**Step 3: Modify `updateProjectiles` to apply flanking**

In `src/units.ts`, add `FLANK_DAMAGE_MULTIPLIER` to the imports from constants:

```typescript
import { UNIT_STATS, ARMY_COMPOSITION, MAP_WIDTH, MAP_HEIGHT, ELEVATION_RANGE_BONUS, FLANK_ANGLE_THRESHOLD, FLANK_DAMAGE_MULTIPLIER } from './constants';
```

In `updateProjectiles`, replace the hit detection block (lines ~610-620):

```typescript
      if (dx * dx + dy * dy <= hitDist * hitDist) {
        const projAngle = Math.atan2(p.vel.y, p.vel.x);
        const flanked = isFlanked(projAngle, unit.gunAngle);
        const actualDamage = flanked ? p.damage * FLANK_DAMAGE_MULTIPLIER : p.damage;
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

**Step 4: Run tests to verify they pass**

Run: `npx vitest run src/units.test.ts`
Expected: PASS

**Step 5: Commit**

```bash
git add src/units.ts src/units.test.ts
git commit -m "feat: apply 1.5x flanking damage multiplier in updateProjectiles"
```

---

### Task 4: Add flanking visual feedback

**Files:**
- Modify: `src/game.ts:269-285` (hit effect processing)
- Modify: `src/effects.ts` (add flanked variant to blood spray)

**Step 1: Amplify blood spray for flanking hits in `game.ts`**

In `game.ts`, update the hit processing loop (~line 270-285). When a hit is flanked, pass amplified damage to the blood effects so they appear bigger:

```typescript
    for (const hit of hits) {
      const unitGfx = this.renderer.getUnitContainer(hit.targetId);
      if (unitGfx) fx?.addHitFlash(unitGfx);

      if (this.bloodEnabled) {
        const victimTeam: Team = hit.team === 'blue' ? 'red' : 'blue';
        const effectDamage = hit.flanked ? hit.damage * 1.5 : hit.damage;
        fx?.addBloodSpray(hit.pos, hit.angle, victimTeam, effectDamage);
        if (hit.killed) {
          fx?.addKillText(hit.pos, hit.team);
          fx?.addBloodBurst(hit.pos, hit.angle, victimTeam, effectDamage);
        }
      } else {
        fx?.addImpactBurst(hit.pos, hit.team);
        if (hit.killed) fx?.addKillText(hit.pos, hit.team);
      }
    }
```

This makes flanked hits produce ~1.5x larger blood effects (since blood scales with damage), creating a noticeable visual difference without adding a new effect type.

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: PASS

**Step 3: Commit**

```bash
git add src/game.ts
git commit -m "feat: amplify blood effects for flanking hits"
```

---

### Task 5: Improve elevation zone visuals with gradient

**Files:**
- Modify: `src/renderer.ts:1,10,70-81` (renderElevationZones)

**Step 1: Update `renderElevationZones` with gradient fill**

In `src/renderer.ts`, add `Text` and `Container` to imports (Container is already imported):

The import line already has `Container` — just add `Text`:

```typescript
import { Application, Graphics, Container, Text } from 'pixi.js';
```

Change the `elevationGraphics` property type:

```typescript
private elevationGraphics: Container | null = null;
```

Replace the `renderElevationZones` method:

```typescript
  renderElevationZones(zones: ElevationZone[]): void {
    if (this.elevationGraphics) {
      this.app.stage.removeChild(this.elevationGraphics);
      this.elevationGraphics.destroy({ children: true });
    }
    const container = new Container();
    const gfx = new Graphics();

    for (const z of zones) {
      // Outer layer — blends with background
      gfx.roundRect(z.x, z.y, z.w, z.h, 6);
      gfx.fill({ color: 0x2e2e48, alpha: 0.5 });

      // Middle layer
      const m = 8;
      gfx.roundRect(z.x + m, z.y + m, z.w - m * 2, z.h - m * 2, 4);
      gfx.fill({ color: 0x333358, alpha: 0.35 });

      // Inner layer — lightest
      const m2 = 16;
      gfx.roundRect(z.x + m2, z.y + m2, z.w - m2 * 2, z.h - m2 * 2, 2);
      gfx.fill({ color: 0x3a3a68, alpha: 0.25 });

      // Subtle border
      gfx.roundRect(z.x, z.y, z.w, z.h, 6);
      gfx.setStrokeStyle({ width: 1, color: 0x66ff88, alpha: 0.15 });
      gfx.stroke();

      // Label
      const label = new Text({
        text: '+20% Range',
        style: {
          fontSize: 10,
          fontFamily: 'monospace',
          fill: '#66ff88',
        },
      });
      label.alpha = 0.5;
      label.anchor.set(0.5, 0);
      label.x = z.x + z.w / 2;
      label.y = z.y + 4;
      container.addChild(label);
    }

    container.addChild(gfx);
    // Ensure graphics render behind labels
    container.setChildIndex(gfx, 0);

    this.elevationGraphics = container;
    this.app.stage.addChildAt(this.elevationGraphics, 2);
  }
```

**Step 2: Run full test suite**

Run: `npx vitest run`
Expected: PASS (renderer tests are visual, no unit test regressions)

**Step 3: Visual verification**

Run the game in browser and verify:
- Elevation zones show gradient (lighter center, darker edges)
- Green border is visible but subtle
- "+20% Range" label appears at top-center of each zone
- Labels are readable but not distracting (50% alpha)

**Step 4: Commit**

```bash
git add src/renderer.ts
git commit -m "feat: gradient elevation zones with +20% Range labels"
```

---

### Task 6: Manual integration test

**Step 1: Run the game and verify both features together**

Verify flanking:
- Position blue units behind red units during planning
- Confirm hits from behind deal more damage (bigger blood effects)
- Confirm head-on hits look normal

Verify elevation:
- Check elevation zones have visible gradient and labels
- Confirm range ring still turns green when unit is on elevation

**Step 2: Final commit if any adjustments needed**
