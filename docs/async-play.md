# Async ("play-by-mail") online matches

> Status: **Phase 1 in progress.** This document is the design of record for
> letting two friends play an online match with hours (or days) between turns,
> instead of requiring both to be online at the same time.

## Why this is cheap to build

Online play is already a **deterministic lockstep** simulation. A round's
outcome is fully reproducible from:

- the **starting unit state** of that round (`OnlineGameState`),
- each side's **waypoints** for the round (`OnlinePathData`),
- the **match seed** (`GameEngine` derives the per-round PRNG as
  `createRng(seed + roundNumber)` — see `src/game.ts`).

This was verified against the engine:

- Randomness is routed through a seeded Mulberry32 PRNG (`src/rng.ts`); the
  simulation advances in a **fixed 1/60 s timestep** (`src/game.ts`), so it is
  frame-rate independent.
- The map and starting armies are generated once and shipped inside
  `OnlineGameState`, so both clients start identical even though *offline*
  generation uses unseeded `Math.random`.
- State **carries over between rounds** — units keep HP/position, dead units
  stay dead, and the match ends only on full elimination. There are **no
  between-round upgrades or spawns** in online PvP (those exist only in
  single-player Horde).
- `hashGameState` (`src/online-sync.ts`) already verifies cross-client sync and
  is used today for desync detection.

So the only thing that makes today's online play *synchronous* is that turn
data lives in an **ephemeral WebRTC data channel**. Move it into durable
storage and the "both online at once" requirement disappears. Supabase Realtime
**Postgres Changes** then doubles as the live channel: if both players happen to
be online the update lands in seconds (feels like today); if not, the row just
waits until someone reopens the match.

## Model: append-only turn log + simultaneous blind submission

The source of truth is an **append-only turn log**. A match is reconstructable
from `initial_state + ordered turns`. The `matches` row also caches the latest
resolved snapshot so a returning client can resume **without** replaying the
whole match.

Each round, **both players may submit independently, in any order, blind** —
nobody waits for a "your move / my move" ping-pong. The round resolves the
moment both submissions exist. "Your turn" simply means *you have not yet
submitted the current round*.

