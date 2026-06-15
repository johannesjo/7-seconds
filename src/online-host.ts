import { createOnlineRoom, generateRoomId, getShareUrl, getLocalPlayerId } from './online';
import type { OnlineConnection } from './online';
import { dlog, startPeerMonitor } from './online-debug';
import type {
  OnlineGameState,
  OnlinePhase,
  OnlinePathData,
  OnlineRoundResult,
  OnlineConnectionState,
  OnlineSignal,
  OnlineWaypointData,
  OnlineSyncHash,
} from './online-types';
import { isValidPlayerId } from './online-score';

interface OnlineHostCallbacks {
  onConnectionStateChange: (state: OnlineConnectionState) => void;
  onShareUrl: (url: string) => void;
  onGuestPathsReceived: () => void;
  onGuestRematchRequested: () => void;
  onGuestIdentity: (playerId: string) => void;
}

export class OnlineHost {
  private callbacks: OnlineHostCallbacks;
  private connection: OnlineConnection | null = null;
  private pendingPaths: OnlinePathData | null = null;
  private connectionState: OnlineConnectionState = 'idle';
  private guestPeerId: string | null = null;
  private _guestWantsRematch = false;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopPeerMonitor: (() => void) | null = null;

  // Single long timeout for peer discovery via Supabase signaling.
  private static readonly CONNECTION_TIMEOUT_MS = 120_000;
  /** How long to wait for automatic reconnection before declaring disconnect. */
  private static readonly RECONNECT_GRACE_MS = 20_000;

  constructor(callbacks: OnlineHostCallbacks) {
    this.callbacks = callbacks;
  }

  get isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  get guestWantsRematch(): boolean {
    return this._guestWantsRematch;
  }

  async createRoom(): Promise<string> {
    const roomId = generateRoomId();
    await this.createRoomWithId(roomId);
    this.callbacks.onShareUrl(getShareUrl(roomId));
    return roomId;
  }

  async createRoomWithId(roomId: string): Promise<void> {
    this.setConnectionState('waiting');

    try {
      this.connection = await createOnlineRoom(
        roomId,
        'host',
        (peerId) => this.handlePeerJoin(peerId),
        (peerId) => this.handlePeerLeave(peerId),
        (peerId) => this.handlePeerReconnecting(peerId),
      );
    } catch (e) {
      dlog(`host createRoom failed: ${e}`);
      this.setConnectionState('error');
      return;
    }

    this.stopPeerMonitor?.();
    this.stopPeerMonitor = startPeerMonitor(() => this.connection?.getPeers() ?? {}, 'host');
    dlog('host createRoom');

    this.connection.paths[1]((data: OnlinePathData, peerId: string) => {
      if (peerId !== this.guestPeerId) return;
      this.pendingPaths = data;
      this.callbacks.onGuestPathsReceived();
    });

    this.connection.signal[1]((data: OnlineSignal, peerId: string) => {
      if (peerId !== this.guestPeerId) return;
      if (data.type === 'rematch') {
        this._guestWantsRematch = true;
        this.callbacks.onGuestRematchRequested();
      } else if (data.type === 'identity' && data.playerId && isValidPlayerId(data.playerId)) {
        this.callbacks.onGuestIdentity(data.playerId);
      }
    });

    // Single timeout — host re-announces offer every 3s automatically
    this.timeoutTimer = setTimeout(() => {
      this.timeoutTimer = null;
      if (this.connectionState === 'waiting') {
        dlog('host connection timeout');
        this.setConnectionState('error');
      }
    }, OnlineHost.CONNECTION_TIMEOUT_MS);
  }

  consumeGuestPaths(): OnlinePathData | null {
    const paths = this.pendingPaths;
    this.pendingPaths = null;
    return paths;
  }

  /** Reset rematch state for a new game. */
  resetRematch(): void {
    this._guestWantsRematch = false;
  }

  /** Send own identity to the guest. */
  sendIdentity(): void {
    this.connection?.signal[0]({ type: 'identity', playerId: getLocalPlayerId() });
  }

  /** Request rematch (host side). */
  sendRematchRequest(): void {
    this.connection?.signal[0]({ type: 'rematch' });
  }

  sendGameState(state: OnlineGameState): void {
    this.connection?.state[0](state);
  }

  sendPhase(phase: OnlinePhase): void {
    this.connection?.phase[0](phase);
  }

  sendWaypoints(data: OnlineWaypointData): void {
    this.connection?.waypoints[0](data);
  }

  sendSyncHash(data: OnlineSyncHash): void {
    this.connection?.sync[0](data);
  }

  sendResult(result: OnlineRoundResult): void {
    this.connection?.result[0](result);
  }

  destroy(): void {
    this.clearTimeout();
    this.clearReconnectTimer();
    this.stopPeerMonitor?.();
    this.stopPeerMonitor = null;
    this.connection?.leave();
    this.connection = null;
    this.pendingPaths = null;
    this.guestPeerId = null;
    this._guestWantsRematch = false;
    this.connectionState = 'idle';
  }

  private handlePeerJoin(peerId: string): void {
    // Accept the same guest, or a new guest if disconnected/reconnecting
    if (this.guestPeerId && this.guestPeerId !== peerId
      && this.connectionState !== 'disconnected' && this.connectionState !== 'reconnecting') return;
    this.guestPeerId = peerId;
    this.clearTimeout();
    this.clearReconnectTimer();
    this.setConnectionState('connected');
    this.sendIdentity();
  }

  private handlePeerLeave(peerId: string): void {
    // No guest ever connected and the transport gave up (both WebRTC and relay
    // failed) — surface as an error rather than leaving the user on "waiting".
    if (!this.guestPeerId) {
      if (this.connectionState === 'waiting') {
        this.clearTimeout();
        this.clearReconnectTimer();
        this.setConnectionState('error');
      }
      return;
    }
    if (peerId === this.guestPeerId || peerId === '') {
      // Real peer match, or an empty-peerId give-up after a failed failover —
      // either way the connection is gone. Don't wait out the grace timer.
      this.clearReconnectTimer();
      this.setConnectionState('disconnected');
    }
  }

  private handlePeerReconnecting(peerId: string): void {
    if (peerId !== this.guestPeerId) return;
    // Don't restart the timer if already reconnecting (guard against flapping).
    if (this.connectionState === 'reconnecting') return;
    this.setConnectionState('reconnecting');
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.connectionState === 'reconnecting') {
        dlog('host reconnect grace period expired');
        this.setConnectionState('disconnected');
      }
    }, OnlineHost.RECONNECT_GRACE_MS);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private clearTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private setConnectionState(state: OnlineConnectionState): void {
    this.connectionState = state;
    this.callbacks.onConnectionStateChange(state);
  }
}
