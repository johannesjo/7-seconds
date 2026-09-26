# Android turn notifications

The Android app uses the existing Capacitor Local Notifications plugin to show ordinary device notifications. Enable “Turn alerts on this device” in an open match and allow the Android permission prompt. The preference is saved on this device, and the app rechecks OS permission after reopening.

When an open match detects a new turn while the app is backgrounded, it schedules a local notification. Tapping the notification opens that match. While the game is visible, it shows its existing turn banner instead.

These alerts depend on the match still running. Leaving the match or closing the app stops turn detection, and Android may pause a background WebView. There are no closed-app background checks in this implementation. Scheduled reminders alone cannot detect a friend's move.

No Firebase project, service account, or native push dependency is used. Browser Web Push remains separate and continues to use the existing Supabase notifier and service worker.

A future closed-app implementation could use Android WorkManager to check for turns, but checks have a minimum interval of 15 minutes and may be delayed further. It would also need to securely share and refresh the player's existing Supabase session.

References: [Capacitor Local Notifications](https://capacitorjs.com/docs/apis/local-notifications), [Android periodic work](https://developer.android.com/reference/androidx/work/PeriodicWorkRequest).
