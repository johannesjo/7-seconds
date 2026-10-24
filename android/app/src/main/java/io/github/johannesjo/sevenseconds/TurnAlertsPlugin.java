package io.github.johannesjo.sevenseconds;

import android.Manifest;
import android.app.Notification;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.net.Uri;
import android.os.Build;
import android.provider.Settings;
import androidx.core.app.NotificationCompat;
import androidx.core.app.NotificationManagerCompat;
import androidx.core.content.ContextCompat;
import com.getcapacitor.JSObject;
import com.getcapacitor.PermissionState;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.firebase.FirebaseApp;
import com.google.firebase.messaging.FirebaseMessaging;
import com.google.firebase.messaging.RemoteMessage;
import java.util.Map;

/**
 * Turn alerts for online matches through Firebase Cloud Messaging. The match-referee Edge Function
 * sends notification messages, which Android shows by itself while the game is in the background or
 * closed. While it is open, TurnAlertsService hands them here: they are shown unless their match is
 * on screen, which updates live. Tapping an alert opens its match.
 * A build without google-services.json has no Firebase app, and a phone without Google Play services
 * can't receive FCM: isAvailable() is false and the game falls back to local notifications from an
 * open match. See docs/turn-alerts.md.
 */
@CapacitorPlugin(
    name = "TurnAlerts",
    permissions = @Permission(strings = { Manifest.permission.POST_NOTIFICATIONS }, alias = TurnAlertsPlugin.NOTIFICATIONS)
)
public class TurnAlertsPlugin extends Plugin {
    static final String NOTIFICATIONS = "notifications";
    /** channel_id in src/server/alerts.ts (fcmMessage), and the manifest's default channel. */
    static final String CHANNEL_ID = "turns";
    /** The FCM data keys; Android passes them to the activity as extras when an alert is tapped. */
    private static final String EXTRA_MATCH = "seven_match";
    private static final String EXTRA_RANKED = "seven_ranked";
    /** Set by FCM on the extras of a tapped alert; set on ours too, so each alert opens its match once. */
    private static final String EXTRA_ID = "google.message_id";

    /** The plugin while the game runs, for alerts that arrive meanwhile. */
    private static volatile TurnAlertsPlugin instance;
    /** The online match on screen, whose alerts would only repeat what it shows. */
    private static volatile String openMatch;

    @Override
    public void load() {
        instance = this;
        if (configured() && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            NotificationChannel channel = new NotificationChannel(
                CHANNEL_ID,
                getContext().getString(R.string.turn_alerts_channel),
                NotificationManager.IMPORTANCE_DEFAULT
            );
            channel.setDescription(getContext().getString(R.string.turn_alerts_channel_description));
            getContext().getSystemService(NotificationManager.class).createNotificationChannel(channel);
        }
    }

    @Override
    protected void handleOnDestroy() {
        if (instance == this) instance = null;
    }

    private boolean configured() {
        return (
            !FirebaseApp.getApps(getContext()).isEmpty() &&
            GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(getContext()) == ConnectionResult.SUCCESS
        );
    }

    /** BridgeActivity passes its launch intent here too, so a tap that starts the app is seen. */
    @Override
    protected void handleOnNewIntent(Intent intent) {
        super.handleOnNewIntent(intent);
        String match = intent.getStringExtra(EXTRA_MATCH);
        if (match == null || !match.matches("[a-z2-9]{6}")) return;
        // Reopened from recents, or relaunched after Android ended the process: Android hands back the
        // task's first intent, an old tap. Seen alerts are remembered for the same reason.
        if ((intent.getFlags() & Intent.FLAG_ACTIVITY_LAUNCHED_FROM_HISTORY) != 0) return;
        String id = intent.getStringExtra(EXTRA_ID);
        if (id != null) {
            SharedPreferences seen = getContext().getSharedPreferences("turn_alerts", Context.MODE_PRIVATE);
            String opened = seen.getString("opened", "");
            if (("\n" + opened + "\n").contains("\n" + id + "\n")) return;
            // The task's first intent is the only old one Android hands back, so a few recent ones suffice.
            StringBuilder recent = new StringBuilder(id);
            String[] earlier = opened.isEmpty() ? new String[0] : opened.split("\n");
            for (int i = 0; i < Math.min(earlier.length, 9); i++) recent.append('\n').append(earlier[i]);
            seen.edit().putString("opened", recent.toString()).apply();
        }
        intent.removeExtra(EXTRA_MATCH);
        boolean ranked = "1".equals(intent.getStringExtra(EXTRA_RANKED));
        // Kept until the page listens: on a cold start it is still loading.
        notifyListeners("alertOpened", new JSObject().put("match", match).put("ranked", ranked), true);
    }

    /** The online match now on screen, or none (match: null). */
    @PluginMethod
    public void setOpenMatch(PluginCall call) {
        openMatch = call.getString("match");
        call.resolve();
    }

