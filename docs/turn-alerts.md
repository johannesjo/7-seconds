# Turn alerts

The match referee tells a player when an online match needs them, so they can
close the game between moves. It sends after the response to the move that
caused it, so an alert can never slow down or fail a move.

| Moment | Who | Title · body |
| --- | --- | --- |
| Someone joins your invite or search | host | Opponent joined (ranked: Ranked opponent found) · *Name* is in. Plan round N. |
| Your opponent submits first | the other player | Your turn · *Name* has planned round N. |
| A round is played | the player who planned first | Round played · Watch round N vs *Name*, then plan round N+1. |
| The match ends by elimination | the player who planned first | Victory! / Defeat · … Watch the final round. |
| Your opponent concedes | you | Victory! · *Name* conceded the match. |

AI commanders are never alerted, nor is the player who just acted. Not
covered: matches decided on time by the hourly job (a timeout found during a
request does alert the winner), and a commander seated by the background job
after its player left the search (they find the match as their turn). A newer
alert for a match replaces the older one (per-match tag), in the browser and
on Android.

## Channels

- **Browsers: Web Push.** "Notify me when it's my turn" in an online match
  subscribes this browser (`public/sw-notify.js`, VAPID public key in
  `src/online-push.ts`) and stores the subscription in the player's own
  `players` row. Covers desktop Chrome/Firefox and Android Chrome; iOS Safari
  only as an installed web app.
- **Android app: Firebase Cloud Messaging.** "Turn alerts on this device"
  asks for Android 13's notification permission and registers the device's
  FCM token for every session the device plays as, casual and ranked
  (`seven_push_register`, at most five devices per player, unused devices
  pruned after 60 days). Alerts arrive with the app closed; tapping one opens
  its match. While the app is open, alerts for the match on screen stay quiet.
- **Android app without Firebase** (a build without `google-services.json`,
  or a phone without Google Play services): local notifications from a match
  left open in the background, as before. Closing the app stops these.
- **Email** (optional, off in production): set `RESEND_API_KEY` and
  `NOTIFY_FROM_EMAIL` on the function and verify a sender domain in Resend.
  Addresses in `players.email` are not verified, so anyone could have alerts
  sent to someone else's address; add a confirmation step before turning
  email on.

## Owner setup

Web Push needs nothing new: function secrets are project-wide, so the
`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` and `VAPID_SUBJECT` set for the old
`notify-turn` function apply to `match-referee` too. Migration 0004 removes the old
`notify_turn_on_commit` webhook; the deployed `notify-turn` function is then
unused and can be deleted in the dashboard.

For Android FCM:

1. **Firebase project.** Add Firebase to the Google Cloud project that holds
   the Play Games configuration (or any project), add the Android app
   `io.github.johannesjo.sevenseconds`, and download `google-services.json`
   into `android/app/` for local builds. It is gitignored: its API key ships
   in the app anyway, but GitHub secret scanning flags it, so keep it out of
   the repo. For CI release builds store its contents as the
   `ANDROID_GOOGLE_SERVICES_JSON` repository secret (see DEPLOYMENT.md).
   Restrict its API key to this Android app (package name and signing SHA-1)
   and to the APIs Firebase needs.
2. **Sender credentials.** Enable the *Firebase Cloud Messaging API (V1)*,
   create a service account with only the *Firebase Cloud Messaging API
   Admin* role, create a JSON key, and store it:

   ```sh
   supabase secrets set --project-ref puoxmqovckvfoqyihasl FCM_SERVICE_ACCOUNT="$(cat fcm-key.json)"
   ```

   Delete the local key file afterwards.
3. **Android build.** Bump `versionCode`, build and ship. Installed apps older
   than this build lack the plugin and keep using local notifications.
4. **Play Console → Data safety:** declare the device token (device or other
   IDs, app functionality, optional).

## Verifying

- `src/server/alerts.test.ts` (wording, links, FCM message) and
  `tests/referee.test.ts` (who is alerted when).
- On devices, after setup: turn alerts on, close the app on phone A, plan a
  round on phone B; A shows "Your turn" and opens the match when tapped.
