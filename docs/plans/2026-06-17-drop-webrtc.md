# Drop WebRTC — unify all online play on the durable log

**Date:** 2026-06-17
**Status:** Plan / in progress
**Scope:** `src/online*`, `src/main.ts`, `index.html`, `supabase/` (no schema change)

## Thesis

Every online game becomes an async durable-log match (`matches` + `turns` in
Postgres, commit→reveal→resolve). When both players are present the Realtime
subscription already makes it feel live; when one leaves it's play-by-mail. One
protocol, one seed model (blind commit-reveal), no streamed game state.

**Why WebRTC isn't needed here:** 7 Seconds is plan-then-watch with a
*deterministic-lockstep* engine — both sides compute the identical 7-second
outcome from `(startState, bluePaths, redPaths, seed)`. There is no continuous
real-time input during the battle to stream. The live path's state streaming is
redundant with the deterministic engine (the async guest already recomputes the
round locally). WebRTC bought only ~1–2s of phase-transition latency — negligible
for turn-based play — at the cost of NAT/TURN/mobile fragility and ~3,000 lines.

**Bonus:** dropping WebRTC eliminates the entire Part 2.0 (uniform seed) and
Part 3 (WebRTC accelerator) problem from the unification plan — there is only one
seed model, so the impedance mismatch ceases to exist.

## Decisions (locked 2026-06-17)

1. **Win/loss record → port to async.** `online-score.ts` survives. Record
   win/loss in the async `onGameOver`, keyed by the opponent's Supabase uid; the
   menu "record" line keeps working.
2. **Menu → two buttons:** "Play a Friend" (create match + share link) and
   "Play a Stranger" (matchmaking). Plus the existing "My Matches".
3. **Old `?join=` links → fall through to menu.** The param is ignored; no
   handler, no error. `?amatch=` is the only online deep link.

## Delete outright (modules + tests)

WebRTC-only, no async consumers:

- `online-peer.ts` (+`.test.ts`) — only imported by `online.ts`
- `online-relay.ts` (+`.test.ts`) — only imported by `online.ts`
- `online-host.ts` (+`.test.ts`) — only imported by `main.ts`
- `online-guest.ts` — only imported by `main.ts`
- `online-transport.test.ts` — tests `connectTransport` (removed)
- `online-sync.ts` (+`.test.ts`) — live desync hash; **verify** no async use, then delete.
  (Keep `online-determinism.test.ts` — engine determinism is still worth asserting.)

## Trim `online.ts`

- **Keep:** `getSupabaseClient`, `safeUUID`, `localPeerId`, `getLocalPlayerId`,
  `generateRoomId`, the Supabase constants (async + auth depend on these).
- **Delete:** `connectTransport`, `createOnlineRoom`, `OnlineConnection`, the
  `online-peer`/`online-relay` imports, TURN/STUN/ICE config + signaling.
- `getShareUrl` / `getJoinRoomId` (live `?join=`) become dead → remove; async has
  `getAsyncShareUrl` / `?amatch=`.

## Repoint matchmaking ("Play a Stranger")

`findMatch()`'s presence-based deterministic pairing is WebRTC-independent — it
just elects host/guest. Change only the consumer: the host calls
`createAsyncMatch()` and broadcasts the match id via presence; the guest calls
`startAsyncGame(matchId)`. Stranger matches get a short `abandon_after` fuse
(single-session framing — supported by the reveal-aware abandon clock).

## Gut the live path in `main.ts`

Delete `startOnlineHostGame`, `guestTickCallback`, `startOnlineGuestMode`,
`createHostCallbacks`, the `onlineHost`/`onlineGuest` state, the `onlineBtn`
handler, the `?join=` deep-link branch, and the live result handlers' inline
`recordWin/recordLoss` (moves into async `onGameOver`). Async hooks, playback,
and My Matches stay.

## Sequencing (each step keeps tests + build green; one commit per step)

1. Repoint matchmaking → async (additive). Verify two-browser stranger match.
2. Collapse the menu to two buttons; route friend-play to async; port W/L into
   async `onGameOver`.
3. Delete `main.ts` live functions + handlers + the `?join=` branch.
4. Delete the WebRTC modules + tests; trim `online.ts`.
5. Remove dead types in `online-types.ts`; delete `online-sync` if confirmed unused.
6. Full suite + build + two-browser feel-check.

## Risk & rollback

- Repoint *before* deleting, so the new path is proven before the old is gone.
- Per-step commits → trivial revert. Net diff ≈ −3,000 lines.
- The deterministic engine, async protocol, notifications, and My Matches are
  untouched.
