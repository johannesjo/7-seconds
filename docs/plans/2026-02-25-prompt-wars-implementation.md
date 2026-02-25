# Prompt Wars — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build an MVP single-screen RTS where players write strategy prompts that control AI commanders in real-time via Chrome's Prompt API.

**Architecture:** Vite + TypeScript for build tooling. PixiJS v8 for 2D rendering (battle only). HTML/CSS for prompt and result screens. Chrome Prompt API (LanguageModel) for two parallel AI sessions that issue per-unit orders every ~1500ms. Pure functions for game logic, class for game engine state.

**Tech Stack:** Vite, TypeScript, PixiJS 8.x, Vitest, Chrome Prompt API (LanguageModel)

---

### Task 1: Project Scaffolding

**Files:**
- Create: `package.json`, `tsconfig.json`, `vite.config.ts`, `index.html`, `src/main.ts`

**Step 1: Initialize project and install dependencies**

Run:
```bash
cd /home/johannes/www/master-space-master
npm init -y
npm install pixi.js
npm install -D typescript vite vitest
```

**Step 2: Create `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "isolatedModules": true,
    "noEmit": true,
    "jsx": "preserve",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "types": ["vitest/globals"]
  },
  "include": ["src"]
}
```

**Step 3: Create `vite.config.ts`**

```ts
import { defineConfig } from 'vite';

export default defineConfig({
  root: '.',
  build: {
    outDir: 'dist',
  },
});
```

**Step 4: Create `index.html`**

```html
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Prompt Wars</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      background: #111;
      color: #eee;
      font-family: 'Segoe UI', system-ui, sans-serif;
      overflow: hidden;
      width: 100vw;
      height: 100vh;
    }
    .screen { display: none; width: 100%; height: 100%; }
    .screen.active { display: flex; }

    /* Prompt Screen */
    #prompt-screen {
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 24px;
      padding: 32px;
    }
    #prompt-screen h1 {
      font-size: 48px;
      letter-spacing: 4px;
      text-transform: uppercase;
    }
    .prompt-container {
      display: flex;
      gap: 32px;
      width: 100%;
      max-width: 1000px;
    }
    .prompt-side {
      flex: 1;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .prompt-side label {
      font-size: 14px;
      text-transform: uppercase;
      letter-spacing: 2px;
    }
    .prompt-side.blue label { color: #4a9eff; }
    .prompt-side.red label { color: #ff4a4a; }
    .prompt-side textarea {
      width: 100%;
      height: 200px;
      background: #1a1a2e;
      border: 1px solid #333;
      color: #eee;
      padding: 12px;
      font-family: inherit;
      font-size: 14px;
      resize: none;
      border-radius: 4px;
    }
    .prompt-side textarea:focus { outline: none; border-color: #555; }
    #battle-btn {
      padding: 16px 48px;
      font-size: 20px;
      font-weight: bold;
      text-transform: uppercase;
      letter-spacing: 4px;
      background: #2a2a4a;
      color: #eee;
      border: 2px solid #555;
      border-radius: 4px;
      cursor: pointer;
    }
    #battle-btn:hover { background: #3a3a5a; border-color: #777; }

    /* Battle Screen */
    #battle-screen {
      position: relative;
      flex-direction: column;
      align-items: center;
    }
    #battle-hud {
      position: absolute;
      top: 0;
      left: 0;
      right: 0;
      display: flex;
      justify-content: space-between;
      align-items: center;
      padding: 8px 16px;
      background: rgba(0,0,0,0.6);
      z-index: 10;
      font-size: 14px;
    }
    .speed-controls button {
      background: #2a2a4a;
      color: #eee;
      border: 1px solid #444;
      padding: 4px 12px;
      cursor: pointer;
      font-size: 12px;
    }
    .speed-controls button.active { background: #4a4a7a; border-color: #88f; }

    /* Result Screen */
    #result-screen {
      position: absolute;
      top: 0; left: 0; right: 0; bottom: 0;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      gap: 16px;
      background: rgba(0,0,0,0.75);
      z-index: 20;
    }
    #result-screen h2 { font-size: 64px; letter-spacing: 4px; }
    #result-screen .stats { font-size: 18px; opacity: 0.8; }
    #result-screen .buttons { display: flex; gap: 16px; margin-top: 16px; }
    #result-screen button {
      padding: 12px 32px;
      font-size: 16px;
      background: #2a2a4a;
      color: #eee;
      border: 1px solid #555;
      border-radius: 4px;
      cursor: pointer;
    }
    #result-screen button:hover { background: #3a3a5a; }

    /* Loading */
    #loading-overlay {
      display: none;
      position: fixed;
      top: 0; left: 0; right: 0; bottom: 0;
      background: rgba(0,0,0,0.8);
      align-items: center;
      justify-content: center;
      z-index: 30;
      font-size: 24px;
    }
    #loading-overlay.active { display: flex; }
  </style>
</head>
<body>
  <div id="prompt-screen" class="screen active">
    <h1>Prompt Wars</h1>
    <div class="prompt-container">
      <div class="prompt-side blue">
        <label>Blue Commander</label>
        <textarea id="blue-prompt" placeholder="Write your battle strategy...&#10;&#10;Example: Send scouts to flank from the left. Soldiers hold the center and focus fire on the weakest enemy. Tanks push aggressively up the right side."></textarea>
      </div>
      <div class="prompt-side red">
        <label>Red Commander</label>
        <textarea id="red-prompt" placeholder="Write your battle strategy...&#10;&#10;Example: Group all units together and push through the center. Tanks in front, soldiers behind, scouts guard the flanks."></textarea>
      </div>
    </div>
    <button id="battle-btn">Battle!</button>
  </div>

  <div id="battle-screen" class="screen">
    <div id="battle-hud">
      <span id="blue-count" style="color:#4a9eff">Blue: 10</span>
      <div class="speed-controls">
        <button data-speed="1" class="active">1x</button>
        <button data-speed="2">2x</button>
        <button data-speed="3">3x</button>
      </div>
      <span id="red-count" style="color:#ff4a4a">Red: 10</span>
    </div>
    <div id="pixi-container"></div>
  </div>

  <div id="result-screen" class="screen">
    <h2 id="winner-text">Blue Wins!</h2>
    <div class="stats" id="result-stats"></div>
    <div class="buttons">
      <button id="rematch-btn">Rematch</button>
      <button id="new-battle-btn">New Battle</button>
    </div>
  </div>

  <div id="loading-overlay">Commanders are planning...</div>

  <script type="module" src="/src/main.ts"></script>
</body>
</html>
```

