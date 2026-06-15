import { getSupabaseClient } from './online';
import { dlog } from './online-debug';

/** Cached promise so concurrent callers share a single sign-in attempt. */
let authPromise: Promise<string | null> | null = null;

/** Ensure the shared Supabase client has an anonymous session.
 *
 *  Async matches need a stable `auth.uid()` for row-level security and to
 *  identify the host/guest. Anonymous sign-in gives us that without any login
 *  UI — the session is persisted by supabase-js in localStorage and reused
 *  across reloads. Returns the user id, or null if auth is unavailable
 *  (e.g. anonymous sign-ins disabled, or offline). */
export function ensureAuth(): Promise<string | null> {
  if (authPromise) return authPromise;

  authPromise = (async () => {
    const client = getSupabaseClient();
    try {
      const { data: { session } } = await client.auth.getSession();
      if (session?.user) {
        dlog(`auth: existing session ${session.user.id.slice(0, 8)}`);
        return session.user.id;
      }
      const { data, error } = await client.auth.signInAnonymously();
      if (error || !data.user) {
        dlog(`auth: anonymous sign-in failed: ${error?.message ?? 'no user'}`);
        return null;
      }
      dlog(`auth: signed in anonymously ${data.user.id.slice(0, 8)}`);
      return data.user.id;
    } catch (e) {
      dlog(`auth: sign-in threw: ${e}`);
      return null;
    }
  })();

  return authPromise;
}

/** Current authenticated user id, or null if not signed in yet. Synchronous —
 *  call ensureAuth() first to guarantee a session exists. */
export async function getAuthUserId(): Promise<string | null> {
  const client = getSupabaseClient();
  const { data: { session } } = await client.auth.getSession();
  return session?.user?.id ?? null;
}

/** Reset cached auth state (tests / sign-out). */
export function resetAuthCache(): void {
  authPromise = null;
}
