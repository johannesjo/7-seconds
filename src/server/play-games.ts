// Verifies a Play Games player for ranked play. The Android app gets a
// single-use server authorization code from Play Games; the referee exchanges
// it for an access token with the game's Web OAuth client, checks with the
// `applications/verify` endpoint that the player signed in to *this* game, and
// reads their display name and picture. See docs/ranked.md.

export interface PlayGamesConfig {
  webClientId: string;
  webClientSecret: string;
  /** The numeric Play Games application id. */
  appId: string;
}

export interface PlayGamesPlayer {
  id: string;
  name: string;
  avatar: string | null;
}

/** A failure the player can act on; `transient` ones are worth retrying. */
export class PlayGamesError extends Error {
  constructor(message: string, readonly transient: boolean) { super(message); }
}

/** Only Google-hosted pictures (matching the ranked_profiles check), so a
 *  profile can't make other players' devices load an arbitrary address. */
export function validAvatar(url: unknown): string | null {
  return typeof url === 'string' && url.length <= 600
    && /^https:\/\/lh[0-9]+\.(googleusercontent|ggpht)\.com\/[^\s"'<>\\]+$/.test(url) ? url : null;
}

export async function verifyPlayGames(code: unknown, config: PlayGamesConfig, fetchFn: typeof fetch = fetch): Promise<PlayGamesPlayer> {
  if (typeof code !== 'string' || code.length < 10 || code.length > 4096) throw new PlayGamesError('Missing Play Games authorization; sign in again', false);
  const google = async (url: string, init: RequestInit = {}) => {
    let res: Response;
    try { res = await fetchFn(url, { ...init, signal: AbortSignal.timeout(15_000) }); }
    catch { throw new PlayGamesError('Google Play Games is unreachable; try again', true); }
    if (!res.ok) throw new PlayGamesError('Google Play Games verification failed; sign in again', res.status >= 500 || res.status === 429);
    try { return await res.json(); }
    catch { throw new PlayGamesError('Google Play Games sent an invalid response; try again', true); }
  };
  const token = await google('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, client_id: config.webClientId, client_secret: config.webClientSecret, grant_type: 'authorization_code', redirect_uri: '' }),
  });
  if (typeof token?.access_token !== 'string') throw new PlayGamesError('Google token exchange failed; sign in again', false);
  const headers = { Authorization: `Bearer ${token.access_token}` };
  const verified = await google(`https://games.googleapis.com/games/v1/applications/${encodeURIComponent(config.appId)}/verify`, { headers });
  const player = await google('https://games.googleapis.com/games/v1/players/me', { headers });
  if (typeof verified?.player_id !== 'string' || player?.playerId !== verified.player_id
      || typeof player.displayName !== 'string' || !player.displayName.trim()) {
    throw new PlayGamesError('Play Games player verification failed; sign in again', false);
  }
  return { id: verified.player_id, name: player.displayName.trim().slice(0, 100), avatar: validAvatar(player.avatarImageUrl) };
}
