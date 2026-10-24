// Runs the migrations against a scratch PostgreSQL 16 database, with stand-ins
// for Supabase's roles and auth (supabase/tests/supabase-stub.sql), and checks
// the referee's database functions and what clients may and may not do.
//
//   SEVEN_PG_URL=postgresql://postgres@localhost:5432/postgres npx vitest run tests/
//
// Skipped without the URL (see tests/pg.ts).
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PG_URL, createTestDatabase, type Role, type TestDatabase } from './pg';

let db: TestDatabase;
const run = (sql: string, role?: Role, uid?: string) => db.run(sql, role, uid);
const failure = (sql: string, role?: Role, uid?: string) => db.failure(sql, role, uid);

const A = '00000000-0000-4000-8000-0000000000aa';
const B = '00000000-0000-4000-8000-0000000000bb';
const C = '00000000-0000-4000-8000-0000000000cc';
const BOT = '00000000-0000-4000-8000-000000007a01';
const STATE = `'{"units":[],"obstacles":[],"elevationZones":[],"mapWidth":1000,"mapHeight":1000}'::jsonb`;
const PLAN = `'[{"unitId":"u","waypoints":[{"x":1,"y":2}]}]'::jsonb`;

/** Edit match timestamps the way time passing would (past the identity guard). */
function backdate(set: string, where: string): void {
  run(`set local session_replication_role = replica; update matches set ${set} where ${where};`, 'postgres');
}
/** Forfeit everything `uid` still has in play, so caps from earlier tests don't interfere. */
function clear(uid: string): void {
  run(`select seven_forfeit('${uid}', id) from matches where status in ('open','active') and '${uid}' in (host_player, guest_player);`);
}

const describeSql = PG_URL ? describe : describe.skip;

