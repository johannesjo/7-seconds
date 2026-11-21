import { createClient, type SupabaseClient } from '@supabase/supabase-js';

// VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY at build time point the game at
// another project, e.g. a local `supabase start` stack.
export const SUPABASE_URL: string = import.meta.env?.VITE_SUPABASE_URL || 'https://puoxmqovckvfoqyihasl.supabase.co';
// Full JWT form required — the short `sb_publishable_*` format causes
// Supabase Realtime subscription failures. Do not replace with short key.
export const SUPABASE_KEY: string = import.meta.env?.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InB1b3htcW92Y2t2Zm9xeWloYXNsIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI5MDM4NjksImV4cCI6MjA4ODQ3OTg2OX0.6rg48T_ddfzj_0-TKwluvxMpTQgSj9aqzyTRMFkHFT4';

/** Generate a v4 UUID without throwing in insecure contexts.
 *  `crypto.randomUUID` is only defined in secure contexts (HTTPS/localhost);
 *  calling it over plain HTTP throws, which — since `localPeerId` runs at module
 *  load — would crash the entire app, not just online mode. Fall back to a
 *  manually assembled RFC-4122 v4 UUID so the rest of the app still loads. */
export function safeUUID(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }
  } catch { /* insecure context — fall through to manual generation */ }

  const bytes = new Uint8Array(16);
  try {
    crypto.getRandomValues(bytes);
  } catch {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant 10xx
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, '0'));
  return `${hex.slice(0, 4).join('')}-${hex.slice(4, 6).join('')}-${hex.slice(6, 8).join('')}-${hex.slice(8, 10).join('')}-${hex.slice(10, 16).join('')}`;
}

let sharedClient: SupabaseClient | null = null;

/** A fetch that gives up after `ms`, also honouring the caller's own signal.
 *  Without it a request on a dead connection (captive Wi-Fi, a stalled proxy)
 *  never settles, and neither does the screen waiting on it. */
export function fetchWithTimeout(ms: number): typeof fetch {
  return (input, init = {}) => {
    // A plain controller rather than AbortSignal.any/timeout, which older
    // Android WebViews lack.
    const controller = new AbortController();
    const abort = () => controller.abort();
    const timer = setTimeout(abort, ms);
    if (init.signal?.aborted) abort();
    init.signal?.addEventListener('abort', abort, { once: true });
    return fetch(input, { ...init, signal: controller.signal }).finally(() => {
      clearTimeout(timer);
      init.signal?.removeEventListener('abort', abort);
    });
  };
}

/** Options for every Supabase client: no HTTP request waits longer than the
 *  referee's own 20 s limit (see online-async.ts). */
export const SUPABASE_GLOBAL = { fetch: fetchWithTimeout(20_000) };

/** Shared Supabase client — avoids duplicate WebSocket connections. */
export function getSupabaseClient(): SupabaseClient {
  if (!sharedClient) {
    sharedClient = createClient(SUPABASE_URL, SUPABASE_KEY, { global: SUPABASE_GLOBAL });
  }
  return sharedClient;
}

const LOCAL_ID_KEY = '7s-player-id';

/** Get or create a persistent local player ID. */
export function getLocalPlayerId(): string {
  try {
    let id = localStorage.getItem(LOCAL_ID_KEY);
    if (!id) {
      id = safeUUID();
      localStorage.setItem(LOCAL_ID_KEY, id);
    }
    return id;
  } catch {
    // localStorage unavailable (private browsing, cookies disabled)
    return safeUUID();
  }
}

/** Characters excluding ambiguous ones (l, 1, o, 0, I, O). */
const ROOM_CHARS = 'abcdefghijkmnpqrstuvwxyz23456789';

/** Generate a 6-character alphanumeric room ID without ambiguous characters. */
export function generateRoomId(): string {
  // Rejection sampling keeps the distribution uniform regardless of alphabet
  // size. ROOM_CHARS has 32 chars and 256 % 32 === 0, so limit is 256 and no
  // byte is ever rejected today — but this stays correct if the alphabet changes.
  const limit = 256 - (256 % ROOM_CHARS.length); // largest multiple of ROOM_CHARS.length ≤ 256
  let id = '';
  while (id.length < 6) {
    const bytes = crypto.getRandomValues(new Uint8Array(6 - id.length));
    for (const b of bytes) {
      if (b < limit && id.length < 6) {
        id += ROOM_CHARS[b % ROOM_CHARS.length];
      }
    }
  }
  return id;
}
