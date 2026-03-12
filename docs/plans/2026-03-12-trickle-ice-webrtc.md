# Trickle ICE WebRTC Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace trystero with a custom WebRTC implementation using trickle ICE to fix mobile network connectivity failures.

**Architecture:** Direct `RTCPeerConnection` with trickle ICE, signaled via Supabase Realtime broadcast. Single `RTCDataChannel` with JSON message multiplexing replaces trystero's 6 `makeAction` channels. STUN-only (no TURN) — mobile STUN works fine, mobile TURN was the problem.

**Tech Stack:** `RTCPeerConnection` (browser API), `@supabase/supabase-js` (already installed), Supabase Realtime broadcast for signaling.

---

### Task 1: Remove trystero and patch-package

**Files:**
- Delete: `patches/trystero+0.22.0.patch`
- Modify: `package.json`

**Step 1: Remove trystero dependency**

```bash
npm uninstall trystero
```

**Step 2: Remove patch-package dev dependency and postinstall script**

```bash
npm uninstall patch-package
```

Remove the `"postinstall": "patch-package"` line from `package.json` scripts.

**Step 3: Delete the patch file**

```bash
rm patches/trystero+0.22.0.patch
rmdir patches 2>/dev/null || true
```

**Step 4: Verify clean install**

```bash
npm install
```

Expected: Installs without errors. No postinstall patch-package step.

**Step 5: Commit**

```bash
git add package.json package-lock.json patches/
git commit -m "chore: remove trystero and patch-package dependencies"
```

---

### Task 2: Write the WebRTC peer connection module

This is the core replacement for trystero. It creates an `RTCPeerConnection`, handles trickle ICE, manages a single `RTCDataChannel`, and multiplexes typed messages.

**Files:**
- Create: `src/online-peer.ts`

**Step 1: Write the signaling types and ICE config**

The signaling types define the messages exchanged via Supabase Realtime. The ICE config uses only STUN servers (Google + Cloudflare).

```typescript
// src/online-peer.ts
import { createClient, type RealtimeChannel } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY } from './online';
import { dlog } from './online-debug';

/** Messages sent over Supabase Realtime for WebRTC signaling. */
type SignalMessage =
  | { type: 'offer'; sdp: string; peerId: string }
  | { type: 'answer'; sdp: string; peerId: string }
  | { type: 'candidate'; candidate: RTCIceCandidateInit; peerId: string }
  | { type: 'bye'; peerId: string };

const ICE_SERVERS: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun1.l.google.com:19302' },
  { urls: 'stun:stun2.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
```

**Step 2: Write the `createPeerConnection` function**

This function:
1. Joins a Supabase broadcast channel for signaling
2. Creates an `RTCPeerConnection`
3. If host: creates a `RTCDataChannel`, creates an offer, sends it
4. If guest: waits for offer, creates answer, sends it
5. Both sides: trickle ICE candidates as they arrive
6. Fires `onOpen(peerId)` when the data channel opens
7. Fires `onClose(peerId)` when the connection drops
8. Fires `onMessage(type, data, peerId)` for each received message
9. Returns `{ send, leave, getPeers }`

