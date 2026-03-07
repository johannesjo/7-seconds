import { createOnlineRoom, generateRoomId, getShareUrl, getLocalPlayerId } from './online';
import type { OnlineConnection } from './online';
import type {
  OnlineGameState,
  OnlinePhase,
  OnlinePathData,
  OnlineFrameData,
  OnlineRoundResult,
  OnlineConnectionState,
  OnlineSignal,
} from './online-types';
import type { Unit, Vec2 } from './types';

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
    this.setConnectionState('waiting');

    this.connection = createOnlineRoom(
      roomId,
      'host',
      (peerId) => this.handlePeerJoin(peerId),
      (peerId) => this.handlePeerLeave(peerId),
    );

    this.connection.paths[1]((data: OnlinePathData) => {
      this.pendingPaths = data;
      this.callbacks.onGuestPathsReceived();
    });

    this.connection.signal[1]((data: OnlineSignal) => {
      if (data.type === 'rematch') {
        this._guestWantsRematch = true;
        this.callbacks.onGuestRematchRequested();
      } else if (data.type === 'identity' && data.playerId) {
        this.callbacks.onGuestIdentity(data.playerId);
      }
    });

    this.callbacks.onShareUrl(getShareUrl(roomId));
    return roomId;
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

  applyGuestPaths(units: Unit[], pathData: OnlinePathData): void {
    const pathsByUnitId = new Map<string, Vec2[]>();
    for (const entry of pathData.paths) {
      pathsByUnitId.set(entry.unitId, entry.waypoints);
    }
    for (const unit of units) {
      if (unit.team !== 'red') continue;
      const waypoints = pathsByUnitId.get(unit.id);
      if (waypoints) {
        unit.waypoints = waypoints;
        unit.moveTarget = waypoints.length > 0 ? waypoints[0] : null;
      }
    }
  }

  destroy(): void {
    this.connection?.leave();
    this.connection = null;
    this.pendingPaths = null;
    this.guestPeerId = null;
    this._guestWantsRematch = false;
    this.setConnectionState('idle');
  }

  private handlePeerJoin(peerId: string): void {
    this.guestPeerId = peerId;
    this.setConnectionState('connected');
    // Send identity on connect
    this.sendIdentity();
  }

  private handlePeerLeave(peerId: string): void {
    if (peerId === this.guestPeerId) {
      this.guestPeerId = null;
      this.setConnectionState('disconnected');
    }
  }

  private setConnectionState(state: OnlineConnectionState): void {
    this.connectionState = state;
    this.callbacks.onConnectionStateChange(state);
  }
}
