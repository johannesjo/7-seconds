# Prompt Wars — Game Design Document

## Concept

A single-screen RTS where players don't control units directly. Instead, they write natural language strategy prompts that instruct an on-device AI commander. Two AI commanders (one per side) control units in real-time during battle. Players can write prompts for both sides (hot-seat mode).

The core skill is **prompt engineering** — a vague prompt produces dumb tactics, a detailed prompt produces smart ones.

## Game Flow

1. **Prompt Screen** — Two text areas (left/right). Each player writes a strategy prompt. Hit "Battle!"
2. **Battle Screen** — AI commanders control all units in real-time. Battle auto-plays until one side is eliminated.
3. **Result Screen** — Winner overlay, stats, rematch or new battle.

No menus, no settings, no accounts. Three screens.

## Unit Types

| Unit       | Shape          | Speed  | HP  | Damage | Range       | Count |
|------------|----------------|--------|-----|--------|-------------|-------|
| **Scout**  | Small circle   | Fast   | 30  | 5/s    | Melee       | 4     |
| **Soldier**| Medium square  | Normal | 60  | 10/s   | Short range | 4     |
| **Tank**   | Large hexagon  | Slow   | 120 | 20/s   | Melee       | 2     |

10 units per side (4 scouts, 4 soldiers, 2 tanks). Identical armies.

Implicit rock-paper-scissors: scouts kite tanks (speed), soldiers outrange scouts, tanks crush soldiers in direct fights.

## AI Integration

### Chrome Prompt API (`window.ai.languageModel`)

Two AI sessions created at battle start, each with the user's prompt as system instruction.

**Every ~1500ms during battle:**

1. Engine serializes game state to JSON:
```json
{
  "my_units": [
    { "id": "scout_1", "pos": [200, 100], "hp": 30 },
    { "id": "tank_1", "pos": [100, 400], "hp": 120 }
  ],
  "enemy_units": [
    { "id": "e_soldier_1", "pos": [600, 300], "hp": 60 }
  ],
  "obstacles": [{ "x": 400, "y": 200, "w": 80, "h": 120 }]
}
```

2. AI responds with per-unit orders:
```json
{
  "orders": [
    { "id": "scout_1", "move_to": [500, 100], "attack": "e_soldier_1" },
    { "id": "tank_1", "move_to": [400, 400], "attack": null }
  ]
}
```

3. Units smoothly interpolate toward targets between AI calls.

**Fallback:** If AI returns malformed JSON, keep previous orders.

### The User's Prompt

The user's prompt becomes the AI commander's personality and strategy. Examples:

- Vague: *"Just win"* — AI has no guidance, plays poorly
- Detailed: *"Flank with scouts from the left. Soldiers hold center and focus fire on weakest enemy. Tanks push up the right side aggressively. If a unit is below 30% HP, pull it back."* — AI plays much better

## Battlefield

- **Size:** ~1200x800 logical pixels, single screen
- **Layout:** Left team spawns in left third, right team in right third
- **Terrain:** 3-5 rectangular obstacles in the middle zone, randomly placed but mirrored (left-right symmetry) for fairness
- **Pathfinding:** Steering behavior — units move toward targets, slide along obstacle edges. Random nudge if stuck.

## Combat

- Units attack when an enemy is within their range
- Damage is applied per second (continuous, not burst)
- Dead units fade out and are removed
- No armor, no abilities, no special mechanics
- Target selection: follow AI's `attack` order; if target is dead or null, engage nearest enemy in range

## UI Details

### Prompt Screen
- Split view: left textarea, right textarea
- Army preview below each textarea (shows the 10 units)
- "Battle!" button center

### Battle Screen
- Full battlefield canvas (PixiJS)
- Small health bars above each unit
- Team colors: blue (left) vs red (right)
- Kill counter at top: `Blue: X alive | Red: X alive`
- Speed controls: 1x / 2x / 3x

### Result Screen
- Overlay on battlefield: "Blue Wins!" / "Red Wins!"
- Stats: units killed, units survived, battle duration
- "Rematch" button (same prompts) / "New Battle" button (back to prompts)

## Technical Architecture

### Stack
- Vite + TypeScript
- PixiJS for rendering
- Chrome Prompt API for AI
- No backend

### Modules

| Module                      | Responsibility                                    |
|-----------------------------|---------------------------------------------------|
| `main.ts`                   | Entry point, screen management                    |
| `game.ts`                   | Game loop (60fps), tick updates, collision         |
| `units.ts`                  | Unit types, movement, combat, health              |
| `battlefield.ts`            | Map generation, obstacles, spawning               |
| `ai-commander.ts`           | Prompt API wrapper, state serialization, parsing   |
| `renderer.ts`               | PixiJS setup, drawing everything                  |
| `screens/prompt-screen.ts`  | Prompt input UI                                   |
| `screens/battle-screen.ts`  | Battle view + speed controls                      |
| `screens/result-screen.ts`  | Win/loss overlay + stats                          |

### Game Loop
```
Every frame (60fps):
  - Move units toward current targets (interpolation)
  - Check attack ranges, deal damage (scaled by delta time)
  - Remove dead units
  - Check win condition

Every ~1500ms:
  - Serialize game state
  - Send to both AI sessions in parallel
  - Parse responses, update unit orders
```

## Out of Scope (Future)
- Networked multiplayer
- AI vs human direct control
- Army composition choices
- Multiple maps
- Sound/music
- Persistent stats / leaderboards
- Alternative AI providers / fallbacks
