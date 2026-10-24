# Online play

> Status: **referee protocol (rules version 2).** All online play — friend
> invites, random opponents, AI commanders and Ranked — runs through the
> `match-referee` Edge Function on the shared Supabase project. Earlier
> designs: [online PvP](plans/2026-03-07-online-pvp-design.md) (WebRTC),
> [reliability](plans/2026-06-16-unified-online-reliability.md),
> [dropping WebRTC](plans/2026-06-17-drop-webrtc.md).

## Model

A match is a durable row in `matches` plus one `turns` row per team and
round. Rounds are simultaneous and blind: each player draws a plan without
seeing the other's, and the round is played once both plans are in.

1. **Create / find.** A friend invite is created by the referee (`create`),
   which generates the board and armies, so nobody can hand themselves a
   stronger army. A random-opponent search (`matchmake`) pairs the player with
   someone already waiting, or opens a waiting match the next searcher joins.
2. **Join.** Opening an invite link calls `join`, which takes the free seat.
   Open matches can't be listed: only someone holding the link can join.
3. **Plan.** `submit` stores the plan in `match_plans`, which no client can
   read, and adds a `turns` row with `paths = null` so the opponent sees that a
   plan is in. Resubmitting the same plan is a no-op; a different one is refused.
4. **Play.** When the second plan arrives, the referee resolves the round with
   the same deterministic engine the clients run (`GameEngine.resolveRound`,
   bundled into the function), using a fresh random seed. One database call
   (`seven_apply_round`) then publishes both plans on `turns`, keeps the round's
   start state and seed (`prev_state`, `prev_seed`), writes the new board and
   advances `current_round`; on elimination it finishes the match.
5. **Watch.** Clients follow their match with Realtime (and a 15 s poll as a
   safety net). When the round advances, each client animates it from
   `prev_state`, the published plans and `prev_seed`, then shows the next
   planning phase. The animation is the same simulation the server ran, so
   it shows exactly what happened. A device remembers the last round it showed
   (`7s-watched-<id>`); coming back after the opponent finished a round plays
   that round first.
6. **End.** A match ends by elimination, by `forfeit` (the opponent wins; an
   invite nobody joined is withdrawn), or by the idle limit (below).

Compared with the old protocol, there is no commit–reveal step: the referee
holds the plans, so a player never has to come back just to reveal, a lost
plan can't wedge a round, and nobody can change a plan after seeing the
opponent's.

### AI commanders

When a random-opponent search finds nobody, an AI commander takes the guest
seat. Two exist (`match_bots`): **Cadet Pip (AI)**, a recruit, and **Major
Flint (AI)**, a veteran (the veteran wins about 60% against the recruit).
They use the vs-AI position-scoring planner (`src/ai-planner.ts`,
`src/bot.ts`), planning every unit since online play has no real-time chase
AI.

- Casual searches show a 20-second countdown, then call in a commander
  (`bot`). The player can pick one at once instead.
- Ranked searches wait 40 seconds (the server refuses a commander before 30),
  and a player has at most three unfinished ranked matches against
  commanders; beyond that the search waits for a human.
- A search left open (the player closed the app) gets a commander after two
  minutes from the `seven-assign-bots` job; the match then shows up as the
  player's turn.
- A commander plans the moment a round begins, so a round against it plays
  as soon as the player submits. If its plan is ever missing, the client's
  `advance` request (sent after a few seconds of waiting) makes the server
  catch up.

### Idle limit

`last_move_at` is touched on every plan and round. Invites expire after 7
days, searches and ranked matches after 3. An expired invite or search is
abandoned. An expired match in play is won by the side that submitted the
current round, if exactly one did (`timeout`); otherwise nobody wins. The
`seven-expire-matches` job runs hourly, and any referee request on an expired
match settles it at once.

## Trust model

Clients can read their own matches and nothing else; every write goes
through the referee with the service role. RLS select policies limit
`matches` and `turns` to the two players; `match_plans`, `match_bots`,
`ranked_profiles`, `ranked_results` and `push_devices` deny all client access,
and insert/update/delete on `matches`/`turns` are revoked from the API roles.
So a player cannot:

- read the opponent's plan before the round is played,
- claim a win, rewrite the board, or advance a round,
- join or even see a match they don't hold the link to,
- start from an unfair board (the server generates it).

A `matches_guard` trigger keeps identity columns immutable and finished
matches finished, even for the service role.

