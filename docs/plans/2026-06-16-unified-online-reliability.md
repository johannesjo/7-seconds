# Unified, reliable online play — seamless drop-in / drop-out

**Date:** 2026-06-16
**Status:** Plan / design of record (revised after multi-lens review)
**Scope:** `src/online-async*`, `src/online*`, `src/game.ts`, `supabase/`

> **Revision note.** This version incorporates four review passes — distributed
> correctness, architecture, implementation feasibility (verified against the
> code), and product/UX. The biggest change from the first draft: the live and
> async paths use **two different seed models**, so "a live game silently
> becomes play-by-mail mid-round" is *not* free. The plan now unifies the
> protocol up front (Part 2) and constrains live↔async handoff to **round
> boundaries**, which makes the rest tractable.

## Implementation status (2026-06-16)

Landed and unit-tested (330 tests green, production build clean):

- **1.1 Retry transient writes** — `src/online-retry.ts` (`withRetry`, tested),
  wired into commit/reveal/persist.
- **1.2 Idempotent commit** — upsert + read-back verify in `commitTurn`.
- **1.3 Self-healing subscription + safety-net poll** — `subscribeMatch`
  re-subscribes on channel error; `AsyncGameController` polls (browser-gated,
  injectable `PollEnv`, tested).
- **1.4 Race-as-success + stale-seed guard** — `persistRoundResult` reports
  rows-affected; `onRoundPlayed` reloads before re-deriving a seed.
- **1.6 Forfeit / lost-stash escape hatch** — `finishMatch` + `forfeit()`,
  honest lost-plan messaging, Forfeit button.
- **1.7** — already satisfied: `notify-turn` no-ops when there's no opponent.
- **1b Headless engine** — `game.ts` is now pixi-free at runtime (type-only
  Renderer/PathDrawer + `Renderer.createPathDrawer`), unblocking server-side use.
- **2.2 Host-first-move** — host plans/commits round 1 before a guest joins;
  `awaitingGuest` flag + "Plan your first move" lobby button.
- **1a Abandon timeout** — `supabase/migrations/0003_reliability.sql`
  (`last_move_at`, `abandon_after`, `expire_abandoned_matches()` + pg_cron).
  Pure SQL; **needs applying in the Supabase dashboard** (no client deploy here).

Not yet implemented (scoped below; larger and/or needs infra I can't verify
from this environment):

- **1.5 server-side `resolve-round` Edge Function** — engine is now headless so
  this is unblocked, but it needs a Deno deploy + reveal webhook wiring.
- **2.0 uniform commit-reveal seed for live**, **2.1 matchmaking→durable
  match**, **2.3 matches list**, **Part 3 WebRTC accelerator** — these are the
  1–2 week items; they rewrite the working live path and/or need browser
  verification, so they are deliberately left for a follow-up rather than
  shipped blind.

## The ask

1. **Make async reliable.** Today it stalls: matches wedge, players see
   "please retry," turns silently fail, and a dropped client can hang a match
   forever.
2. **Unify async and WebRTC** into one experience instead of two stacks the
   player picks up front.
3. **Let a player make their first move before the opponent arrives**, and let
   either side drop out and back in without breaking the match.

---

## Key insight: async is the stronger foundation — but the two stacks disagree on the seed

Both modes share the deterministic-lockstep engine: a round's outcome is
reproducible from `OnlineGameState` (round start) + each side's `PathList`
waypoints + a per-round seed (`createRng(seed + roundNumber)`, `src/game.ts`).
They share `OnlineGameState` (`src/online-types.ts`), the `PathList` move type,
and the desync hash (`src/online-sync.ts`).

The durable async turn log (`matches` + `turns` in Postgres) is strictly more
capable than the ephemeral WebRTC channel: it survives drops and is resumable.
So the thesis stands:

> **Make the durable turn log the single source of truth for all online play.
> Treat WebRTC/relay as an optional low-latency accelerator, not a separate
> mode.**

**But there is a real impedance mismatch the first draft hand-waved.** The two
stacks derive the per-round seed *differently*:

- **Live** (`main.ts` `sendWaypoints` → `engine.getRoundSeed()`): the **host
  authors** the seed (`seed + roundNumber`) and streams it to the guest. There
  is no blind commit — the host already sees everything, so it just sends state
  outright (`sendGameState`).
