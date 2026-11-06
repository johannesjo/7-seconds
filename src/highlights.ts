// Battle highlights: who did what, for the multi-kill callouts, the
// between-rounds card and the result screen. Purely a record of hits the
// simulation already produced; nothing here feeds back into the rules.
import type { Team, UnitType } from './types';

/** Kills by one team this close together (simulation seconds) chain into a
 *  multi-kill. */
export const MULTI_KILL_WINDOW_S = 0.8;

export interface UnitTally {
  id: string;
  type: UnitType;
  team: Team;
  kills: number;
  damage: number;
  flanks: number;
}

export interface TeamTally {
  kills: number;
  damage: number;
  flanks: number;
  shieldBreaks: number;
  /** Most kills in one multi-kill chain. */
  bestStreak: number;
}

export interface Tally {
  units: Map<string, UnitTally>;
  teams: Record<Team, TeamTally>;
}

/** The unit a hit is credited to. */
export interface HitSource {
  id: string;
  type: UnitType;
  team: Team;
}

export interface TallyHit {
  /** The team that dealt the hit. */
  team: Team;
  source?: HitSource;
  /** HP the target actually lost. */
  damage: number;
  killed: boolean;
  flanked: boolean;
}

function emptyTeam(): TeamTally {
  return { kills: 0, damage: 0, flanks: 0, shieldBreaks: 0, bestStreak: 0 };
}

export function createTally(): Tally {
  return { units: new Map(), teams: { blue: emptyTeam(), red: emptyTeam() } };
}

function addHit(tally: Tally, hit: TallyHit, streak: number): void {
  const team = tally.teams[hit.team];
  team.damage += hit.damage;
  if (hit.flanked) team.flanks++;
  if (hit.killed) team.kills++;
  team.bestStreak = Math.max(team.bestStreak, streak);
  const src = hit.source;
  if (!src) return;
  let unit = tally.units.get(src.id);
  if (!unit) {
    unit = { id: src.id, type: src.type, team: src.team, kills: 0, damage: 0, flanks: 0 };
    tally.units.set(src.id, unit);
  }
  unit.damage += hit.damage;
  if (hit.flanked) unit.flanks++;
  if (hit.killed) unit.kills++;
}

/** Add `from` into `into` (e.g. a finished Horde wave into the whole run). */
export function mergeTally(into: Tally, from: Tally): void {
  for (const team of ['blue', 'red'] as const) {
    const a = into.teams[team];
    const b = from.teams[team];
    a.kills += b.kills;
    a.damage += b.damage;
    a.flanks += b.flanks;
    a.shieldBreaks += b.shieldBreaks;
    a.bestStreak = Math.max(a.bestStreak, b.bestStreak);
  }
  for (const u of from.units.values()) {
    const prev = into.units.get(u.id);
    if (!prev) {
      into.units.set(u.id, { ...u });
      continue;
    }
    prev.kills += u.kills;
    prev.damage += u.damage;
    prev.flanks += u.flanks;
  }
}

/** Tallies the current round and the whole battle, and tracks multi-kills. */
export class HighlightTracker {
  round = createTally();
  readonly battle = createTally();
  private streaks: Record<Team, { count: number; last: number }> = {
    blue: { count: 0, last: -Infinity },
    red: { count: 0, last: -Infinity },
  };

  startRound(): void {
    this.round = createTally();
    this.streaks.blue = { count: 0, last: -Infinity };
    this.streaks.red = { count: 0, last: -Infinity };
  }

  /** Record a hit at simulation time `time`. Returns the length of the kill
   *  chain this hit extends (1 for a lone kill, 0 for a non-kill). */
  recordHit(hit: TallyHit, time: number): number {
    let streak = 0;
    if (hit.killed) {
      const s = this.streaks[hit.team];
      s.count = time - s.last <= MULTI_KILL_WINDOW_S ? s.count + 1 : 1;
      s.last = time;
      streak = s.count;
    }
    addHit(this.round, hit, streak);
    addHit(this.battle, hit, streak);
    return streak;
  }

  recordShieldBreak(team: Team): void {
    this.round.teams[team].shieldBreaks++;
    this.battle.teams[team].shieldBreaks++;
  }
}

