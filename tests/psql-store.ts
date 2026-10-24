// A RefereeStore over psql, for tests: the same named-argument function calls
// the Edge Function makes through PostgREST, against a TestDatabase.
import type { RefereeStore, MatchRow, Team } from '../src/server/referee';
import { StoreError } from '../src/server/referee';
import type { PathList } from '../src/online-plan';
import type { BotDifficulty } from '../src/bot';
import type { TestDatabase } from './pg';

const literal = (text: string) => `'${text.replaceAll("'", "''")}'`;

export class PsqlStore implements RefereeStore {
  private readonly signatures = new Map<string, { name: string; type: string }[]>();
  /** Every function called, in order. */
  readonly calls: string[] = [];

  constructor(private readonly db: TestDatabase) {}

  private query(sql: string): string {
    try {
      return this.db.run(sql);
    } catch (error) {
      const stderr = String((error as { stderr?: string }).stderr ?? error);
      const found = stderr.match(/ERROR:\s+([0-9A-Z]{5}):\s+(.*)/);
      throw new StoreError(found ? found[2].trim() : stderr, found?.[1]);
    }
  }

  private signature(fn: string): { name: string; type: string }[] {
    let args = this.signatures.get(fn);
    if (!args) {
      const row = this.db.run(`select json_build_object('names', proargnames, 'types', array(select format_type(t, null) from unnest(proargtypes) t))
        from pg_proc where proname = ${literal(fn)} and pronamespace = 'public'::regnamespace;`, 'postgres');
      if (!row) throw new Error(`No function ${fn}`);
      const { names, types } = JSON.parse(row) as { names: string[]; types: string[] };
      args = names.map((name, i) => ({ name, type: types[i] }));
      this.signatures.set(fn, args);
    }
    return args;
  }

  async rpc<T>(fn: string, args: Record<string, unknown>): Promise<T> {
    this.calls.push(fn);
    const known = this.signature(fn);
    const params = Object.keys(args).map(key => {
      const arg = known.find(a => a.name === key);
      if (!arg) throw new StoreError(`Could not find the function public.${fn} with parameter ${key}`, 'PGRST202');
      const value = args[key];
      const json = value === null || value === undefined ? 'null' : arg.type === 'jsonb' ? JSON.stringify(value) : null;
      if (arg.type === 'jsonb') return `${key} => ${literal(json!)}::jsonb`;
      if (value === null || value === undefined) return `${key} => null::${arg.type}`;
      return `${key} => ${literal(String(value))}::${arg.type}`;
    });
    const out = this.query(`select to_jsonb(public.${fn}(${params.join(', ')}));`);
    return (out === '' ? null : JSON.parse(out)) as T;
  }

  async match(id: string): Promise<MatchRow | null> {
    const out = this.query(`select to_jsonb(m) from matches m where id = ${literal(id)};`);
    return out ? JSON.parse(out) : null;
  }

  async plans(id: string, round: number): Promise<{ team: Team; paths: PathList }[]> {
    const out = this.query(`select coalesce(json_agg(json_build_object('team', team, 'paths', paths) order by team), '[]') from match_plans
      where match_id = ${literal(id)} and round = ${round};`);
    return JSON.parse(out);
  }

  async bot(player: string): Promise<{ difficulty: BotDifficulty } | null> {
    const out = this.query(`select to_jsonb(b) from (select difficulty from match_bots where player = ${literal(player)}) b;`);
    return out ? JSON.parse(out) : null;
  }
}
