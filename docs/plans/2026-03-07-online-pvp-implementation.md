# Online PvP Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Allow two players to play PvP remotely via a share link using WebRTC peer-to-peer connections.

**Architecture:** Host-client model using Trystero (`trystero/supabase`) for WebRTC. Host runs the game engine and streams frame data to Guest. Guest renders received frames like a live replay. Players connect via share link containing a room ID.

**Tech Stack:** Trystero (WebRTC), Supabase free tier (signaling only), existing Pixi.js renderer and replay frame format.

---

### Task 1: Install Trystero dependency

**Files:**
- Modify: `package.json`

**Step 1: Install trystero**

Run: `npm install trystero`

**Step 2: Verify installation**

Run: `npm ls trystero`
Expected: `trystero@0.x.x` listed

**Step 3: Commit**

```bash
git add package.json package-lock.json
git commit -m "chore: add trystero dependency for online PvP"
```

---

### Task 2: Define online message types

**Files:**
- Create: `src/online-types.ts`
- Test: `src/online-types.test.ts`

**Step 1: Write the type definitions**

```typescript
// src/online-types.ts
import { Obstacle, ElevationZone, Vec2, ReplayUnitSnapshot, ReplayProjectileSnapshot, ReplayEvent, Team } from './types';

/** Sent by Host to Guest after connection to initialize the game. */
export interface OnlineGameState {
  units: {
    id: string;
    type: string;
    team: Team;
    x: number;
    y: number;
    hp: number;
    maxHp: number;
    radius: number;
  }[];
  obstacles: Obstacle[];
  elevationZones: ElevationZone[];
  mapWidth: number;
  mapHeight: number;
}

/** Phase transitions sent from Host to Guest. */
export type OnlinePhase = 'blue-planning' | 'red-planning' | 'playing' | 'round-end';

/** Sent by Guest to Host: the drawn paths for red units. */
export interface OnlinePathData {
  paths: { unitId: string; waypoints: Vec2[] }[];
}

/** Sent by Host to Guest each tick during battle. */
export interface OnlineFrameData {
  units: ReplayUnitSnapshot[];
  projectiles: ReplayProjectileSnapshot[];
  events: ReplayEvent[];
}

/** Sent by Host to Guest when a round ends or game ends. */
export interface OnlineRoundResult {
  winner: Team | 'draw';
  blueAlive: number;
  redAlive: number;
  duration: number;
  gameOver: boolean;
}

/** Connection state for UI. */
export type OnlineConnectionState = 'idle' | 'waiting' | 'connecting' | 'connected' | 'disconnected' | 'error';
```

**Step 2: Write a basic type check test**

```typescript
// src/online-types.test.ts
import { describe, it, expect } from 'vitest';
import type { OnlineGameState, OnlinePathData, OnlineFrameData, OnlineRoundResult, OnlineConnectionState } from './online-types';

describe('online-types', () => {
  it('OnlineGameState has required fields', () => {
    const state: OnlineGameState = {
      units: [{ id: 'b0', type: 'soldier', team: 'blue', x: 0, y: 0, hp: 60, maxHp: 60, radius: 10 }],
      obstacles: [],
      elevationZones: [],
      mapWidth: 1200,
      mapHeight: 800,
    };
    expect(state.units).toHaveLength(1);
    expect(state.mapWidth).toBe(1200);
  });

  it('OnlinePathData serializes waypoints', () => {
    const data: OnlinePathData = {
      paths: [{ unitId: 'r0', waypoints: [{ x: 100, y: 200 }, { x: 300, y: 400 }] }],
    };
    const json = JSON.parse(JSON.stringify(data));
    expect(json.paths[0].waypoints).toHaveLength(2);
  });

  it('OnlineConnectionState covers all states', () => {
    const states: OnlineConnectionState[] = ['idle', 'waiting', 'connecting', 'connected', 'disconnected', 'error'];
    expect(states).toHaveLength(6);
  });
});
```

**Step 3: Run tests to verify**

Run: `npx vitest run src/online-types.test.ts`
Expected: 3 tests PASS

**Step 4: Commit**

```bash
git add src/online-types.ts src/online-types.test.ts
git commit -m "feat(online): add message type definitions for online PvP"
```

---

### Task 3: Create connection manager (`online.ts`)

**Files:**
- Create: `src/online.ts`
- Test: `src/online.test.ts`

This module wraps Trystero room management and exposes typed action channels.

**Step 1: Write the connection manager**

