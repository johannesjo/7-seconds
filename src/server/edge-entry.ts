// The match referee's entry point for the Edge Function. scripts/build-referee.mjs
// bundles everything reachable from here into supabase/functions/match-referee/referee.mjs,
// so the server runs the exact engine and rules the clients run. Must stay
// DOM-free: importing it never pulls in pixi or the renderer.
export { handleReferee, StoreError, type RefereeStore, type RefereeDeps, type MatchRow, type User } from './referee';
export { verifyPlayGames, PlayGamesError, type PlayGamesConfig } from './play-games';
export { alertText, fcmMessage, webPushPayload, alertUrl, type Alert } from './alerts';
export { RULES_VERSION } from '../online-plan';
// For the bundle's own test: the engine pieces it must reproduce exactly.
export { GameEngine } from '../game';
export { planBotPaths } from '../bot';
