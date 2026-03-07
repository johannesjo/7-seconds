# Online PvP Design - Remote Multiplayer via Share Link

**Date:** 2026-03-07
**Status:** Draft

## Goal

Allow two players to play PvP remotely by sharing a link. No accounts, no servers to maintain, no cost.

## Architecture

```
Player A (Host)                    Player B (Guest)
+---------------+                  +---------------+
| Runs engine   |<--- WebRTC ----->| Renders only  |
| Draws paths   |   (P2P, E2E)    | Draws paths   |
| Sends frames  |                  | Sends paths   |
+---------------+                  +---------------+
        |                                  |
        +-- Supabase Realtime (signaling) -+
            (~5 messages, then P2P only)
```

- **Trystero** (`trystero/supabase`) handles WebRTC connection setup
- **Supabase free tier** provides signaling (SDP offers, ICE candidates)
- After connection: all data flows P2P, E2E encrypted, no server involved

## Technology Choice

**Trystero** over PeerJS because:
- Built-in room concept (`joinRoom()`) maps directly to share links
- `makeAction()` API provides typed message channels with auto-serialization
- Swappable signaling backends (Supabase, Nostr, MQTT, BitTorrent) — one-line import change
- Smaller bundle (~10-15 KB vs ~80 KB)
- E2E encryption by default

**Supabase strategy** over Nostr/BitTorrent because:
- Faster connection (~1-3s vs ~3-8s)
- More reliable (managed infrastructure vs community relays)
- Free tier is generous (500 concurrent Realtime connections)
- Same Supabase project can later support matchmaking, leaderboards, accounts

## Game Flow

### 1. Lobby

1. Host clicks "Online PvP" in menu
2. Host creates a room via `joinRoom({ appId: '7-seconds' }, roomId)`
3. UI shows a share link: `https://domain.com/?join=<roomId>`
4. Host shares link with friend
5. Guest opens link, joins same room
6. Both see "Connected" — game starts

### 2. Planning Phase

1. **Blue planning (Host):** Host draws paths for Blue units locally
2. Host sends `phase:red-planning` to Guest
3. **Red planning (Guest):** Guest draws paths for Red units
4. Guest sends `paths` message to Host (array of unit waypoints)
5. Host receives paths, assigns them to Red units

### 3. Battle Phase

1. Host sends `phase:playing` to Guest
2. Host runs the game engine simulation
3. Each tick, Host sends a `frame` message to Guest containing:
   - Unit positions and states
   - Active projectiles
   - Combat events (fire, hit, kill)
4. Guest renders received frames (like replay playback)
5. Both players watch the same battle

### 4. Round End

1. Host detects win/loss/draw
2. Host sends `result` message with outcome
3. Both see results screen
4. Next round begins (back to step 2)

## Message Protocol

All messages are JS objects, auto-serialized by Trystero.

### Actions (Trystero makeAction channels)

```typescript
// Host -> Guest
const [sendState, _]    = room.makeAction<GameState>('state')    // initial game setup
const [sendPhase, _]    = room.makeAction<Phase>('phase')        // phase transitions
const [sendFrame, _]    = room.makeAction<FrameData>('frame')    // simulation frames
const [sendResult, _]   = room.makeAction<RoundResult>('result') // round outcome

// Guest -> Host
const [sendPaths, _]    = room.makeAction<PathData>('paths')     // red unit waypoints
```

### Message Types

```typescript
interface GameState {
  units: SerializedUnit[]
  obstacles: Obstacle[]
  elevationZones: ElevationZone[]
  mapWidth: number
  mapHeight: number
}

type Phase = 'blue-planning' | 'red-planning' | 'playing' | 'ended'

interface FrameData {
  units: { id: string; x: number; y: number; hp: number; alive: boolean }[]
  projectiles: { x: number; y: number; dx: number; dy: number }[]
  events: ReplayEvent[]
}

interface PathData {
  paths: { unitId: string; waypoints: { x: number; y: number }[] }[]
}

interface RoundResult {
  winner: 'blue' | 'red' | 'draw'
  blueAlive: number
  redAlive: number
}
```

## Host-Client Model

**Host is authoritative:**
- Host generates the map (obstacles, elevation, unit placement)
- Host runs the full game engine simulation
- Host determines all combat outcomes
- Guest cannot cheat — they only send path input

**Guest is a "live replay viewer":**
- Guest receives initial game state and renders it
- Guest draws paths and sends them to Host
- Guest receives frame data and renders it (reusing replay rendering logic)
- Guest does NOT run the game engine

## New Files

| File | Purpose |
|------|---------|
| `src/online.ts` | Shared types, Trystero room setup, connection lifecycle |
| `src/online-host.ts` | Host logic: create room, send frames, receive paths |
| `src/online-guest.ts` | Guest logic: join room, receive frames, send paths |

## Modified Files

| File | Changes |
|------|---------|
| `src/main.ts` | "Online PvP" button, URL param detection (`?join=`), online mode flow |
| `src/game.ts` | Hook to emit frame data each tick when in online host mode |
| `src/renderer.ts` | Guest mode: render from received frames instead of local engine |

## Dependencies

- `trystero` (~10-15 KB gzipped, tree-shakeable)
- Supabase project (free tier, no credit card)

## Connection Handling

### Happy Path
1. Host creates room, waits for peer
2. Guest joins, `room.onPeerJoin()` fires on both sides
3. Game proceeds

### Disconnection
- Implement heartbeat ping every 2 seconds via `room.ping()`
- If no response for 5 seconds, show "Connection lost" overlay
- No auto-reconnect in v1 — show "Return to menu" button
- Room is destroyed on disconnect

### Error States
- Guest opens link but Host has left -> "Game not found" message
- Connection fails (NAT issues) -> "Could not connect" with retry option

## Known Limitations (v1)

- **No reconnection** — if connection drops, game is lost
- **No spectators** — 1v1 only
- **No matchmaking** — share link only
- **Standard PvP only** — no online CTF or Horde
- **IP exposure** — WebRTC reveals player IPs to each other (inherent to P2P)
- **iOS Safari** — reconnection is broken in Trystero; acceptable since v1 targets web + Android
- **NAT traversal** — ~10-15% of connections behind strict NATs may fail without a TURN server. Using free STUN servers only in v1.

## Future Extensions

These build on the same Supabase project + Trystero foundation:

1. **Matchmaking** — Supabase database for lobby/queue
2. **Leaderboards** — Supabase database for rankings
3. **Accounts** — Supabase Auth (email, Google, anonymous)
4. **Online CTF** — same P2P protocol, different game mode
5. **Reconnection** — rejoin room on disconnect
6. **TURN relay** — for NAT-hostile networks (Metered.ca free tier or Cloudflare Calls)
7. **Async play** — submit paths to Supabase, opponent plays later
