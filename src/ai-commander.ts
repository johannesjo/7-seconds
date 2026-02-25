import { Unit, Team, Obstacle, AiResponse, AiUnitOrder } from './types';
import { MAP_WIDTH, MAP_HEIGHT } from './constants';

const SYSTEM_PROMPT = `You are an AI commander in a real-time strategy battle game.

MAP: ${MAP_WIDTH}x${MAP_HEIGHT} pixels. (0,0) is top-left.
Your team spawns on the {side} side.

UNIT TYPES:
- scout: very fast (180 px/s), 30 HP, 5 damage/s, melee
- soldier: medium speed (120 px/s), 60 HP, 10 damage/s, 80px range
- tank: slow (60 px/s), 120 HP, 20 damage/s, melee

You receive the game state as JSON and MUST respond with a JSON object containing orders for each of your alive units.

Response format:
{"orders":[{"id":"unit_id","move_to":[x,y],"attack":"enemy_id_or_null"}]}

YOUR COMMANDER'S STRATEGY:
{userPrompt}

Follow your commander's strategy. Be tactical. Respond ONLY with valid JSON.`;

const ORDER_SCHEMA = {
  type: 'object',
  properties: {
    orders: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          move_to: { type: 'array', items: { type: 'number' }, minItems: 2, maxItems: 2 },
          attack: { type: ['string', 'null'] },
        },
        required: ['id', 'move_to'],
      },
    },
  },
  required: ['orders'],
};

/** Serialize game state to JSON for a given team's perspective. */
export function serializeState(units: Unit[], obstacles: Obstacle[], forTeam: Team): string {
  const myUnits = units.filter(u => u.alive && u.team === forTeam);
  const enemyUnits = units.filter(u => u.alive && u.team !== forTeam);

  return JSON.stringify({
    map: { width: MAP_WIDTH, height: MAP_HEIGHT },
    obstacles: obstacles.map(o => ({ x: o.x, y: o.y, w: o.w, h: o.h })),
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

/** Wraps the Chrome Prompt API to issue orders each tick. Falls back to simple behavior. */
export class AiCommander {
  private session: LanguageModelSession | null = null;
  private team: Team;
  private userPrompt: string;

  constructor(team: Team, userPrompt: string) {
    this.team = team;
    this.userPrompt = userPrompt;
  }

  async init(): Promise<boolean> {
    try {
      if (typeof LanguageModel === 'undefined') {
        console.warn('LanguageModel API not available');
        return false;
      }

      const availability = await LanguageModel.availability();
      if (availability === 'unavailable') {
        console.warn('Language model unavailable');
        return false;
      }

      const side = this.team === 'blue' ? 'LEFT' : 'RIGHT';
      const systemContent = SYSTEM_PROMPT
        .replace('{side}', side)
        .replace('{userPrompt}', this.userPrompt);

      this.session = await LanguageModel.create({
        initialPrompts: [
          { role: 'system', content: systemContent },
        ],
      });

      return true;
    } catch (err) {
      console.warn('Failed to create AI session:', err);
      return false;
    }
  }

  async getOrders(units: Unit[], obstacles: Obstacle[]): Promise<AiResponse> {
    if (!this.session) {
      return fallbackOrders(units, this.team);
    }

    try {
      const stateJson = serializeState(units, obstacles, this.team);
      const raw = await this.session.prompt(stateJson, {
        responseConstraint: ORDER_SCHEMA,
      });
      const parsed = parseAiResponse(raw);
      return parsed ?? fallbackOrders(units, this.team);
    } catch (err) {
      console.warn('AI prompt failed:', err);
      return fallbackOrders(units, this.team);
    }
  }

  destroy(): void {
    this.session?.destroy();
    this.session = null;
  }
}
