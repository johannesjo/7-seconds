/** Retry helper for Supabase writes.
 *
 *  Async-match reliability hinges on not surfacing a transient blip as a dead
 *  end: a brief network drop or 5xx must not wedge a match behind a "please
 *  retry" the player has to action by hand. This wraps a single Supabase call
 *  and retries it with exponential backoff + jitter — but only for *transient*
 *  failures. Logical failures (RLS denial, unique/constraint violations, the
 *  write-once-seed trigger) are deterministic: retrying them just burns time,
 *  so they return immediately for the caller to handle. */

import { dlog } from './online-debug';

/** The shape every Supabase query result shares: an `error` that is null on
 *  success. We only read `error`, so this is intentionally minimal. */
export interface PgResult {
  error: { message?: string; code?: string } | null;
}

export interface RetryOptions {
  /** Total attempts including the first. Default 3. */
  attempts?: number;
  /** Base backoff in ms; attempt n waits ~base * 2^n with jitter. Default 300. */
  baseDelayMs?: number;
  /** Classify an error as worth retrying. Default: anything that isn't a known
   *  logical/permanent Postgres error. */
  isTransient?: (err: { message?: string; code?: string }) => boolean;
  /** Injectable sleep so tests don't wait on real timers. */
  sleep?: (ms: number) => Promise<void>;
  /** Label for debug logging. */
  label?: string;
}

/** Postgres SQLSTATEs that are permanent — retrying cannot change the outcome.
 *  - 23505 unique_violation (e.g. a duplicate commit for the same slot)
 *  - 23503 foreign_key_violation
 *  - 23514 check_violation (e.g. an invalid status)
 *  - 42501 insufficient_privilege (an RLS policy denied the write)
 *  - P0001 raise_exception (our own guard triggers, e.g. "seed is write-once")
 *  - 22xxx data exceptions (bad input) */
const PERMANENT_CODES = new Set(['23505', '23503', '23514', '42501', 'P0001']);

function defaultIsTransient(err: { message?: string; code?: string }): boolean {
  const code = err.code ?? '';
  if (PERMANENT_CODES.has(code)) return false;
  if (code.startsWith('22')) return false; // data exception class
  // PostgREST surfaces some client errors as PGRST1xx with a 4xx — those are
  // logical too. PGRST then 5xx/timeouts are transient. Without a code (network
  // error, fetch failure) we assume transient.
  if (/^PGRST1\d\d$/.test(code)) return false;
  return true;
}

const realSleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Run a Supabase query, retrying transient failures with backoff. Returns the
 *  last result (whether success or a permanent/exhausted error) so the caller
 *  keeps its existing error handling. A thrown error (network failure) is
 *  treated as transient and retried; the final throw is re-thrown. */
export async function withRetry<T extends PgResult>(
  // PromiseLike, not Promise: Supabase's query builder is a thenable, not a real
  // Promise, so callers can pass `() => client.from(...).select()` directly.
  fn: () => PromiseLike<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 3;
  const base = opts.baseDelayMs ?? 300;
  const isTransient = opts.isTransient ?? defaultIsTransient;
  const sleep = opts.sleep ?? realSleep;
  const label = opts.label ?? 'query';

  let lastResult: T | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt > 0) {
      // Exponential backoff with full jitter to avoid two clients re-colliding.
      const ceil = base * 2 ** (attempt - 1);
      await sleep(Math.random() * ceil);
    }
    try {
      const result = await fn();
      if (!result.error) return result;
      lastResult = result;
      if (!isTransient(result.error)) return result; // permanent — don't retry
      dlog(`retry: ${label} transient error (attempt ${attempt + 1}/${attempts}): ${result.error.message}`);
    } catch (e) {
      // Thrown = network/fetch failure: transient. Keep retrying; re-throw last.
      dlog(`retry: ${label} threw (attempt ${attempt + 1}/${attempts}): ${String(e)}`);
      if (attempt === attempts - 1) throw e;
    }
  }
  // Exhausted retries on a transient error: return the last result so the caller
  // surfaces its normal failure path.
  return lastResult as T;
}
