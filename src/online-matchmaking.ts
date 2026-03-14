import { getSupabaseClient, generateRoomId } from './online';
import { dlog } from './online-debug';

const MATCH_TIMEOUT_MS = 60_000;
/** Keep matchmaking channel alive after host resolves so guest receives presence update. */
const HOST_LINGER_MS = 5_000;

interface MatchResult {
  role: 'host' | 'guest';
  roomId: string;
}

/** Search for a random opponent via Supabase Realtime Presence.
 *  Uses Presence (server-tracked state sync) instead of broadcast for reliable
 *  peer discovery — broadcast alone can fail on some mobile networks.
 *  Returns the role and roomId once matched. Throws on cancel or timeout. */
export function findMatch(): { promise: Promise<MatchResult>; cancel: () => void } {
  // Per-session random ID — not the persistent localStorage player ID,
  // which is shared across tabs on the same device.
  const seekerId = crypto.randomUUID();
  const client = getSupabaseClient();
  const channel = client.channel('matchmaking-lobby', {
    config: {
      presence: { key: seekerId },
    },
  });

  let resolved = false;
  let timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  let rejectPromise: ((reason: Error) => void) | null = null;

  const cleanup = () => {
    if (timeoutTimer) { clearTimeout(timeoutTimer); timeoutTimer = null; }
    client.removeChannel(channel);
  };

  const promise = new Promise<MatchResult>((resolve, reject) => {
    rejectPromise = reject;

    const processPresence = () => {
      if (resolved) return;
      const state = channel.presenceState();

      for (const presences of Object.values(state)) {
        if (resolved) return;
        const p = presences[0] as Record<string, unknown>;
        const peerId = p.seekerId as string;
        if (!peerId || peerId === seekerId) continue;

        // Check if a hosting peer has selected us as guest
        if (p.status === 'hosting' && p.guestId === seekerId) {
          resolved = true;
          dlog(`matchmaking: matched as guest, room=${p.roomId}`);
          cleanup();
          resolve({ role: 'guest', roomId: p.roomId as string });
          return;
        }

        // Try to match with a seeking peer — deterministic: lower ID = host
        if (p.status === 'seeking' && seekerId < peerId) {
          resolved = true;
          const roomId = generateRoomId();
          dlog(`matchmaking: I am host, matched with ${peerId.slice(0, 8)}`);
          // Update presence so guest discovers the match
          channel.track({ seekerId, status: 'hosting', roomId, guestId: peerId });
          // Keep channel alive so guest receives the presence update
          setTimeout(cleanup, HOST_LINGER_MS);
          resolve({ role: 'host', roomId });
          return;
        }
      }
    };

    channel.on('presence', { event: 'sync' }, () => {
      const count = Object.keys(channel.presenceState()).length;
      dlog(`matchmaking: presence sync (${count} peers)`);
      processPresence();
    });

    channel.subscribe(async (status) => {
      if (status === 'SUBSCRIBED') {
        dlog('matchmaking: joined lobby');
        await channel.track({ seekerId, status: 'seeking', ts: Date.now() });
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        if (!resolved) {
          resolved = true;
          cleanup();
          reject(new Error(`Matchmaking channel failed: ${status}`));
        }
      }
    });

    timeoutTimer = setTimeout(() => {
      timeoutTimer = null;
      if (!resolved) {
        resolved = true;
        cleanup();
        reject(new Error('No opponent found'));
      }
    }, MATCH_TIMEOUT_MS);
  });

  const cancel = () => {
    if (!resolved) {
      resolved = true;
      cleanup();
      rejectPromise?.(new Error('Matchmaking cancelled'));
    }
  };

  return { promise, cancel };
}
