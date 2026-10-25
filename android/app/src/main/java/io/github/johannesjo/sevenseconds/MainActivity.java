package io.github.johannesjo.sevenseconds;

import android.graphics.Rect;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.view.ViewCompat;

import java.util.Arrays;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        // Ranked sign-in (Play Games) and turn alerts (Firebase); both stay
        // inert in builds without their configuration. See docs/ranked.md.
        registerPlugin(RankedIdentityPlugin.class);
        registerPlugin(TurnAlertsPlugin.class);
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        // TODO: remove clearCache once users have updated past the caching issue
        webView.clearCache(true);

        // Handle back gesture / back button — allow WebView back navigation for
        // sub-pages (privacy policy, terms) but prevent exiting the app
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (webView.canGoBack()) {
                    webView.goBack();
                }
                // Otherwise swallow — prevents accidental app exit
            }
        });

        // Disable overscroll glow/bounce to prevent pull-to-refresh style gestures
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);

        // Keep the system back gesture from grabbing edge swipes meant for the
        // game. Android honours at most 200dp per edge, so claim the bottom
        // 200dp of each side, where thumbs sit while playing.
        webView.addOnLayoutChangeListener((v, left, top, right, bottom, oldLeft, oldTop, oldRight, oldBottom) -> {
            int width = right - left;
            int height = bottom - top;
            float density = v.getResources().getDisplayMetrics().density;
            int band = Math.min(height, (int) (200 * density));
            int edge = Math.min(width / 2, (int) (48 * density));
            ViewCompat.setSystemGestureExclusionRects(v, Arrays.asList(
                    new Rect(0, height - band, edge, height),
                    new Rect(width - edge, height - band, width, height)));
        });
    }
}
