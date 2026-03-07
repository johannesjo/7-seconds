import { createOnlineRoom, type OnlineConnection } from './online';
import type {
  OnlineConnectionState,
  OnlineGameState,
  OnlinePhase,
  OnlineFrameData,
  OnlinePathData,
  OnlineRoundResult,
} from './online-types';

export interface OnlineGuestCallbacks {
  onConnectionStateChange: (state: OnlineConnectionState) => void;
  onGameState: (state: OnlineGameState) => void;
  onPhaseChange: (phase: OnlinePhase) => void;
  onFrame: (frame: OnlineFrameData) => void;
  onResult: (result: OnlineRoundResult) => void;
}

/**
 * Manages the guest side of an online PvP session.
 * Connects to a host's room and relays incoming messages via callbacks.
 */
export class OnlineGuest {
  private connection: OnlineConnection | null = null;
  private connectionState: OnlineConnectionState = 'idle';
  private readonly callbacks: OnlineGuestCallbacks;

  constructor(callbacks: OnlineGuestCallbacks) {
    this.callbacks = callbacks;
  }

  get isConnected(): boolean {
    return this.connectionState === 'connected';
  }

  /** Join an existing room hosted by another player. */
  joinRoom(roomId: string): void {
    this.setConnectionState('connecting');

    this.connection = createOnlineRoom(
      roomId,
      'guest',
      () => this.setConnectionState('connected'),
      () => this.setConnectionState('disconnected'),
    );

    const [, receiveState] = this.connection.state;
    const [, receivePhase] = this.connection.phase;
    const [, receiveFrame] = this.connection.frame;
    const [, receiveResult] = this.connection.result;

    receiveState((state) => this.callbacks.onGameState(state));
    receivePhase((phase) => this.callbacks.onPhaseChange(phase));
    receiveFrame((frame) => this.callbacks.onFrame(frame));
    receiveResult((result) => this.callbacks.onResult(result));
  }

  /** Send planned unit paths to the host. */
  sendPaths(paths: OnlinePathData): void {
    if (!this.connection) return;
    const [send] = this.connection.paths;
    send(paths);
  }

  /** Tear down the connection and reset state. */
  destroy(): void {
    if (this.connection) {
      this.connection.leave();
      this.connection = null;
    }
    this.setConnectionState('idle');
  }

  private setConnectionState(state: OnlineConnectionState): void {
    this.connectionState = state;
    this.callbacks.onConnectionStateChange(state);
  }
}
