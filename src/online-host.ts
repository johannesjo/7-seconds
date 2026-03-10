import { createOnlineRoom, generateRoomId, getShareUrl, getLocalPlayerId } from './online';
import type { OnlineConnection } from './online';
import { dlog, startPeerMonitor } from './online-debug';
import type {
  OnlineGameState,
  OnlinePhase,
  OnlinePathData,
  OnlineFrameData,
  OnlineRoundResult,
  OnlineConnectionState,
  OnlineSignal,
} from './online-types';
import { isValidPlayerId } from './online-score';

export interface OnlineHostCallbacks {
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
  private resubTimer: ReturnType<typeof setTimeout> | null = null;
  private stopPeerMonitor: (() => void) | null = null;
  private destroyed = false;

  // Total max wait: (20s × 5 resubs) + (2s × 5 delays) + 20s final = ~130s before error
  // 20s interval gives slow mobile ICE negotiation enough time to complete
  private static readonly RESUB_INTERVAL_MS = 20_000;
  private static readonly RESUB_DELAY_MS = 2_000;
  private static readonly MAX_RESUBS = 5;

  constructor(callbacks: OnlineHostCallbacks) {
    this.callbacks = callbacks;
  }

  get isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  get guestWantsRematch(): boolean {
    return this._guestWantsRematch;
  }

  createRoom(): string {
    const roomId = generateRoomId();
    this.destroyed = false;
    this.setupRoom(roomId, 0);
    this.callbacks.onShareUrl(getShareUrl(roomId));
    return roomId;
  }

  private setupRoom(roomId: string, resubCount: number): void {
    this.setConnectionState('waiting');

    // Clean up previous connection
    if (this.connection) {
      this.connection.leave();
      this.connection = null;
    }

    this.connection = createOnlineRoom(
      roomId,
      'host',
      (peerId) => this.handlePeerJoin(peerId),
      (peerId) => this.handlePeerLeave(peerId),
    );

    this.stopPeerMonitor?.();
    this.stopPeerMonitor = startPeerMonitor(() => this.connection?.getPeers() ?? {}, 'host');
    dlog(`host setupRoom resub=${resubCount}`);

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

    // Periodically re-create the room if no guest joins,
    // to recover from stalled Supabase Realtime subscriptions
    this.clearResubTimer();
    if (resubCount < OnlineHost.MAX_RESUBS) {
      this.resubTimer = setTimeout(() => {
        this.resubTimer = null;
        if (this.connectionState !== 'waiting' || this.destroyed) return;
        console.log(`[online-host] Resubscribing (${resubCount + 1}/${OnlineHost.MAX_RESUBS})…`);
        if (this.connection) {
          this.connection.leave();
          this.connection = null;
        }
        this.resubTimer = setTimeout(() => {
          this.resubTimer = null;
          if (!this.destroyed) this.setupRoom(roomId, resubCount + 1);
        }, OnlineHost.RESUB_DELAY_MS);
      }, OnlineHost.RESUB_INTERVAL_MS);
    } else {
      // Final timeout — give up after all resubs exhausted
      this.timeoutTimer = setTimeout(() => {
        if (this.connectionState === 'waiting') {
          this.setConnectionState('error');
        }
      }, OnlineHost.RESUB_INTERVAL_MS);
    }
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

  sendFrame(frame: OnlineFrameData): void {
    this.connection?.frame[0](frame);
  }

  sendResult(result: OnlineRoundResult): void {
    this.connection?.result[0](result);
  }

  destroy(): void {
    this.destroyed = true;
    this.clearTimeout();
    this.clearResubTimer();
    this.stopPeerMonitor?.();
    this.stopPeerMonitor = null;
    this.connection?.leave();
    this.connection = null;
    this.pendingPaths = null;
    this.guestPeerId = null;
    this._guestWantsRematch = false;
    this.setConnectionState('idle');
  }

  private handlePeerJoin(peerId: string): void {
    // Reject additional peers if a guest is already connected
    if (this.guestPeerId) return;
    this.guestPeerId = peerId;
    this.clearTimeout();
    this.clearResubTimer();
    this.setConnectionState('connected');
    this.sendIdentity();
  }

  private handlePeerLeave(peerId: string): void {
    if (peerId === this.guestPeerId) {
      this.guestPeerId = null;
      this.setConnectionState('disconnected');
    }
  }

  private clearTimeout(): void {
    if (this.timeoutTimer) {
      clearTimeout(this.timeoutTimer);
      this.timeoutTimer = null;
    }
  }

  private clearResubTimer(): void {
    if (this.resubTimer) {
      clearTimeout(this.resubTimer);
      this.resubTimer = null;
    }
  }

  private setConnectionState(state: OnlineConnectionState): void {
    this.connectionState = state;
    this.callbacks.onConnectionStateChange(state);
  }
}