```typescript
// src/online.ts
import { joinRoom, Room } from 'trystero/supabase';
import { OnlineGameState, OnlinePhase, OnlinePathData, OnlineFrameData, OnlineRoundResult, OnlineConnectionState } from './online-types';

// Supabase config — the free project used only for signaling
const TRYSTERO_CONFIG = {
  appId: '7-seconds-pvp',
  // TODO: Replace with actual Supabase project URL and anon key
  supabaseUrl: '', // e.g. 'https://xxx.supabase.co'
  supabaseKey: '', // anon/public key
};

export type OnlineRole = 'host' | 'guest';

export interface OnlineActions {
  sendState: (data: OnlineGameState, peerId?: string) => void;
  onState: (cb: (data: OnlineGameState, peerId: string) => void) => void;
  sendPhase: (data: OnlinePhase, peerId?: string) => void;
  onPhase: (cb: (data: OnlinePhase, peerId: string) => void) => void;
  sendPaths: (data: OnlinePathData, peerId?: string) => void;
  onPaths: (cb: (data: OnlinePathData, peerId: string) => void) => void;
  sendFrame: (data: OnlineFrameData, peerId?: string) => void;
  onFrame: (cb: (data: OnlineFrameData, peerId: string) => void) => void;
  sendResult: (data: OnlineRoundResult, peerId?: string) => void;
  onResult: (cb: (data: OnlineRoundResult, peerId: string) => void) => void;
}

export interface OnlineConnection {
  room: Room;
  actions: OnlineActions;
  role: OnlineRole;
  roomId: string;
  peerId: string | null;
  destroy: () => void;
}

/** Generate a short random room ID. */
export function generateRoomId(): string {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789'; // no ambiguous chars
  let id = '';
  for (let i = 0; i < 6; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  return id;
}

/** Build the share URL for a room. */
export function getShareUrl(roomId: string): string {
  const url = new URL(window.location.href);
  url.searchParams.set('join', roomId);
  // Remove other params that might be present
  url.hash = '';
  return url.toString();
}

/** Check if the current URL has a join param. */
export function getJoinRoomId(): string | null {
  const params = new URLSearchParams(window.location.search);
  return params.get('join');
}

/** Create a room and return typed action channels. */
export function createOnlineRoom(
  roomId: string,
  role: OnlineRole,
  onPeerJoin: (peerId: string) => void,
  onPeerLeave: (peerId: string) => void,
): OnlineConnection {
  const room = joinRoom(TRYSTERO_CONFIG, roomId);

  const [sendState, onState] = room.makeAction<OnlineGameState>('state');
  const [sendPhase, onPhase] = room.makeAction<OnlinePhase>('phase');
  const [sendPaths, onPaths] = room.makeAction<OnlinePathData>('paths');
  const [sendFrame, onFrame] = room.makeAction<OnlineFrameData>('frame');
  const [sendResult, onResult] = room.makeAction<OnlineRoundResult>('result');

  room.onPeerJoin(onPeerJoin);
  room.onPeerLeave(onPeerLeave);

  let peerId: string | null = null;

  const originalOnJoin = onPeerJoin;
  room.onPeerJoin((id) => {
    peerId = id;
    originalOnJoin(id);
  });

  return {
    room,
    actions: { sendState, onState, sendPhase, onPhase, sendPaths, onPaths, sendFrame, onFrame, sendResult, onResult },
    role,
    roomId,
    get peerId() { return peerId; },
    destroy: () => room.leave(),
  };
}
```

**Step 2: Write tests for pure utility functions**

```typescript
// src/online.test.ts
import { describe, it, expect } from 'vitest';
import { generateRoomId, getShareUrl } from './online';

describe('online', () => {
  it('generateRoomId returns a 6-char string', () => {
    const id = generateRoomId();
    expect(id).toHaveLength(6);
    expect(id).toMatch(/^[a-z0-9]+$/);
  });

  it('generateRoomId produces unique IDs', () => {
    const ids = new Set(Array.from({ length: 50 }, () => generateRoomId()));
    expect(ids.size).toBeGreaterThan(45); // very unlikely to have collisions
  });

  it('getShareUrl includes join param', () => {
    const url = getShareUrl('abc123');
    expect(url).toContain('join=abc123');
  });
});
```

**Step 3: Run tests**

Run: `npx vitest run src/online.test.ts`
Expected: 3 tests PASS

**Step 4: Commit**

```bash
git add src/online.ts src/online.test.ts
git commit -m "feat(online): add connection manager with Trystero room setup"
```

---

### Task 4: Create host logic (`online-host.ts`)

**Files:**
- Create: `src/online-host.ts`

The host module orchestrates the game from the host's perspective:
- Creates the room and waits for a guest
- Sends initial game state to guest
- During blue-planning: host draws paths locally, then transitions to red-planning
- During red-planning: waits for guest to send paths
- During playing: streams frame data each tick
- On round end: sends result

**Step 1: Write the host module**