- **Async** (`online-async-game.ts:298`, `deriveMatchSeed`): the round-1 seed is
  **derived from both players' blind commit hashes** (anti-grind fairness); no
  single player authors it.

Consequence: a round that is played live was **never written to `turns`** (no
commit, no reveal, no hashes). If the WebRTC link dies mid-round, the async
path at `online-async-game.ts:298` has nothing to resolve from —
`hashPaths(blue.paths)` doesn't exist — and the match wedges. The earlier
conclusion that this was "graceful" was wrong.

**The fix that unblocks everything: one protocol.** Make *all* online play —
live or not — go through commit→reveal with the seed derived from both commits.
Live play then just means "both commits/reveals are landing within seconds, so
we also animate them in real time." The seed is uniform, the turn log is always
populated, and live↔async transitions become safe. This is the load-bearing
decision; it moves into Part 2 rather than being deferred to Part 3.

---

## Decisions this plan makes (the hard choices, surfaced)

1. **Uniform commit-reveal seed for every online round** (live included). The
   host no longer authors the seed. This costs live play one extra round-trip
   (commit hashes before the animation can start) but removes the mismatch and
   closes a cheat vector. *(Part 2.0)*
2. **Live↔async handoff happens only at round boundaries, never mid-round.**
   There is no engine "checkpoint/resume": the incremental live ticker
   (`guestTickCallback`) and the atomic `resolveRound()` are different machines.
   If a peer drops mid-round, the present player finishes the round
   *deterministically from the already-committed reveals* (same inputs the live
   sim used), then the next round is async. No rewind, no mid-round adoption.
   *(Part 3.2)*
3. **Strangers are not play-by-mail.** Matchmade games assume a single session;
   they get a short inactivity timeout and a "one-off" framing. Only friend
   matches get the multi-day cadence. *(Part 2 + UX)*
4. **Phase 3 (WebRTC accelerator) is gated, not assumed.** Parts 1+2 deliver the
   entire stated ask on the durable log alone. Build Phase 3 only if measured
   turn-resolution latency is a real complaint. *(Sequencing)*

---

## Part 1 — Reliability hardening (do first; ships value with no schema change)

Concrete defects, with the corrected fixes from the correctness review.

### 1.1 Retry transient backend failures
`commitTurn` / `revealTurn` / `persistRoundResult` (`src/online-async.ts`)
return `false` on any error; the controller surfaces "please retry"
(`submitPlan`, `onRoundPlayed`). A blip wedges the match.

**Fix:** one `withRetry(fn, { isTransient })` wrapping every write — 3 attempts,
exponential backoff + jitter (~300ms/900ms/2.7s). Retry only *transient*
failures (network/5xx); never retry *logical* ones (RLS denial,
unique-violation — those route to 1.2/1.4). The injectable `AsyncIO` seam
(`online-async-game.ts:60`) and the `FakeBackend` test harness make this
unit-testable by mocking failures.

### 1.2 Idempotent commit — but do not clobber a reveal
`commitTurn` does a bare `insert`; a retried/double-clicked commit hits the
`(match_id, round, team)` PK and reads as failure even though the commit landed.

**Fix:** `upsert(..., { onConflict: 'match_id,round,team', ignoreDuplicates: true })`,
then **read the row back and verify `commit_hash` equals ours**. Three outcomes:
hash matches → success; row already has non-null `paths` (already revealed) →
success, do nothing; hash differs → protocol violation (different paths under
same slot), surface an unrecoverable error. `ignoreDuplicates` guarantees we
never overwrite a revealed `paths` column. (Reveal is already idempotent at the
query level but must also be retried per 1.1.)

### 1.3 Self-healing subscription + safety-net poll (highest leverage)
`subscribeMatch` (`src/online-async.ts:264`) logs channel status but never acts
on `CHANNEL_ERROR`/`TIMED_OUT`/`CLOSED`, and there is no fallback. A dropped
socket hangs the match silently.

**Fix:**
- On non-`SUBSCRIBED` status, tear down and re-subscribe with **bounded**
  backoff (max ~5 attempts, 1/2/4/8/16s). After exhausting, surface a single
  non-alarming notice and rely on the poll.