describeSql('referee database', () => {
  beforeAll(() => {
    // Matches from before the referee, as clients wrote them.
    db = createTestDatabase(`seven_referee_sql_${process.pid}`, { version: '0004', sql: `
      insert into matches(id, host_player, guest_player, initial_state, latest_state, status) values
      ('legac1', '${A}', '${B}', ${STATE}, ${STATE}, 'active'),
      ('legac2', '${A}', null, ${STATE}, ${STATE}, 'open'),
      ('legac3', '${A}', '${B}', ${STATE}, ${STATE}, 'host_won');` });
  });
  afterAll(() => db?.drop());

  it('ends matches made under the old protocol, keeping finished ones', () => {
    expect(run(`select id, status, coalesce(finish_reason, '-') from matches where id like 'legac%' order by id;`)).toBe(
      'legac1|abandoned|version\nlegac2|abandoned|version\nlegac3|host_won|-');
  });

  it('leaves clients no way to write matches, turns or plans', () => {
    run(`select seven_create('${A}', 'perm01', 2, ${STATE}, 'Ann');`);
    expect(failure(`insert into matches(id, host_player, initial_state, latest_state) values ('x', '${A}', ${STATE}, ${STATE});`, 'authenticated', A)).toMatch(/permission denied/);
    expect(failure(`update matches set status = 'host_won' where id = 'perm01';`, 'authenticated', A)).toMatch(/permission denied/);
    expect(failure(`insert into turns(match_id, round, team, player) values ('perm01', 1, 'blue', '${A}');`, 'authenticated', A)).toMatch(/permission denied/);
    for (const table of ['match_plans', 'match_bots', 'ranked_profiles', 'ranked_results', 'push_devices']) {
      expect(failure(`select * from ${table};`, 'authenticated', A)).toMatch(/permission denied/);
    }
    expect(failure(`select seven_forfeit('${A}', 'perm01');`, 'authenticated', A)).toMatch(/permission denied/);
    expect(failure(`select seven_assign_bots();`, 'anon')).toMatch(/permission denied/);
  });

  it('shows a match only to its two players', () => {
    run(`select seven_create('${A}', 'priv01', 2, ${STATE}, null);`);
    expect(run(`select count(*) from matches where id = 'priv01';`, 'authenticated', A)).toBe('1');
    expect(run(`select count(*) from matches where id = 'priv01';`, 'authenticated', B)).toBe('0');
    run(`select seven_join('${B}', 'priv01', 'Bea');`);
    expect(run(`select guest_name, status from matches where id = 'priv01';`, 'authenticated', B)).toBe('Bea|active');
    expect(run(`select count(*) from matches where id = 'priv01';`, 'authenticated', C)).toBe('0');
    expect(failure(`select seven_join('${C}', 'priv01', null);`)).toMatch(/already has two players/);
  });

  it('keeps plans secret until both are in, then publishes them with the round', () => {
    run(`select seven_create('${A}', 'play01', 2, ${STATE}, 'Ann');`);
    // The host may plan round 1 before anyone joins.
    expect(run(`select seven_submit_plan('${A}', 'play01', 1, ${PLAN}, null)->>'both';`)).toBe('false');
    run(`select seven_join('${B}', 'play01', 'Bea');`);
    expect(run(`select team, paths is null from turns where match_id = 'play01';`, 'authenticated', B)).toBe('blue|t');
    // Same orders again: fine. Different ones: refused. Wrong round, wrong player: refused.
    expect(run(`select seven_submit_plan('${A}', 'play01', 1, ${PLAN}, null)->>'both';`)).toBe('false');
    expect(failure(`select seven_submit_plan('${A}', 'play01', 1, '[]'::jsonb, null);`)).toMatch(/already in/);
    expect(failure(`select seven_submit_plan('${B}', 'play01', 2, '[]'::jsonb, null);`)).toMatch(/round has changed/);
    expect(failure(`select seven_submit_plan('${C}', 'play01', 1, '[]'::jsonb, null);`)).toMatch(/Not your match/);
    expect(run(`select seven_submit_plan('${B}', 'play01', 1, '[]'::jsonb, 'Bea 2')->>'both';`)).toBe('true');

    const end = `'{"units":[{"id":"x"}],"obstacles":[],"elevationZones":[],"mapWidth":1000,"mapHeight":1000}'::jsonb`;
    expect(run(`select seven_apply_round('play01', 1, ${end}, 42, null);`)).toBe('t');
    // A duplicate resolution changes nothing.
    expect(run(`select seven_apply_round('play01', 1, ${end}, 43, null);`)).toBe('f');
    expect(run(`select current_round, prev_seed, prev_state = initial_state, latest_state->'units'->0->>'id', guest_name from matches where id = 'play01';`)).toBe('2|42|t|x|Bea 2');
    expect(run(`select team, paths::text from turns where match_id = 'play01' order by team;`, 'authenticated', A)).toBe(
      'blue|[{"unitId": "u", "waypoints": [{"x": 1, "y": 2}]}]\nred|[]');
    expect(run(`select count(*) from match_plans where match_id = 'play01';`)).toBe('0');
  });

  it('finishes on elimination, and a finished match stays finished', () => {
    run(`select seven_create('${A}', 'fini01', 2, ${STATE}, null); select seven_join('${B}', 'fini01', null);
      select seven_submit_plan('${A}', 'fini01', 1, '[]'::jsonb, null); select seven_submit_plan('${B}', 'fini01', 1, '[]'::jsonb, null);
      select seven_apply_round('fini01', 1, ${STATE}, 1, 'red');`);
    expect(run(`select status, finish_reason, finished_at is not null from matches where id = 'fini01';`)).toBe('guest_won|battle|t');
    expect(failure(`update matches set status = 'host_won' where id = 'fini01';`)).toMatch(/stays finished/);
    expect(failure(`select seven_submit_plan('${A}', 'fini01', 2, '[]'::jsonb, null);`)).toMatch(/has finished/);
  });

  it('forfeits to the opponent and withdraws unjoined invites', () => {
    run(`select seven_create('${A}', 'forf01', 2, ${STATE}, null); select seven_join('${B}', 'forf01', null);`);
    expect(run(`select (seven_forfeit('${A}', 'forf01')).status;`)).toBe('guest_won');
    run(`select seven_create('${A}', 'forf02', 2, ${STATE}, null);`);
    expect(run(`select (seven_forfeit('${A}', 'forf02')).finish_reason;`)).toBe('cancelled');
    // Cancel never concedes a match someone joined.
    run(`select seven_create('${A}', 'canc01', 2, ${STATE}, null); select seven_join('${B}', 'canc01', null);`);
    expect(run(`select (seven_cancel('${A}', 'canc01')).status;`)).toBe('active');
    run(`select seven_forfeit('${B}', 'canc01');`);
  });

  it('pairs searchers, reuses a waiting match on retry, and caps unfinished matches', () => {
    const mm = (who: string, id: string) => run(`select (seven_matchmake('${who}', '${id}', false, 2, ${STATE}, null)).id;`);
    expect(mm(A, 'queue1')).toBe('queue1');
    expect(mm(A, 'queue2')).toBe('queue1'); // still waiting: the same match
    expect(mm(B, 'queue3')).toBe('queue1'); // paired into A's search
    expect(mm(B, 'queue4')).toBe('queue1'); // retry within two minutes, nothing planned yet
    expect(run(`select guest_player = '${B}', status from matches where id = 'queue1';`)).toBe('t|active');
    // Ranked and casual queues and other rules versions never mix.
    expect(run(`select (seven_matchmake('${C}', 'queue5', false, 3, ${STATE}, null)).id;`)).toBe('queue5');
    expect(failure(`select seven_matchmake('${C}', 'queue6', true, 2, ${STATE}, null);`)).toMatch(/Play Games profile required/);
    run(`select seven_cancel('${C}', 'queue5'); select seven_forfeit('${A}', 'queue1');`);

    const live = Number(run(`select seven_live_count('${C}', false);`));
    for (let i = live; i < 5; i++) run(`select seven_create('${C}', 'cap0${i}', 2, ${STATE}, null);`);
    expect(failure(`select seven_matchmake('${C}', 'capxx', false, 2, ${STATE}, null);`)).toMatch(/5 unfinished/);
    expect(failure(`select seven_create('${C}', 'capxy', 2, ${STATE}, null);`)).toMatch(/5 unfinished/);
    run(`select seven_forfeit('${C}', id) from matches where id like 'cap0%';`);
  });

  it('seats an AI commander only after the wait, and never in invites', () => {
    clear(B); clear(C);
    run(`select seven_matchmake('${C}', 'botq01', false, 2, ${STATE}, null);`);
    expect(run(`select (seven_seat_bot('botq01', interval '1 minute')).guest_bot;`)).toBe('f');
    expect(run(`select seven_assign_bots(interval '1 minute');`)).toBe('0');
    backdate(`created_at = now() - interval '5 minutes'`, `id = 'botq01'`);
    expect(run(`select seven_assign_bots(interval '1 minute');`)).toBe('1');
    expect(run(`select guest_bot, status, guest_name like '%(AI)' from matches where id = 'botq01';`)).toBe('t|active|t');
    run(`select seven_create('${C}', 'botq02', 2, ${STATE}, null);`);
    expect(run(`select (seven_seat_bot('botq02', interval '0')).guest_bot;`)).toBe('f');
    // Asked for by the searcher: a commander of the chosen difficulty.
    run(`select seven_matchmake('${B}', 'botq03', false, 2, ${STATE}, null);`);
    expect(run(`select (seven_seat_bot('botq03', interval '0', 'veteran')).guest_name;`)).toBe('Major Flint (AI)');
    run(`select seven_forfeit('${C}', 'botq01'); select seven_forfeit('${C}', 'botq02'); select seven_forfeit('${B}', 'botq03');`);
  });

  it('settles idle matches: the side that planned wins, otherwise nobody', () => {
    clear(A); clear(B);
    run(`select seven_create('${A}', 'idle01', 2, ${STATE}, null); select seven_join('${B}', 'idle01', null);
      select seven_submit_plan('${B}', 'idle01', 1, '[]'::jsonb, null);
      select seven_create('${A}', 'idle02', 2, ${STATE}, null); select seven_join('${B}', 'idle02', null);
      select seven_create('${A}', 'idle03', 2, ${STATE}, null);`);
    backdate(`last_move_at = now() - interval '8 days'`, `id like 'idle0%'`);
    // Submitting into an expired match settles it instead.
    expect(run(`select seven_submit_plan('${A}', 'idle02', 1, '[]'::jsonb, null)->>'expired';`)).toBe('true');
    expect(run(`select public.expire_abandoned_matches();`, 'postgres')).toBe('2');
    expect(run(`select id, status, finish_reason from matches where id like 'idle0%' order by id;`)).toBe(
      'idle01|guest_won|timeout\nidle02|abandoned|abandoned\nidle03|abandoned|abandoned');
  });

  it('rates ranked matches once, with provisional K and fixed AI ratings', () => {
    run(`select seven_ranked_profile('${A}', 'pgsA', 'Ann', null); select seven_ranked_profile('${B}', 'pgsB', 'Bea', 'https://lh3.googleusercontent.com/a/b');`);
    expect(failure(`select seven_ranked_profile('${A}', 'pgsOther', 'Ann', null);`)).toMatch(/bound to another/);
    expect(failure(`select seven_ranked_profile('${C}', 'pgsC', 'Cy', 'https://evil.example/x.png');`)).toMatch(/avatar_url/);
    expect(run(`select (seven_matchmake('${A}', 'rank01', true, 2, ${STATE}, 'ignored')).host_name;`)).toBe('Ann');
    expect(run(`select (seven_matchmake('${B}', 'rank02', true, 2, ${STATE}, null)).id;`)).toBe('rank01');
    // Invites are casual only.
    expect(failure(`select seven_join('${C}', 'rank01', null);`)).toMatch(/not found/i);

    const view = JSON.parse(run(`select seven_ranked_view('${A}', 'rank01');`));
    expect(view.stakes).toEqual({ win: 20, loss: -20 });
    expect(view.opponent).toMatchObject({ display_name: 'Bea', rating: 1200, provisional: true, bot: false });
    expect(JSON.stringify(view)).not.toContain(B);

    run(`select seven_forfeit('${B}', 'rank01');`);
    run(`select seven_finish('rank01', 'red', 'battle');`); // already over: no second rating
    expect(run(`select display_name, rating, games, wins, losses, peak_rating from ranked_profiles where player in ('${A}', '${B}') order by display_name;`)).toBe(
      'Ann|1220|1|1|0|1220\nBea|1180|1|0|1|1200');
    expect(run(`select winner, host_delta, guest_delta, reason from ranked_results where match_id = 'rank01';`)).toBe('blue|20|-20|forfeit');
    expect(JSON.parse(run(`select seven_ranked_view('${A}', 'rank01');`)).result).toMatchObject({ won: true, delta: 20, rating: 1220, rank: 1 });

    // Against an AI commander: the player's rating moves, the commander's doesn't.
    run(`select seven_matchmake('${A}', 'rank03', true, 2, ${STATE}, null);`);
    expect(run(`select (seven_seat_bot('rank03', interval '0')).guest_player;`)).toMatch(/^00000000-0000-4000-8000-000000007a0[12]$/);
    const before = run(`select rating from ranked_profiles r join matches m on m.guest_player = r.player where m.id = 'rank03';`);
    run(`select seven_forfeit('${A}', 'rank03');`);
    expect(run(`select rating from ranked_profiles r join matches m on m.guest_player = r.player where m.id = 'rank03';`)).toBe(before);
    expect(Number(run(`select rating from ranked_profiles where player = '${A}';`))).toBeLessThan(1220);
  });

  it('caps ranked AI matches at three per player', () => {
    for (let i = 0; i < 4; i++) {
      run(`select seven_matchmake('${B}', 'rbot0${i}', true, 2, ${STATE}, null);`);
      run(`select seven_seat_bot(id, interval '0') from matches where host_player = '${B}' and status = 'open' and ranked;`);
      // Planned, so the next search opens a new match rather than handing this one back.
      run(`select seven_submit_plan('${B}', id, 1, '[]'::jsonb, null) from matches where host_player = '${B}' and status = 'active' and ranked and current_round = 1
        and not exists (select 1 from match_plans p where p.match_id = matches.id and p.team = 'blue');`);
    }
    expect(run(`select count(*) from matches where ranked and guest_bot and status = 'active' and host_player = '${B}';`)).toBe('3');
    expect(run(`select count(*) from matches where ranked and status = 'open' and host_player = '${B}';`)).toBe('1');
  });

  it('serves ranked overviews and the ladder without player ids', () => {
    const overview = run(`select seven_ranked_overview('${B}');`);
    const parsed = JSON.parse(overview);
    expect(parsed.profile).toMatchObject({ display_name: 'Bea', you: true });
    expect(parsed.matches.map((m: { state: string }) => m.state).sort()).toEqual(['searching', 'their_turn', 'their_turn', 'their_turn']);
    expect(parsed.history[0]).toMatchObject({ match_id: 'rank01', won: false, delta: -20, opponent: 'Ann', reason: 'forfeit' });
    const board = run(`select seven_ranked_leaderboard('${C}');`);
    expect(JSON.parse(board).players.map((p: { display_name: string }) => p.display_name)).toEqual(['Ann', 'Bea']); // Ann's loss to an AI still leaves her above Bea
    expect(JSON.parse(board).you).toBeNull();
    for (const text of [overview, board]) for (const id of [A, B, BOT]) expect(text).not.toContain(id);
  });

  it('deletes a ranked profile: forfeits, removes its matches, keeps opponents\u2019 results', () => {
    run(`select seven_ranked_delete_profile('${B}');`);
    expect(run(`select count(*) from ranked_profiles where player = '${B}';`)).toBe('0');
    expect(run(`select count(*) from matches where ranked and '${B}' in (host_player, guest_player);`)).toBe('0');
    expect(run(`select guest_player is null, host_player = '${A}' from ranked_results where match_id = 'rank01';`)).toBe('t|t');
  });

  it('registers turn alert devices for the signed-in player only, five at most', () => {
    for (let i = 0; i < 7; i++) run(`select seven_push_register('token-${i}-xxxxxxxxxxxxxxxxxxxxxxxx');`, 'authenticated', A);
    expect(run(`select count(*) from push_devices where player = '${A}';`)).toBe('5');
    run(`select seven_push_unregister('token-6-xxxxxxxxxxxxxxxxxxxxxxxx');`, 'authenticated', A);
    expect(run(`select count(*) from push_devices where player = '${A}';`)).toBe('4');
    expect(failure(`select seven_push_register('token-x-xxxxxxxxxxxxxxxxxxxxxxxx');`, 'anon')).toMatch(/permission denied|sign-in required/);
  });
});
