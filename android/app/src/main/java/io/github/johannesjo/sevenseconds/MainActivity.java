package io.github.johannesjo.sevenseconds;

import android.os.Build;
import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;
import androidx.core.graphics.Insets;
import androidx.core.view.ViewCompat;
import androidx.core.view.WindowInsetsCompat;

import com.getcapacitor.BridgeActivity;
import com.getcapacitor.WebViewListener;

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

        // Tell the page how wide the back-gesture zones at the screen edges
        // are, so it can keep the battle map out of them (see .edge-guard in
        // index.html). Zero with 3-button navigation.
        webView.addOnLayoutChangeListener((v, l, t, r, b, ol, ot, or, ob) -> pushGestureInsets(webView));
        getBridge().addWebViewListener(new WebViewListener() {
            @Override
            public void onPageLoaded(WebView view) {
                pushGestureInsets(view);
            }
        });
    }

    private void pushGestureInsets(WebView webView) {
        WindowInsetsCompat insets = ViewCompat.getRootWindowInsets(webView);
        if (insets == null) return;
        // Before Android 10 there is no back gesture; the compat value would be the nav bar
        Insets gestures = Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q
                ? insets.getInsets(WindowInsetsCompat.Type.systemGestures())
                : Insets.NONE;
        float density = getResources().getDisplayMetrics().density;
        webView.evaluateJavascript(
                "document.documentElement.style.setProperty('--gesture-left','" + Math.round(gestures.left / density) + "px');"
                        + "document.documentElement.style.setProperty('--gesture-right','" + Math.round(gestures.right / density) + "px');",
                null);
    }
}
