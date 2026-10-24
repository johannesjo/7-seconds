package io.github.johannesjo.sevenseconds;

import android.content.MutableContextWrapper;
import android.os.CancellationSignal;
import android.util.Base64;
import androidx.core.content.ContextCompat;
import androidx.credentials.Credential;
import androidx.credentials.CredentialManager;
import androidx.credentials.CredentialManagerCallback;
import androidx.credentials.CustomCredential;
import androidx.credentials.GetCredentialRequest;
import androidx.credentials.GetCredentialResponse;
import androidx.credentials.exceptions.GetCredentialCancellationException;
import androidx.credentials.exceptions.GetCredentialException;
import androidx.credentials.exceptions.NoCredentialException;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.google.android.gms.common.ConnectionResult;
import com.google.android.gms.common.GoogleApiAvailability;
import com.google.android.gms.games.GamesSignInClient;
import com.google.android.gms.games.PlayGames;
import com.google.android.libraries.identity.googleid.GetSignInWithGoogleOption;
import com.google.android.libraries.identity.googleid.GoogleIdTokenCredential;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;

@CapacitorPlugin(name = "RankedIdentity")
public class RankedIdentityPlugin extends Plugin {
    private PluginCall pendingCall;
    private CancellationSignal cancellationSignal;

    private boolean available() {
        return getContext().getResources().getBoolean(R.bool.ranked_identity_enabled)
            && GoogleApiAvailability.getInstance().isGooglePlayServicesAvailable(getContext()) == ConnectionResult.SUCCESS;
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        call.resolve(new JSObject().put("available", available()));
    }

    @PluginMethod
    public void signIn(PluginCall call) {
        getActivity().runOnUiThread(() -> {
            if (!available()) {
                call.reject("Ranked sign-in is unavailable in this Android build or on this device.", "UNAVAILABLE");
                return;
            }
            if (pendingCall != null) {
                call.reject("A ranked sign-in is already open.", "IN_PROGRESS");
                return;
            }
            pendingCall = call;
            cancellationSignal = new CancellationSignal();
            try {
                byte[] random = new byte[32];
                new SecureRandom().nextBytes(random);
                String nonce = Base64.encodeToString(random, Base64.URL_SAFE | Base64.NO_WRAP | Base64.NO_PADDING);
                byte[] digest = MessageDigest.getInstance("SHA-256").digest(nonce.getBytes(StandardCharsets.UTF_8));
                StringBuilder hashedNonce = new StringBuilder();
                for (byte value : digest) hashedNonce.append(String.format(java.util.Locale.ROOT, "%02x", value & 0xff));
                GetSignInWithGoogleOption option = new GetSignInWithGoogleOption.Builder(
                    getContext().getString(R.string.ranked_google_web_client_id))
                    .setNonce(hashedNonce.toString()).build();
                GetCredentialRequest request = new GetCredentialRequest.Builder().addCredentialOption(option).build();
                CredentialManager.create(getContext()).getCredentialAsync(
                    new MutableContextWrapper(getActivity()), request, cancellationSignal,
                    ContextCompat.getMainExecutor(getContext()),
                    new CredentialManagerCallback<GetCredentialResponse, GetCredentialException>() {
                        @Override
                        public void onResult(GetCredentialResponse result) {
                            if (pendingCall != call) return;
                            Credential credential = result.getCredential();
                            if (!(credential instanceof CustomCredential)
                                || !GoogleIdTokenCredential.TYPE_GOOGLE_ID_TOKEN_CREDENTIAL.equals(credential.getType())) {
                                reject(call, "Google returned an unsupported credential.", "SIGN_IN_FAILED");
                                return;
                            }
                            try {
                                String idToken = GoogleIdTokenCredential.createFrom(credential.getData()).getIdToken();
                                signInToPlayGames(call, idToken, nonce);
                            } catch (Exception error) {
                                reject(call, "Could not read the Google sign-in credential.", "SIGN_IN_FAILED");
                            }
                        }

                        @Override
                        public void onError(GetCredentialException error) {
                            if (error instanceof NoCredentialException) {
                                reject(call, "No Google account is available. Add a Google account on this device and try again.", "NO_CREDENTIAL");
                                return;
                            }
                            boolean cancelled = error instanceof GetCredentialCancellationException;
                            reject(call, cancelled ? "Sign-in was cancelled." : "Google sign-in failed. Please try again.",
                                cancelled ? "CANCELLED" : "SIGN_IN_FAILED");
                        }
                    });
            } catch (NoSuchAlgorithmException | RuntimeException error) {
                reject(call, "Could not start Google sign-in.", "SIGN_IN_FAILED");
            }
        });
    }

    private void signInToPlayGames(PluginCall call, String idToken, String nonce) {
        GamesSignInClient games = PlayGames.getGamesSignInClient(getActivity());
        games.isAuthenticated().addOnCompleteListener(status -> {
            if (pendingCall != call) return;
            if (!status.isSuccessful()) {
                reject(call, "Could not check Play Games sign-in.", "PLAY_GAMES_FAILED");
            } else if (status.getResult().isAuthenticated()) {
                requestServerCode(call, games, idToken, nonce);
            } else {
                games.signIn().addOnCompleteListener(signIn -> {
                    if (pendingCall != call) return;
                    if (!signIn.isSuccessful() || !signIn.getResult().isAuthenticated()) {
                        reject(call, "Play Games sign-in was not completed.", "PLAY_GAMES_FAILED");
                        return;
                    }
                    requestServerCode(call, games, idToken, nonce);
                });
            }
        });
    }

    private void requestServerCode(PluginCall call, GamesSignInClient games, String idToken, String nonce) {
        games.requestServerSideAccess(getContext().getString(R.string.ranked_google_web_client_id), false)
            .addOnCompleteListener(result -> {
                if (pendingCall != call) return;
                if (!result.isSuccessful() || result.getResult() == null || result.getResult().isEmpty()) {
                    reject(call, "Could not authorize the Play Games profile.", "PLAY_GAMES_FAILED");
                    return;
                }
                pendingCall = null;
                cancellationSignal = null;
                call.resolve(new JSObject().put("idToken", idToken).put("nonce", nonce)
                    .put("serverAuthCode", result.getResult()));
            });
    }

    private void reject(PluginCall call, String message, String code) {
        if (pendingCall != call) return;
        pendingCall = null;
        cancellationSignal = null;
        call.reject(message, code);
    }

    @Override
    protected void handleOnDestroy() {
        CancellationSignal signal = cancellationSignal;
        if (pendingCall != null) reject(pendingCall, "Sign-in was interrupted. Please try again.", "CANCELLED");
        if (signal != null) signal.cancel();
    }
}