- Add a **safety-net poll**: low-frequency `refresh()` (~15–20s) only while the
  match is non-terminal **and the tab is visible**; plus an immediate
  `refresh()` on `visibilitychange→visible` and on `online`. Pause the poll and
  unsubscribe on `visibilitychange→hidden`.
- **Correctness guard (already true in code — keep it):** when `fetchTurns`
  returns `null` (transient), the poll must **no-op**, never act on a phantom
  empty list. `step()` at `online-async-game.ts:243` already does this; the poll
  must route through the same path and not bypass it. A poll must never
  re-prompt a redraw.

### 1.4 Stop dropped clients wedging the match
Three stuck states, none of which recover today:

- **Round-advance race.** Two clients resolve the same round; the first
  `persistRoundResult` wins the `expectedRound` guard, the second fails.
  **Fix (corrected):** treat the guard-failure-because-already-advanced case as
  **benign success** — but do **not** clear the stash and continue blindly.
  `onRoundPlayed` (`online-async-game.ts:191-199`) currently ignores `persist`'s
  return value and clears the stash unconditionally. Change it to: check the
  return; on guard-failure, **`refresh()` to pick up the advanced round
  (including the now-set `seed`) before doing anything else, and only clear the
  stash for a round once that round is confirmed advanced**. Surface an error
  *only* if the round did not advance.
- **Stale-seed re-derivation (new, from review).** After a lost round-1 advance
  race, a client still holding `match.seed == null` in memory must **reload the
  match before resolving round 2** — otherwise `match.seed ?? deriveMatchSeed(...)`
  at `online-async-game.ts:298` re-derives a seed from round-2 hashes and
  diverges. The `refresh()` in the fix above must complete before the next
  `resolve()`.
- **Stuck-reveal (opponent revealed, you never resolved).** Resolution must not
  depend on one specific client staying alive — see 1.5.
- **Indefinite wait.** Add an inactivity timeout (1.4b).

### 1.4b Abandon / forfeit / timeout (needs new infrastructure)
**Verified:** there is **no scheduled-job infra** today (no `pg_cron`, no
`Deno.cron`, only the webhook-triggered `notify-turn`). So this is real work:
- Add nullable `last_move_at` (and `abandon_after`) columns to `matches`
  (backward-compatible; backfill from `updated_at` on first access).
- Add a scheduled Edge Function (`Deno.cron` or `pg_cron`) that flips a match to
  `abandoned` past its threshold. **Friend matches: long (e.g. 7d). Matchmade:
  short (e.g. 12–24h).**
- Player-facing: a **Forfeit** button (self-initiated loss, any time), a
  once-per-day **Nudge** (re-notify the opponent, or copyable message if push is
  denied), and a **Claim-win** that only appears past threshold, with a short
  grace/confirm window so a returning opponent isn't robbed. Mutual inactivity →
  draw. Estimate: ~2–3 days incl. the cron function.

### 1.5 Make resolution any-client (then server-side)
`resolveRound` runs on whichever client is present and *that* client writes the
authoritative `latest_state` (`startAsyncRoundPlayback` in `main.ts`); the DB
comment in `0001_async_matches.sql` admits "no server referee."

- **Short term:** allow *any* present client to resolve a fully-revealed round
  it didn't personally play (relax the `playingRound` gate in `resolve()`),
  persisting under the `expectedRound` guard so the first writer wins and the
  rest no-op via 1.4.
- **Medium term:** a Supabase Edge Function `resolve-round`, triggered by the
  reveal webhook (mirroring `notify-turn`), runs the same deterministic
  `resolveRound` server-side and writes `latest_state` + advances the round.
  **Idempotency (new, from review):** the webhook can fire more than once and
  both reveals may arrive near-simultaneously, so the function must (a) verify
  both reveals are durably present, (b) check `current_round` still equals the
  round being resolved and **no-op if it already advanced**, (c) persist under
  the same `expectedRound` guard. This makes the match un-wedgeable and removes
  the client-trust hole.
- **Blocker (verified):** `src/game.ts:7-8` imports `Renderer` and `PathDrawer`,
  which import `pixi.js`. The *pure* modules `resolveRound` needs (`units`,
  `constants`, `types`, `rng`, `online-types`, `battlefield`, `ctf`,
  `ai-scoring`, `obstacle-merge`) are all DOM-clean. Deno can't tree-shake, so
  **extract the headless simulation into `game-core.ts`** (no Pixi/DOM) that
  both the client `GameEngine` and the Edge Function import. Worth doing
  regardless of the server-side step.