```typescript
// src/online-host.ts
import { OnlineConnection, createOnlineRoom, generateRoomId, getShareUrl } from './online';
import { OnlineGameState, OnlineFrameData, OnlinePathData, OnlineRoundResult, OnlineConnectionState } from './online-types';
import { GameEngine } from './game';
import { Renderer } from './renderer';
import { Unit, Vec2, ReplayFrame } from './types';

export interface OnlineHostCallbacks {
  onConnectionStateChange: (state: OnlineConnectionState) => void;
  onShareUrl: (url: string, roomId: string) => void;
  onGuestPathsReceived: () => void;
}

export class OnlineHost {
  private connection: OnlineConnection | null = null;
  private callbacks: OnlineHostCallbacks;
  private guestPeerId: string | null = null;

  constructor(callbacks: OnlineHostCallbacks) {
    this.callbacks = callbacks;
  }

  /** Create a room and start waiting for a guest. */
  createRoom(): string {
    const roomId = generateRoomId();
    this.callbacks.onConnectionStateChange('waiting');
    this.callbacks.onShareUrl(getShareUrl(roomId), roomId);

    this.connection = createOnlineRoom(
      roomId,
      'host',
      (peerId) => {
        this.guestPeerId = peerId;
        this.callbacks.onConnectionStateChange('connected');
      },
      (_peerId) => {
        this.guestPeerId = null;
        this.callbacks.onConnectionStateChange('disconnected');
      },
    );

    // Listen for guest paths
    this.connection.actions.onPaths((data: OnlinePathData) => {
      this._pendingPaths = data;
      this.callbacks.onGuestPathsReceived();
    });

    return roomId;
  }

  private _pendingPaths: OnlinePathData | null = null;

  /** Get and consume paths sent by the guest. */
  consumeGuestPaths(): OnlinePathData | null {
    const paths = this._pendingPaths;
    this._pendingPaths = null;
    return paths;
  }

  /** Send initial game state to guest. */
  sendGameState(state: OnlineGameState): void {
    this.connection?.actions.sendState(state);
  }

  /** Notify guest of a phase change. */
  sendPhase(phase: OnlineGameState extends never ? never : import('./online-types').OnlinePhase): void {
    this.connection?.actions.sendPhase(phase);
  }

  /** Stream a frame to the guest. */
  sendFrame(frame: OnlineFrameData): void {
    this.connection?.actions.sendFrame(frame);
  }

  /** Send round result to guest. */
  sendResult(result: OnlineRoundResult): void {
    this.connection?.actions.sendResult(result);
  }

  /** Apply guest paths to red units. */
  applyGuestPaths(units: Unit[], pathData: OnlinePathData): void {
    for (const p of pathData.paths) {
      const unit = units.find(u => u.id === p.unitId);
      if (unit && unit.team === 'red') {
        unit.waypoints = p.waypoints;
      }
    }
  }

  get isConnected(): boolean {
    return this.guestPeerId !== null;
  }

  destroy(): void {
    this.connection?.destroy();
    this.connection = null;
    this.guestPeerId = null;
  }
}
```

**Step 2: Commit**

```bash
git add src/online-host.ts
git commit -m "feat(online): add host logic for online PvP"
```

---

### Task 5: Create guest logic (`online-guest.ts`)

**Files:**
- Create: `src/online-guest.ts`

The guest module:
- Joins a room using the room ID from the share link
- Receives initial game state and renders it
- During red-planning: enables path drawing, sends paths to host
- During playing: receives frame data and renders it (like replay)

**Step 1: Write the guest module**

```typescript
// src/online-guest.ts
import { OnlineConnection, createOnlineRoom } from './online';
import { OnlineGameState, OnlinePhase, OnlineFrameData, OnlinePathData, OnlineRoundResult, OnlineConnectionState } from './online-types';
import { Renderer } from './renderer';
import { Unit, Projectile, Team, ReplayEvent } from './types';

export interface OnlineGuestCallbacks {
  onConnectionStateChange: (state: OnlineConnectionState) => void;
  onGameState: (state: OnlineGameState) => void;
  onPhaseChange: (phase: OnlinePhase) => void;
  onFrame: (frame: OnlineFrameData) => void;
  onResult: (result: OnlineRoundResult) => void;
}

export class OnlineGuest {
  private connection: OnlineConnection | null = null;
  private callbacks: OnlineGuestCallbacks;

  constructor(callbacks: OnlineGuestCallbacks) {
    this.callbacks = callbacks;
  }

  /** Join a room as guest. */
  joinRoom(roomId: string): void {
    this.callbacks.onConnectionStateChange('connecting');

    this.connection = createOnlineRoom(
      roomId,
      'guest',
      (_peerId) => {
        this.callbacks.onConnectionStateChange('connected');
      },
      (_peerId) => {
        this.callbacks.onConnectionStateChange('disconnected');
      },
    );

    this.connection.actions.onState((state: OnlineGameState) => {
      this.callbacks.onGameState(state);
    });

    this.connection.actions.onPhase((phase: OnlinePhase) => {
      this.callbacks.onPhaseChange(phase);
    });

    this.connection.actions.onFrame((frame: OnlineFrameData) => {
      this.callbacks.onFrame(frame);
    });

    this.connection.actions.onResult((result: OnlineRoundResult) => {
      this.callbacks.onResult(result);
    });
  }

  /** Send drawn paths to the host. */
  sendPaths(paths: OnlinePathData): void {
    this.connection?.actions.sendPaths(paths);
  }

  get isConnected(): boolean {
    return this.connection?.peerId !== null;
  }

  destroy(): void {
    this.connection?.destroy();
    this.connection = null;
  }
}
```