**Step 5: Create `src/main.ts` placeholder**

```ts
console.log('Prompt Wars loaded');
```

**Step 6: Add scripts to `package.json`**

Add to the `"scripts"` section:
```json
{
  "dev": "vite",
  "build": "tsc && vite build",
  "test": "vitest",
  "test:run": "vitest run"
}
```

**Step 7: Verify dev server runs**

Run: `npm run dev`
Expected: Vite dev server starts, page shows "Prompt Wars" title with two text areas.

**Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json vite.config.ts index.html src/main.ts
git commit -m "chore: scaffold Vite + PixiJS + TypeScript project"
```

---

### Task 2: Core Types & Unit System

**Files:**
- Create: `src/types.ts`, `src/constants.ts`, `src/units.ts`, `src/units.test.ts`

**Step 1: Create `src/types.ts`**

```ts
export type UnitType = 'scout' | 'soldier' | 'tank';
export type Team = 'blue' | 'red';
export type GamePhase = 'prompt' | 'battle' | 'result';

export interface Vec2 {
  x: number;
  y: number;
}

export interface UnitStats {
  hp: number;
  speed: number;
  damage: number;
  range: number;
  radius: number;
}

export interface Unit {
  id: string;
  type: UnitType;
  team: Team;
  pos: Vec2;
  hp: number;
  maxHp: number;
  speed: number;
  damage: number;
  range: number;
  radius: number;
  moveTarget: Vec2 | null;
  attackTargetId: string | null;
  alive: boolean;
}

export interface Obstacle {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface AiUnitOrder {
  id: string;
  move_to: [number, number];
  attack: string | null;
}

export interface AiResponse {
  orders: AiUnitOrder[];
}

export interface BattleResult {
  winner: Team;
  blueAlive: number;
  redAlive: number;
  blueKilled: number;
  redKilled: number;
  duration: number;
}
```

**Step 2: Create `src/constants.ts`**

```ts
import { UnitStats, UnitType } from './types';

export const MAP_WIDTH = 1200;
export const MAP_HEIGHT = 800;

export const UNIT_STATS: Record<UnitType, UnitStats> = {
  scout:   { hp: 30,  speed: 180, damage: 5,  range: 20, radius: 6  },
  soldier: { hp: 60,  speed: 120, damage: 10, range: 80, radius: 10 },
  tank:    { hp: 120, speed: 60,  damage: 20, range: 25, radius: 14 },
};

export const ARMY_COMPOSITION: { type: UnitType; count: number }[] = [
  { type: 'scout', count: 4 },
  { type: 'soldier', count: 4 },
  { type: 'tank', count: 2 },
];

export const AI_POLL_INTERVAL_MS = 1500;
export const UNIT_ATTACK_COOLDOWN_MS = 1000;
```

**Step 3: Write failing tests in `src/units.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { createUnit, createArmy, moveUnit, findTarget, applyDamage } from './units';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';
import { Unit } from './types';

describe('createUnit', () => {
  it('creates a scout with correct stats', () => {
    const unit = createUnit('scout_1', 'scout', 'blue', { x: 100, y: 200 });
    expect(unit.type).toBe('scout');
    expect(unit.hp).toBe(30);
    expect(unit.maxHp).toBe(30);
    expect(unit.speed).toBe(180);
    expect(unit.damage).toBe(5);
    expect(unit.range).toBe(20);
    expect(unit.alive).toBe(true);
    expect(unit.pos).toEqual({ x: 100, y: 200 });
    expect(unit.team).toBe('blue');
  });

  it('creates a tank with correct stats', () => {
    const unit = createUnit('tank_1', 'tank', 'red', { x: 500, y: 300 });
    expect(unit.hp).toBe(120);
    expect(unit.speed).toBe(60);
    expect(unit.damage).toBe(20);
  });
});

describe('createArmy', () => {
  it('creates 10 units for blue team on the left side', () => {
    const units = createArmy('blue');
    expect(units).toHaveLength(10);
    expect(units.filter(u => u.type === 'scout')).toHaveLength(4);
    expect(units.filter(u => u.type === 'soldier')).toHaveLength(4);
    expect(units.filter(u => u.type === 'tank')).toHaveLength(2);
    units.forEach(u => {
      expect(u.team).toBe('blue');
      expect(u.pos.x).toBeLessThan(MAP_WIDTH / 3);
    });
  });

  it('creates 10 units for red team on the right side', () => {
    const units = createArmy('red');
    expect(units).toHaveLength(10);
    units.forEach(u => {
      expect(u.team).toBe('red');
      expect(u.pos.x).toBeGreaterThan(MAP_WIDTH * 2 / 3);
    });
  });
});

describe('moveUnit', () => {
  it('moves unit toward its target', () => {
    const unit = createUnit('s1', 'scout', 'blue', { x: 0, y: 0 });
    unit.moveTarget = { x: 100, y: 0 };
    moveUnit(unit, 1, []);
    expect(unit.pos.x).toBeGreaterThan(0);
    expect(unit.pos.y).toBeCloseTo(0, 1);
  });

  it('does not move past its target', () => {
    const unit = createUnit('s1', 'scout', 'blue', { x: 0, y: 0 });
    unit.moveTarget = { x: 10, y: 0 };
    moveUnit(unit, 1, []);
    expect(unit.pos.x).toBeCloseTo(10, 1);
  });

  it('does nothing without a target', () => {
    const unit = createUnit('s1', 'scout', 'blue', { x: 50, y: 50 });
    moveUnit(unit, 1, []);
    expect(unit.pos).toEqual({ x: 50, y: 50 });
  });
});

describe('findTarget', () => {
  it('returns nearest enemy of preferred type', () => {
    const attacker = createUnit('s1', 'scout', 'blue', { x: 100, y: 100 });
    const enemy1 = createUnit('e1', 'soldier', 'red', { x: 200, y: 100 });
    const enemy2 = createUnit('e2', 'soldier', 'red', { x: 300, y: 100 });
    const allUnits = [attacker, enemy1, enemy2];

    const target = findTarget(attacker, allUnits, 'e1');
    expect(target).toBe(enemy1);
  });

  it('falls back to nearest enemy if preferred target is dead', () => {
    const attacker = createUnit('s1', 'scout', 'blue', { x: 100, y: 100 });
    const enemy1 = createUnit('e1', 'soldier', 'red', { x: 200, y: 100 });
    enemy1.alive = false;
    const enemy2 = createUnit('e2', 'soldier', 'red', { x: 300, y: 100 });
    const allUnits = [attacker, enemy1, enemy2];

    const target = findTarget(attacker, allUnits, 'e1');
    expect(target).toBe(enemy2);
  });

  it('returns null when no enemies alive', () => {
    const attacker = createUnit('s1', 'scout', 'blue', { x: 100, y: 100 });
    const target = findTarget(attacker, [attacker], null);
    expect(target).toBeNull();
  });
});

describe('applyDamage', () => {
  it('reduces HP', () => {
    const unit = createUnit('s1', 'scout', 'blue', { x: 0, y: 0 });
    applyDamage(unit, 10);
    expect(unit.hp).toBe(20);
  });

  it('marks unit as dead when HP reaches 0', () => {
    const unit = createUnit('s1', 'scout', 'blue', { x: 0, y: 0 });
    applyDamage(unit, 30);
    expect(unit.hp).toBe(0);
    expect(unit.alive).toBe(false);
  });

  it('does not go below 0 HP', () => {
    const unit = createUnit('s1', 'scout', 'blue', { x: 0, y: 0 });
    applyDamage(unit, 999);
    expect(unit.hp).toBe(0);
  });
});
```

**Step 4: Run tests to verify they fail**

Run: `npx vitest run`
Expected: All tests FAIL (module not found)

**Step 5: Implement `src/units.ts`**

```ts
import { Unit, UnitType, Team, Vec2, Obstacle } from './types';
import { UNIT_STATS, ARMY_COMPOSITION, MAP_WIDTH, MAP_HEIGHT } from './constants';

export function createUnit(id: string, type: UnitType, team: Team, pos: Vec2): Unit {
  const stats = UNIT_STATS[type];
  return {
    id,
    type,
    team,
    pos: { ...pos },
    hp: stats.hp,
    maxHp: stats.hp,
    speed: stats.speed,
    damage: stats.damage,
    range: stats.range,
    radius: stats.radius,
    moveTarget: null,
    attackTargetId: null,
    alive: true,
  };
}

export function createArmy(team: Team): Unit[] {
  const units: Unit[] = [];
  const isBlue = team === 'blue';
  const baseX = isBlue ? MAP_WIDTH * 0.15 : MAP_WIDTH * 0.85;
  let index = 0;

  for (const { type, count } of ARMY_COMPOSITION) {
    for (let i = 0; i < count; i++) {
      const spacing = MAP_HEIGHT / 12;
      const yOffset = (index - 4.5) * spacing;
      const pos = { x: baseX, y: MAP_HEIGHT / 2 + yOffset };
      units.push(createUnit(`${team}_${type}_${i}`, type, team, pos));
      index++;
    }
  }

  return units;
}

function distance(a: Vec2, b: Vec2): number {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return Math.sqrt(dx * dx + dy * dy);
}

function clamp(val: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, val));
}

