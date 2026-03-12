import { createClient } from '@supabase/supabase-js';
import { SUPABASE_URL, SUPABASE_KEY, generateRoomId } from './online';
import { dlog } from './online-debug';

const SEEK_STALE_MS = 10_000;
const MATCH_TIMEOUT_MS = 60_000;

interface SeekMessage {
  type: 'seek';
  playerId: string;
  ts: number;
}

interface MatchMessage {
  type: 'match';
  hostId: string;
  guestId: string;
  roomId: string;
}

interface LeaveMessage {
  type: 'leave';
  playerId: string;
}

type LobbyMessage = SeekMessage | MatchMessage | LeaveMessage;

interface MatchResult {
  role: 'host' | 'guest';
  roomId: string;
}

/** Search for a random opponent via Supabase Realtime broadcast.
 *  Returns the role and roomId once matched. Throws on cancel or timeout. */
export function findMatch(): { promise: Promise<MatchResult>; cancel: () => void } {
  // Use a per-session random ID, not the persistent localStorage player ID.
  // localStorage is shared across tabs, so two tabs on the same device would
  // have identical IDs and silently filter each other's seek messages.
  const seekerId = crypto.randomUUID();
  const client = createClient(SUPABASE_URL, SUPABASE_KEY);
  const channel = client.channel('matchmaking-lobby', { config: { broadcast: { self: false } } });

  let resolved = false;
  let seekInterval: ReturnType<typeof setInterval> | null = null;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let rejectPromise: ((reason: Error) => void) | null = null;

  const cleanup = () => {
    resolved = true;
    if (seekInterval) { clearInterval(seekInterval); seekInterval = null; }
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    channel.send({ type: 'broadcast', event: 'lobby', payload: { type: 'leave', playerId: seekerId } as LeaveMessage });
    client.removeChannel(channel);
  };

  const promise = new Promise<MatchResult>((resolve, reject) => {
    rejectPromise = reject;
    const activeSeekers = new Map<string, number>(); // playerId → timestamp

    const tryMatch = (opponentId: string) => {
      if (resolved) return;
      // Deterministic: lower playerId is host
      const iAmHost = seekerId < opponentId;
      if (iAmHost) {
        const roomId = generateRoomId();
        dlog(`matchmaking: I am host, matched with ${opponentId.slice(0, 8)}`);
        channel.send({
          type: 'broadcast',
          event: 'lobby',
          payload: { type: 'match', hostId: seekerId, guestId: opponentId, roomId } as MatchMessage,
        });
        cleanup();
        resolve({ role: 'host', roomId });
      }
      // If opponent has lower ID, they will send the match message — we wait
    };

    channel.on('broadcast', { event: 'lobby' }, ({ payload }) => {
      if (resolved) return;
      const msg = payload as LobbyMessage;

      if (msg.type === 'seek') {
        if (msg.playerId === seekerId) return;
        if (Date.now() - msg.ts > SEEK_STALE_MS) return;
        activeSeekers.set(msg.playerId, msg.ts);
        dlog(`matchmaking: saw seeker ${msg.playerId.slice(0, 8)}`);
        tryMatch(msg.playerId);
      } else if (msg.type === 'match') {
        if (msg.guestId === seekerId) {
          dlog(`matchmaking: matched as guest, room=${msg.roomId}`);
          cleanup();
          resolve({ role: 'guest', roomId: msg.roomId });
        }
      } else if (msg.type === 'leave') {
        activeSeekers.delete(msg.playerId);
      }
    });

    channel.subscribe((status) => {
      if (status === 'SUBSCRIBED') {
        dlog('matchmaking: joined lobby');
        // Broadcast seek immediately and then every 3s
        const sendSeek = () => {
          if (resolved) return;
          channel.send({
            type: 'broadcast',
            event: 'lobby',
            payload: { type: 'seek', playerId: seekerId, ts: Date.now() } as SeekMessage,
          });
        };
        sendSeek();
        seekInterval = setInterval(sendSeek, 3_000);
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (!resolved) {
          cleanup();
          reject(new Error(`Matchmaking channel failed: ${status}`));
        }
      }
    });

    timeoutTimer = setTimeout(() => {
      timeoutTimer = null;
      if (!resolved) {
        cleanup();
        reject(new Error('No opponent found'));
      }
    }, MATCH_TIMEOUT_MS);
  });

  const cancel = () => {
    if (!resolved) {
      cleanup();
      rejectPromise?.(new Error('Matchmaking cancelled'));
    }
  };

  return { promise, cancel };
}
