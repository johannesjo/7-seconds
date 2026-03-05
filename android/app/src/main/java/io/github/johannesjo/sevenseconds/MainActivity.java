package io.github.johannesjo.sevenseconds;

import android.os.Bundle;
import android.webkit.WebSettings;
import android.webkit.WebView;

import androidx.activity.OnBackPressedCallback;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        WebView webView = getBridge().getWebView();
        WebSettings settings = webView.getSettings();
        settings.setCacheMode(WebSettings.LOAD_NO_CACHE);
        // TODO: remove clearCache once users have updated past the caching issue
        webView.clearCache(true);

        // Disable back gesture / back button — prevents accidental navigation
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // Intentionally empty — swallow back events
            }
        });

        // Disable overscroll glow/bounce to prevent pull-to-refresh style gestures
        webView.setOverScrollMode(WebView.OVER_SCROLL_NEVER);
    }
}