function rectContainsCircle(obs: Obstacle, pos: Vec2, radius: number): boolean {
  const closestX = clamp(pos.x, obs.x, obs.x + obs.w);
  const closestY = clamp(pos.y, obs.y, obs.y + obs.h);
  const dx = pos.x - closestX;
  const dy = pos.y - closestY;
  return dx * dx + dy * dy < radius * radius;
}

export function moveUnit(unit: Unit, dt: number, obstacles: Obstacle[]): void {
  if (!unit.moveTarget || !unit.alive) return;

  const dx = unit.moveTarget.x - unit.pos.x;
  const dy = unit.moveTarget.y - unit.pos.y;
  const dist = Math.sqrt(dx * dx + dy * dy);

  if (dist < 2) {
    unit.pos.x = unit.moveTarget.x;
    unit.pos.y = unit.moveTarget.y;
    return;
  }

  const step = unit.speed * dt;
  const moveX = (dx / dist) * Math.min(step, dist);
  const moveY = (dy / dist) * Math.min(step, dist);

  let newX = unit.pos.x + moveX;
  let newY = unit.pos.y + moveY;

  // Obstacle avoidance: try full move, then horizontal only, then vertical only
  const blocked = obstacles.some(o => rectContainsCircle(o, { x: newX, y: newY }, unit.radius));
  if (blocked) {
    const hBlocked = obstacles.some(o => rectContainsCircle(o, { x: newX, y: unit.pos.y }, unit.radius));
    const vBlocked = obstacles.some(o => rectContainsCircle(o, { x: unit.pos.x, y: newY }, unit.radius));
    if (!hBlocked) {
      newY = unit.pos.y;
    } else if (!vBlocked) {
      newX = unit.pos.x;
    } else {
      return; // stuck
    }
  }

  // Clamp to map bounds
  newX = clamp(newX, unit.radius, MAP_WIDTH - unit.radius);
  newY = clamp(newY, unit.radius, MAP_HEIGHT - unit.radius);

  unit.pos.x = newX;
  unit.pos.y = newY;
}

export function findTarget(attacker: Unit, allUnits: Unit[], preferredId: string | null): Unit | null {
  const enemies = allUnits.filter(u => u.alive && u.team !== attacker.team);
  if (enemies.length === 0) return null;

  // Preferred target first
  if (preferredId) {
    const preferred = enemies.find(u => u.id === preferredId);
    if (preferred) return preferred;
  }

  // Nearest enemy
  let nearest = enemies[0];
  let nearestDist = distance(attacker.pos, nearest.pos);
  for (let i = 1; i < enemies.length; i++) {
    const d = distance(attacker.pos, enemies[i].pos);
    if (d < nearestDist) {
      nearest = enemies[i];
      nearestDist = d;
    }
  }
  return nearest;
}

export function isInRange(attacker: Unit, target: Unit): boolean {
  return distance(attacker.pos, target.pos) <= attacker.range + attacker.radius + target.radius;
}

