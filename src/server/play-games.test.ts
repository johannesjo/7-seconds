import { describe, it, expect } from 'vitest';
import { verifyPlayGames, validAvatar, PlayGamesError } from './play-games';

const config = { webClientId: 'web.apps.googleusercontent.com', webClientSecret: 'secret', appId: '123' };

function fakeGoogle(responses: Record<string, unknown>, status: Record<string, number> = {}) {
  const seen: string[] = [];
  const fetchFn = (async (url: string, init?: RequestInit) => {
    seen.push(url);
    const key = Object.keys(responses).find(k => url.includes(k))!;
    if (key === 'oauth2') expect(String(init?.body)).toContain('code=the-server-code');
    return new Response(JSON.stringify(responses[key]), { status: status[key] ?? 200 });
  }) as typeof fetch;
  return { fetchFn, seen };
}

describe('Play Games verification', () => {
  it('exchanges the code and reads the verified player', async () => {
    const { fetchFn, seen } = fakeGoogle({
      oauth2: { access_token: 'at' },
      'applications/123/verify': { player_id: 'g1' },
      'players/me': { playerId: 'g1', displayName: '  Commander Ann ', avatarImageUrl: 'https://lh3.googleusercontent.com/a/x' },
    });
    expect(await verifyPlayGames('the-server-code', config, fetchFn)).toEqual({ id: 'g1', name: 'Commander Ann', avatar: 'https://lh3.googleusercontent.com/a/x' });
    expect(seen).toHaveLength(3);
  });

  it('refuses a player the verify endpoint did not confirm', async () => {
    const { fetchFn } = fakeGoogle({ oauth2: { access_token: 'at' }, verify: { player_id: 'g1' }, 'players/me': { playerId: 'g2', displayName: 'X' } });
    await expect(verifyPlayGames('the-server-code', config, fetchFn)).rejects.toThrow(/verification failed/);
  });

  it('tells transient Google failures from bad codes', async () => {
    const down = fakeGoogle({ oauth2: {} }, { oauth2: 503 });
    await expect(verifyPlayGames('the-server-code', config, down.fetchFn)).rejects.toMatchObject({ transient: true });
    const bad = fakeGoogle({ oauth2: {} }, { oauth2: 400 });
    await expect(verifyPlayGames('the-server-code', config, bad.fetchFn)).rejects.toMatchObject({ transient: false });
    await expect(verifyPlayGames('', config, bad.fetchFn)).rejects.toBeInstanceOf(PlayGamesError);
  });

  it('keeps only Google-hosted pictures', () => {
    expect(validAvatar('https://lh5.ggpht.com/abc')).toBe('https://lh5.ggpht.com/abc');
    expect(validAvatar('https://evil.example/a.png')).toBeNull();
    expect(validAvatar('https://lh3.googleusercontent.com/a"onload')).toBeNull();
  });
});
