import { createOnlineRoom, getLocalPlayerId, type OnlineConnection } from './online';
import type {
  OnlineConnectionState,
  OnlineGameState,
  OnlinePhase,
  OnlineFrameData,
  OnlinePathData,
  OnlineRoundResult,
  OnlineSignal,
} from './online-types';
import { isValidPlayerId } from './online-score';

export interface OnlineGuestCallbacks {
  onConnectionStateChange: (state: OnlineConnectionState) => void;
  onGameState: (state: OnlineGameState) => void;
  onPhaseChange: (phase: OnlinePhase) => void;
  onFrame: (frame: OnlineFrameData) => void;
  onResult: (result: OnlineRoundResult) => void;
  onHostRematchRequested: () => void;
  onHostIdentity: (playerId: string) => void;
}

export class OnlineGuest {
  private connection: OnlineConnection | null = null;
  private connectionState: OnlineConnectionState = 'idle';
  private readonly callbacks: OnlineGuestCallbacks;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryCount = 0;
  private _hostWantsRematch = false;
  private hostPeerId: string | null = null;
  private destroyed = false;

  private static readonly ATTEMPT_TIMEOUT_MS = 8_000;
  private static readonly MAX_RETRIES = 3;
  private static readonly RETRY_DELAY_MS = 2_000;

  constructor(callbacks: OnlineGuestCallbacks) {
    this.callbacks = callbacks;
  }

  get isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  get hostWantsRematch(): boolean {
    return this._hostWantsRematch;
  }

  joinRoom(roomId: string): void {
    this.destroyed = false;
    this.retryCount = 0;
    this.attemptJoin(roomId);
  }

  private attemptJoin(roomId: string): void {
    this.setConnectionState('connecting');

    // Clean up previous attempt
    if (this.connection) {
      this.connection.leave();
      this.connection = null;
    }

    this.connection = createOnlineRoom(
      roomId,
      'guest',
      (peerId) => {
        this.hostPeerId = peerId;
        this.clearRetryTimer();
        this.setConnectionState('connected');
        this.sendIdentity();
      },
      (peerId) => {
        if (peerId === this.hostPeerId) this.setConnectionState('disconnected');
      },
    );

    const [, receiveState] = this.connection.state;
    const [, receivePhase] = this.connection.phase;
    const [, receiveFrame] = this.connection.frame;
    const [, receiveResult] = this.connection.result;

    receiveState((state) => this.callbacks.onGameState(state));
    receivePhase((phase) => this.callbacks.onPhaseChange(phase));
    receiveFrame((frame) => this.callbacks.onFrame(frame));
    receiveResult((result) => this.callbacks.onResult(result));

    this.connection.signal[1]((data: OnlineSignal, peerId: string) => {
      if (peerId !== this.hostPeerId) return;
      if (data.type === 'rematch') {
        this._hostWantsRematch = true;
        this.callbacks.onHostRematchRequested();
      } else if (data.type === 'identity' && data.playerId && isValidPlayerId(data.playerId)) {
        this.callbacks.onHostIdentity(data.playerId);
      }
    });

    // Retry if no peer joins within timeout
    this.clearRetryTimer();
    this.retryTimer = setTimeout(() => {
      if (this.connectionState === 'connected' || this.destroyed) return;

      if (this.retryCount < OnlineGuest.MAX_RETRIES) {
        this.retryCount++;
        console.log(`[online-guest] Retry ${this.retryCount}/${OnlineGuest.MAX_RETRIES}…`);
        // Delay before retry to let old Supabase client clean up
        if (this.connection) {
          this.connection.leave();
          this.connection = null;
        }
        this.retryTimer = setTimeout(() => {
          if (!this.destroyed) this.attemptJoin(roomId);
        }, OnlineGuest.RETRY_DELAY_MS);
      } else {
        this.setConnectionState('error');
      }
    }, OnlineGuest.ATTEMPT_TIMEOUT_MS);
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
    this.destroyed = true;
    this.clearRetryTimer();
    if (this.connection) {
      this.connection.leave();
      this.connection = null;
    }
    this._hostWantsRematch = false;
    this.hostPeerId = null;
    this.setConnectionState('idle');
  }

  private clearRetryTimer(): void {
    if (this.retryTimer) {
      clearTimeout(this.retryTimer);
      this.retryTimer = null;
    }
  }

  private setConnectionState(state: OnlineConnectionState): void {
    this.connectionState = state;
    this.callbacks.onConnectionStateChange(state);
  }
}