/** "Double kill" for 2, up to "Rampage" for 5 or more; null below 2. */
export function multiKillLabel(count: number): string | null {
  if (count < 2) return null;
  return ['Double kill', 'Triple kill', 'Quad kill'][count - 2] ?? 'Rampage';
}

/** The unit with the most kills (damage breaks ties), on `team` or on either
 *  side when null. Null when nobody has a kill. */
export function findMvp(tally: Tally, team: Team | null): UnitTally | null {
  let best: UnitTally | null = null;
  for (const u of tally.units.values()) {
    if (team && u.team !== team) continue;
    if (u.kills === 0) continue;
    if (!best || u.kills > best.kills || (u.kills === best.kills && u.damage > best.damage)) best = u;
  }
  return best;
}

/** Display name for a unit type: "Sniper". */
export function unitName(type: UnitType): string {
  return `${type[0].toUpperCase()}${type.slice(1)}`;
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function mvpName(u: UnitTally, teamLabel: boolean): string {
  const name = unitName(u.type);
  return teamLabel ? `${u.team === 'blue' ? 'Blue' : 'Red'} ${name.toLowerCase()}` : name;
}

/** Up to two short highlights of a round for the between-rounds card, seen
 *  from `team` (vs the computer), or from both sides when null (two humans). */
export function roundHighlights(tally: Tally, team: Team | null, multiKillMin = 2): string[] {
  const out: string[] = [];
  const teams: Team[] = team ? [team] : ['blue', 'red'];
  const name = (t: Team) => (team ? '' : `${t === 'blue' ? 'Blue' : 'Red'}: `);

  const streakTeam = teams.reduce((a, b) => (tally.teams[b].bestStreak > tally.teams[a].bestStreak ? b : a));
  const label = tally.teams[streakTeam].bestStreak >= multiKillMin ? multiKillLabel(tally.teams[streakTeam].bestStreak) : null;
  if (label) out.push(`${name(streakTeam)}${label}!`);

  const mvp = findMvp(tally, team);
  if (mvp && mvp.kills >= 2) out.push(`MVP: ${mvpName(mvp, !team)}, ${plural(mvp.kills, 'kill')}`);

  if (out.length < 2) {
    const flankTeam = teams.reduce((a, b) => (tally.teams[b].flanks > tally.teams[a].flanks ? b : a));
    const flanks = tally.teams[flankTeam].flanks;
    if (flanks >= 2) out.push(`${name(flankTeam)}${plural(flanks, 'flank hit')}`);
  }
  return out.slice(0, 2);
}

/** Highlight lines for the result screen, seen from `team`, or from both
 *  sides when null. A chain shorter than `multiKillMin` isn't a highlight
 *  (Horde never calls out a mere double). */
export function battleHighlights(tally: Tally, team: Team | null, multiKillMin = 2): string[] {
  const lines: string[] = [];
  const mvp = findMvp(tally, team);
  if (mvp) {
    const parts = [plural(mvp.kills, 'kill'), `${Math.round(mvp.damage)} damage`];
    if (mvp.flanks > 0) parts.push(plural(mvp.flanks, 'flank hit'));
    lines.push(`MVP: ${mvpName(mvp, !team)} · ${parts.join(' · ')}`);
  }

  const teams: Team[] = team ? [team] : ['blue', 'red'];
  const perTeam = (pick: (t: TeamTally) => number, label: string): void => {
    const values = teams.map(t => pick(tally.teams[t]));
    if (values.every(v => v === 0)) return;
    lines.push(team ? `${label}: ${values[0]}` : `${label}: Blue ${values[0]} · Red ${values[1]}`);
  };
  perTeam(t => t.flanks, 'Flank hits');
  perTeam(t => t.shieldBreaks, 'Shields broken');

  const best = Math.max(...teams.map(t => tally.teams[t].bestStreak));
  const label = best >= multiKillMin ? multiKillLabel(best) : null;
  if (label) {
    const who = team ? '' : ` (${teams.filter(t => tally.teams[t].bestStreak === best).map(t => (t === 'blue' ? 'Blue' : 'Red')).join(', ')})`;
    lines.push(`Best moment: ${label}${who}`);
  }
  return lines;
}
