// Apply supabase/migrations/*.sql that the target database hasn't run yet, in
// order, each in a single transaction together with its history row. Usage:
//   SUPABASE_DB_URL=postgresql://… node scripts/apply-migrations.mjs [--dry-run]
//
// Why not `supabase db push`: the project is shared with Imperial Battleground,
// whose migrations the CLI would see as unknown remote versions, and 0001–0003
// were applied by hand before any history existed. This runner keeps its own
// history in a schema the Data API doesn't expose (seven_private), and treats a
// changed file that was already applied as an error: applied migrations are
// immutable, so add a new one instead. Needs psql; uses Node built-ins only.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

// Report failures as one clear line (and a failing exit code), not a stack trace.
process.on('uncaughtException', error => {
  console.error(`Migration run failed: ${error instanceof Error ? error.message : error}`);
  process.exit(1);
});

const dryRun = process.argv.includes('--dry-run');
const dir = 'supabase/migrations';

// The URL goes to psql through libpq environment variables, so its password never appears in argv.
function connectionEnv() {
  const raw = process.env.SUPABASE_DB_URL;
  if (!raw) throw new Error('Set SUPABASE_DB_URL to the database connection string');
  const url = new URL(raw);
  if (!/^postgres(ql)?:$/.test(url.protocol)) throw new Error('SUPABASE_DB_URL must be a postgresql:// URL');
  const env = {
    // A Unix socket directory may come as ?host=/path (as libpq allows).
    PGHOST: url.searchParams.get('host') || decodeURIComponent(url.hostname),
    PGPORT: url.port || '5432',
    PGUSER: decodeURIComponent(url.username),
    PGPASSWORD: decodeURIComponent(url.password),
    PGDATABASE: decodeURIComponent(url.pathname.slice(1)) || 'postgres',
  };
  const sslmode = url.searchParams.get('sslmode');
  if (sslmode) env.PGSSLMODE = sslmode;
  return env;
}
const pgEnv = { ...process.env, ...connectionEnv() };
delete pgEnv.SUPABASE_DB_URL;

function psql(sql, singleTransaction = false) {
  const args = ['-v', 'ON_ERROR_STOP=1', '-X', '-q', '-At', ...(singleTransaction ? ['-1'] : [])];
  const result = spawnSync('psql', args, { input: sql, encoding: 'utf8', env: pgEnv });
  if (result.error) throw result.error;
  if (result.status) throw new Error(result.stderr.trim() || `psql exited with ${result.status}`);
  return result.stdout.trim();
}
const literal = text => `'${text.replaceAll("'", "''")}'`;

// Migrations applied by hand before this runner's history existed, recognised
// by an object each one creates. Recorded only when the history is first created.
const BASELINE = {
  '0001': `to_regclass('public.matches') is not null`,
  '0002': `to_regclass('public.players') is not null`,
  '0003': `exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'matches' and column_name = 'last_move_at')`,
};

// Each file runs inside one transaction with `psql -1`; these would escape or bend that.
function checkMigration(file, sql) {
  if (/^\s*\\/m.test(sql)) throw new Error(`${file}: psql meta-commands (lines starting with \\) are not allowed`);
  if (/^\s*(begin|commit|rollback|start\s+transaction)\b\s*;/im.test(sql)) {
    throw new Error(`${file}: transaction control is not allowed; each migration already runs in one transaction`);
  }
}

const files = readdirSync(dir).filter(f => /^\d+_[\w-]+\.sql$/.test(f)).sort();
const versions = files.map(f => f.split('_')[0]);
const duplicate = versions.find((v, i) => versions.indexOf(v) !== i);
if (duplicate) throw new Error(`Two migrations share version ${duplicate}`);

const applied = new Map();
if (psql(`select to_regclass('seven_private.schema_migrations') is not null;`) === 't') {
  for (const row of psql(`select version, coalesce(checksum, '') from seven_private.schema_migrations;`).split('\n').filter(Boolean)) {
    const [version, checksum] = row.split('|');
    applied.set(version, checksum || null);
  }
} else {
  const known = psql(`select ${Object.entries(BASELINE).map(([v, check]) => `case when ${check} then ${literal(v)} end`).join(', ')};`);
  const baseline = known.split('|').filter(Boolean);
  console.log(`No migration history yet; ${dryRun ? 'would record' : 'recording'} as already applied: ${baseline.length ? baseline.join(', ') : 'none (fresh database)'}`);
  for (const version of baseline) applied.set(version, null);
  if (!dryRun) {
    psql(`create schema if not exists seven_private;
      revoke all on schema seven_private from public;
      create table seven_private.schema_migrations (version text primary key, checksum text, applied_at timestamptz not null default now());
      ${baseline.map(v => `insert into seven_private.schema_migrations(version) values (${literal(v)});`).join('\n')}`, true);
  }
}

let pending = 0;
for (const file of files) {
  const version = file.split('_')[0];
  const sql = readFileSync(`${dir}/${file}`, 'utf8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  if (applied.has(version)) {
    const recorded = applied.get(version);
    if (recorded && recorded !== checksum) throw new Error(`${file} changed after it was applied; add a new migration instead`);
    console.log(`= ${file} (already applied)`);
    continue;
  }
  checkMigration(file, sql);
  pending++;
  if (dryRun) { console.log(`+ ${file} (pending)`); continue; }
  console.log(`+ ${file}`);
  // The history row goes in first: a concurrent run blocks on the lock, then fails on the primary key.
  try {
    psql(`select pg_advisory_xact_lock(hashtext('seven_private.schema_migrations'));
      insert into seven_private.schema_migrations(version, checksum) values (${literal(version)}, ${literal(checksum)});
      ${sql}`, true);
  } catch (error) {
    throw new Error(`${file} failed and was rolled back: ${error instanceof Error ? error.message : error}`);
  }
}
console.log(pending ? `${dryRun ? 'Pending' : 'Applied'}: ${pending} migration(s)` : 'Database is up to date');