### 1.6 Recover from lost local stash (don't promise a redraw that can't work)
Committed paths live only in `localStorage` (`localStoragePathStash`). If
cleared, reveal is impossible and the current "please redraw it" message is a
trap: the server already holds the old commit hash, so a redraw fails
`verifyReveal` (`online-async-core.ts:111`) and the round can never resolve.

**Fix:**
- Replace the false "redraw" affordance with an explicit, honest path: detect
  the lost-stash case and offer **Forfeit this round** (advance via 1.4b
  semantics) so the match is never permanently wedged.
- *Optional* device-recovery: store an **encrypted** copy of the paths in the
  `turns` row at commit, revealing the key only at reveal. **Caveat (from
  review):** a key derived purely from public `matchId + userId` is brute-forceable
  by anyone with DB access (small path space → known-plaintext attack), so it
  does **not** preserve blind fairness against a malicious server. If pursued,
  the key must include a client-held secret the server cannot derive — and even
  then it only survives same-device resets, **not** device switches (anonymous
  `auth.uid()` differs per device, `online-auth.ts`). Given the complexity, the
  **Forfeit escape hatch is the recommended baseline**; treat encrypted recovery
  as a later nice-to-have.

### 1.7 Notifications: idempotent, observable, host-aware
`notify-turn` swallows errors and always returns 200; `registerTurnNotifications`
(`online-push.ts`) clobbers the player row each call. **Also (from review):**
`notify-turn` early-returns when the opponent is `null`, so a host's first move
(2.2) sends nothing.

**Fix:** retry push once on transient FCM/Resend failure; log delivery
outcomes; only write changed fields on re-register; and handle the
no-guest-yet case explicitly (no error, defer the "your turn" notification
until a guest joins). Lower priority than 1.1–1.5.

**Outcome of Part 1:** the existing async mode becomes reliable and
self-healing. Shippable on its own.

---

## Part 2 — One protocol, one lobby, first move, real drop-in/out

### 2.0 Uniform commit-reveal seed (the unification prerequisite)
Per the decision above: route **live** rounds through commit→reveal with
`deriveMatchSeed` too. This is the change that makes one source of truth
*actually* true and is a precondition for any later live accelerator. Without
it, Part 3 cannot degrade safely. (If we decide we never want live unification,
we can skip 2.0 and keep live WebRTC fully separate — see Sequencing.)

### 2.1 Collapse the menu — with the right framing per intent
Today: three buttons (`online-btn`, `online-random-btn`, `online-async-btn`) →
three paths (`startOnlineHostGame`, `startOnlineGuestMode`, `startAsyncGame`).
Collapse to:
- **Play with a friend** → durable match + share link (multi-day cadence).
- **Play a stranger** → matchmaking that creates/joins a **durable match**, but
  framed as a **single session** with a short timeout (Decision 3). Do **not**
  imply a stranger will return for turn 2.

**Feasibility (verified):** the matchmaking change itself is small —
`online-matchmaking.ts` swaps `generateRoomId()` for `createAsyncMatch()` and
returns a match id + team — **but the ripple is medium-to-large**: `main.ts`'s
`startOnlineGuestMode`/host flows must open `AsyncGameController` instead of the
WebRTC engine, and `online-matchmaking.test.ts` needs a new variant. Scope it as
its own chunk (~2–3 days), not a one-liner.

### 2.2 Let the host move first
While `status === 'open'`, still show the share link **and** let the host plan +
commit round 1. The commit-reveal model already supports this: the host's hash
sits in `turns`; the moment a guest joins (`status → active`) and commits, the
round resolves.

**Feasibility (corrected — not "small, contained"):** the controller change is
one early-return at `online-async-game.ts:253`, but it ripples:
- `asyncHooks()` in `main.ts` must merge `onWaitingForGuest` (hides planning,
  shows share link) and `onPlanTurn` (shows planning) into a combined
  share-link-**and**-planning state.
- Notification timing must change (1.7): suppress "your turn" until a guest
  exists, then notify on join.
