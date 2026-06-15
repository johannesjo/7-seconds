import { createOnlineRoom, getLocalPlayerId, type OnlineConnection } from './online';
import { dlog, startPeerMonitor } from './online-debug';
import type {
  OnlineConnectionState,
  OnlineGameState,
  OnlinePhase,
  OnlinePathData,
  OnlineRoundResult,
  OnlineSignal,
  OnlineWaypointData,
  OnlineSyncHash,
} from './online-types';
import { isValidPlayerId } from './online-score';

interface OnlineGuestCallbacks {
  onConnectionStateChange: (state: OnlineConnectionState) => void;
  onGameState: (state: OnlineGameState) => void;
  onPhaseChange: (phase: OnlinePhase) => void;
  onWaypoints: (data: OnlineWaypointData) => void;
  onSyncHash: (data: OnlineSyncHash) => void;
  onResult: (result: OnlineRoundResult) => void;
  onHostRematchRequested: () => void;
  onHostIdentity: (playerId: string) => void;
}

export class OnlineGuest {
  private connection: OnlineConnection | null = null;
  private connectionState: OnlineConnectionState = 'idle';
  private readonly callbacks: OnlineGuestCallbacks;
  private timeoutTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _hostWantsRematch = false;
  private hostPeerId: string | null = null;
  private stopPeerMonitor: (() => void) | null = null;

  // Single long timeout for peer discovery via Supabase signaling.
  private static readonly CONNECTION_TIMEOUT_MS = 120_000;
  /** How long to wait for automatic reconnection before declaring disconnect. */
  private static readonly RECONNECT_GRACE_MS = 20_000;

  constructor(callbacks: OnlineGuestCallbacks) {
    this.callbacks = callbacks;
  }

  get isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  get hostWantsRematch(): boolean {
    return this._hostWantsRematch;
  }

  async joinRoom(roomId: string): Promise<void> {
    this.setConnectionState('connecting');

    try {
      this.connection = await createOnlineRoom(
        roomId,
        'guest',
        (peerId) => {
          this.hostPeerId = peerId;
          this.clearTimeout();
          this.clearReconnectTimer();
          this.setConnectionState('connected');
          this.sendIdentity();
        },
        (peerId) => {
          // Never connected and the transport gave up (both WebRTC and relay
          // failed) — surface as an error instead of hanging on "connecting".
          if (!this.hostPeerId) {
            if (this.connectionState === 'connecting') {
              this.clearTimeout();
              this.clearReconnectTimer();
              this.setConnectionState('error');
            }
            return;
          }
          // Peer layer has exhausted all reconnection attempts — connection is gone.
          if (peerId === this.hostPeerId) {
            this.clearReconnectTimer();
            this.setConnectionState('disconnected');
          }
        },
        (peerId) => {
          // Peer layer is attempting reconnection — show UI and start grace timer.
          if (peerId !== this.hostPeerId) return;
          if (this.connectionState === 'reconnecting') return;
          this.setConnectionState('reconnecting');
          this.reconnectTimer = setTimeout(() => {
            this.reconnectTimer = null;
            if (this.connectionState === 'reconnecting') {
              dlog('guest reconnect grace period expired');
              this.setConnectionState('disconnected');
            }
          }, OnlineGuest.RECONNECT_GRACE_MS);
        },
      );
    } catch (e) {
      dlog(`guest joinRoom failed: ${e}`);
      this.setConnectionState('error');
      return;
    }

    this.stopPeerMonitor?.();
    this.stopPeerMonitor = startPeerMonitor(() => this.connection?.getPeers() ?? {}, 'guest');
    dlog('guest joinRoom');

    const [, receiveState] = this.connection.state;
    const [, receivePhase] = this.connection.phase;
    const [, receiveResult] = this.connection.result;
    const [, receiveWaypoints] = this.connection.waypoints;
    const [, receiveSync] = this.connection.sync;

    receiveState((state, peerId) => {
      if (peerId !== this.hostPeerId) return;
      this.callbacks.onGameState(state);
    });
    receivePhase((phase, peerId) => {
      if (peerId !== this.hostPeerId) return;
      this.callbacks.onPhaseChange(phase);
    });
    receiveWaypoints((data, peerId) => {
      if (peerId !== this.hostPeerId) return;
      this.callbacks.onWaypoints(data);
    });
    receiveSync((data, peerId) => {
      if (peerId !== this.hostPeerId) return;
      this.callbacks.onSyncHash(data);
    });
    receiveResult((result, peerId) => {
      if (peerId !== this.hostPeerId) return;
      this.callbacks.onResult(result);
    });

    this.connection.signal[1]((data: OnlineSignal, peerId: string) => {
      if (peerId !== this.hostPeerId) return;
      if (data.type === 'rematch') {
        this._hostWantsRematch = true;
        this.callbacks.onHostRematchRequested();
      } else if (data.type === 'identity' && data.playerId && isValidPlayerId(data.playerId)) {
        this.callbacks.onHostIdentity(data.playerId);
      }
    });

    // Single timeout — signaling channel stays open for peer discovery
    this.timeoutTimer = setTimeout(() => {
      this.timeoutTimer = null;
      if (this.connectionState !== 'connected') {
        dlog('guest connection timeout');
        this.setConnectionState('error');
      }
    }, OnlineGuest.CONNECTION_TIMEOUT_MS);
  }

  /** Reset rematch state for a new game. */
  resetRematch(): void {
    this._hostWantsRematch = false;
  }

  /** Send own identity to the host. */
  private sendIdentity(): void {
    this.connection?.signal[0]({ type: 'identity', playerId: getLocalPlayerId() });
  }

  /** Request rematch (guest side). */
  sendRematchRequest(): void {
    this.connection?.signal[0]({ type: 'rematch' });
  }

  sendPaths(paths: OnlinePathData): void {
    if (!this.connection) return;
    const [send] = this.connection.paths;
    send(paths);
  }

  destroy(): void {
    this.clearTimeout();
    this.clearReconnectTimer();
    this.stopPeerMonitor?.();
    this.stopPeerMonitor = null;
    if (this.connection) {
      this.connection.leave();
      this.connection = null;
    }
    this._hostWantsRematch = false;
    this.hostPeerId = null;
    this.connectionState = 'idle';
  }

  private clearTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private setConnectionState(state: OnlineConnectionState): void {
    this.connectionState = state;
    this.callbacks.onConnectionStateChange(state);
  }
}