export function applyDamage(unit: Unit, amount: number): void {
  unit.hp = Math.max(0, unit.hp - amount);
  if (unit.hp === 0) {
    unit.alive = false;
  }
}
```

**Step 6: Run tests to verify they pass**

Run: `npx vitest run`
Expected: All tests PASS

**Step 7: Commit**

```bash
git add src/types.ts src/constants.ts src/units.ts src/units.test.ts
git commit -m "feat: add core types, constants, and unit system with tests"
```

---

### Task 3: Battlefield Generation

**Files:**
- Create: `src/battlefield.ts`, `src/battlefield.test.ts`

**Step 1: Write failing tests in `src/battlefield.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { generateObstacles } from './battlefield';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';

describe('generateObstacles', () => {
  it('generates 3-5 obstacles', () => {
    const obstacles = generateObstacles();
    expect(obstacles.length).toBeGreaterThanOrEqual(3);
    expect(obstacles.length).toBeLessThanOrEqual(5);
  });

  it('obstacles are symmetrical (mirrored left-right)', () => {
    const obstacles = generateObstacles();
    // Each obstacle on the left should have a mirror on the right
    // Center obstacle (if odd count) should be centered
    for (const obs of obstacles) {
      const centerX = obs.x + obs.w / 2;
      const mirrorCenterX = MAP_WIDTH - centerX;
      // Either this is the center obstacle or has a mirror
      const isCentered = Math.abs(centerX - MAP_WIDTH / 2) < 1;
      const hasMirror = obstacles.some(o => {
        const oCenterX = o.x + o.w / 2;
        return Math.abs(oCenterX - mirrorCenterX) < 1 && o !== obs;
      });
      expect(isCentered || hasMirror).toBe(true);
    }
  });

  it('obstacles are within the middle zone of the map', () => {
    const obstacles = generateObstacles();
    for (const obs of obstacles) {
      expect(obs.x).toBeGreaterThanOrEqual(MAP_WIDTH * 0.25);
      expect(obs.x + obs.w).toBeLessThanOrEqual(MAP_WIDTH * 0.75);
      expect(obs.y).toBeGreaterThanOrEqual(50);
      expect(obs.y + obs.h).toBeLessThanOrEqual(MAP_HEIGHT - 50);
    }
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run`
Expected: FAIL (module not found)

**Step 3: Implement `src/battlefield.ts`**

```ts
import { Obstacle } from './types';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';

function randomInRange(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min)) + min;
}

export function generateObstacles(): Obstacle[] {
  const obstacles: Obstacle[] = [];

  // 1-2 mirrored pairs + optionally 1 center obstacle
  const pairCount = randomInRange(1, 3); // 1 or 2 pairs
  const hasCenter = Math.random() > 0.5;

  for (let i = 0; i < pairCount; i++) {
    const w = randomInRange(40, 100);
    const h = randomInRange(60, 160);
    const x = randomInRange(MAP_WIDTH * 0.25, MAP_WIDTH * 0.45 - w);
    const y = randomInRange(50, MAP_HEIGHT - 50 - h);

    // Left obstacle
    obstacles.push({ x, y, w, h });
    // Mirrored right obstacle
    obstacles.push({ x: MAP_WIDTH - x - w, y, w, h });
  }

  if (hasCenter || obstacles.length < 3) {
    const w = randomInRange(40, 80);
    const h = randomInRange(60, 140);
    const x = (MAP_WIDTH - w) / 2;
    const y = randomInRange(50, MAP_HEIGHT - 50 - h);
    obstacles.push({ x, y, w, h });
  }

  return obstacles;
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/battlefield.ts src/battlefield.test.ts
git commit -m "feat: add symmetrical obstacle generation with tests"
```

---

### Task 4: AI Commander

**Files:**
- Create: `src/ai-commander.ts`, `src/ai-commander.test.ts`

**Step 1: Write failing tests in `src/ai-commander.test.ts`**

```ts
import { describe, it, expect } from 'vitest';
import { serializeState, parseAiResponse, fallbackOrders } from './ai-commander';
import { createUnit } from './units';
import { Obstacle } from './types';

describe('serializeState', () => {
  it('serializes units and obstacles for a team', () => {
    const units = [
      createUnit('blue_scout_0', 'scout', 'blue', { x: 100, y: 200 }),
      createUnit('red_soldier_0', 'soldier', 'red', { x: 800, y: 300 }),
    ];
    const obstacles: Obstacle[] = [{ x: 400, y: 200, w: 80, h: 120 }];

    const result = serializeState(units, obstacles, 'blue');
    const parsed = JSON.parse(result);

    expect(parsed.my_units).toHaveLength(1);
    expect(parsed.my_units[0].id).toBe('blue_scout_0');
    expect(parsed.enemy_units).toHaveLength(1);
    expect(parsed.enemy_units[0].id).toBe('red_soldier_0');
    expect(parsed.obstacles).toHaveLength(1);
  });

  it('excludes dead units', () => {
    const units = [
      createUnit('blue_scout_0', 'scout', 'blue', { x: 100, y: 200 }),
      createUnit('red_soldier_0', 'soldier', 'red', { x: 800, y: 300 }),
    ];
    units[1].alive = false;

    const result = serializeState(units, [], 'blue');
    const parsed = JSON.parse(result);

    expect(parsed.enemy_units).toHaveLength(0);
  });
});

describe('parseAiResponse', () => {
  it('parses valid JSON response', () => {
    const json = JSON.stringify({
      orders: [
        { id: 'scout_1', move_to: [500, 100], attack: 'e_soldier_1' },
        { id: 'tank_1', move_to: [400, 400], attack: null },
      ],
    });

    const result = parseAiResponse(json);
    expect(result).not.toBeNull();
    expect(result!.orders).toHaveLength(2);
    expect(result!.orders[0].move_to).toEqual([500, 100]);
  });

  it('returns null for malformed JSON', () => {
    expect(parseAiResponse('not json')).toBeNull();
    expect(parseAiResponse('{"orders": "bad"}')).toBeNull();
    expect(parseAiResponse('{}')).toBeNull();
  });

  it('filters out orders with invalid structure', () => {
    const json = JSON.stringify({
      orders: [
        { id: 'scout_1', move_to: [500, 100], attack: null },
        { id: 'tank_1', move_to: 'bad' },
        { move_to: [100, 100] },
      ],
    });

    const result = parseAiResponse(json);
    expect(result).not.toBeNull();
    expect(result!.orders).toHaveLength(1);
  });
});

describe('fallbackOrders', () => {
  it('orders all units toward the center of the map', () => {
    const units = [
      createUnit('blue_scout_0', 'scout', 'blue', { x: 100, y: 200 }),
      createUnit('blue_tank_0', 'tank', 'blue', { x: 100, y: 400 }),
    ];

    const orders = fallbackOrders(units, 'blue');
    expect(orders.orders).toHaveLength(2);
    orders.orders.forEach(o => {
      expect(o.move_to[0]).toBeGreaterThan(100);
    });
  });
});
```

**Step 2: Run tests to verify they fail**

Run: `npx vitest run`
Expected: FAIL

**Step 3: Implement `src/ai-commander.ts`**

```ts
import { Unit, Team, Obstacle, AiResponse, AiUnitOrder } from './types';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';

declare global {
  interface Window {
    LanguageModel?: {
      availability: (opts?: Record<string, unknown>) => Promise<string>;
      create: (opts?: Record<string, unknown>) => Promise<AiSession>;
    };
  }
}

interface AiSession {
  prompt: (text: string, opts?: Record<string, unknown>) => Promise<string>;
  destroy: () => void;
}

const SYSTEM_PROMPT = `You are an AI commander in a real-time strategy battle game.

MAP: ${MAP_WIDTH}x${MAP_HEIGHT} pixels. (0,0) is top-left.
Your team spawns on the {side} side.

UNIT TYPES:
- scout: very fast (180 px/s), 30 HP, 5 damage/s, melee
- soldier: medium speed (120 px/s), 60 HP, 10 damage/s, 80px range
- tank: slow (60 px/s), 120 HP, 20 damage/s, melee

You receive the game state as JSON and MUST respond with a JSON object containing orders for each of your alive units.

Response format:
{"orders":[{"id":"unit_id","move_to":[x,y],"attack":"enemy_id_or_null"}]}

YOUR COMMANDER'S STRATEGY:
{userPrompt}

Follow your commander's strategy. Be tactical. Respond ONLY with valid JSON.`;

const ORDER_SCHEMA = {
  type: 'object',
  properties: {
    orders: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          move_to: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          attack: { type: ['string', 'null'] },
        },
        required: ['id', 'move_to'],
      },
    },
  },
  required: ['orders'],
};

