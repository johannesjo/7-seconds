# Android turn notifications

Friend-match turn notifications use the Capacitor 8 Push Notifications plugin and Firebase Cloud Messaging (FCM). The app registers an FCM device token after the player enables notifications. `players.notify_push` controls delivery; opting out clears the stored token. The `notify-turn` Supabase Edge Function sends a visible notification with `data.matchId`, so tapping it opens that match even if the app was closed. Web Push and optional email still use the same webhook.

## Firebase and Android setup

1. Create a Firebase project and register an Android app with package ID `io.github.johannesjo.sevenseconds`.
2. Download that app's `google-services.json` into `android/app/`. This file is ignored by Git. The existing Gradle configuration applies the Google Services plugin when the file exists.
3. Build and distribute an updated Android binary (`npm run build`, `npx cap sync android`, then the normal Gradle release build). The app loads its web code from `capacitor.config.ts`'s hosted `server.url`, but an older installed binary cannot acquire the newly added native plugin just from a website update. The web code detects this and leaves push unavailable on those builds.

## Supabase sender setup

1. In the Firebase project, enable the **Firebase Cloud Messaging API** and create a service account with permission to send FCM messages. Download its private-key JSON and keep it outside the repository.
2. Store the complete JSON as the Supabase Edge Function secret `FCM_SERVICE_ACCOUNT_JSON` (Dashboard → Edge Functions → Secrets). Never add it to the client bundle or Git. The function mints short-lived OAuth tokens with the `firebase.messaging` scope and sends to the service account's `project_id` through FCM HTTP v1.
3. Deploy the updated `notify-turn` function and keep the existing authenticated `public.turns` INSERT Database Webhook. `players.fcm_token` already exists in migration `0002_players_and_notifications.sql`; no new database migration is needed.

On an Android 13+ device, enable notifications from the friend-match checkbox and accept the OS prompt. To verify end to end, commit a turn from the other player, close the recipient app, and tap the system notification. The Firebase project file, service-account secret, function deployment, webhook, and an updated installed binary are all required for real delivery. This repository contains none of the Firebase credentials.

References: [Capacitor Push Notifications](https://capacitorjs.com/docs/apis/push-notifications), [FCM HTTP v1](https://firebase.google.com/docs/cloud-messaging/send/v1-api), [Supabase Edge Function secrets](https://supabase.com/docs/guides/functions/secrets).