```typescript
export interface PeerCallbacks {
  onOpen: (peerId: string) => void;
  onClose: (peerId: string) => void;
  onMessage: (type: string, data: unknown, peerId: string) => void;
}

interface PeerState {
  pc: RTCPeerConnection;
  dc: RTCDataChannel | null;
  peerId: string;
}

export interface PeerHandle {
  send: (type: string, data: unknown) => void;
  leave: () => void;
  getPeers: () => Record<string, RTCPeerConnection>;
}

/** Unique ID for this browser tab — used for signaling identity. */
const localPeerId = crypto.randomUUID();

export async function createPeerConnection(
  roomId: string,
  role: 'host' | 'guest',
  callbacks: PeerCallbacks,
): Promise<PeerHandle> {
  const client = createClient(SUPABASE_URL, SUPABASE_KEY);
  const channelName = `rtc-${roomId}`;
  const channel = client.channel(channelName, {
    config: { broadcast: { self: false } },
  });

  let peer: PeerState | null = null;
  let destroyed = false;

  const signal = (msg: SignalMessage) => {
    channel.send({ type: 'broadcast', event: 'signal', payload: msg });
  };

  const setupDataChannel = (dc: RTCDataChannel, peerId: string) => {
    dc.binaryType = 'arraybuffer';
    dc.onopen = () => {
      dlog(`dc open with ${peerId.slice(0, 8)}`);
      if (!destroyed) callbacks.onOpen(peerId);
    };
    dc.onclose = () => {
      dlog(`dc close with ${peerId.slice(0, 8)}`);
      if (!destroyed) callbacks.onClose(peerId);
    };
    dc.onmessage = (e) => {
      try {
        const { t, d } = JSON.parse(e.data as string);
        callbacks.onMessage(t, d, peerId);
      } catch {
        dlog(`dc parse error: ${e.data}`);
      }
    };
  };

  const createPC = (remotePeerId: string): PeerState => {
    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    pc.onicecandidate = (e) => {
      if (e.candidate) {
        dlog(`ice candidate: ${e.candidate.type ?? 'null'} ${e.candidate.protocol ?? ''}`);
        signal({ type: 'candidate', candidate: e.candidate.toJSON(), peerId: localPeerId });
      }
    };

    pc.onconnectionstatechange = () => {
      dlog(`connState: ${pc.connectionState}`);
      if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
        if (!destroyed) callbacks.onClose(remotePeerId);
      }
    };

    pc.oniceconnectionstatechange = () => {
      dlog(`iceState: ${pc.iceConnectionState}`);
    };

    let dc: RTCDataChannel | null = null;

    if (role === 'host') {
      dc = pc.createDataChannel('data');
      setupDataChannel(dc, remotePeerId);
    } else {
      pc.ondatachannel = (e) => {
        dc = e.channel;
        if (peer) peer.dc = dc;
        setupDataChannel(dc, remotePeerId);
      };
    }

    return { pc, dc, peerId: remotePeerId };
  };

  const handleSignal = async (msg: SignalMessage) => {
    if (destroyed) return;
    if (msg.peerId === localPeerId) return;

    if (msg.type === 'offer' && role === 'guest') {
      peer = createPC(msg.peerId);
      await peer.pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
      const answer = await peer.pc.createAnswer();
      await peer.pc.setLocalDescription(answer);
      dlog(`sending answer to ${msg.peerId.slice(0, 8)}`);
      signal({ type: 'answer', sdp: answer.sdp!, peerId: localPeerId });

    } else if (msg.type === 'answer' && role === 'host' && peer) {
      await peer.pc.setRemoteDescription({ type: 'answer', sdp: msg.sdp });
      dlog(`got answer from ${msg.peerId.slice(0, 8)}`);

    } else if (msg.type === 'candidate' && peer) {
      try {
        await peer.pc.addIceCandidate(msg.candidate);
      } catch (e) {
        dlog(`addIceCandidate error: ${e}`);
      }

    } else if (msg.type === 'bye') {
      if (!destroyed) callbacks.onClose(msg.peerId);
    }
  };

  // Subscribe to signaling channel
  await new Promise<void>((resolve, reject) => {
    channel.on('broadcast', { event: 'signal' }, ({ payload }) => {
      handleSignal(payload as SignalMessage);
    });

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        dlog(`signaling channel subscribed (${role})`);
        resolve();
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        reject(new Error(`Signaling channel failed: ${status}`));
      }
    });
  });

  // Host: create offer and start signaling
  if (role === 'host') {
    // We don't know the guest's peerId yet. Create a placeholder and
    // update it when the guest answers.
    peer = createPC('pending');
    const offer = await peer.pc.createOffer();
    await peer.pc.setLocalDescription(offer);
    dlog('sending offer');
    signal({ type: 'offer', sdp: offer.sdp!, peerId: localPeerId });

    // Re-announce offer periodically in case guest joins late
    const announceInterval = setInterval(() => {
      if (destroyed || !peer || peer.dc?.readyState === 'open') {
        clearInterval(announceInterval);
        return;
      }
      dlog('re-announcing offer');
      signal({ type: 'offer', sdp: offer.sdp!, peerId: localPeerId });
    }, 10_000);
  }

  const send = (type: string, data: unknown) => {
    if (peer?.dc?.readyState === 'open') {
      peer.dc.send(JSON.stringify({ t: type, d: data }));
    }
  };

  const leave = () => {
    destroyed = true;
    signal({ type: 'bye', peerId: localPeerId });
    peer?.dc?.close();
    peer?.pc.close();
    peer = null;
    client.removeAllChannels();
  };

  const getPeers = (): Record<string, RTCPeerConnection> => {
    if (peer && peer.peerId !== 'pending') {
      return { [peer.peerId]: peer.pc };
    }
    return {};
  };

  return { send, leave, getPeers };
}
```