The referee checks each request: the session (anonymous for casual play, a
Google identity for ranked), that the caller holds a seat, the round, the
client's rules version, and the plan itself (`sanitizePlan`: only living
units of the caller's team, finite points on a 0.01 grid, at most 100 points
per unit, rocket paths only for rocketeers).

## Rules versions

The server resolves rounds and the clients animate them, so both must run
the same simulation. `RULES_VERSION` (`src/online-plan.ts`) names it; every
match records the version it was created under (`matches.rules`).

- `src/rules-version.test.ts` is a tripwire: scripted battles with every unit
  type, cover and hills must end as recorded. When a change to movement,
  combat, ordnance or terrain makes it fail, bump `RULES_VERSION` and update
  its `GOLDEN` values.
- The referee refuses `create`, `join`, `matchmake`, `bot` and `submit` from a
  client on another version (HTTP 426, "Reload or update the app").
- A match on another version can't be continued: the referee ends it with no
  winner (`finish_reason = 'version'`), and the client explains why.
- Each bump ships a migration ending the matches in play on older versions
  (0004 did this for the pre-referee protocol, version 1).
- After changing the engine or the referee, rebuild the bundle
  (`npm run referee:bundle`) and commit it; CI's `npm run referee:check` fails
  on a stale bundle.

## Ranked

Android only, through Google Play Games; see [ranked.md](ranked.md).

## Turn alerts

The referee alerts the opponent when it's their move (`turn`), when a round
was played (`round`), when they won or lost (`result`), when someone joined
their match (`joined`) and when their opponent conceded (`forfeit`) — never an
AI commander, and never the player who just acted. Channels: Web Push for
browsers, Firebase Cloud Messaging for the Android app, and email if
configured. See [turn-alerts.md](turn-alerts.md).

## Schema

| table | key | purpose |
| --- | --- | --- |
| `matches` | `id` | seats and names, board (`initial_state`, `latest_state`, `prev_state`), round, status, `rules`, `ranked`, `matchmaking`, `guest_bot`, `finish_reason` |
| `turns` | `(match_id, round, team)` | who has planned each round; plans once the round is played |
| `match_plans` | `(match_id, round, team)` | plans held until both are in (service role only) |
| `match_bots` | `player` | AI commanders and their fixed ranked ratings |
| `players` | `id` | Web Push subscription and email for turn alerts (each player their own row) |
| `push_devices` | `(player, token)` | Android FCM tokens (`seven_push_register`/`unregister`) |
| `ranked_profiles`, `ranked_results` | | see [ranked.md](ranked.md) |

Migrations live in `supabase/migrations`; `0004_referee.sql` holds every
function above. The database functions are tested against a real PostgreSQL
16 (`tests/referee-sql.test.ts`), and the referee end to end over them
(`tests/referee.test.ts`); both need `SEVEN_PG_URL` (see `tests/pg.ts`).

## Code map

| file | responsibility |
| --- | --- |
| `src/server/referee.ts` | **the referee**: every action, platform-free (storage, randomness, alerts injected) |
| `src/server/play-games.ts`, `src/server/alerts.ts` | Play Games verification; alert wording and FCM/Web Push payloads |
| `supabase/functions/match-referee/index.ts` | the Edge Function: sessions, database, alert senders; imports the bundle `referee.mjs` |
| `src/online-plan.ts` | `RULES_VERSION`, plan sanitizing, winner helpers |
| `src/bot.ts`, `src/ai-planner.ts` | AI commanders; the planner shared with vs-AI |
| `src/online-async.ts` | client IO: referee calls (with retries), reads, Realtime, the match list query |
| `src/online-async-core.ts` | **pure**: whose move it is, match-list outcomes |
| `src/online-async-game.ts` | the match controller: plan → submit → watch, missed-round replay, polling |
| `src/match-list.ts` | the "Play a Friend" hub |
| `src/main.ts` | wiring: the match screens, the random-opponent search and its AI countdown |
| `src/ranked.ts`, `src/ranked-ui.ts` | Ranked sign-in, API and screen |
| `src/online-push.ts`, `src/turn-alerts.ts`, `src/notify.ts` | turn alerts: Web Push, FCM, local Android fallback |

## Deployment

See [DEPLOYMENT.md](../DEPLOYMENT.md): migrations and the `match-referee`
function deploy automatically from `main` before the web client.
