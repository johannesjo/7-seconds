# Unified, reliable online play — seamless drop-in / drop-out

**Date:** 2026-06-16
**Status:** Plan / design of record
**Scope:** `src/online-async*`, `src/online*`, `supabase/`

## The ask

Three things, in priority order:

1. **Make async reliable.** Today it stalls: matches get stuck, players see
   "please retry", turns silently fail, and a dropped client can wedge a match
   forever.
2. **Unify async and WebRTC** into one experience instead of two parallel
   stacks the player chooses between up front.
3. **Let a player make their first move before the opponent arrives**, and
   allow either side to drop out and back in at any point without breaking the
   match.

This document explains why these are really *one* change, and lays out a
phased path to get there without a rewrite.

---

## Key insight: async is already the stronger foundation

Both modes already share the same engine contract:

- Deterministic lockstep: a round's outcome is fully reproducible from
  `OnlineGameState` (start of round) + each side's `OnlinePathData` (waypoints)
  + the per-round seed (`createRng(seed + roundNumber)` in `src/game.ts`). This
  is documented and verified in `docs/async-play.md`.
- The same `OnlineGameState` snapshot type (`src/online-types.ts`) and the same
  `PathList` move type (`src/online-async-core.ts`, `OnlinePathData` in
  `src/online-types.ts`).
- The same desync hash (`hashGameState`, `src/online-sync.ts`).

The **only** difference between the two stacks is *where the turn data lives*:

| | Source of truth | Transport | Resume after drop | First move before peer |
|---|---|---|---|---|
| **WebRTC** (`online-peer/relay/host/guest`) | ephemeral, in two peers' RAM | P2P data channel + Supabase relay fallback | no — peer drop ends the game | no — host waits for guest |
| **Async** (`online-async*`) | durable Postgres (`matches` + `turns`) | Supabase Realtime Postgres-changes | yes — reopen the link | almost (host waits on lobby today) |

The durable turn log is strictly more capable. So the unification thesis is:

> **Make the durable async turn log the single source of truth for *all*
> online play. Treat WebRTC/relay as an optional "live presence" accelerator
> that makes turn delivery instant when both players happen to be online — not
> as a separate game mode.**

A "live" game becomes "an async match where both clients are currently
subscribed and reacting within seconds." A player walking away becomes "an
async match where one client stopped reacting." There is no mode switch, no
state hand-off, no separate code path to keep in sync. This is exactly the
drop-in/drop-out behavior the request describes — it falls out of the model
rather than being bolted on.

This also resolves the "very difficult to unify" conclusion an earlier analysis
reached: that conclusion assumed we'd try to *bridge two live engines into the
async protocol mid-game*. We do the opposite — everything is async underneath,
and WebRTC is demoted to a delivery optimization.

---

## Part 1 — Reliability fixes (do this first, ships value immediately)

These harden the existing async stack and are valuable even before any
unification. Concrete defects found in the current code:

### 1.1 No retry on transient backend failures

`commitTurn`, `revealTurn`, `persistRoundResult` (`src/online-async.ts`) each
return `false` on any error and the controller surfaces "please retry" to the
user (`submitPlan`, `onRoundPlayed` in `src/online-async-game.ts`). A brief
network blip therefore wedges the match until the player manually re-submits.