This matches how the live game already works: red plans without seeing blue's
paths (blue's are only revealed at the `playing` phase).

### Commit–reveal (blind fairness without trusted gating)

The DB has **no authenticated server logic** and players are anonymous, so we
cannot rely on row-level security alone to hide an opponent's paths. Instead we
use a two-step commit–reveal per `(round, team)`:

1. **Commit** — each player inserts a turn row carrying only a `commit_hash`
   of their canonicalised paths. The `paths` column is `NULL`.
2. **Reveal** — once *both* commit rows for the round exist, each player fills
   in their own `paths`. On receiving the opponent's reveal, the client
   verifies `hash(paths) === commit_hash`.

Properties:

- You cannot see the opponent's paths early — they are `NULL` until revealed,
  and reveal only happens after both have committed.
- You cannot change your paths after committing — the hash must match.
- A refusal to reveal is a stalemate, resolved later by turn expiry / forfeit
  (Phase 3).

### Match seed (anti-grind)

The match seed is **derived from the two round-1 commit hashes**
(`deriveMatchSeed`) rather than chosen by the host. Because both commits are
blind, neither player can shop for a favourable RNG seed. The seed is fixed
before the first `playing` phase and reused for every round via the engine's
existing `seed + roundNumber` scheme.

## Identity & auth

Phase 1 adds **Supabase Anonymous Auth** (`signInAnonymously`). This issues a
real persistent `auth.uid()` with **no login screen**, which:

- gives RLS something to gate row ownership on (`host_player` / `guest_player`),
- upgrades player identity from a spoofable localStorage UUID to a JWT subject.

The localStorage player id (`getLocalPlayerId`) is kept for backward-compatible
score tracking.

## Schema

See `supabase/migrations/0001_async_matches.sql`. Two tables:

`matches` — one row per match (cheap "your turn" queries + resume snapshot):

| column          | type        | notes                                            |
| --------------- | ----------- | ------------------------------------------------ |
| `id`            | text PK     | = share-link room id                             |
| `host_player`   | uuid        | creator's `auth.uid()`                           |
| `guest_player`  | uuid        | joiner's `auth.uid()`, null until joined         |
| `initial_state` | jsonb       | round-1 `OnlineGameState`                        |
| `latest_state`  | jsonb       | snapshot at start of `current_round` (fast resume) |
| `seed`          | bigint      | match seed, null until round-1 resolves          |
| `current_round` | int         | 1-based                                          |
| `status`        | text        | `open` / `active` / `host_won` / `guest_won` / `abandoned` |
| `updated_at`    | timestamptz |                                                  |

`turns` — append-only log, the authoritative record:

| column        | type        | notes                              |
| ------------- | ----------- | ---------------------------------- |
| `match_id`    | text        | → `matches.id`                     |
| `round`       | int         |                                    |
| `team`        | text        | `blue` (host) / `red` (guest)      |
| `player`      | uuid        | submitter's `auth.uid()`           |
| `commit_hash` | bigint      | hash of paths (commit step)        |
| `paths`       | jsonb       | null until reveal                  |
| `submitted_at`| timestamptz | commit time                        |
| `revealed_at` | timestamptz | reveal time                        |

PK `(match_id, round, team)`.

## Client flow

```
openMatch(id):
  ensureAuth()
  row  = matches[id];  log = turns[match_id=id]
  engine.loadOnlineGameState(row.latest_state)   // resume without full replay
  subscribe Postgres changes on turns & matches for id

# my turn (I have not committed current_round):
  draw paths -> submitCommit(round, team, paths)   // store hash only
  (can close the app)

# both committed for the round:
  submitReveal(round, team, paths)                 // store my paths

# both revealed for the round:
  verify opponent hash
  if seed is null: seed = deriveMatchSeed(id, blueHash, redHash); persist
  engine.startPlaying() with both paths + seed     // existing deterministic sim
  on round end: persist latest_state + current_round (+ status if game over)
```

Everything reused as-is: `OnlineGameState`, `OnlinePathData`, the headless
`GameEngine`, and `hashGameState` for verification. Only the **transport**
changes — Postgres rows + Realtime instead of the WebRTC channel.

## Code map

| File                          | Responsibility                                            |
| ----------------------------- | --------------------------------------------------------- |
| `src/online-auth.ts`          | anonymous auth (`ensureAuth`)                             |
| `src/online-async-core.ts`    | **pure** logic: path hashing, seed derivation, round state machine, verification (unit-tested) |
| `src/online-async.ts`         | Supabase IO: create/join/load, commit, reveal, subscribe  |
| `src/online-async-game.ts`    | orchestration controller (commit→reveal→resolve→persist) |
| `src/online-push.ts`          | client notification registration (email + Web Push)       |
| `supabase/migrations/0001_*`  | matches/turns schema + RLS                                |
| `supabase/migrations/0002_*`  | players table + RLS (notification contacts)               |
| `supabase/functions/notify-turn` | Edge Function: "your turn" email + Web Push            |

## Phasing

- **Phase 1 (this work):** anon auth, schema + RLS, `online-async` transport
  with commit–reveal, snapshot resume. Friend matches can span hours via
  in-app Realtime + manual resume. *No push notifications yet.*
- **Phase 2 (implemented; deployed push-only):** server-initiated "your turn"
  notifications to reach **absent** players. A `players` table
  (`supabase/migrations/0002_*`) stores an optional email and/or Web Push
  subscription; the `notify-turn` Edge Function (`supabase/functions/notify-turn`)
  fires on each commit via a Database Webhook and nudges the opponent if they
  have not yet submitted the round. Client registration lives in
  `src/online-push.ts`; `public/sw-notify.js` handles the `push` event. Two
  channels are supported: **Web Push** (needs a VAPID keypair —
  `VAPID_PUBLIC_KEY` in `online-push.ts` + matching function secrets) and
  **email** (needs a Resend account *and* a verified sender domain to reach
  anyone but yourself). This deployment is **push-only**; email is left
  unconfigured. Reach caveat: Web Push covers desktop Chrome/Firefox (browser
  running) and Android Chrome, but not iOS Safari unless the app is installed as
  a PWA. Native Android FCM is scaffolded in the schema (`players.fcm_token`)
  but still requires a Firebase project + `@capacitor/push-notifications` —
  deferred.
- **Phase 3:** a "your games" lobby for concurrent matches, turn expiry /
  auto-forfeit, and optional hardening of the reveal step.

### Deployment checklist (as deployed: push-only)

Everything below runs against the existing Supabase project (the same one the
live WebRTC matchmaking uses); the changes are additive.

**Phase 1 — make async matches work:**

1. Apply `supabase/migrations/0001_async_matches.sql` (Dashboard → SQL Editor,
   or `supabase db push`).
2. Enable anonymous sign-ins: Dashboard → Authentication → Sign In / Providers
   → Anonymous.

**Phase 2 — "your turn" Web Push for absent players:**

3. Apply `supabase/migrations/0002_players_and_notifications.sql`.
4. Generate a VAPID keypair: `npx web-push generate-vapid-keys`.
5. Set the public key in `src/online-push.ts` (`VAPID_PUBLIC_KEY`).
6. Deploy the function **from the repo root**:
   `supabase functions deploy notify-turn --project-ref <ref>`.
7. Set its secrets: `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`
   (`supabase secrets set …`). `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` are
   auto-injected — don't set them.
8. Add a Database Webhook on `public.turns` INSERT → `notify-turn`, with the
   service-role key in the `Authorization: Bearer …` header (the function keeps
   `verify_jwt` on, so the webhook must authenticate).

*Email (optional, not configured here):* set `RESEND_API_KEY` + `NOTIFY_FROM_EMAIL`
on the function and verify a sender domain in Resend. The client already collects
an address in the async lobby, so no client change is needed to add it later.

**Phase 3 — reliability (see `docs/plans/2026-06-16-unified-online-reliability.md`):**

9. Apply `supabase/migrations/0003_reliability.sql` (inactivity timeout +
   `last_move_at`/`abandon_after`). Enable `pg_cron` (Dashboard → Database →
   Extensions) so `expire_abandoned_matches()` runs hourly; otherwise call it
   from any external scheduler.
10. *(Optional, recommended)* Server-authoritative round resolution. Build the
    engine bundle (`npm run build:edge`, vendored at
    `supabase/functions/_shared/engine.mjs`), deploy the function
    (`supabase functions deploy resolve-round --project-ref <ref>`), and add a
    Database Webhook on `public.turns` **UPDATE** → `resolve-round` (service-role
    auth, same pattern as `notify-turn`). The server then resolves each round
    with the same deterministic engine the clients run — a match can't wedge if
    no client reopens, and clients can't forge `latest_state`. Idempotent: it
    no-ops once the round has advanced, so it coexists with client resolution.
    Re-run `npm run build:edge` whenever the simulation changes.

### Going live

The async UI and the VAPID public key ship in the **client bundle**, so they
reach players only once the client is rebuilt and redeployed — the backend steps
above are not enough on their own.

- **Test before merge:** `npm run dev` on this branch against the live backend.
- **Launch:** merge to `main`, then rebuild + redeploy the client (GitHub Pages).

## Notes / non-goals

- WebRTC has been removed: all online play (friend invites and "vs random"
  matchmaking) now runs on the async durable turn log. See
  `docs/plans/2026-06-17-drop-webrtc.md`.
- Reconstruction prefers the cached `latest_state` snapshot; the full `turns`
  log is retained for replays and audit/anti-cheat verification.
