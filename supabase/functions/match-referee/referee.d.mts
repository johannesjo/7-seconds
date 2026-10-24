// Types for the generated referee.mjs, covering what index.ts uses. The real
// definitions live in src/server/ (referee.ts, alerts.ts, play-games.ts);
// src/server/edge-bundle.test.ts checks the bundle exports match.
export const RULES_VERSION: number;

export interface Alert {
  player: string; match: string; kind: 'joined' | 'turn' | 'round' | 'result' | 'forfeit';
  ranked: boolean; opponent: string | null; round: number; won?: boolean;
}
export interface MatchRow { id: string; [key: string]: unknown }
export interface RefereeStore {
  rpc<T>(fn: string, args: Record<string, unknown>): Promise<T>;
  match(id: string): Promise<MatchRow | null>;
  plans(id: string, round: number): Promise<{ team: 'blue' | 'red'; paths: unknown }[]>;
  bot(player: string): Promise<{ difficulty: 'recruit' | 'veteran' } | null>;
}
export interface RefereeDeps {
  store: RefereeStore;
  random(): number;
  notify(alert: Alert): void;
  background(task: () => Promise<unknown>): void;
  playGames?: (code: unknown) => Promise<{ id: string; name: string; avatar: string | null }>;
}
export interface PlayGamesConfig { webClientId: string; webClientSecret: string; appId: string }

export function handleReferee(user: { id: string; google: boolean } | null, body: unknown, deps: RefereeDeps): Promise<{ status: number; body: unknown }>;
export class StoreError extends Error { constructor(message: string, code?: string); readonly code?: string }
export function verifyPlayGames(code: unknown, config: PlayGamesConfig, fetchFn?: typeof fetch): Promise<{ id: string; name: string; avatar: string | null }>;
export function alertText(alert: Alert): { title: string; body: string };
export function webPushPayload(appUrl: string, alert: Alert): string;
export function fcmMessage(alert: Alert, token: string): Record<string, unknown>;