    /** An alert that arrived while the game is open (TurnAlertsService). The page refreshes its match
     *  lists; the alert is shown as Android would have, unless its match is on screen. */
    static void received(Context context, RemoteMessage message) {
        Map<String, String> data = message.getData();
        String match = data.get(EXTRA_MATCH);
        if (match == null || !match.matches("[a-z2-9]{6}")) return;
        String ranked = data.get(EXTRA_RANKED);
        TurnAlertsPlugin plugin = instance;
        if (plugin != null) plugin.notifyListeners("alertReceived", new JSObject().put("match", match).put("ranked", "1".equals(ranked)));
        RemoteMessage.Notification shown = message.getNotification();
        if (shown == null || match.equals(openMatch)) return;
        NotificationManagerCompat manager = NotificationManagerCompat.from(context);
        if (!manager.areNotificationsEnabled()) return;
        Intent open = new Intent(context, MainActivity.class)
            .putExtra(EXTRA_MATCH, match)
            .putExtra(EXTRA_RANKED, ranked)
            .putExtra(EXTRA_ID, message.getMessageId());
        PendingIntent tap = PendingIntent.getActivity(
            context,
            match.hashCode(),
            open,
            PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE
        );
        Notification notification = new NotificationCompat.Builder(context, CHANNEL_ID)
            .setSmallIcon(R.drawable.ic_stat_turn)
            .setColor(ContextCompat.getColor(context, R.color.turn_alert))
            .setContentTitle(shown.getTitle())
            .setContentText(shown.getBody())
            .setAutoCancel(true)
            .setContentIntent(tap)
            .build();
        // The same tag as the referee's FCM message, so it replaces the match's earlier alert.
        try {
            manager.notify("seven-" + match, 0, notification);
        } catch (SecurityException revoked) {
            // Permission withdrawn between the check and here.
        }
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        call.resolve(new JSObject().put("available", configured()));
    }

    @Override
    @PluginMethod
    public void checkPermissions(PluginCall call) {
        call.resolve(new JSObject().put(NOTIFICATIONS, notificationState()));
    }

    @Override
    @PluginMethod
    public void requestPermissions(PluginCall call) {
        // Before Android 13 there is nothing to ask: notifications are on unless turned off in settings.
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState(NOTIFICATIONS) == PermissionState.GRANTED) {
            checkPermissions(call);
        } else {
            requestPermissionForAlias(NOTIFICATIONS, call, "permissionAnswered");
        }
    }

    @PermissionCallback
    private void permissionAnswered(PluginCall call) {
        checkPermissions(call);
    }

    /** granted or denied, or on Android 13+ also prompt / prompt-with-rationale. Notifications
     *  turned off in Android settings, or just the "Your turn" channel, count as denied. */
    private String notificationState() {
        NotificationManagerCompat manager = NotificationManagerCompat.from(getContext());
        if (manager.areNotificationsEnabled()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                NotificationChannel channel = manager.getNotificationChannel(CHANNEL_ID);
                if (channel != null && channel.getImportance() == NotificationManager.IMPORTANCE_NONE) return "denied";
            }
            return "granted";
        }
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU) return "denied";
        PermissionState state = getPermissionState(NOTIFICATIONS);
        return state == null || state == PermissionState.GRANTED ? "denied" : state.toString();
    }

    /** This device's FCM token. Token generation stays off (see the manifest) until the player opts in. */
    @PluginMethod
    public void register(PluginCall call) {
        if (!configured()) {
            call.reject("Turn alerts are not set up in this build");
            return;
        }
        FirebaseMessaging messaging = FirebaseMessaging.getInstance();
        messaging.setAutoInitEnabled(true);
        messaging
            .getToken()
            .addOnCompleteListener(task -> {
                if (task.isSuccessful() && task.getResult() != null) {
                    call.resolve(new JSObject().put("token", task.getResult()));
                } else {
                    call.reject("Could not register for turn alerts", task.getException());
                }
            });
    }

    /** Deletes this device's token, so nothing more can reach it even if the server still has it. */
    @PluginMethod
    public void unregister(PluginCall call) {
        if (!configured()) {
            call.resolve();
            return;
        }
        FirebaseMessaging messaging = FirebaseMessaging.getInstance();
        messaging.setAutoInitEnabled(false);
        messaging.deleteToken().addOnCompleteListener(task -> call.resolve());
    }

    /** Android's notification settings for this app: the only way back after a permanent "Don't allow". */
    @PluginMethod
    public void openSettings(PluginCall call) {
        String app = getContext().getPackageName();
        Intent intent = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new Intent(Settings.ACTION_APP_NOTIFICATION_SETTINGS).putExtra(Settings.EXTRA_APP_PACKAGE, app)
            : new Intent(Settings.ACTION_APPLICATION_DETAILS_SETTINGS, Uri.parse("package:" + app));
        try {
            getActivity().startActivity(intent);
            call.resolve();
        } catch (RuntimeException error) {
            call.reject("Could not open the notification settings", error);
        }
    }
}