**Step 3: Handle the host learning the guest's real peerId**

The host creates the PC before knowing the guest's ID. When the answer arrives, update `peer.peerId` so `getPeers()` and `onOpen/onClose` report the correct ID. This is already handled in `handleSignal` — when `msg.type === 'answer'`, `msg.peerId` is the guest's ID. Add this update:

In the `answer` handler, before `setRemoteDescription`:
```typescript
peer.peerId = msg.peerId;
```

**Step 4: Commit**

```bash
git add src/online-peer.ts
git commit -m "feat(online): add custom WebRTC peer connection with trickle ICE"
```

---

### Task 3: Rewrite `createOnlineRoom` in `online.ts`

Replace the trystero-based implementation with one that uses `createPeerConnection` from Task 2, preserving the existing `OnlineConnection` interface exactly.

**Files:**
- Modify: `src/online.ts` (lines 1-56 imports/TURN code, lines 109-160 createOnlineRoom)

**Step 1: Replace imports and remove TURN code**

Remove:
- `import { joinRoom } from 'trystero/supabase'` (line 1)
- `METERED_API_KEY` (line 5)
- `SUPABASE_CONFIG` (lines 12-15)
- `TURN_CACHE_TTL_MS`, `cachedIceServers`, `cachedAt` (lines 22-24)
- `fetchIceServers()` (lines 26-51)
- `prefetchIceServers()` (lines 53-56)

Add:
- `import { createPeerConnection } from './online-peer'`

**Step 2: Rewrite `createOnlineRoom`**

The function must still return `OnlineConnection` with the same `ActionPair<T>` channels. Instead of trystero's `makeAction`, we build action pairs from the multiplexed data channel.

```typescript
export async function createOnlineRoom(
  roomId: string,
  role: 'host' | 'guest',
  onPeerJoin: (peerId: string) => void,
  onPeerLeave: (peerId: string) => void,
): Promise<OnlineConnection> {
  dlog(`createRoom role=${role} room=${roomId}`);

  // Per-channel receive callbacks, keyed by action type name
  const receivers = new Map<string, (data: unknown, peerId: string) => void>();

  const handle = await createPeerConnection(roomId, role, {
    onOpen: onPeerJoin,
    onClose: onPeerLeave,
    onMessage: (type, data, peerId) => {
      receivers.get(type)?.(data, peerId);
    },
  });

  function makeAction<T>(type: string): ActionPair<T> {
    const send = (data: T) => handle.send(type, data);
    const receive = (cb: (data: T, peerId: string) => void) => {
      receivers.set(type, cb as (data: unknown, peerId: string) => void);
    };
    return [send, receive];
  }

  return {
    state: makeAction<OnlineGameState>('state'),
    phase: makeAction<OnlinePhase>('phase'),
    paths: makeAction<OnlinePathData>('paths'),
    frame: makeAction<OnlineFrameData>('frame'),
    result: makeAction<OnlineRoundResult>('result'),
    signal: makeAction<OnlineSignal>('signal'),
    getPeers: () => handle.getPeers(),
    leave: () => handle.leave(),
  };
}
```