- The existing test `online-async-game.test.ts:438-455` asserts the **opposite**
  ("no premature planning") and must be rewritten.
Estimate ~1 day. Still the highest visible-payoff change.

### 2.3 Drop-in/out + a matches list (the resume primitive)
Durable state makes leaving/returning just unsubscribe/reopen; the work is
presentational:
- A **matches list** screen with explicit status badges: **Your turn** (you
  haven't committed), **Waiting for opponent** (you committed), **Round playing**
  (both committed, resolving), **Abandoned**. Reopening calls `startAsyncGame(id)`.
- A small **concurrent-match cap** (e.g. 5) with a clear "finish or abandon one"
  message; **unread badges** for matches awaiting you; **abandoned-match
  lifecycle** (auto-hide/archive after ~30d, retain in DB).
- The `?amatch=` deep link already resumes; ensure push payloads carry it (they
  do) and that the matches list is the default landing when several are active.

### 2.4 Optional presence (cheap, no WebRTC)
A Supabase Realtime **presence** channel per match drives "opponent is online
now" affordances. **Strictly a UI hint** (from review): presence is best-effort
and must **not** drive the safety-net poll frequency or any correctness
decision — the state machine is driven by Postgres `turns` alone.

**Outcome of Part 2:** one protocol, one lobby, first-move-before-opponent, real
drop-in/out, a matches list — all on the durable log. **This likely satisfies
the entire ask.** Part 3 is pure latency polish.

---

## Part 3 — WebRTC as a live accelerator (gated; round-boundary handoff only)

Layer real-time animation onto the unified flow for the case where both players
are present and want the round to animate live rather than each watching a
resolved replay.

### 3.1 Reframe the transport, not the truth
Keep the clean transport seam — `PeerHandle`/`PeerCallbacks`
(`src/online-peer.ts`), the racing/failover proxy in `connectTransport`
(`src/online.ts`), typed channels in `createOnlineRoom`. Change *what it
carries*: commit/reveal messages mirrored over the data channel for instant
feel **and** written to Postgres for durability. Because of 2.0 the seed is the
same on both sides regardless of which message arrived first. The persisted
result is always `resolveRound`'s deterministic output (already true in the
async path), so a desync or drop never corrupts the match.

### 3.2 Degrade only at round boundaries (Decision 2)
There is **no mid-round engine handoff** — the incremental live ticker
(`guestTickCallback`, `main.ts:839`) and atomic `resolveRound()`
(`main.ts:1224`) are different machines and the engine has no checkpoint/resume.
So:
- If WebRTC dies **mid-round**, the present player **finishes the current round
  deterministically from the already-committed reveals** (the very inputs the
  live sim was using — identical outcome, guaranteed by 2.0). The UI shows an
  "Opponent disconnected — finishing the round" overlay; no rewind.
- The **next** round is plain async until/unless the peer returns and a live
  channel re-establishes at the next boundary.
This keeps "seamless" honest: live when both are present, play-by-mail when not,
switching cleanly between rounds.

### 3.3 Signaling shares the match identity
WebRTC signaling already uses a Realtime channel keyed by room id
(`rtc-${roomId}`); key it by the durable match id so the live session and turn
log are one identity. When presence (2.4) shows both players present, clients
opportunistically open the data channel; if it never connects, nothing breaks —
it's async underneath.

### Simpler alternative if Phase 3 isn't worth it
If latency never becomes a complaint, the honest option is to **keep live
WebRTC as a separate fast-path that only shares the lobby + matchmaking**, and
*not* route it through the turn log at all (skip 2.0/3.x). This is less elegant
but avoids the extra live commit round-trip and the dual-write path. Decide
based on real usage, not aesthetics.

---

## Cross-cutting: product / UX requirements

These make the experience *feel* seamless and reliable, beyond correctness:

