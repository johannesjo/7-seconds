// A scratch PostgreSQL database with the migrations applied, for integration
// tests. Set SEVEN_PG_URL to any PostgreSQL 16 server you can create
// databases on, e.g. postgresql://postgres@localhost:5432/postgres. Needs psql.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';

export const PG_URL = process.env.SEVEN_PG_URL;
const MIGRATIONS = 'supabase/migrations';

export type Role = 'service_role' | 'authenticated' | 'anon' | 'postgres';

export interface TestDatabase {
  /** Run `sql` as `role`, signed in as `uid` (auth.uid()), in one transaction. Returns psql's output. */
  run(sql: string, role?: Role, uid?: string): string;
  /** The error `sql` fails with (throws if it succeeds). */
  failure(sql: string, role?: Role, uid?: string): string;
  drop(): void;
}

function psql(url: string, sql: string): string {
  return execFileSync('psql', [url, '-v', 'ON_ERROR_STOP=1', '-v', 'VERBOSITY=verbose', '-X', '-q', '-At', '-1'],
    { input: sql, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function admin(command: string): void {
  execFileSync('psql', [PG_URL!, '-X', '-q', '-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
}

/** Create `name` fresh: Supabase stand-ins, then every migration. `beforeVersion`
 *  runs (as postgres) just before migration `version`, to seed older data. */
export function createTestDatabase(name: string, seed?: { version: string; sql: string }): TestDatabase {
  const url = new URL(PG_URL!);
  url.pathname = `/${name}`;
  const dbUrl = url.toString();
  admin(`drop database if exists ${name}`);
  admin(`create database ${name}`);
  psql(dbUrl, readFileSync('supabase/tests/supabase-stub.sql', 'utf8'));
  for (const file of readdirSync(MIGRATIONS).filter(f => /^\d+_.*\.sql$/.test(f)).sort()) {
    if (seed && file.startsWith(seed.version)) psql(dbUrl, seed.sql);
    psql(dbUrl, readFileSync(`${MIGRATIONS}/${file}`, 'utf8'));
  }
  const run = (sql: string, role: Role = 'service_role', uid?: string) => {
    const prelude = role === 'postgres' ? '' : `set local role ${role};\n`;
    const claims = uid ? `select set_config('request.jwt.claim.sub', '${uid}', true) \\gset\n` : '';
    return psql(dbUrl, `${prelude}${claims}${sql}`);
  };
  return {
    run,
    failure(sql, role = 'service_role', uid) {
      try { run(sql, role, uid); } catch (error) { return String((error as { stderr?: string }).stderr ?? error); }
      throw new Error(`expected failure: ${sql}`);
    },
    drop() { admin(`drop database if exists ${name}`); },
  };
}
