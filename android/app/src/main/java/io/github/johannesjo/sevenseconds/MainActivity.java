package io.github.johannesjo.sevenseconds;

import android.graphics.Rect;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowCompat;
import androidx.core.view.WindowInsetsCompat;
import androidx.core.view.WindowInsetsControllerCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

import java.util.Collections;

public class MainActivity extends BridgeActivity {

    /** On the game page: navigation bar hidden, side edges kept from the back gesture. */
    private boolean gestureGuard = false;

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

        // Drags on the map must never start a system back swipe. On the game
        // page, hide the navigation bar (a swipe from the bottom brings it back
        // for a moment) and exclude the whole view from the back gesture:
        // Android caps exclusions at 200dp per edge, but not while the bar is
        // hidden this way. Otherwise the page keeps the map out of the gesture
        // zones itself (see .edge-guard in index.html).
        webView.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> {
            applyGestureExclusion(webView);
            pushGestureInsets(webView);
        });
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView view) {
                updateGestureGuard(view);
                pushGestureInsets(view);
            }
        });
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        // Dialogs and app switches can bring the bar back
        if (hasFocus && getBridge() != null) updateGestureGuard(getBridge().getWebView());
    }

    private void updateGestureGuard(WebView webView) {
        // The policy pages keep the bar and the back swipe that leaves them.
        // The game is served from a folder (server.url ends in "/7-seconds/"),
        // so its last path segment is that folder, not "index.html".
        String url = webView.getUrl();
        String page = url == null ? null : Uri.parse(url).getLastPathSegment();
        gestureGuard = url != null && (page == null || !page.endsWith(".html") || page.equals("index.html"));
        WindowInsetsControllerCompat bars = WindowCompat.getInsetsController(getWindow(), webView);
        bars.setSystemBarsBehavior(WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE);
        if (gestureGuard) {
            bars.hide(WindowInsetsCompat.Type.navigationBars());
        } else {
            bars.show(WindowInsetsCompat.Type.navigationBars());
        }
        applyGestureExclusion(webView);
    }

    private void applyGestureExclusion(WebView webView) {
        // Only the parts inside the edge gesture zones count. Should a device cap
        // it anyway, Android keeps the bottom of the rect: the player's units.
        ViewCompat.setSystemGestureExclusionRects(webView, gestureGuard
                ? Collections.singletonList(new Rect(0, 0, webView.getWidth(), webView.getHeight()))
                : Collections.emptyList());
    }

    private void pushGestureInsets(WebView webView) {
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(webView);
        if (insets == null) return;
        // Before Android 10 there is no back gesture; the compat value would be the nav bar.
        // With the guard on, the edges are excluded, so the map may use them.
        Insets gestures = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q && !gestureGuard
                ? insets.getInsets(WindowInsetsCompat.Type.systemGestures())
                : Insets.NONE;
        float density = getResources().getDisplayMetrics().density;
        webView.evaluateJavascript(
                "document.documentElement.style.setProperty('--gesture-left','" + Math.round(gestures.left / density) + "px');"
                        + "document.documentElement.style.setProperty('--gesture-right','" + Math.round(gestures.right / density) + "px');",
                null);
    }
}