- **First-move fairness copy (2.2):** explain that both players commit blindly
  regardless of who moved first ("your opponent's move stays hidden until you've
  both committed — still a fair simultaneous turn"), so a late-joining friend
  doesn't feel disadvantaged.
- **Retry/error feedback (1.1):** during auto-retry show a quiet "Submitting…"
  state, not a raw error; on final failure show a plain-language message and a
  reassurance that the move is saved locally. Never surface backend codes.
- **Reconnection/sync UX (1.3):** when the subscription is down >~5s, show a
  subtle "Syncing…" on the affected match; resume cleanly on
  background→foreground.
- **Live-disconnect UX (3.2):** the "Opponent disconnected — finishing the
  round" overlay, plus a one-line determinism reassurance if asked ("the result
  is the same as if they'd stayed").
- **Abandon/forfeit UX (1.4b):** Forfeit (self), Nudge (≤1/day), Claim-win with
  a grace window, a returning-opponent "at risk" banner, mutual-inactivity draw,
  and clear "ended after N days inactivity" messaging.
- **Onboarding (2.1):** first async match shows a one-liner ("take turns over
  hours or days; you'll be notified when it's your turn"); first commit shows
  "locked in — you can close the app."
- **Notifications-denied (1.7/2.3):** pre-prompt rationale before the OS dialog;
  if denied, tell the player to check the matches list and badge accordingly.

---

## Suggested sequencing

| Phase | Deliverable | Depends on | Est. | Risk |
|---|---|---|---|---|
| **1** | Reliability: retry (1.1), idempotent commit (1.2), self-healing sub + safety-net poll (1.3), race-as-success + stale-seed guard (1.4) | — | 3–5 d | low, high value |
| **1a** | Abandon/forfeit + scheduled-job infra + `last_move_at` columns (1.4b) | new cron fn | 2–3 d | medium (new infra) |
| **1b** | Extract `game-core.ts`; server-side `resolve-round` Edge Function (1.5) | core extraction | 3–5 d | medium |
| **2.0** | Uniform commit-reveal seed for live rounds | 1 | 2–3 d | medium (live protocol change) |
| **2** | One lobby (2.1), host-first-move (2.2, incl. test rewrite), matches list + drop-in/out (2.3), presence (2.4), UX copy | 1, 2.0 | 1–2 wk | low–medium |
| **3** | WebRTC live accelerator, round-boundary degradation (gated on latency data) | 1–2 | 1–2 wk | medium |

Parts 1 + 2 deliver the full ask. 1b and 3 are the heavier, optional pieces.

---

## Risks & open questions (with verified facts)

- **Engine not import-clean — confirmed.** `game.ts:7-8` pulls in Pixi via
  `Renderer`/`PathDrawer`; the simulation core is otherwise DOM-free. Server-side
  resolution (1b) requires the `game-core.ts` extraction first.
- **No scheduled-job infra — confirmed.** Abandon timeout (1.4b) is new work
  (`Deno.cron`/`pg_cron` + columns), not config.
- **Test harness is ready — confirmed.** `FakeBackend` + `memStash` + injectable
  `AsyncIO` (`online-async-game.test.ts`) make Parts 1/2.0 testable offline; the
  host-first-move test at `:438-455` must be rewritten.
- **Live seed-model change (2.0)** adds one round-trip to live play. Acceptable
  for a turn-based game, but confirm it doesn't make the live path feel laggy
  before committing to Phase 3.
- **Trust model.** Client-written `latest_state` is fine for friends, weak for
  strangers; the server-side resolver (1b) closes it. Decide whether matchmade
  games *require* 1b before launch.
- **Cost/quota.** Bound poll frequency (visible tabs only, stop on terminal),
  cap concurrent matches, and degrade gracefully (pause poll + banner) near
  free-tier limits; quantify against `docs/plans/2026-03-07-online-pvp-design.md`.
- **Migration.** All changes are additive (nullable columns, new tables/fns);
  in-flight matches must open unchanged — backfill `last_move_at` from
  `updated_at` lazily rather than via a destructive migration.
- **Strangers in an async shell — open question.** Even with a short timeout, is
  matchmade play better served by *live-only* (no durable resume)? Revisit after
  Part 2 ships and we see real abandon rates.

---

## What I'd build first

**Part 1 items 1.3 + 1.4** (self-healing subscription + safety-net poll, plus
race-as-success with the stale-seed guard): the smallest change — contained to
`online-async.ts`/`online-async-game.ts`, no schema, no new infra — that
eliminates the great majority of "it just got stuck" reports. Then **host-first
move (2.2)** as the biggest visible "seamless" win (budget the UI/test ripple).
Treat 2.0 + Part 3 as a separate, latency-driven decision.
