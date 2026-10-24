package io.github.johannesjo.sevenseconds;

import com.google.firebase.messaging.FirebaseMessagingService;
import com.google.firebase.messaging.RemoteMessage;

/** Turn alerts that arrive while the game is open. Android shows the others by itself. */
public class TurnAlertsService extends FirebaseMessagingService {
    @Override
    public void onMessageReceived(RemoteMessage message) {
        TurnAlertsPlugin.received(this, message);
    }
}