**Step 2: Commit**

```bash
git add src/online-guest.ts
git commit -m "feat(online): add guest logic for online PvP"
```

---

### Task 6: Add frame emission hook to GameEngine

**Files:**
- Modify: `src/game.ts`

Add an optional `onFrame` callback to GameEngine that fires each tick during the `playing` phase, emitting the current frame data. The host will use this to stream frames to the guest.

**Step 1: Add the onFrame callback option to the constructor**

In `src/game.ts`, add to the `opts` parameter:

```typescript
// Add to constructor opts type (around line 46-53):
onFrame?: (frame: OnlineFrameData) => void;
```

Add to the class fields:

```typescript
private onFrameCallback: ((frame: import('./online-types').OnlineFrameData) => void) | null = null;
```

In the constructor body:

```typescript
this.onFrameCallback = opts?.onFrame ?? null;
```

**Step 2: Emit frame data after recordFrame() in the tick method**

After line `this.recordFrame();` (around line 425), add:

```typescript
if (this.onFrameCallback) {
  const lastFrame = this.replayFrames[this.replayFrames.length - 1];
  const frameEvents = this.replayEvents.filter(e => e.frame === this.replayFrames.length - 1);
  this.onFrameCallback({
    units: lastFrame.units,
    projectiles: lastFrame.projectiles,
    events: frameEvents,
  });
}
```

**Step 3: Also add an `onPhaseChange` callback for the host to notify the guest**

Add to opts:

```typescript
onPhaseChange?: (phase: TurnPhase) => void;
```

Add field and constructor assignment:

```typescript
private onPhaseChangeCallback: ((phase: TurnPhase) => void) | null = null;
// in constructor:
this.onPhaseChangeCallback = opts?.onPhaseChange ?? null;
```

In `setPhase()`, after `this.onEvent('phase-change', ...)` (line 180), add:

```typescript
this.onPhaseChangeCallback?.(phase);
```

**Step 4: Add a method to set red unit waypoints externally (for host applying guest paths)**

```typescript
/** Set waypoints for red units from external input (online guest paths). */
setRedPaths(paths: { unitId: string; waypoints: Vec2[] }[]): void {
  for (const p of paths) {
    const unit = this.units.find(u => u.id === p.unitId);
    if (unit && unit.team === 'red') {
      unit.waypoints = p.waypoints;
    }
  }
}
```

**Step 5: Add a method to get the serialized game state for sending to guest**

```typescript
/** Get serialized game state for sending to online guest. */
getOnlineGameState(): import('./online-types').OnlineGameState {
  return {
    units: this.units.map(u => ({
      id: u.id,
      type: u.type,
      team: u.team,
      x: u.pos.x,
      y: u.pos.y,
      hp: u.hp,
      maxHp: u.maxHp,
      radius: u.radius,
    })),
    obstacles: this.obstacles,
    elevationZones: this.elevationZones,
    mapWidth: MAP_WIDTH,
    mapHeight: MAP_HEIGHT,
  };
}
```

**Step 6: Run existing tests to ensure no regressions**

Run: `npx vitest run`
Expected: All existing tests PASS

**Step 7: Commit**

```bash
git add src/game.ts
git commit -m "feat(online): add frame/phase emission hooks to GameEngine"
```

---

### Task 7: Add online mode UI to HTML

**Files:**
- Modify: `index.html`

**Step 1: Add "Online PvP" button to the prompt screen**

After the first `.btn-row` div (after the `vs Player` button, around line 352), add:

```html
<button id="online-btn" style="padding:12px 36px;font-size:16px;font-weight:bold;text-transform:uppercase;letter-spacing:3px;background:#2a4a2a;color:#44ff88;border:2px solid #228844;border-radius:4px;cursor:pointer">Online PvP</button>
```

Add it inside the first `.btn-row` div alongside the other buttons.

**Step 2: Add the online lobby overlay**

After the `cover-screen` div (around line 406), add:

```html
<div id="online-lobby" style="display:none;position:absolute;top:0;left:0;right:0;bottom:0;flex-direction:column;align-items:center;justify-content:center;gap:16px;background:rgba(0,0,0,0.85);z-index:25;padding:32px">
  <h2 style="font-size:28px;letter-spacing:3px;text-transform:uppercase;color:#44ff88">Online PvP</h2>
  <p id="online-status" style="font-size:16px;opacity:0.8">Creating room...</p>
  <div id="online-share-container" style="display:none;flex-direction:column;align-items:center;gap:12px">
    <p style="font-size:14px;opacity:0.7">Share this link with your opponent:</p>
    <input id="online-share-url" type="text" readonly style="width:320px;max-width:90vw;padding:10px;font-size:14px;background:#1a1a2a;color:#eee;border:1px solid #555;border-radius:4px;text-align:center" />
    <button id="online-copy-btn" style="padding:8px 24px;font-size:14px;background:#2a4a2a;color:#44ff88;border:1px solid #228844;border-radius:4px;cursor:pointer">Copy Link</button>
  </div>
  <button id="online-cancel-btn" style="padding:8px 24px;font-size:14px;background:#2a2a4a;color:#eee;border:1px solid #555;border-radius:4px;cursor:pointer;opacity:0.7;margin-top:16px">Cancel</button>
</div>
```

