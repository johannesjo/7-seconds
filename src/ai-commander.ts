import { CreateMLCEngine, MLCEngine } from '@mlc-ai/web-llm';
import { Unit, Team, Obstacle, AiResponse, AiUnitOrder } from './types';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';

const MODEL_ID = 'SmolLM2-360M-Instruct-q4f32_1-MLC';

const SYSTEM_PROMPT = `RTS game. Map: ${MAP_WIDTH}x${MAP_HEIGHT}px. You control {side} team.
Units have id, pos [x,y], hp. You MUST give an order for EVERY alive unit. Strategy: {userPrompt}
Reply ONLY with JSON: {"orders":[{"id":"unit_id","move_to":[x,y],"attack":"enemy_id_or_null"}]}`;

// --- Shared WebLLM engine singleton ---

let sharedEngine: MLCEngine | null = null;
let engineReady = false;
let engineLoading = false;
let onProgress: ((progress: { text: string; progress: number }) => void) | null = null;

export function setProgressCallback(cb: (progress: { text: string; progress: number }) => void): void {
  onProgress = cb;
}

async function getEngine(): Promise<MLCEngine | null> {
  if (engineReady && sharedEngine) return sharedEngine;
  if (engineLoading) return null; // loading in progress, caller should wait

  engineLoading = true;
  try {
    sharedEngine = await CreateMLCEngine(MODEL_ID, {
      initProgressCallback: (progress) => {
        onProgress?.({ text: progress.text, progress: progress.progress });
      },
    });
    engineReady = true;
    return sharedEngine;
  } catch (err) {
    console.warn('WebLLM init failed:', err);
    sharedEngine = null;
    return null;
  } finally {
    engineLoading = false;
  }
}

// --- Pure functions (unchanged, used by tests) ---

/** Serialize game state to JSON for a given team's perspective. */
export function serializeState(units: Unit[], obstacles: Obstacle[], forTeam: Team): string {
  const myUnits = units.filter(u => u.alive && u.team === forTeam);
  const enemyUnits = units.filter(u => u.alive && u.team !== forTeam);

  return JSON.stringify({
    map: { width: MAP_WIDTH, height: MAP_HEIGHT },
    // obstacles disabled: obstacles.map(o => ({ x: o.x, y: o.y, w: o.w, h: o.h })),
    my_units: myUnits.map(u => ({
      id: u.id, type: u.type, pos: [Math.round(u.pos.x), Math.round(u.pos.y)], hp: u.hp, max_hp: u.maxHp,
    })),
    enemy_units: enemyUnits.map(u => ({
      id: u.id, type: u.type, pos: [Math.round(u.pos.x), Math.round(u.pos.y)], hp: u.hp, max_hp: u.maxHp,
    })),
  });
}

/** Parse raw AI response text into a validated AiResponse, or null if invalid. */
export function parseAiResponse(raw: string): AiResponse | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
    const parsed = JSON.parse(cleaned);

    if (!parsed.orders || !Array.isArray(parsed.orders)) return null;

    const validOrders: AiUnitOrder[] = parsed.orders.filter(
      (o: Record<string, unknown>) =>
        typeof o.id === 'string' &&
        Array.isArray(o.move_to) &&
        o.move_to.length === 2 &&
        typeof o.move_to[0] === 'number' &&
        typeof o.move_to[1] === 'number',
    ).map((o: Record<string, unknown>) => ({
      id: o.id as string,
      move_to: o.move_to as [number, number],
      attack: typeof o.attack === 'string' ? o.attack : null,
    }));

    if (validOrders.length === 0) return null;

    return { orders: validOrders };
  } catch {
    return null;
  }
}

/** Generate simple fallback orders when AI is unavailable. */
export function fallbackOrders(units: Unit[], team: Team): AiResponse {
  const myUnits = units.filter(u => u.alive && u.team === team);
  const enemyUnits = units.filter(u => u.alive && u.team !== team);

  return {
    orders: myUnits.map(u => {
      const targetX = team === 'blue' ? MAP_WIDTH * 0.7 : MAP_WIDTH * 0.3;
      const nearestEnemy = enemyUnits.length > 0
        ? enemyUnits.reduce((nearest, e) => {
            const dCurr = Math.hypot(u.pos.x - nearest.pos.x, u.pos.y - nearest.pos.y);
            const dNew = Math.hypot(u.pos.x - e.pos.x, u.pos.y - e.pos.y);
            return dNew < dCurr ? e : nearest;
          })
        : null;

      return {
        id: u.id,
        move_to: nearestEnemy
          ? [Math.round(nearestEnemy.pos.x), Math.round(nearestEnemy.pos.y)] as [number, number]
          : [targetX, u.pos.y] as [number, number],
        attack: nearestEnemy?.id ?? null,
      };
    }),
  };
}

/** Fill in orders for any alive units the AI didn't include. */
function backfillOrders(aiResponse: AiResponse, units: Unit[], team: Team): AiResponse {
  const myUnits = units.filter(u => u.alive && u.team === team);
  const orderedIds = new Set(aiResponse.orders.map(o => o.id));
  const missing = myUnits.filter(u => !orderedIds.has(u.id));

  if (missing.length === 0) return aiResponse;

  const fb = fallbackOrders(units, team);
  const missingOrders = fb.orders.filter(o => !orderedIds.has(o.id));

  return { orders: [...aiResponse.orders, ...missingOrders] };
}

// --- AiCommander class ---

/** Uses WebLLM (primary) or Chrome AI (fallback) to issue orders each tick. */
export class AiCommander {
  private engine: MLCEngine | null = null;
  private team: Team;
  private userPrompt: string;
  private systemPrompt = '';

  constructor(team: Team, userPrompt: string) {
    this.team = team;
    this.userPrompt = userPrompt;
  }

  async init(): Promise<boolean> {
    // Build system prompt (needed for both backends)
    const side = this.team === 'blue' ? 'LEFT' : 'RIGHT';
    this.systemPrompt = SYSTEM_PROMPT
      .replace('{side}', side)
      .replace('{userPrompt}', this.userPrompt);

    // Try WebLLM first
    const engine = await getEngine();
    if (engine) {
      this.engine = engine;
      console.log(`[${this.team}] WebLLM engine ready`);
      return true;
    }

    console.warn(`[${this.team}] WebLLM unavailable, using fallback`);
    return false;
  }

  async getOrders(units: Unit[], obstacles: Obstacle[]): Promise<AiResponse> {
    if (!this.engine) {
      throw new Error(`[${this.team}] AI engine not initialized`);
    }

    const stateJson = serializeState(units, obstacles, this.team);

    const response = await this.engine.chat.completions.create({
      messages: [
        { role: 'system', content: this.systemPrompt },
        { role: 'user', content: stateJson },
      ],
      max_tokens: 512,
    });

    const raw = response.choices[0].message.content ?? '';
    console.log(`[${this.team}] AI responded:`, raw.substring(0, 200));

    const parsed = parseAiResponse(raw);
    if (!parsed) {
      console.warn(`[${this.team}] Failed to parse AI response, skipping`);
      return { orders: [] };
    }

    return backfillOrders(parsed, units, this.team);
  }

  destroy(): void {
    // Shared engine persists — don't destroy it
    this.engine = null;
  }
}