**Fix:** wrap all Supabase writes in a small retry helper with exponential
backoff + jitter (e.g. 3 attempts: 300ms / 900ms / 2.7s). Distinguish
*transient* failures (network/5xx — retry) from *logical* ones (RLS denial,
unique-violation — don't retry, treat per 1.2/1.3). A single
`withRetry(fn, { isTransient })` used by every write keeps this in one place.

### 1.2 Commit is not idempotent

`commitTurn` does a bare `insert`; a retried/double-clicked commit hits the
`(match_id, round, team)` primary key and returns an error the caller reads as
failure. The player's commit actually landed, but they see "could not submit."

**Fix:** make commit idempotent. On unique-violation, re-read the existing row;
if its `commit_hash` equals ours, treat as success. Better: use
`upsert(..., { onConflict: 'match_id,round,team', ignoreDuplicates: true })`
and then verify the stored hash matches. (Reveal is already idempotent at the
query level, but should likewise be retried.)

### 1.3 Realtime subscription has no liveness guarantee or fallback

`subscribeMatch` (`src/online-async.ts`) logs the channel status but never acts
on `CHANNEL_ERROR` / `TIMED_OUT` / `CLOSED`. If the socket drops, the match
hangs silently with no recovery (the analysis confirmed there is no fallback
poll). The comment "fire within seconds when both players online" is an
assumption, not a guarantee.

**Fix:**
- On a non-`SUBSCRIBED` status, tear down and re-subscribe with backoff.
- Add a **safety-net poll**: a low-frequency `refresh()` (e.g. every 15–20s)
  while the match is open and the tab is visible, plus an immediate `refresh()`
  on `visibilitychange → visible` and on `online` (network regained). This is
  the single highest-leverage reliability fix — it makes the match
  self-healing regardless of Realtime delivery.

### 1.4 A dropped client can wedge the match forever

Three stuck states the analysis found, none of which recover today:

- Opponent commits, then never reveals/resolves → you wait indefinitely.
- A player resolves + advances; the other player's `persistRoundResult`
  fails the `expectedRound` guard and they see an error instead of just
  re-syncing to the new round.
- Both drop mid-resolve; on reopen both race to persist and one gets an error.

**Fixes:**
- **Treat the round-advance race as success, not error.** In `onRoundPlayed`,
  if `persist` fails the `expectedRound` guard because the round already
  advanced, that is the *expected* benign outcome — `refresh()` and continue
  silently. Only surface an error if the round did **not** advance.
- **Server-side resolution for the stuck-reveal case (see 1.5).** Once both
  sides have revealed, the round outcome is fully determined; it should not
  depend on a *specific* client staying alive to run `resolveRound`. Any
  participant (or the server) can resolve it.
- **Abandon/forfeit affordance + timeout.** Add an explicit "claim win /
  abandon" path: if it's been the opponent's turn for longer than a threshold
  (configurable, e.g. 7 days for friends; shorter for matchmade), either the
  present player may claim, or a scheduled job flips the match to `abandoned`.
  Surface this in the lobby ("Your friend hasn't moved in 3 days — [Nudge] /
  [Claim win]").

### 1.5 Resolution is client-trusted and client-bound

`resolveRound` runs on whichever client happens to be present
(`startAsyncRoundPlayback` in `main.ts`), and that client also *writes* the
authoritative `latest_state`. The DB comment in `0001_async_matches.sql` is
candid: "no server referee re-simulates the match." This is the root of both
the wedge cases and a cheating vector (a client can write any `latest_state`).

**Fix (incremental):**
- Short term: keep client resolution but make it *any-client* resolution —
  remove the `playingRound === this.playingRound` gating so a freshly reopened
  client will resolve a fully-revealed round it didn't personally play. Persist
  with the `expectedRound` guard so the first writer wins and the rest no-op.
- Medium term: add a **Supabase Edge Function `resolve-round`** that runs the
  same deterministic `resolveRound` server-side once both reveals exist
  (triggered by the reveal webhook, mirroring `notify-turn`). The server writes
  `latest_state` + advances the round. Clients then become pure *animators* of
  a result the server already computed — no client can wedge or forge it. The
  engine is already headless and deterministic, so this reuses `resolveRound`
  verbatim in a Deno function (the engine core must be import-clean of DOM —
  see Risks).

### 1.6 Lost local stash blocks reveal with no recovery

After commit, paths live only in `localStorage` (`localStoragePathStash`). If
that's cleared (or the player switches devices), reveal is impossible and they
see "your submitted plan was lost; please redraw it" — but the commit hash is
already on the server, so a redraw won't match and the round can't resolve.

**Fix:** make the stash recoverable. Options, in order of preference:
- Encrypt the paths client-side and store the ciphertext in the `turns` row at
  commit time (key derived from the match id + user); reveal just publishes the
  key/plaintext. This keeps blind-fairness (server can't read pre-reveal) while
  making reveal device-independent. Simpler interim: accept that on stash loss
  we can offer "redraw" only if the player hasn't committed elsewhere, and
  detect the hash-mismatch case explicitly with a clear message + a "forfeit
  round" escape hatch so the match isn't permanently wedged.

### 1.7 Notifications are best-effort and swallow failures

`notify-turn` (`supabase/functions/notify-turn`) catches push/email errors and
always returns 200; `registerTurnNotifications` (`src/online-push.ts`)
overwrites the player row on every call and ignores upsert failures.

**Fix:** make the function idempotent and observable (log delivery
success/failure to a table or at least structured logs); retry push once on
transient FCM/Resend failure; stop clobbering `email`/flags on re-register
(only write fields that changed). Lower priority than 1.1–1.5.

**Outcome of Part 1:** the *existing* async mode becomes reliable and
self-healing. Ship it. This de-risks everything after it.

---

## Part 2 — One lobby, drop-in / drop-out, first move before the opponent

This is the UX unification. It does **not** require WebRTC yet — it's built
entirely on the (now reliable) durable turn log.

### 2.1 Collapse the menu to one "Play online" flow

Today there are three buttons (`online-btn`, `online-random-btn`,
`online-async-btn`) and three code paths (`startOnlineHostGame`,
`startOnlineGuestMode`, `startAsyncGame`). Collapse to:

- **Play with a friend** → creates a durable match, shows the share link.
- **Play a stranger** → matchmaking (existing `online-matchmaking.ts`) that
  *creates / joins a durable match* instead of a bare WebRTC room.

Both land in the **same `AsyncGameController`-driven flow**. "Live" vs
"play-by-mail" is no longer a choice the player makes — it's just how fast the
other side happens to respond.

### 2.2 Let the host move first ("first move before opponent arrives")

Currently `onWaitingForGuest` (`online-async-game.ts` → `main.ts`) parks the
host on the share-link screen and *blocks planning* until a guest joins. The
request is to let them plan round 1 immediately.

**Change:** while `status === 'open'`, still show the share link, **but also
allow the host to plan and commit round 1.** The commit-reveal model already
supports this perfectly — the host commits a hash, it sits in `turns`, and the
moment a guest joins (`status → active`) and commits, the round resolves. This
is a small, contained change:

- In `step()`, for `action === 'commit'` while `status === 'open'`: show the
  share link **and** enable planning (instead of returning early at
  `online-async-game.ts:253`).
- Keep `onWaitingForGuest` for the post-commit state ("Move locked in — waiting
  for a friend to join and play").

This makes the host's first session productive instead of a dead wait, and it's
the single most visible "seamless" improvement.

### 2.3 Drop-in / drop-out is already the model — make the UI honest about it

Because state is durable, leaving and returning is just unsubscribe / reopen.
The work here is presentational, not architectural:

- A **"matches" list** screen (we already store match ids; list the player's
  active matches with whose-turn-it-is badges). Reopening any match calls
  `startAsyncGame(id)`. This turns drop-out from "lose the game" into "come back
  later," and gives notifications somewhere to deep-link.
- Clear, non-alarming presence/status copy driven by match state + (optionally)
  a lightweight presence channel (2.4): "Your turn," "Waiting for Alex,"
  "Alex is here now" (live), "Alex left — your move is saved."
- The existing deep-link (`?amatch=`) already resumes; ensure
  `notify-turn`/push payloads carry it (they do) and that the matches list is
  the default landing when several are active.

### 2.4 Optional presence (cheap, no WebRTC)

To make "the other player is here right now" feel live without P2P, add a
Supabase Realtime **presence** channel per match (separate from the
postgres-changes subscription). This drives "Alex is online" affordances and
lets us tighten the safety-net poll when both are present. Pure additive; no
effect on correctness.

**Outcome of Part 2:** one mode, first-move-before-opponent, real drop-in/out,
a matches list. Still 100% durable-log based — already "seamless and reliable"
for the turn-based cadence. **This may be enough**; Part 3 is the latency
optimization on top.

---

## Part 3 — WebRTC as a live accelerator (optimization, not a mode)

Now layer real-time speed onto the unified flow for the case where both players
are actively present and want the round to *animate live* rather than each
watching a resolved replay.

### 3.1 Reframe the transport layer

The WebRTC/relay stack already hides behind a clean transport seam:
`PeerHandle` + `PeerCallbacks` (`src/online-peer.ts`), the racing/failover proxy
in `connectTransport` (`src/online.ts`), and typed channels in
`createOnlineRoom`. Keep all of it — but change *what it carries*. Instead of
being the source of truth, the live channel becomes a **low-latency mirror of
the durable turn log**:

- When both peers are connected, a commit/reveal is sent over the data channel
  *and* written to Postgres. The data channel makes it feel instant; the DB
  write makes it durable and is the tie-breaker.
- The live simulation (host-authoritative lockstep, `guestTickCallback` in
  `main.ts`) runs exactly as today for the *animation*, but the **persisted
  result is always `resolveRound`'s deterministic output** (already true in the
  async path via `startAsyncRoundPlayback`). So a desync or a mid-round drop
  never corrupts the match — worst case both sides fall back to watching the
  resolved replay, which the durable log can always reproduce.

### 3.2 Drop-out during a live round degrades gracefully

If the WebRTC link dies mid-round (today: game over), the present player simply
finishes the round as a resolved/animated async round from the durable
reveals, and the match continues. The departing player picks it up later from
the durable log. The existing `connectTransport` failover (WebRTC → relay →
close) becomes "live → still-live-via-relay → fall back to turn-log," with the
last step being graceful instead of fatal.

### 3.3 Signaling reuses the match row

WebRTC signaling already uses a Supabase Realtime channel keyed by room id
(`rtc-${roomId}` in `online-peer.ts`). Key it by the durable match id so a live
session and its turn log are the same identity. When a player opens a match and
sees (via presence, 2.4) that the opponent is also present, the client opportun-
istically establishes the data channel; if it never connects, nothing breaks —
it's pure async underneath.

**Outcome of Part 3:** when both are present it feels like today's live game
(instant, animated, lockstep); when one leaves it silently becomes
play-by-mail; when they return it's live again. One match, one source of truth,
no mode switch.

---

## Suggested sequencing

| Phase | Deliverable | Depends on | Risk |
|---|---|---|---|
| **1** | Reliability hardening (retry, idempotent commit, self-healing subscription + safety-net poll, race-as-success, abandon timeout) | — | low, high value |
| **1b** | Server-side `resolve-round` Edge Function (anti-wedge, anti-cheat) | engine headless-clean | medium |
| **2** | One lobby; host-first-move; matches list; durable drop-in/out; presence | Phase 1 | low |
| **3** | WebRTC demoted to live-accelerator mirror of the turn log; graceful live→async degradation | Phases 1–2 | medium |

Phases 1 and 2 deliver the bulk of "seamless and reliable" on their own. Phase 3
is the latency cherry on top and is the only part touching the WebRTC code.

---

## Risks & open questions

- **Engine must be import-clean for server-side resolution (1b/3).** `resolveRound`
  is static and headless, but confirm the `game.ts` import graph pulls in no
  DOM/Pixi modules so it can run in a Deno Edge Function. If it does, extract the
  pure simulation core into a DOM-free module. (Worth doing regardless.)
- **Trust model.** Today's "friends don't cheat" stance (client writes
  `latest_state`) is fine for *play with a friend* but weak for *play a
  stranger*. Server-side resolution (1b) closes this; decide whether matchmade
  games require it before launch.
- **Cost.** Safety-net polling + presence raise Supabase Realtime/DB usage
  modestly. Bound poll frequency, only poll visible tabs, and stop when a match
  is terminal. Quantify against the free-tier limits noted in
  `docs/plans/2026-03-07-online-pvp-design.md`.
- **Migration.** In-flight async matches must keep working across the schema/flow
  changes; all Part 2/3 changes are additive to the existing tables (no
  destructive migration anticipated). New columns (e.g. encrypted stash, last-
  move timestamps for the timeout) are nullable additions.
- **Notification timing for "your turn"** already exists (`notify-turn` +
  `online-push.ts`); make sure the unified flow fires it on every transition to
  the opponent's-action state, including the new host-first-move case.

---

## What I'd build first

If we want one concrete, shippable starting point: **Phase 1's self-healing
subscription + safety-net poll (1.3) and race-as-success (1.4)**, because
together they eliminate the great majority of "it just got stuck" reports with
a small, well-contained change to `online-async.ts` and `online-async-game.ts`
— no schema change, no new infrastructure. Host-first-move (2.2) is the next
smallest change with the biggest visible "seamless" payoff.