**Step 3: Add day-mode styles for online elements**

In the `<style>` section, add after the existing day-mode styles (around line 342):

```css
body.day-mode #online-btn { background: #cce8cc; color: #226633; border-color: #44aa66; }
body.day-mode #online-lobby { background: rgba(245,240,224,0.85); color: #443322; }
body.day-mode #online-share-url { background: #e8e0cc; color: #443322; border-color: #aa9977; }
body.day-mode #online-copy-btn { background: #cce8cc; color: #226633; border-color: #44aa66; }
body.day-mode #online-cancel-btn { background: #e8e0cc; color: #443322; border-color: #aa9977; }
```

**Step 4: Commit**

```bash
git add index.html
git commit -m "feat(online): add online PvP button and lobby overlay to HTML"
```

---

### Task 8: Wire up online mode in main.ts

**Files:**
- Modify: `src/main.ts`

This is the largest task. It integrates the online host/guest modules into the existing game flow.

**Step 1: Add imports and DOM references**

At the top of `main.ts`, add:

```typescript
import { OnlineHost } from './online-host';
import { OnlineGuest } from './online-guest';
import { getJoinRoomId } from './online';
import { OnlineConnectionState, OnlineGameState, OnlinePhase, OnlineFrameData, OnlineRoundResult, OnlinePathData } from './online-types';
```

Add DOM references after the existing ones:

```typescript
const onlineBtn = document.getElementById('online-btn')!;
const onlineLobby = document.getElementById('online-lobby')!;
const onlineStatus = document.getElementById('online-status')!;
const onlineShareContainer = document.getElementById('online-share-container')!;
const onlineShareUrl = document.getElementById('online-share-url') as HTMLInputElement;
const onlineCopyBtn = document.getElementById('online-copy-btn')!;
const onlineCancelBtn = document.getElementById('online-cancel-btn')!;
```

Add state:

```typescript
let onlineHost: OnlineHost | null = null;
let onlineGuest: OnlineGuest | null = null;
let onlineActive = false;
let onlineRole: 'host' | 'guest' | null = null;
```

**Step 2: Add host flow**

```typescript
// --- Online PvP: Host flow ---
onlineBtn.addEventListener('click', async () => {
  await initRenderer();
  onlineActive = true;
  onlineRole = 'host';
  onlineLobby.style.display = 'flex';
  onlineStatus.textContent = 'Waiting for opponent...';
  onlineShareContainer.style.display = 'none';

  onlineHost = new OnlineHost({
    onConnectionStateChange: (state: OnlineConnectionState) => {
      if (state === 'connected') {
        onlineStatus.textContent = 'Opponent connected! Starting...';
        onlineLobby.style.display = 'none';
        startOnlineHostGame();
      } else if (state === 'disconnected') {
        onlineStatus.textContent = 'Opponent disconnected.';
        // Show lobby again or return to menu
        if (engine) {
          engine.stop();
          engine = null;
        }
        onlineLobby.style.display = 'flex';
        onlineShareContainer.style.display = 'none';
      }
    },
    onShareUrl: (url: string) => {
      onlineShareContainer.style.display = 'flex';
      onlineShareUrl.value = url;
    },
    onGuestPathsReceived: () => {
      // Guest submitted paths — apply them and start the battle
      if (engine && onlineHost) {
        const pathData = onlineHost.consumeGuestPaths();
        if (pathData) {
          engine.setRedPaths(pathData.paths);
          engine.confirmPlan(); // transitions from red-planning to playing
        }
      }
    },
  });

  onlineHost.createRoom();
});

function startOnlineHostGame(): void {
  lastReplayData = null;
  engine?.stop();
  document.body.classList.toggle('day-mode', dayModeCb.checked);
  renderer!.setTheme(dayModeCb.checked ? DAY_THEME : NIGHT_THEME);

  engine = new GameEngine(renderer!, onGameEvent, {
    aiMode: false,
    onFrame: (frame: OnlineFrameData) => {
      onlineHost?.sendFrame(frame);
    },
    onPhaseChange: (phase) => {
      if (onlineHost) {
        const onlinePhase: OnlinePhase = phase === 'cover' ? 'red-planning' : phase as OnlinePhase;
        onlineHost.sendPhase(onlinePhase);
      }
    },
  });

  showScreen('battle');
  speedToggle.classList.remove('active');
  speedToggle.dataset.speed = '1';
  speedToggle.textContent = '3x';
  roundCounterEl.textContent = 'Round 1';
  engine.startBattle();

  // Send initial game state to guest
  onlineHost!.sendGameState(engine.getOnlineGameState());
}
```

