import { createOnlineRoom, generateRoomId, getShareUrl } from './online';
import type { OnlineConnection } from './online';
import type {
  OnlineGameState,
  OnlinePhase,
  OnlinePathData,
  OnlineFrameData,
  OnlineRoundResult,
  OnlineConnectionState,
} from './online-types';
import type { Unit, Vec2 } from './types';

export interface OnlineHostCallbacks {
  onConnectionStateChange: (state: OnlineConnectionState) => void;
  onShareUrl: (url: string) => void;
  onGuestPathsReceived: () => void;
}

/**
 * Orchestrates an online PvP game from the host's perspective.
 * Manages the Trystero connection, sends game state to the guest,
 * and collects path data submitted by the guest.
 */
export class OnlineHost {
  private callbacks: OnlineHostCallbacks;
  private connection: OnlineConnection | null = null;
  private pendingPaths: OnlinePathData | null = null;
  private connectionState: OnlineConnectionState = 'idle';
  private guestPeerId: string | null = null;

  constructor(callbacks: OnlineHostCallbacks) {
    this.callbacks = callbacks;
  }

  /** Whether a guest is currently connected. */
  get isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  /**
   * Create a room and wait for the guest to join.
   * Returns the generated room ID.
   */
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

    this.callbacks.onShareUrl(getShareUrl(roomId));

    return roomId;
  }

  /**
   * Return any pending path data from the guest and clear it.
   * Returns null if no paths have been received since the last call.
   */
  consumeGuestPaths(): OnlinePathData | null {
    const paths = this.pendingPaths;
    this.pendingPaths = null;
    return paths;
  }

  /** Send the full game state to the guest. */
  sendGameState(state: OnlineGameState): void {
    this.connection?.state[0](state);
  }

  /** Send a phase change to the guest. */
  sendPhase(phase: OnlinePhase): void {
    this.connection?.phase[0](phase);
  }

  /** Send a single animation frame to the guest. */
  sendFrame(frame: OnlineFrameData): void {
    this.connection?.frame[0](frame);
  }

  /** Send a round result to the guest. */
  sendResult(result: OnlineRoundResult): void {
    this.connection?.result[0](result);
  }

  /**
   * Apply guest-submitted paths to the red units array.
   * Matches paths by unit ID and overwrites each unit's waypoints.
   */
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

  /** Tear down the connection and reset state. */
  destroy(): void {
    this.connection?.leave();
    this.connection = null;
    this.pendingPaths = null;
    this.guestPeerId = null;
    this.setConnectionState('idle');
  }

  private handlePeerJoin(peerId: string): void {
    this.guestPeerId = peerId;
    this.setConnectionState('connected');
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
