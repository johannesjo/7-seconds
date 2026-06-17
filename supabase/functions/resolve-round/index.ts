// Supabase Edge Function: resolve-round
//
// Triggered by a Database Webhook on UPDATE of public.turns (a "reveal" fills in
// the paths column). When both teams have revealed the current round, the server
// authoritatively simulates it with the SAME deterministic engine the clients
// run (vendored in ../_shared/engine.mjs), writes latest_state, advances the
// round, and sets the terminal status on a win. Runs with the service role.
//
// Why server-side: today whichever client is present resolves the round and
// writes latest_state, so (a) a match can wedge if no client ever reopens, and
// (b) a client could write a forged state. This closes both — clients become
// pure animators of a result the server already committed.
//
// Idempotent and race-safe: it only advances while current_round still equals
// the round being resolved (optimistic guard), so duplicate webhook deliveries
// and a client that also resolves both no-op after the first writer wins.
//
// Deploy:
//   1. npm run build:edge            (regenerate ../_shared/engine.mjs)
//   2. supabase functions deploy resolve-round
//   3. Create a Database Webhook: table public.turns, events UPDATE, POST to
//      this function (service-role auth). See docs/async-play.md.
//
// Deno-targeted; intentionally outside ./src so the app's tsc/vite ignore it.
// @ts-nocheck
import { createClient } from 'npm:@supabase/supabase-js@2';
import {
  resolveRound, deriveMatchSeed, verifyReveal, blueAlive, isPlausibleGameState, ROUND_DURATION_S,
} from '../_shared/engine.mjs';

const ROUND_END_TICK = Math.round(ROUND_DURATION_S * 60);

const admin = createClient(
  Deno.env.get('SUPABASE_URL')!,
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
);

// Optional shared-secret gate. The function URL is public, so if WEBHOOK_SECRET
// is configured, require the Database Webhook to send it (set a custom header
// `Authorization: Bearer <secret>`). Constant-time compare avoids timing leaks.
// If the secret isn't set we proceed (so the function works before it's wired),
// but log loudly — configure it in production.
const WEBHOOK_SECRET = Deno.env.get('WEBHOOK_SECRET') ?? '';

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function authorized(req: Request): boolean {
  if (!WEBHOOK_SECRET) {
    console.warn('resolve-round: WEBHOOK_SECRET not set — accepting unauthenticated request');
    return true;
  }
  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : header;
  return timingSafeEqual(token, WEBHOOK_SECRET);
}

Deno.serve(async (req) => {
  try {
    if (!authorized(req)) return new Response('unauthorized', { status: 401 });
    const payload = await req.json();
    const record = payload.record ?? payload.new;
    const matchId = record?.match_id;
    if (!matchId) return new Response('ignored', { status: 200 });

    const { data: match } = await admin
      .from('matches')
      .select('id, latest_state, seed, current_round, status, host_player, guest_player')
      .eq('id', matchId)
      .single();
    if (!match) return new Response('no match', { status: 200 });
    if (match.status !== 'open' && match.status !== 'active') {
      return new Response('not in play', { status: 200 });
    }
    // latest_state is participant-written (an untrusted stranger in a matchmade
    // game). Refuse to simulate an implausible snapshot — it can't be resolved
    // and a huge/garbage state would burn the service-role function's CPU.
    if (!isPlausibleGameState(match.latest_state)) {
      console.error(`resolve-round: implausible latest_state for ${matchId}`);
      return new Response('invalid state', { status: 200 });
    }

    const round = match.current_round;
    const { data: turns } = await admin
      .from('turns')
      .select('team, commit_hash, paths')
      .eq('match_id', matchId)
      .eq('round', round);

    const blue = turns?.find((t) => t.team === 'blue');
    const red = turns?.find((t) => t.team === 'red');
    // Both sides must have REVEALED (paths present) before we can resolve.
    if (!blue?.paths || !red?.paths) return new Response('not both revealed', { status: 200 });

    // Reject a peer that changed paths after committing (same check as the client).
    const blueTurn = { team: 'blue', commitHash: Number(blue.commit_hash), paths: blue.paths };
    const redTurn = { team: 'red', commitHash: Number(red.commit_hash), paths: red.paths };
    if (!verifyReveal(blueTurn) || !verifyReveal(redTurn)) {
      console.error(`resolve-round: reveal verification failed for ${matchId} r${round}`);
      return new Response('verification failed', { status: 200 });
    }

    // Round 1 derives the write-once seed from both blind commits; later rounds
    // reuse the stored match seed. Per-round PRNG = matchSeed + (round - 1).
    const matchSeed = match.seed ?? deriveMatchSeed(matchId, Number(blue.commit_hash), Number(red.commit_hash));
    const roundSeed = matchSeed + (round - 1);

    const { endState, gameOver } = resolveRound(
      match.latest_state, blue.paths, red.paths, roundSeed, ROUND_END_TICK,
    );

    const patch: Record<string, unknown> = {
      latest_state: endState,
      current_round: round + 1,
    };
    if (match.seed == null) patch.seed = matchSeed; // write-once, with the advance
    if (gameOver) patch.status = blueAlive(endState) ? 'host_won' : 'guest_won';

    // Optimistic guard: only land while still on this round. A duplicate webhook
    // or a client that also resolved will find current_round already advanced
    // and update zero rows — a benign no-op.
    const { data: updated, error } = await admin
      .from('matches')
      .update(patch)
      .eq('id', matchId)
      .eq('current_round', round)
      .select('id');
    if (error) {
      console.error('resolve-round update error', error);
      return new Response('error', { status: 200 });
    }
    const landed = (updated?.length ?? 0) > 0;
    return new Response(landed ? `resolved r${round}` : 'already advanced', { status: 200 });
  } catch (e) {
    console.error('resolve-round error', e);
    // Always 200 so the webhook does not retry-storm on malformed input.
    return new Response('error', { status: 200 });
  }
});
