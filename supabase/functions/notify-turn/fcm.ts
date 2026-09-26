import { TURN_NOTIFICATION_BODY } from './turn.ts';

/** FCM HTTP v1 delivery. The access token is minted from a service account by
 * the Edge Function and is never exposed to the browser. */
export async function sendFcm(
  deviceToken: string,
  matchId: string,
  projectId: string,
  accessToken: string,
  fetcher: typeof fetch = fetch,
): Promise<void> {
  if (!/^[a-zA-Z0-9_-]+$/.test(projectId)) throw new Error('Invalid Firebase project ID');
  const response = await fetcher(`https://fcm.googleapis.com/v1/projects/${projectId}/messages:send`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      message: {
        token: deviceToken,
        notification: { title: '7 Seconds', body: TURN_NOTIFICATION_BODY },
        data: { matchId },
        android: { priority: 'high' },
      },
    }),
  });
  if (!response.ok) throw new Error(`FCM send failed (${response.status})`);
}

/** google-auth-library's getAccessToken returns an object, not the token string. */
export async function sendFcmWithAuth(
  deviceToken: string,
  matchId: string,
  projectId: string,
  auth: { getAccessToken(): Promise<{ token?: string | null }> },
  fetcher: typeof fetch = fetch,
): Promise<void> {
  const { token } = await auth.getAccessToken();
  if (!token) throw new Error('FCM OAuth access token is unavailable');
  await sendFcm(deviceToken, matchId, projectId, token, fetcher);
}
