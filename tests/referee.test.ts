// The match referee end to end: requests in, the real database functions and
// engine underneath (tests/pg.ts). Skipped without SEVEN_PG_URL.
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { PG_URL, createTestDatabase, type TestDatabase } from './pg';
import { PsqlStore } from './psql-store';
import { handleReferee, cleanName, ROUND_TICKS, type MatchRow, type RefereeDeps, type User } from '../src/server/referee';
import type { Alert } from '../src/server/alerts';
import { RULES_VERSION, type PathList } from '../src/online-plan';
import { GameEngine } from '../src/game';
import { planBotPaths } from '../src/bot';
import { createRng } from '../src/rng';

const ANN: User = { id: '00000000-0000-4000-8000-0000000000a1', google: false };
const BEA: User = { id: '00000000-0000-4000-8000-0000000000b2', google: false };
const CY: User = { id: '00000000-0000-4000-8000-0000000000c3', google: true };
const DEE: User = { id: '00000000-0000-4000-8000-0000000000d4', google: true };

let db: TestDatabase;
let store: PsqlStore;
let alerts: Alert[];
let background: Promise<unknown>[];
let rng: () => number;
let testIndex = 0;

function deps(): RefereeDeps {
  return {
    store,
    random: () => rng(),
    notify: alert => { alerts.push(alert); },
    background: task => { background.push(task()); },
    playGames: async code => {
      if (code === 'bad-code-0000') throw new (await import('../src/server/play-games')).PlayGamesError('Google Play Games verification failed; sign in again', false);
      return { id: `pgs-${String(code)}`, name: String(code).split('-')[0], avatar: null };
    },
  };
}

async function call(user: User | null, body: Record<string, unknown>) {
  return handleReferee(user, { rules: RULES_VERSION, ...body }, deps());
}
async function ok(user: User, body: Record<string, unknown>): Promise<MatchRow> {
  const res = await call(user, body);
  if (res.status !== 200) throw new Error(`${body.action} failed: ${res.status} ${JSON.stringify(res.body)}`);
  return (res.body as { match: MatchRow }).match;
}
function turns(id: string): { round: number; team: string; paths: PathList | null }[] {
  return JSON.parse(db.run(`select coalesce(json_agg(json_build_object('round', round, 'team', team, 'paths', paths) order by round, team), '[]') from turns where match_id = '${id}';`));
}
const plan = (match: MatchRow, team: 'blue' | 'red', seed: number) => planBotPaths(match.latest_state, team, 'veteran', createRng(seed));

const describeDb = PG_URL ? describe : describe.skip;

describe('referee request checks', () => {
  it('needs a session, a known action and the current rules', async () => {
    expect((await handleReferee(null, { action: 'create' }, {} as RefereeDeps)).status).toBe(401);
    expect((await handleReferee(ANN, { action: 'nope' }, {} as RefereeDeps)).status).toBe(400);
    expect((await handleReferee(ANN, [], {} as RefereeDeps)).status).toBe(400);
    const outdated = await handleReferee(ANN, { action: 'submit', rules: RULES_VERSION - 1 }, {} as RefereeDeps);
    expect(outdated.status).toBe(426);
    expect((outdated.body as { error: string }).error).toMatch(/Reload or update/);
  });

  it('keeps ranked play to Google accounts', async () => {
    for (const action of ['me', 'leaderboard', 'profile']) {
      expect((await handleReferee(ANN, { action }, {} as RefereeDeps)).status).toBe(401);
    }
    expect((await handleReferee(ANN, { action: 'matchmake', ranked: true, rules: RULES_VERSION }, {} as RefereeDeps)).status).toBe(401);
  });

  it('cleans display names', () => {
    expect(cleanName('  Ann \u0000 <b>Smith</b>  ')).toBe('Ann bSmith/b');
    expect(cleanName('Major Flint (AI)')).toBe('Major Flint');
    expect(cleanName('x'.repeat(50))).toHaveLength(24);
    expect(cleanName('   ')).toBeNull();
    expect(cleanName(42)).toBeNull();
  });
});

