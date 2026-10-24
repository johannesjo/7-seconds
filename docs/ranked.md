# Ranked

> Status: **built, inert until configured.** The Ranked button appears only in
> an Android build whose Play Games ids are set (below), on a phone with
> Google Play services. Adapted from Imperial Battleground's ranked ladder.

Ranked matches are random-opponent matches rated with Elo. Players sign in
with Google Play Games, which gives each a verified display name and picture.
Opponents are only ever drawn by matchmaking: picking your opponent would make
it trivial to feed one account wins, so friends play casual matches instead.

## How it plays

- **Sign in.** The Ranked screen's "Sign in with Play Games" runs Google
  sign-in and Play Games sign-in (`RankedIdentityPlugin`). The Google ID token
  creates a permanent Supabase session, kept apart from the anonymous casual
  one (`storageKey: 7s-ranked-auth`), so casual matches are untouched. The
  single-use Play Games server code goes to the referee (`profile`), which
  verifies it with Google and binds that Play Games player to the account.
  Once bound, neither can be rebound to another.
- **Find an opponent.** Pairs with a ranked player waiting on the same rules
  version, or opens a waiting search. After 40 seconds without a human, an AI
  commander takes the seat; the match is rated as usual (see below).
- **Play.** Exactly like a casual match. A line under the HUD shows the stakes
  ("Ranked · Win +16 / Loss −16 · vs Name (1234)"), and the result screen the
  rating change, new rating, title and rank.
- **Leave it.** Matches wait for your move for 3 days; then the side that
  planned the current round wins on time (rated).
- **Delete.** "Delete ranked profile" counts unfinished ranked matches as
  forfeits, deletes the profile, its ranked matches and its turn alert
  devices, and keeps only the opponents' side of past results.

## Ratings

Elo starts at 1200, with the standard expected-score formula. Each side uses
its own K: 40 while a player has fewer than 10 rated games, 32 after, so a
provisional player moves faster than an established opponent. A result is
recorded once per match (`ranked_results`), in the same transaction that
ends it, so retries can't rate a match twice. Forfeits and timeouts are
rated; matches with no winner (abandoned, other rules version) are not.

AI commanders keep fixed ratings (Cadet Pip 1100, Major Flint 1300): their
side of a result records 0, so nobody can pump or sink a commander with
throwaway accounts. They are never on the ladder and have no rank. The
commander rated closest to the player takes the seat.

Titles by rating: Recruit below 1050, then Corporal, Sergeant (1150, where
everyone starts), Lieutenant (1250), Captain (1350), Major (1450), Colonel
(1550), General (1700) and Marshal (1850+).

## Referee actions (ranked)

POST `/functions/v1/match-referee` with the ranked session's access token.
All need a Google identity (401 otherwise).

| action | parameters | response |
| --- | --- | --- |
| `profile` | `serverAuthCode` | `{profile}` |
| `me` | | `{profile, matches: [battle], history: [result]}` |
| `leaderboard` | | `{players: [card], you}` (top 100 human players) |
| `view` | `id` | `{battle: {team, status, expired, opponent, stakes, result}}` |
| `matchmake` | `ranked: true` | `{match}` |
| `deleteProfile` | | `{deleted: true}` |

Match moves (`submit`, `advance`, `forfeit`, `bot`, `cancel`) are the casual
actions, called with the ranked session. Cards and results never contain
Supabase or Play Games ids.

## Owner setup

Nothing here is done yet; the backend side ships with migration 0004 and the
`match-referee` function, and stays unused until these steps.

1. **Play Console → Play Games Services.** Create a Play Games project for
   *7 Seconds* (`io.github.johannesjo.sevenseconds`). Add Android credentials
   for the app signing key, the upload key and any debug keys (their SHA-1s).
   Note the numeric **Play Games application id**.
2. **Google Cloud (the project linked to Play Games).** Create an **OAuth
   client of type Web application**. In Play Games Services → Configuration,
   add a **Game server** credential using that Web client. Enable the
   *Google Play Games Services API*. Publish the Play Games configuration, or
   add tester accounts first.
3. **Supabase → Authentication → Providers → Google.** Enable it with the Web
   client id and secret, keep nonce checking on, and allow the Android client
   audience if Supabase asks for it. Keep anonymous sign-ins enabled (casual
   play needs them).
4. **Function secrets** (`supabase secrets set --project-ref puoxmqovckvfoqyihasl …`):
   `GOOGLE_WEB_CLIENT_ID`, `GOOGLE_WEB_CLIENT_SECRET`, `PGS_APP_ID`. The
   client secret never belongs in the app.
5. **`android/gradle.properties`:** set `rankedPlayGamesAppId` and
   `rankedGoogleWebClientId` (both public). Bump `versionCode`, build
   (`npm run cap:build`) and ship through a test track. Builds without them
   have no Ranked mode.
6. **Play Console → Data safety:** declare the Play Games profile (name,
   picture, player id) and app activity (ranked results) as collected for app
   functionality, linked to the user, deletable in the app.
7. **Check on two phones:** sign in on both, "Find ranked opponent" on both,
   play a match to the end, and confirm the stakes line, the rating change on
   the result screen, both histories and the leaderboard.

## Not verified here

The ranked database functions and referee actions are tested against
PostgreSQL (`tests/`), with Play Games verification faked. The Android plugin
is the one Imperial Battleground ships, renamed; it has not been compiled or
run in this repository's CI, and the Google sign-in exchange needs the real
credentials and a device.