**Step 3: Add guest flow**

```typescript
// --- Online PvP: Guest flow ---
function startOnlineGuestMode(roomId: string): void {
  onlineActive = true;
  onlineRole = 'guest';
  onlineLobby.style.display = 'flex';
  onlineStatus.textContent = 'Connecting to game...';
  onlineShareContainer.style.display = 'none';

  onlineGuest = new OnlineGuest({
    onConnectionStateChange: (state: OnlineConnectionState) => {
      if (state === 'connected') {
        onlineStatus.textContent = 'Connected! Waiting for host...';
      } else if (state === 'disconnected') {
        onlineStatus.textContent = 'Host disconnected.';
      }
    },
    onGameState: async (state: OnlineGameState) => {
      // Host sent game state — initialize renderer and show battlefield
      await initRenderer();
      document.body.classList.toggle('day-mode', dayModeCb.checked);
      renderer!.setTheme(dayModeCb.checked ? DAY_THEME : NIGHT_THEME);
      onlineLobby.style.display = 'none';

      // Render the initial state
      const { setMapSize } = await import('./constants');
      setMapSize(state.mapWidth, state.mapHeight);
      renderer!.renderElevationZones(state.elevationZones);
      renderer!.renderObstacles(state.obstacles);

      // Store units for path drawing during red-planning
      guestUnits = state.units.map(u => ({
        id: u.id,
        type: u.type as import('./types').UnitType,
        team: u.team,
        pos: { x: u.x, y: u.y },
        hp: u.hp,
        maxHp: u.maxHp,
        radius: u.radius,
        speed: 0,
        damage: 0,
        range: 0,
        moveTarget: null,
        waypoints: [],
        attackTargetId: null,
        alive: true,
        fireCooldown: 0,
        fireTimer: 0,
        projectileSpeed: 0,
        projectileRadius: 0,
        vel: { x: 0, y: 0 },
        gunAngle: 0,
        turnSpeed: 0,
      }));
      guestElevationZones = state.elevationZones;

      renderer!.renderUnits(guestUnits);
      showScreen('battle');
      battleHud.style.display = 'none';
    },
    onPhaseChange: (phase: OnlinePhase) => {
      if (phase === 'red-planning') {
        // Enable path drawing for red units
        onPhaseChange('red-planning');
        // Guest needs a PathDrawer — create one via the renderer
        enableGuestPathDrawing();
      } else if (phase === 'blue-planning') {
        onPhaseChange('blue-planning');
        // Guest waits during host's planning
        planningLabel.textContent = 'Opponent Planning';
        planningOverlay.classList.add('active');
        confirmBtn.classList.remove('active');
      } else if (phase === 'playing') {
        onPhaseChange('playing');
        battleHud.style.display = '';
      } else if (phase === 'round-end') {
        // Handled by onResult
      }
    },
    onFrame: (frame: OnlineFrameData) => {
      // Render the frame like a replay
      if (!renderer) return;
      const units = frame.units.map(s => ({
        id: s.id,
        type: s.type,
        team: s.team,
        pos: { x: s.x, y: s.y },
        vel: { x: s.vx, y: s.vy },
        gunAngle: s.gunAngle,
        hp: s.hp,
        maxHp: s.maxHp,
        alive: s.alive,
        radius: s.radius,
        speed: 0, damage: 0, range: 0,
        moveTarget: null, waypoints: [],
        attackTargetId: null,
        fireCooldown: 0, fireTimer: 0,
        projectileSpeed: 0, projectileRadius: 0,
        turnSpeed: 0,
      }));
      const projectiles = frame.projectiles.map(s => ({
        pos: { x: s.x, y: s.y },
        vel: { x: s.vx, y: s.vy },
        target: { x: 0, y: 0 },
        damage: s.damage,
        radius: s.radius,
        team: s.team,
        maxRange: s.maxRange,
        distanceTraveled: s.distanceTraveled,
        trail: s.trail,
      }));

      renderer.renderUnits(units as import('./types').Unit[], 1 / 60);
      renderer.renderProjectiles(projectiles as import('./types').Projectile[]);
      renderer.effects?.update(1 / 60);

      // Trigger effects for events
      const fx = renderer.effects;
      if (fx) {
        for (const event of frame.events) {
          if (event.type === 'fire') {
            fx.addMuzzleFlash(event.pos, event.angle, 6);
          } else if (event.type === 'hit') {
            const victimTeam = event.team === 'blue' ? 'red' : 'blue';
            fx.addBloodSpray(event.pos, event.angle, victimTeam as import('./types').Team, event.damage);
          } else if (event.type === 'kill') {
            const victimTeam = event.team === 'blue' ? 'red' : 'blue';
            fx.addBloodSpray(event.pos, event.angle, victimTeam as import('./types').Team, event.damage);
            fx.addBloodBurst(event.pos, event.angle, victimTeam as import('./types').Team, event.damage);
            fx.addKillText(event.pos, event.team);
          }
        }
      }

      // Update HUD counts from frame
      const blueAlive = frame.units.filter(u => u.alive && u.team === 'blue').length;
      const redAlive = frame.units.filter(u => u.alive && u.team === 'red').length;
      blueCountEl.textContent = `Blue: ${blueAlive}`;
      redCountEl.textContent = `Red: ${redAlive}`;
    },
    onResult: (result: OnlineRoundResult) => {
      const color = result.winner === 'blue' ? '#4a9eff' : '#ff4a4a';
      winnerTextEl.innerHTML = `${result.winner === 'blue' ? 'Blue' : 'Red'} Wins!`;
      winnerTextEl.style.color = color;
      resultStatsEl.innerHTML = [
        `Duration: ${result.duration.toFixed(1)}s`,
        `Blue survivors: ${result.blueAlive}`,
        `Red survivors: ${result.redAlive}`,
      ].join('<br>');

      rematchBtn.style.display = 'none'; // Guest can't rematch (host controls)
      newBattleBtn.textContent = 'Leave';
      replayBtn.style.display = 'none';
      showScreen('result');
    },
  });

  onlineGuest.joinRoom(roomId);
}

// Guest-specific state
let guestUnits: import('./types').Unit[] = [];
let guestElevationZones: import('./types').ElevationZone[] = [];
let guestPathDrawer: import('./path-drawer').PathDrawer | null = null;

function enableGuestPathDrawing(): void {
  if (!renderer) return;
  const { PathDrawer } = require('./path-drawer');
  guestPathDrawer = new PathDrawer(renderer.stage, renderer.canvas, (pos: import('./types').Vec2) => renderer!.highlightZonesAt(pos));
  guestPathDrawer.theme = renderer.currentTheme;
  guestPathDrawer.enable('red', guestUnits, guestElevationZones);

  // Show planning UI
  planningLabel.textContent = 'Your Planning';
  planningLabel.style.color = '#ff4a4a';
  planningOverlay.classList.add('active');
  confirmBtn.classList.add('active');
}
```