describeDb('referee with the database', () => {
  beforeAll(() => {
    db = createTestDatabase(`seven_referee_${process.pid}`);
    store = new PsqlStore(db);
  });
  afterAll(() => db?.drop());
  beforeEach(() => {
    alerts = [];
    background = [];
    // A different sequence per test: the same one would draw the same match ids.
    rng = createRng(1234 + ++testIndex);
  });

  it('plays a friend match: invite, join, plans held until both are in, then resolved', async () => {
    const created = await ok(ANN, { action: 'create', name: 'Ann' });
    expect(created).toMatchObject({ status: 'open', host_name: 'Ann', rules: RULES_VERSION, current_round: 1 });
    expect(created.initial_state.units.length).toBeGreaterThan(0);

    // The host plans round 1 before the friend arrives.
    await ok(ANN, { action: 'submit', id: created.id, round: 1, paths: plan(created, 'blue', 1) });
    expect(alerts).toEqual([]);
    const joined = await ok(BEA, { action: 'join', id: created.id, name: 'Bea' });
    expect(joined).toMatchObject({ status: 'active', guest_name: 'Bea' });
    expect(alerts).toMatchObject([{ player: ANN.id, kind: 'joined', opponent: 'Bea' }]);
    expect(turns(created.id)).toEqual([{ round: 1, team: 'blue', paths: null }]);

    alerts = [];
    const redPlan = plan(joined, 'red', 2);
    const after = await ok(BEA, { action: 'submit', id: created.id, round: 1, paths: redPlan });
    expect(after.current_round).toBe(2);
    expect(alerts).toMatchObject([{ player: ANN.id, kind: 'round', round: 2, opponent: 'Bea' }]);

    // Both plans are public now, and replaying them from the stored start
    // state and seed gives exactly the stored result: what clients animate.
    const published = turns(created.id);
    expect(published.map(t => [t.team, t.paths != null])).toEqual([['blue', true], ['red', true]]);
    const row = (await store.match(created.id))!;
    expect(row.prev_state).toEqual(created.initial_state);
    const replay = GameEngine.resolveRound(row.prev_state as never, published[0].paths!, published[1].paths!, Number(row.prev_seed), ROUND_TICKS);
    expect(JSON.parse(JSON.stringify(replay.endState))).toEqual(row.latest_state);
    expect(JSON.stringify(published[1].paths)).toBe(JSON.stringify(redPlan));
  });

  it('refuses moves that are not the caller’s to make', async () => {
    const created = await ok(ANN, { action: 'create' });
    await ok(BEA, { action: 'join', id: created.id });
    const stranger = await call(CY, { action: 'submit', id: created.id, round: 1, paths: [] });
    expect(stranger.status).toBe(404);
    expect((await call(CY, { action: 'join', id: created.id })).status).toBe(409);
    expect((await call(ANN, { action: 'submit', id: created.id, round: 3, paths: [] })).status).toBe(409);
    expect((await call(ANN, { action: 'submit', id: created.id, round: 1, paths: 'x' })).status).toBe(400);
    expect((await call(ANN, { action: 'submit', id: 'BAD!', round: 1, paths: [] })).status).toBe(400);
    // Orders for the other side's units are dropped, not obeyed.
    const red = created.initial_state.units.find(u => u.team === 'red')!;
    await ok(ANN, { action: 'submit', id: created.id, round: 1, paths: [{ unitId: red.id, waypoints: [{ x: 1, y: 1 }] }] });
    expect(JSON.parse(db.run(`select paths from match_plans where match_id = '${created.id}';`))).toEqual([]);
    expect((await call(ANN, { action: 'submit', id: created.id, round: 1, paths: [{ unitId: red.id, waypoints: [{ x: 2, y: 2 }] }] })).status).toBe(200);
    await ok(BEA, { action: 'forfeit', id: created.id });
  });

  it('alerts the opponent whose turn it is, and the winner of a forfeit', async () => {
    const created = await ok(ANN, { action: 'create', name: 'Ann' });
    await ok(BEA, { action: 'join', id: created.id, name: 'Bea' });
    alerts = [];
    await ok(ANN, { action: 'submit', id: created.id, round: 1, paths: [], name: 'Annie' });
    expect(alerts).toMatchObject([{ player: BEA.id, kind: 'turn', round: 1, opponent: 'Annie' }]);
    alerts = [];
    const ended = await ok(ANN, { action: 'forfeit', id: created.id });
    expect(ended).toMatchObject({ status: 'guest_won', finish_reason: 'forfeit' });
    expect(alerts).toMatchObject([{ player: BEA.id, kind: 'forfeit' }]);
    expect((await call(ANN, { action: 'submit', id: created.id, round: 1, paths: [] })).status).toBe(409);
  });

  it('lets a searcher call in an AI commander, who plans every round at once', async () => {
    const waiting = await ok(ANN, { action: 'matchmake', name: 'Ann' });
    expect(waiting).toMatchObject({ status: 'open', matchmaking: true, guest_player: null });
    let match = await ok(ANN, { action: 'bot', id: waiting.id, difficulty: 'recruit' });
    expect(match).toMatchObject({ status: 'active', guest_bot: true, guest_name: 'Cadet Pip (AI)' });
    expect(turns(match.id)).toEqual([{ round: 1, team: 'red', paths: null }]);

    // Every submit resolves the round straight away; the commander is ready for the next.
    for (let round = 1; match.status === 'active' && round <= 40; round++) {
      match = await ok(ANN, { action: 'submit', id: match.id, round, paths: plan(match, 'blue', round) });
      if (match.status === 'active') expect(match.current_round).toBe(round + 1);
    }
    // Most such games end within a few rounds; two lone shielders can't hurt each other.
    if (match.status !== 'active') expect(match).toMatchObject({ finish_reason: 'battle' });
    expect(alerts).toEqual([]); // nothing to tell an AI commander
  });

  it('pairs two searchers, and catches up on a commander move the server still owes', async () => {
    const first = await ok(ANN, { action: 'matchmake', name: 'Ann' });
    const paired = await ok(BEA, { action: 'matchmake', name: 'Bea' });
    expect(paired.id).toBe(first.id);
    expect(paired).toMatchObject({ status: 'active', host_name: 'Ann', guest_name: 'Bea' });
    expect(alerts).toMatchObject([{ player: ANN.id, kind: 'joined', opponent: 'Bea' }]);
    await ok(ANN, { action: 'forfeit', id: first.id });

    // A commander seated by the background job hasn't planned yet.
    const waiting = await ok(ANN, { action: 'matchmake' });
    db.run(`select seven_seat_bot('${waiting.id}', interval '0');`);
    expect(turns(waiting.id)).toEqual([]);
    await ok(ANN, { action: 'advance', id: waiting.id });
    expect(turns(waiting.id)).toEqual([{ round: 1, team: 'red', paths: null }]);
    await ok(ANN, { action: 'forfeit', id: waiting.id });
  });

  it('ends matches made on other rules with a clear message', async () => {
    const created = await ok(ANN, { action: 'create' });
    await ok(BEA, { action: 'join', id: created.id });
    db.run(`set local session_replication_role = replica; update matches set rules = ${RULES_VERSION + 1} where id = '${created.id}';`, 'postgres');
    const res = await call(ANN, { action: 'submit', id: created.id, round: 1, paths: [] });
    expect(res.status).toBe(409);
    expect((res.body as { error: string }).error).toMatch(/newer version/);
    expect((await store.match(created.id))).toMatchObject({ status: 'abandoned', finish_reason: 'version' });
  });

  it('settles an idle match when someone comes back to it', async () => {
    const created = await ok(ANN, { action: 'create' });
    await ok(BEA, { action: 'join', id: created.id });
    await ok(BEA, { action: 'submit', id: created.id, round: 1, paths: [] });
    db.run(`set local session_replication_role = replica; update matches set last_move_at = now() - interval '9 days' where id = '${created.id}';`, 'postgres');
    const res = await call(ANN, { action: 'submit', id: created.id, round: 1, paths: [] });
    expect(res.status).toBe(409);
    expect((res.body as { match: MatchRow }).match).toMatchObject({ status: 'guest_won', finish_reason: 'timeout' });
  });

  it('runs ranked play: verified profiles, a rated match, the ladder', async () => {
    expect((await call(CY, { action: 'matchmake', ranked: true })).status).toBe(409); // no profile yet
    expect((await call(CY, { action: 'profile', serverAuthCode: 'bad-code-0000' })).status).toBe(400);
    const res = await call(CY, { action: 'profile', serverAuthCode: 'Cy-code-123' });
    expect(res.body).toEqual({ profile: { display_name: 'Cy', avatar_url: null, rating: 1200, games: 0, wins: 0, losses: 0, peak_rating: 1200 } });
    await call(DEE, { action: 'profile', serverAuthCode: 'Dee-code-456' });

    const waiting = await ok(CY, { action: 'matchmake', ranked: true, name: 'ignored' });
    expect(waiting).toMatchObject({ ranked: true, host_name: 'Cy' });
    // Ranked searches give humans 30 seconds before a commander may sit down.
    expect(await ok(CY, { action: 'bot', id: waiting.id })).toMatchObject({ status: 'open', guest_player: null });
    const paired = await ok(DEE, { action: 'matchmake', ranked: true });
    expect(paired.id).toBe(waiting.id);

    const view = (await call(CY, { action: 'view', id: waiting.id })).body as { battle: { stakes: { win: number; loss: number } } };
    expect(view.battle.stakes).toEqual({ win: 20, loss: -20 });

    let match = paired;
    for (let round = 1; match.status === 'active' && round <= 40; round++) {
      await ok(CY, { action: 'submit', id: match.id, round, paths: plan(match, 'blue', round) });
      match = await ok(DEE, { action: 'submit', id: match.id, round, paths: plan(match, 'red', round + 50) });
    }
    const me = (await call(CY, { action: 'me' })).body as { profile: { games: number; rating: number }; history: { won: boolean; delta: number }[] };
    expect(me.profile.games).toBe(1);
    expect(me.history[0].delta).toBe(me.history[0].won ? 20 : -20);
    expect(me.profile.rating).toBe(1200 + me.history[0].delta);
    const board = (await call(DEE, { action: 'leaderboard' })).body as { players: { display_name: string }[]; you: { you: boolean } };
    expect(board.players).toHaveLength(2);
    expect(board.you.you).toBe(true);
    expect(JSON.stringify(board)).not.toContain(CY.id);

    // A ranked commander after the wait.
    const search = await ok(CY, { action: 'matchmake', ranked: true });
    db.run(`set local session_replication_role = replica; update matches set created_at = now() - interval '1 minute' where id = '${search.id}';`, 'postgres');
    expect(await ok(CY, { action: 'bot', id: search.id })).toMatchObject({ status: 'active', guest_bot: true });

    expect((await call(CY, { action: 'deleteProfile' })).body).toEqual({ deleted: true });
    expect(await store.match(search.id)).toBeNull();
  });

  it('turns a database failure into a retryable 503', async () => {
    const broken = { ...store, match: async () => { throw new Error('connection reset'); } } as unknown as PsqlStore;
    const res = await handleReferee(ANN, { action: 'advance', id: 'abcdef' }, { ...deps(), store: broken });
    expect(res.status).toBe(503);
  });
});
