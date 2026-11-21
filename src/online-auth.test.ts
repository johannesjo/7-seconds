import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AuthApiError, AuthRetryableFetchError } from '@supabase/supabase-js';

const getSession = vi.fn();
const signInAnonymously = vi.fn();
vi.mock('./online', () => ({ getSupabaseClient: () => ({ auth: { getSession, signInAnonymously } }) }));
vi.mock('./online-debug', () => ({ dlog: () => {} }));

const { ensureAuth } = await import('./online-auth');

const session = (id: string) => ({ data: { session: { user: { id } } } });
const noSession = { data: { session: null } };

describe('ensureAuth', () => {
  beforeEach(() => {
    getSession.mockReset();
    signInAnonymously.mockReset();
  });

  it('signs in again when the stored session was dropped after a first sign-in', async () => {
    getSession.mockResolvedValueOnce(session('old-user')).mockResolvedValueOnce(noSession);
    signInAnonymously.mockResolvedValueOnce({ data: { user: { id: 'new-user' } }, error: null });

    expect(await ensureAuth()).toBe('old-user');
    expect(await ensureAuth()).toBe('new-user');
  });

  it('keeps the stored identity when the session check fails on a bad network', async () => {
    // A failed token refresh leaves the stored session in place; a new
    // anonymous user would orphan the player's matches.
    getSession.mockResolvedValueOnce({ data: { session: null }, error: new AuthRetryableFetchError('Failed to fetch', 0) });

    expect(await ensureAuth()).toBeNull();
    expect(signInAnonymously).not.toHaveBeenCalled();
  });

  it('signs in again at once when the server rejected the stored session', async () => {
    // supabase-js has already deleted that session; waiting would only fail
    // the player's next online action too.
    getSession.mockResolvedValueOnce({ data: { session: null }, error: new AuthApiError('Invalid Refresh Token', 400, 'refresh_token_not_found') });
    signInAnonymously.mockResolvedValueOnce({ data: { user: { id: 'fresh' } }, error: null });

    expect(await ensureAuth()).toBe('fresh');
  });

  it('shares one sign-in between concurrent callers', async () => {
    getSession.mockResolvedValue(noSession);
    signInAnonymously.mockResolvedValue({ data: { user: { id: 'u1' } }, error: null });

    const ids = await Promise.all([ensureAuth(), ensureAuth(), ensureAuth()]);

    expect(ids).toEqual(['u1', 'u1', 'u1']);
    expect(signInAnonymously).toHaveBeenCalledTimes(1);
  });

  it('retries after a failed sign-in', async () => {
    getSession.mockResolvedValue(noSession);
    signInAnonymously
      .mockResolvedValueOnce({ data: { user: null }, error: { message: 'rate limited' } })
      .mockResolvedValueOnce({ data: { user: { id: 'u2' } }, error: null });

    expect(await ensureAuth()).toBeNull();
    expect(await ensureAuth()).toBe('u2');
  });
});