**Step 4: Wire up the confirm button for guest**

Modify the existing `confirmBtn` click handler to handle guest mode:

```typescript
// Modify the existing confirmBtn click handler:
confirmBtn.addEventListener('click', () => {
  if (onlineActive && onlineRole === 'guest' && guestPathDrawer) {
    // Collect paths from path drawer and send to host
    const redUnits = guestUnits.filter(u => u.team === 'red');
    const paths: OnlinePathData = {
      paths: redUnits.map(u => ({
        unitId: u.id,
        waypoints: [...u.waypoints],
      })),
    };
    onlineGuest?.sendPaths(paths);
    guestPathDrawer.disable();
    guestPathDrawer.clearGraphics();
    guestPathDrawer = null;

    planningOverlay.classList.remove('active');
    confirmBtn.classList.remove('active');
    planningLabel.textContent = 'Waiting for battle...';
    planningOverlay.classList.add('active');
    return;
  }
  engine?.confirmPlan();
});
```

**Step 5: Wire up host's confirm button to skip red-planning (guest draws instead)**

In the host flow, when the engine transitions to `cover`/`red-planning`, the host should NOT enable local red path drawing. Instead, wait for guest paths. Modify the `onPhaseChange` function to handle this:

```typescript
// In onPhaseChange function, add at the top:
if (onlineActive && onlineRole === 'host') {
  // During online host mode, skip cover screen and red-planning UI
  if (phase === 'cover' || phase === 'red-planning') {
    planningLabel.textContent = 'Opponent Planning';
    planningOverlay.classList.add('active');
    confirmBtn.classList.remove('active');
    battleHud.style.display = 'none';
    return;
  }
}
```

**Step 6: Wire up copy button and cancel button**

```typescript
onlineCopyBtn.addEventListener('click', () => {
  onlineShareUrl.select();
  navigator.clipboard.writeText(onlineShareUrl.value);
  onlineCopyBtn.textContent = 'Copied!';
  setTimeout(() => { onlineCopyBtn.textContent = 'Copy Link'; }, 2000);
});

onlineCancelBtn.addEventListener('click', () => {
  onlineHost?.destroy();
  onlineHost = null;
  onlineGuest?.destroy();
  onlineGuest = null;
  onlineActive = false;
  onlineRole = null;
  onlineLobby.style.display = 'none';
  showScreen('prompt');
});
```

**Step 7: Auto-detect join URL on load**

At the bottom of the IIFE (around line 549-555), add:

```typescript
// Check if we're joining an online game via URL
const joinRoomId = getJoinRoomId();
if (joinRoomId) {
  // Clean up the URL
  const cleanUrl = new URL(window.location.href);
  cleanUrl.searchParams.delete('join');
  window.history.replaceState({}, '', cleanUrl.toString());
  startOnlineGuestMode(joinRoomId);
}
```

**Step 8: Clean up online state in "Back" button handler**