**Step 3: Remove `prefetchIceServers` export**

The function no longer exists. Also remove it from the exports so `main.ts` will show a compile error (fixed in Task 4).

**Step 4: Verify the file compiles (expect error in main.ts)**

```bash
npx tsc --noEmit 2>&1 | head -20
```

Expected: Error about `prefetchIceServers` not found in `main.ts`. No errors in `online.ts` itself.

**Step 5: Commit**

```bash
git add src/online.ts
git commit -m "feat(online): replace trystero with custom trickle ICE WebRTC"
```

---

### Task 4: Remove `prefetchIceServers` call from `main.ts`

**Files:**
- Modify: `src/main.ts` (lines 12, 1209-1210)

**Step 1: Remove the import**

Change line 12 from:
```typescript
import { getJoinRoomId, getLocalPlayerId, prefetchIceServers } from './online';
```
to:
```typescript
import { getJoinRoomId, getLocalPlayerId } from './online';
```

**Step 2: Remove the call**

Delete lines 1209-1210:
```typescript
// Pre-fetch TURN credentials so they're ready when creating/joining rooms
prefetchIceServers();
```

**Step 3: Verify full project compiles**

```bash
npx tsc --noEmit
```

Expected: No errors.

**Step 4: Verify dev server builds**

```bash
npx vite build 2>&1 | tail -5
```

Expected: Build succeeds.

**Step 5: Commit**

```bash
git add src/main.ts
git commit -m "chore: remove prefetchIceServers call (TURN no longer used)"
```

---

### Task 5: Manual testing on desktop

**Step 1: Start dev server**

```bash
npm run dev
```

**Step 2: Test private room (two browser tabs)**

1. Open tab 1, click "vs friend" → creates room with code
2. Open tab 2, enter room code → joins room
3. Verify: both tabs show "connected", game starts
4. Play through a round — verify frames, paths, results all work
5. Test rematch flow

**Step 3: Test "vs random" matchmaking**

1. Open two tabs, both click "vs random"
2. Verify: matchmaking pairs them, game starts
3. Play through a round

**Step 4: Check debug overlay**

Add `?debug=1` to URL and verify:
- ICE candidates logged (should see `srflx` type)
- `connState: connected`
- `dc open` message
- No TURN-related logs

---

### Task 6: Test on mobile network

**Step 1: Deploy to staging or use vite preview**

Either push to a branch with preview deployment, or use `npx vite preview --host` with phone on same network for initial test, then deploy for real mobile carrier test.

**Step 2: Test from mobile with debug overlay**

1. Open game on phone browser with `?debug=1`
2. Open game on desktop browser with `?debug=1`
3. Join same room
4. Verify: connection succeeds with trickle ICE
5. Check that ICE candidates include `srflx` (STUN reflexive)
6. Play through a game

**Step 3: If connection fails, check debug overlay for**

- Are ICE candidates being sent? (should see `ice candidate: srflx`)
- Is the offer/answer exchange completing? (should see `sending answer`, `got answer`)
- What is `connState`? If stuck at `connecting`, ICE candidates may not be reaching the other side

---

### Task 7: Final cleanup

**Files:**
- Verify: `patches/` directory is deleted
- Verify: `package.json` has no trystero or patch-package references
- Verify: no remaining imports of trystero anywhere

**Step 1: Grep for leftover trystero references**

```bash
grep -r "trystero" src/ --include="*.ts"
grep -r "trystero" package.json
```

Expected: No matches (comments about "trystero" in host/guest timeout comments are OK to update).

**Step 2: Update timeout comments in host/guest**

In `online-host.ts` line 33-34 and `online-guest.ts` line 33-34, update the comments that reference trystero:

```typescript
// Single long timeout for peer discovery via Supabase signaling.
```

**Step 3: Commit**

```bash
git add -A
git commit -m "chore: clean up trystero references"
```