export function serializeState(units: Unit[], obstacles: Obstacle[], forTeam: Team): string {
  const myUnits = units.filter(u => u.alive && u.team === forTeam);
  const enemyUnits = units.filter(u => u.alive && u.team !== forTeam);

  return JSON.stringify({
    map: { width: MAP_WIDTH, height: MAP_HEIGHT },
    obstacles: obstacles.map(o => ({ x: o.x, y: o.y, w: o.w, h: o.h })),
    my_units: myUnits.map(u => ({
      id: u.id, type: u.type, pos: [Math.round(u.pos.x), Math.round(u.pos.y)], hp: u.hp, max_hp: u.maxHp,
    })),
    enemy_units: enemyUnits.map(u => ({
      id: u.id, type: u.type, pos: [Math.round(u.pos.x), Math.round(u.pos.y)], hp: u.hp, max_hp: u.maxHp,
    })),
  });
}

export function parseAiResponse(raw: string): AiResponse | null {
  try {
    // Strip markdown code fences if present
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.orders || !Array.isArray(parsed.orders)) return null;

    const validOrders: AiUnitOrder[] = parsed.orders.filter(
      (o: Record<string, unknown>) =>
        typeof o.id === 'string' &&
        Array.isArray(o.move_to) &&
        o.move_to.length === 2 &&
        typeof o.move_to[0] === 'number' &&
        typeof o.move_to[1] === 'number',
    ).map((o: Record<string, unknown>) => ({
      id: o.id as string,
      move_to: o.move_to as [number, number],
      attack: typeof o.attack === 'string' ? o.attack : null,
    }));

    if (validOrders.length === 0) return null;

    return { orders: validOrders };
  } catch {
    return null;
  }
}

export function fallbackOrders(units: Unit[], team: Team): AiResponse {
  const myUnits = units.filter(u => u.alive && u.team === team);
  const enemyUnits = units.filter(u => u.alive && u.team !== team);

  return {
    orders: myUnits.map(u => {
      const targetX = team === 'blue' ? MAP_WIDTH * 0.7 : MAP_WIDTH * 0.3;
      const nearestEnemy = enemyUnits.length > 0
        ? enemyUnits.reduce((nearest, e) => {
            const dCurr = Math.hypot(u.pos.x - nearest.pos.x, u.pos.y - nearest.pos.y);
            const dNew = Math.hypot(u.pos.x - e.pos.x, u.pos.y - e.pos.y);
            return dNew < dCurr ? e : nearest;
          })
        : null;

      return {
        id: u.id,
        move_to: nearestEnemy
          ? [Math.round(nearestEnemy.pos.x), Math.round(nearestEnemy.pos.y)] as [number, number]
          : [targetX, u.pos.y] as [number, number],
        attack: nearestEnemy?.id ?? null,
      };
    }),
  };
}

export class AiCommander {
  private session: AiSession | null = null;
  private team: Team;
  private userPrompt: string;

  constructor(team: Team, userPrompt: string) {
    this.team = team;
    this.userPrompt = userPrompt;
  }

  async init(): Promise<boolean> {
    try {
      if (!window.LanguageModel) {
        console.warn('LanguageModel API not available');
        return false;
      }

      const availability = await window.LanguageModel.availability();
      if (availability === 'unavailable') {
        console.warn('Language model unavailable');
        return false;
      }

      const side = this.team === 'blue' ? 'LEFT' : 'RIGHT';
      const systemContent = SYSTEM_PROMPT
        .replace('{side}', side)
        .replace('{userPrompt}', this.userPrompt);

      this.session = await window.LanguageModel.create({
        initialPrompts: [
          { role: 'system', content: systemContent },
        ],
      });

      return true;
    } catch (err) {
      console.warn('Failed to create AI session:', err);
      return false;
    }
  }

  async getOrders(units: Unit[], obstacles: Obstacle[]): Promise<AiResponse> {
    if (!this.session) {
      return fallbackOrders(units, this.team);
    }

    try {
      const stateJson = serializeState(units, obstacles, this.team);
      const raw = await this.session.prompt(stateJson, {
        responseConstraint: ORDER_SCHEMA,
      });
      const parsed = parseAiResponse(raw);
      return parsed ?? fallbackOrders(units, this.team);
    } catch (err) {
      console.warn('AI prompt failed:', err);
      return fallbackOrders(units, this.team);
    }
  }