Add to the `newBattleBtn` click handler:

```typescript
// Reset online state
onlineHost?.destroy();
onlineHost = null;
onlineGuest?.destroy();
onlineGuest = null;
onlineActive = false;
onlineRole = null;
onlineLobby.style.display = 'none';
```

**Step 9: Run existing tests**

Run: `npx vitest run`
Expected: All existing tests PASS

**Step 10: Commit**

```bash
git add src/main.ts
git commit -m "feat(online): wire up online PvP host and guest flows in main.ts"
```

---

### Task 9: Modify host GameEngine to skip local red planning

**Files:**
- Modify: `src/game.ts`

Add an `onlineHost` option that changes the planning flow: after blue-planning, transition to a "waiting for guest" state instead of cover/red-planning.

**Step 1: Add onlineHost option**

Add to constructor opts:

```typescript
onlineHost?: boolean;
```

Add field:

```typescript
private onlineHostMode = false;
// in constructor:
this.onlineHostMode = opts?.onlineHost ?? false;
```

**Step 2: Modify setPhase to handle online host mode**

In `setPhase`, when `phase === 'cover'` and `this.onlineHostMode`:

```typescript
} else if (phase === 'cover') {
  this.pathDrawer?.disable();
  if (this.onlineHostMode) {
    // In online host mode, go to red-planning but don't enable local path drawing
    // The host waits for guest to send paths via the network
    this.onEvent('phase-change', { phase, round: this.roundNumber });
    this.setPhase('red-planning');
    return;
  }
  if (this.aiMode) {
    // existing AI flow...
```

In the `red-planning` case, skip enabling PathDrawer when in online host mode:

```typescript
} else if (phase === 'red-planning') {
  if (!this.onlineHostMode) {
    this.pathDrawer?.clearPaths('red');
    this.pathDrawer?.enable('red', this.units, this.elevationZones);
  }
  // In online host mode, wait for external call to setRedPaths + confirmPlan
```

**Step 3: Run existing tests**

Run: `npx vitest run`
Expected: All existing tests PASS

**Step 4: Commit**

```bash
git add src/game.ts
git commit -m "feat(online): add onlineHost mode to skip local red planning in GameEngine"
```

---

### Task 10: Add Supabase configuration

**Files:**
- Modify: `src/online.ts`

**Step 1: Set up the Supabase project**

1. Go to https://supabase.com and create a free project
2. Note the project URL and anon key from Settings > API
3. Enable Realtime in the project settings

**Step 2: Update the config in online.ts**

Replace the placeholder values:

```typescript
const TRYSTERO_CONFIG = {
  appId: '7-seconds-pvp',
  supabaseUrl: 'https://YOUR_PROJECT.supabase.co',
  supabaseKey: 'YOUR_ANON_KEY',
};
```

Note: The anon key is safe to expose in client-side code — it's a public key with no elevated permissions.

**Step 3: Commit**

```bash
git add src/online.ts
git commit -m "chore(online): add Supabase project configuration"
```

---

### Task 11: Manual integration testing

**No files to modify — testing checklist.**

**Step 1: Start dev server**

Run: `npm run dev`

**Step 2: Test host flow**

1. Open browser at localhost
2. Click "Online PvP"
3. Verify lobby overlay appears with share URL
4. Verify "Copy Link" button works

**Step 3: Test guest flow**

1. Open a second browser tab
2. Paste the share URL
3. Verify guest connects and lobby disappears on both sides

**Step 4: Test gameplay**

1. Host (Blue) draws paths, clicks Done
2. Guest (Red) sees planning UI, draws paths, clicks Done
3. Both see the battle play out
4. Verify HUD counts update on both sides
5. Verify result screen shows on both sides

**Step 5: Test disconnection**

1. Close the guest tab
2. Verify host sees "Opponent disconnected"

**Step 6: Test mobile**

1. Open host on desktop, guest on phone (same network)
2. Verify touch path drawing works for guest

---

### Task 12: Handle host result emission

**Files:**
- Modify: `src/main.ts`

**Step 1: In the onGameEvent 'end' handler, send result to guest**

In the `if (event === 'end' && data && 'winner' in data)` block, add near the top:

```typescript
if (onlineActive && onlineRole === 'host' && onlineHost) {
  const result = data as BattleResult;
  onlineHost.sendResult({
    winner: result.winner,
    blueAlive: result.blueAlive,
    redAlive: result.redAlive,
    duration: result.duration,
    gameOver: true,
  });
}
```

**Step 2: Run existing tests**

Run: `npx vitest run`
Expected: All existing tests PASS

**Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat(online): emit round result to guest on game end"
```

---

### Task 13: Run full test suite and verify build

**Step 1: Run all tests**

Run: `npx vitest run`
Expected: All tests PASS

**Step 2: Verify production build**

Run: `npm run build`
Expected: Build succeeds with no TypeScript errors

**Step 3: Final commit if any fixes needed**

```bash
git add -A
git commit -m "fix(online): address build/test issues"
```
