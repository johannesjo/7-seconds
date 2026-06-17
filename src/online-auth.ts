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
  if (!authPromise) authPromise = signIn();
  return authPromise;
}

/** Read the user id from an existing persisted session WITHOUT creating one.
 *  Lets the menu decide whether to show "My Matches" without forcing an
 *  anonymous account on a player who has never used online play. */
export async function currentUserId(): Promise<string | null> {
  const client = getSupabaseClient();
  try {
    const { data: { session } } = await client.auth.getSession();
    return session?.user?.id ?? null;
  } catch {
    return null;
  }
}

async function signIn(): Promise<string | null> {
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
      authPromise = null; // don't cache a failure — allow a later retry
      return null;
    }
    dlog(`auth: signed in anonymously ${data.user.id.slice(0, 8)}`);
    return data.user.id;
  } catch (e) {
    dlog(`auth: sign-in threw: ${e}`);
    authPromise = null; // don't cache a failure — allow a later retry
    return null;
  }
}