  destroy(): void {
    this.session?.destroy();
    this.session = null;
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `npx vitest run`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add src/ai-commander.ts src/ai-commander.test.ts
git commit -m "feat: add AI commander with Prompt API integration and fallback"
```

---

### Task 5: Renderer

**Files:**
- Create: `src/renderer.ts`

**Step 1: Implement `src/renderer.ts`**

No tests for rendering code — verify visually.

```ts
import { Application, Graphics, Container, Text } from 'pixi.js';
import { Unit, Obstacle } from './types';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';

export class Renderer {
  private app: Application;
  private unitGraphics: Map<string, Container> = new Map();
  private obstacleGraphics: Graphics | null = null;
  private bgGraphics: Graphics | null = null;

  constructor() {
    this.app = new Application();
  }

  async init(container: HTMLElement): Promise<void> {
    await this.app.init({
      width: MAP_WIDTH,
      height: MAP_HEIGHT,
      backgroundColor: 0x1a1a2e,
      antialias: true,
    });
    container.appendChild(this.app.canvas);
    this.drawBackground();
  }

  private drawBackground(): void {
    this.bgGraphics = new Graphics();
    // Grid lines for spatial reference
    this.bgGraphics.setStrokeStyle({ width: 1, color: 0x222244, alpha: 0.3 });
    for (let x = 0; x <= MAP_WIDTH; x += 100) {
      this.bgGraphics.moveTo(x, 0);
      this.bgGraphics.lineTo(x, MAP_HEIGHT);
      this.bgGraphics.stroke();
    }
    for (let y = 0; y <= MAP_HEIGHT; y += 100) {
      this.bgGraphics.moveTo(0, y);
      this.bgGraphics.lineTo(MAP_WIDTH, y);
      this.bgGraphics.stroke();
    }
    this.app.stage.addChild(this.bgGraphics);
  }

  renderObstacles(obstacles: Obstacle[]): void {
    if (this.obstacleGraphics) {
      this.app.stage.removeChild(this.obstacleGraphics);
    }
    this.obstacleGraphics = new Graphics();
    for (const obs of obstacles) {
      this.obstacleGraphics.rect(obs.x, obs.y, obs.w, obs.h);
      this.obstacleGraphics.fill({ color: 0x3a3a5a });
      this.obstacleGraphics.setStrokeStyle({ width: 1, color: 0x555577 });
      this.obstacleGraphics.stroke();
    }
    this.app.stage.addChild(this.obstacleGraphics);
  }

  renderUnits(units: Unit[]): void {
    const activeIds = new Set<string>();

    for (const unit of units) {
      if (!unit.alive) {
        const existing = this.unitGraphics.get(unit.id);
        if (existing) {
          this.app.stage.removeChild(existing);
          this.unitGraphics.delete(unit.id);
        }
        continue;
      }

      activeIds.add(unit.id);
      let container = this.unitGraphics.get(unit.id);

      if (!container) {
        container = this.createUnitGraphic(unit);
        this.unitGraphics.set(unit.id, container);
        this.app.stage.addChild(container);
      }

      container.x = unit.pos.x;
      container.y = unit.pos.y;

      // Update health bar
      const hpBar = container.getChildAt(1) as Graphics;
      this.updateHealthBar(hpBar, unit);
    }

    // Remove graphics for units no longer present
    for (const [id, container] of this.unitGraphics) {
      if (!activeIds.has(id)) {
        this.app.stage.removeChild(container);
        this.unitGraphics.delete(id);
      }
    }
  }

  private createUnitGraphic(unit: Unit): Container {
    const container = new Container();
    const shape = new Graphics();
    const color = unit.team === 'blue' ? 0x4a9eff : 0xff4a4a;

    if (unit.type === 'scout') {
      shape.circle(0, 0, unit.radius);
      shape.fill(color);
    } else if (unit.type === 'soldier') {
      const r = unit.radius;
      shape.rect(-r, -r, r * 2, r * 2);
      shape.fill(color);
    } else {
      // Tank: hexagon
      const r = unit.radius;
      const points: number[] = [];
      for (let i = 0; i < 6; i++) {
        const angle = (Math.PI / 3) * i - Math.PI / 6;
        points.push(r * Math.cos(angle), r * Math.sin(angle));
      }
      shape.poly(points);
      shape.fill(color);
    }

    container.addChild(shape);

    // Health bar (positioned above unit)
    const hpBar = new Graphics();
    this.updateHealthBar(hpBar, unit);
    container.addChild(hpBar);

    return container;
  }

  private updateHealthBar(bar: Graphics, unit: Unit): void {
    bar.clear();
    const w = unit.radius * 2.5;
    const h = 3;
    const yOff = -(unit.radius + 6);

    // Background
    bar.rect(-w / 2, yOff, w, h);
    bar.fill(0x333333);

    // HP fill
    const hpRatio = unit.hp / unit.maxHp;
    const hpColor = hpRatio > 0.5 ? 0x44ff44 : hpRatio > 0.25 ? 0xffaa00 : 0xff4444;
    bar.rect(-w / 2, yOff, w * hpRatio, h);
    bar.fill(hpColor);
  }

  get ticker() {
    return this.app.ticker;
  }

  destroy(): void {
    this.unitGraphics.clear();
    this.app.destroy(true);
  }
}
```

**Step 2: Verify visually by temporarily rendering test units in `main.ts`**

After implementation, temporarily add to `main.ts`:
```ts
import { Renderer } from './renderer';
import { createArmy } from './units';
import { generateObstacles } from './battlefield';

const renderer = new Renderer();
const container = document.getElementById('pixi-container')!;
// Show battle screen for testing
document.getElementById('prompt-screen')!.classList.remove('active');
document.getElementById('battle-screen')!.classList.add('active');

await renderer.init(container);
const obstacles = generateObstacles();
renderer.renderObstacles(obstacles);
const units = [...createArmy('blue'), ...createArmy('red')];
renderer.renderUnits(units);
```

Run: `npm run dev`
Expected: See blue units on left, red units on right, gray obstacles in the middle, health bars above each unit.

**Step 3: Revert `main.ts` back to placeholder**

```ts
console.log('Prompt Wars loaded');
```

**Step 4: Commit**

```bash
git add src/renderer.ts
git commit -m "feat: add PixiJS renderer for units, obstacles, and health bars"
```

---

### Task 6: Game Engine

**Files:**
- Create: `src/game.ts`

**Step 1: Implement `src/game.ts`**

```ts
import { Unit, Obstacle, Team, BattleResult } from './types';
import { AI_POLL_INTERVAL_MS } from './constants';
import { createArmy, moveUnit, findTarget, isInRange, applyDamage } from './units';
import { generateObstacles } from './battlefield';
import { AiCommander } from './ai-commander';
import { Renderer } from './renderer';

export type GameEventCallback = (event: 'update' | 'end', data?: BattleResult) => void;

export class GameEngine {
  private units: Unit[] = [];
  private obstacles: Obstacle[] = [];
  private blueCommander: AiCommander | null = null;
  private redCommander: AiCommander | null = null;
  private renderer: Renderer;
  private running = false;
  private speedMultiplier = 1;
  private elapsedTime = 0;
  private lastAiPoll = 0;
  private onEvent: GameEventCallback;
  private aiReady = false;

  constructor(renderer: Renderer, onEvent: GameEventCallback) {
    this.renderer = renderer;
    this.onEvent = onEvent;
  }

  async startBattle(bluePrompt: string, redPrompt: string): Promise<void> {
    this.units = [...createArmy('blue'), ...createArmy('red')];
    this.obstacles = generateObstacles();
    this.elapsedTime = 0;
    this.lastAiPoll = -AI_POLL_INTERVAL_MS; // trigger immediate first poll
    this.running = true;
    this.aiReady = false;

    this.renderer.renderObstacles(this.obstacles);

    // Init AI commanders
    this.blueCommander = new AiCommander('blue', bluePrompt);
    this.redCommander = new AiCommander('red', redPrompt);

    const [blueOk, redOk] = await Promise.all([
      this.blueCommander.init(),
      this.redCommander.init(),
    ]);

    if (!blueOk) console.warn('Blue AI using fallback');
    if (!redOk) console.warn('Red AI using fallback');
    this.aiReady = true;

    // Start game loop
    this.renderer.ticker.add(this.tick, this);
  }

  private tick = (ticker: { deltaMS: number }): void => {
    if (!this.running) return;

    const rawDt = ticker.deltaMS / 1000;
    const dt = rawDt * this.speedMultiplier;
    this.elapsedTime += dt;

    // AI polling
    if (this.aiReady && (this.elapsedTime - this.lastAiPoll) * 1000 >= AI_POLL_INTERVAL_MS) {
      this.lastAiPoll = this.elapsedTime;
      this.pollAi();
    }

    // Movement
    for (const unit of this.units) {
      if (!unit.alive) continue;
      moveUnit(unit, dt, this.obstacles);
    }

    // Combat
    for (const unit of this.units) {
      if (!unit.alive) continue;

      const target = findTarget(unit, this.units, unit.attackTargetId);
      if (target && isInRange(unit, target)) {
        applyDamage(target, unit.damage * dt);
      }
    }

    // Render
    this.renderer.renderUnits(this.units);

    // HUD update
    this.onEvent('update');

    // Win condition
    const blueAlive = this.units.filter(u => u.alive && u.team === 'blue').length;
    const redAlive = this.units.filter(u => u.alive && u.team === 'red').length;

    if (blueAlive === 0 || redAlive === 0) {
      this.endBattle(blueAlive === 0 ? 'red' : 'blue');
    }
  };

  private async pollAi(): Promise<void> {
    if (!this.blueCommander || !this.redCommander) return;

    const [blueOrders, redOrders] = await Promise.all([
      this.blueCommander.getOrders(this.units, this.obstacles),
      this.redCommander.getOrders(this.units, this.obstacles),
    ]);

    // Apply orders
    for (const order of blueOrders.orders) {
      const unit = this.units.find(u => u.id === order.id && u.alive);
      if (unit) {
        unit.moveTarget = { x: order.move_to[0], y: order.move_to[1] };
        unit.attackTargetId = order.attack;
      }
    }

    for (const order of redOrders.orders) {
      const unit = this.units.find(u => u.id === order.id && u.alive);
      if (unit) {
        unit.moveTarget = { x: order.move_to[0], y: order.move_to[1] };
        unit.attackTargetId = order.attack;
      }
    }
  }

  private endBattle(winner: Team): void {
    this.running = false;
    this.renderer.ticker.remove(this.tick, this);

    const blueAlive = this.units.filter(u => u.alive && u.team === 'blue').length;
    const redAlive = this.units.filter(u => u.alive && u.team === 'red').length;

    this.onEvent('end', {
      winner,
      blueAlive,
      redAlive,
      blueKilled: 10 - redAlive,
      redKilled: 10 - blueAlive,
      duration: this.elapsedTime,
    });

    this.blueCommander?.destroy();
    this.redCommander?.destroy();
  }

  setSpeed(multiplier: number): void {
    this.speedMultiplier = multiplier;
  }

  getAliveCount(): { blue: number; red: number } {
    return {
      blue: this.units.filter(u => u.alive && u.team === 'blue').length,
      red: this.units.filter(u => u.alive && u.team === 'red').length,
    };
  }

  stop(): void {
    this.running = false;
    this.renderer.ticker.remove(this.tick, this);
    this.blueCommander?.destroy();
    this.redCommander?.destroy();
  }
}
```

**Step 2: Commit**

```bash
git add src/game.ts
git commit -m "feat: add game engine with AI polling loop and combat"
```

---

### Task 7: Screen Management & Main Entry Point

**Files:**
- Modify: `src/main.ts`

**Step 1: Implement `src/main.ts` — full screen management**

```ts
import { Renderer } from './renderer';
import { GameEngine } from './game';
import { BattleResult } from './types';

// DOM elements
const promptScreen = document.getElementById('prompt-screen')!;
const battleScreen = document.getElementById('battle-screen')!;
const resultScreen = document.getElementById('result-screen')!;
const loadingOverlay = document.getElementById('loading-overlay')!;

const bluePromptEl = document.getElementById('blue-prompt') as HTMLTextAreaElement;
const redPromptEl = document.getElementById('red-prompt') as HTMLTextAreaElement;
const battleBtn = document.getElementById('battle-btn')!;

const blueCountEl = document.getElementById('blue-count')!;
const redCountEl = document.getElementById('red-count')!;
const speedButtons = document.querySelectorAll<HTMLButtonElement>('.speed-controls button');

const winnerTextEl = document.getElementById('winner-text')!;
const resultStatsEl = document.getElementById('result-stats')!;
const rematchBtn = document.getElementById('rematch-btn')!;
const newBattleBtn = document.getElementById('new-battle-btn')!;

const pixiContainer = document.getElementById('pixi-container')!;

// State
let renderer: Renderer | null = null;
let engine: GameEngine | null = null;
let lastBluePrompt = '';
let lastRedPrompt = '';

function showScreen(screen: 'prompt' | 'battle' | 'result') {
  promptScreen.classList.toggle('active', screen === 'prompt');
  battleScreen.classList.toggle('active', screen === 'battle' || screen === 'result');
  resultScreen.classList.toggle('active', screen === 'result');
}

function onGameEvent(event: 'update' | 'end', data?: BattleResult) {
  if (event === 'update' && engine) {
    const counts = engine.getAliveCount();
    blueCountEl.textContent = `Blue: ${counts.blue}`;
    redCountEl.textContent = `Red: ${counts.red}`;
  }

  if (event === 'end' && data) {
    const color = data.winner === 'blue' ? '#4a9eff' : '#ff4a4a';
    winnerTextEl.textContent = `${data.winner === 'blue' ? 'Blue' : 'Red'} Wins!`;
    winnerTextEl.style.color = color;
    resultStatsEl.innerHTML = [
      `Duration: ${data.duration.toFixed(1)}s`,
      `Blue survivors: ${data.blueAlive}/10`,
      `Red survivors: ${data.redAlive}/10`,
    ].join('<br>');
    showScreen('result');
  }
}

async function startBattle(bluePrompt: string, redPrompt: string) {
  loadingOverlay.classList.add('active');

  // Clean up previous
  engine?.stop();
  renderer?.destroy();

  renderer = new Renderer();
  await renderer.init(pixiContainer);

  engine = new GameEngine(renderer, onGameEvent);

  showScreen('battle');

  // Reset speed buttons
  speedButtons.forEach(btn => btn.classList.toggle('active', btn.dataset.speed === '1'));

  await engine.startBattle(bluePrompt, redPrompt);
  loadingOverlay.classList.remove('active');
}

// Event listeners
battleBtn.addEventListener('click', () => {
  lastBluePrompt = bluePromptEl.value.trim() || 'Attack the enemy aggressively.';
  lastRedPrompt = redPromptEl.value.trim() || 'Defend and counterattack.';
  startBattle(lastBluePrompt, lastRedPrompt);
});

speedButtons.forEach(btn => {
  btn.addEventListener('click', () => {
    const speed = Number(btn.dataset.speed);
    engine?.setSpeed(speed);
    speedButtons.forEach(b => b.classList.toggle('active', b === btn));
  });
});

rematchBtn.addEventListener('click', () => {
  startBattle(lastBluePrompt, lastRedPrompt);
});

newBattleBtn.addEventListener('click', () => {
  engine?.stop();
  renderer?.destroy();
  renderer = null;
  engine = null;
  showScreen('prompt');
});

// Start on prompt screen
showScreen('prompt');
```

**Step 2: Verify the full game loop works**

Run: `npm run dev`
Expected:
1. Prompt screen shows with two text areas
2. Enter prompts, click "Battle!"
3. Loading overlay appears briefly
4. Battle screen shows with units moving and fighting
5. HUD updates alive counts
6. Speed buttons change game speed
7. When one side is eliminated, result screen shows
8. Rematch and New Battle buttons work

**Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire up screen management and complete game loop"
```

---

### Task 8: Polish & Error Handling

**Files:**
- Modify: `src/main.ts`, `index.html`

**Step 1: Add AI availability warning to prompt screen**

In `index.html`, add after the `<h1>Prompt Wars</h1>`:

```html
<p id="ai-status" style="font-size: 12px; opacity: 0.6;"></p>
```

In `src/main.ts`, add at the bottom (before the `showScreen('prompt')` line):

```ts
// Check AI availability
(async () => {
  const statusEl = document.getElementById('ai-status')!;
  try {
    if (!window.LanguageModel) {
      statusEl.textContent = 'Chrome AI not available — using fallback AI (units will chase nearest enemy)';
      return;
    }
    const availability = await window.LanguageModel.availability();
    if (availability === 'unavailable') {
      statusEl.textContent = 'Language model unavailable — using fallback AI';
    } else if (availability === 'downloadable') {
      statusEl.textContent = 'Language model needs to download — first battle may be slow';
    } else {
      statusEl.textContent = 'Chrome AI ready';
    }
  } catch {
    statusEl.textContent = 'Could not check AI status — using fallback AI';
  }
})();
```

**Step 2: Add LanguageModel type declaration**

Create `src/global.d.ts`:

```ts
interface LanguageModelStatic {
  availability: (opts?: Record<string, unknown>) => Promise<string>;
  create: (opts?: Record<string, unknown>) => Promise<LanguageModelSession>;
}

interface LanguageModelSession {
  prompt: (text: string, opts?: Record<string, unknown>) => Promise<string>;
  promptStreaming: (text: string, opts?: Record<string, unknown>) => ReadableStream<string>;
  destroy: () => void;
}

declare const LanguageModel: LanguageModelStatic | undefined;
```

Update `src/ai-commander.ts` to use `LanguageModel` global instead of `window.LanguageModel`:
- Replace all `window.LanguageModel` with `typeof LanguageModel !== 'undefined' ? LanguageModel : undefined`
- Remove the `declare global` block

**Step 3: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

**Step 4: Run `npm run build` to verify TypeScript compiles**

Run: `npm run build`
Expected: Build succeeds with no errors

**Step 5: Final manual test**

Run: `npm run dev`
Test the full flow:
1. AI status message visible on prompt screen
2. Enter prompts for both sides, click Battle
3. Units spawn, AI controls them (or fallback behavior works)
4. Combat works, units die, health bars update
5. Win condition triggers, result screen shows
6. Rematch works, New Battle works
7. Speed controls work (1x, 2x, 3x)

**Step 6: Commit**

```bash
git add -A
git commit -m "feat: add AI status check, type declarations, and polish"
```

---

Plan complete and saved to `docs/plans/2026-02-25-prompt-wars-implementation.md`. Two execution options:

**1. Subagent-Driven (this session)** — I dispatch fresh subagent per task, review between tasks, fast iteration

**2. Parallel Session (separate)** — Open new session with executing-plans, batch execution with checkpoints

Which approach?