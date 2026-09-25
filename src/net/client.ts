/**
 * Client side of the room protocol (spec: REQ-011, REQ-026, REQ-029, REQ-030).
 *
 * A client never holds authority: it sends intents and mirrors whatever the host
 * broadcasts. `STATE_SNAPSHOT` replaces its mirror wholesale (that is the whole
 * reconnect story), while `STATE_EVENT` is delivered for presentation only.
 */

import type { ClientIntentMessage, NetMessage } from '@/engine/contracts/net';
import { NET_PROTOCOL_VERSION, isHostEvent } from '@/engine/contracts/net';
import type { RoomConfig } from '@/engine/contracts/config';
import type { RoomPlayerSummary } from '@/engine/contracts/net';
import type { GameEvent, GameState } from '@/engine/contracts/state';
import { decodeMessage, encodeMessage, SeqTracker } from './protocol';
import type { SignalConfig, TransportConnection, ClientTransport } from './transport';
import { DEFAULT_CONNECT_TIMEOUT_MS, createPeerJsClient } from './transport';
import { resolveJoinTarget } from './credentials';

export type ClientStatus =
  'idle' | 'connecting' | 'pending-approval' | 'joined' | 'rejected' | 'disconnected';

export interface RoomInfo {
  readonly roomCode: string;
  readonly roomId: string;
  readonly hostPeerId: string;
  readonly mapId: string;
  readonly config: RoomConfig;
  readonly players: readonly RoomPlayerSummary[];
}

export interface ClientSessionOptions {
  readonly signal?: SignalConfig;
  readonly nickname: string;
  readonly characterId?: string | undefined;
  /** Injected by tests; production uses the PeerJS adapter. */
  readonly transport?: () => ClientTransport;
  readonly onStatus?: (status: ClientStatus) => void;
  readonly onState?: (state: GameState) => void;
  readonly onEvent?: (event: GameEvent) => void;
  readonly onRoomInfo?: (info: RoomInfo) => void;
  /** A local intent the host refused, or a join refusal. */
  readonly onRejected?: (reason: string) => void;
  readonly onError?: (code: string, detail: string) => void;
  /**
   * Seat credential restored from storage. A page refresh is the most common
   * disconnect, and seats are SETUP-only, so without this a refreshed client
   * could never rejoin (REQ-011).
   */
  readonly seat?: { playerId: string; token: string } | undefined;
  /** Room reference for a restored session that has not called `connect`. */
  readonly target?: JoinTargetInput | undefined;
}

export interface JoinTargetInput {
  readonly roomId?: string | null | undefined;
  readonly roomCode?: string | null | undefined;
}

export interface ClientJoinResult {
  readonly ok: boolean;
  readonly reason?: string;
  readonly playerId?: string;
}

export class ClientSession {
  /**
   * Stable id proposed to the host in `INTENT_JOIN.from` and echoed back as the
   * seat id. Generated once per session so a reconnect and a first join agree.
   */
  readonly clientId: string;
  private readonly options: ClientSessionOptions;
  private transport: ClientTransport | null = null;
  private connection: TransportConnection | null = null;
  private readonly inboundSeq = new SeqTracker();
  private outboundSeq = 0;
  private status: ClientStatus = 'idle';
  private latestState: GameState | null = null;
  private playerId: string | null = null;
  private token: string | null = null;
  private target: { roomId?: string; roomCode?: string } = {};
  private joinResolver: ((result: ClientJoinResult) => void) | null = null;

  constructor(options: ClientSessionOptions) {
    this.options = options;
    this.clientId = `c${randomSuffix()}`;
    if (options.seat !== undefined) {
      this.playerId = options.seat.playerId;
      this.token = options.seat.token;
    }
    if (options.target !== undefined) {
      this.target = {
        ...(options.target.roomCode ? { roomCode: options.target.roomCode } : {}),
        ...(options.target.roomId ? { roomId: options.target.roomId } : {}),
      };
    }
  }

  /** Seat credential to persist; feed it back through `ClientSessionOptions.seat`. */
  get seatToken(): { playerId: string; token: string } | null {
    if (this.playerId === null || this.token === null) return null;
    return { playerId: this.playerId, token: this.token };
  }

  get currentStatus(): ClientStatus {
    return this.status;
  }

  get currentState(): GameState | null {
    return this.latestState;
  }

  get seatPlayerId(): string | null {
    return this.playerId;
  }

  /** Connects and completes the join handshake. Resolves once accepted. */
  async connect(
    target: JoinTargetInput,
    timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
  ): Promise<ClientJoinResult> {
    const resolved = resolveJoinTarget(target);
    if (resolved === null) {
      this.setStatus('rejected');
      return { ok: false, reason: 'invalid-room-reference' };
    }
    // Store the *normalised* code: the wire schema is uppercase-only, and a
    // hand-typed lowercase code would otherwise be rejected as a bad frame.
    this.target = {
      roomCode: resolved.roomCode,
      ...(target.roomId ? { roomId: target.roomId } : {}),
    };
    this.setStatus('connecting');
    const factory =
      this.options.transport ??
      (() =>
        createPeerJsClient(this.options.signal ?? {}, {
          onError: (code, detail) => {
            this.options.onError?.(code, detail);
          },
        }));
    const transport = factory();
    this.transport = transport;
    let connection: TransportConnection;
    try {
      connection = await transport.connect(resolved.peerId, timeoutMs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'connect-failed';
      this.setStatus('disconnected');
      return { ok: false, reason };
    }
    this.attach(connection);
    return new Promise<ClientJoinResult>((resolve) => {
      this.joinResolver = resolve;
      this.sendJoin(resolved.inviteToken);
    });
  }

  /** Re-dials the room and presents the seat token so the host rebinds the seat. */
  async reconnect(timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS): Promise<ClientJoinResult> {
    if (this.playerId === null || this.token === null) {
      return { ok: false, reason: 'no-seat-token' };
    }
    this.closeConnection();
    const factory =
      this.options.transport ??
      (() =>
        createPeerJsClient(this.options.signal ?? {}, {
          onError: (code, detail) => {
            this.options.onError?.(code, detail);
          },
        }));
    const transport = factory();
    this.transport = transport;
    const resolved = resolveJoinTarget(this.target);
    if (resolved === null) {
      return { ok: false, reason: 'invalid-room-reference' };
    }
    this.target = {
      roomCode: resolved.roomCode,
      ...(this.target.roomId ? { roomId: this.target.roomId } : {}),
    };
    this.setStatus('connecting');
    let connection: TransportConnection;
    try {
      connection = await transport.connect(resolved.peerId, timeoutMs);
    } catch (error) {
      const reason = error instanceof Error ? error.message : 'connect-failed';
      this.setStatus('disconnected');
      return { ok: false, reason };
    }
    this.attach(connection);
    return new Promise<ClientJoinResult>((resolve) => {
      this.joinResolver = resolve;
      this.sendJoin(resolved.inviteToken, {
        playerId: this.playerId as string,
        token: this.token as string,
      });
    });
  }

  /** Sends one intent. Returns `false` when the socket is not usable. */
  sendIntent(intent: Omit<ClientIntentMessage, 'v' | 'seq' | 'from' | 'to'>): boolean {
    const connection = this.connection;
    if (connection === null || this.playerId === null) return false;
    const message = {
      ...intent,
      v: NET_PROTOCOL_VERSION,
      seq: this.outboundSeq,
      from: this.playerId,
    } as ClientIntentMessage;
    this.outboundSeq += 1;
    connection.send(encodeMessage(message));
    return true;
  }

  close(): void {
    this.closeConnection();
    this.transport?.close();
    this.transport = null;
    this.setStatus('idle');
  }

  /* ----------------------------------------------------------------- internal */

  private sendJoin(
    inviteToken: string | null,
    reconnect?: { playerId: string; token: string },
  ): void {
    const connection = this.connection;
    if (connection === null) return;
    const roomId = this.target.roomId;
    const roomCode = this.target.roomCode;
    const payload = {
      nickname: this.options.nickname,
      ...(roomId !== undefined ? { roomId } : {}),
      ...(roomCode !== undefined ? { roomCode } : {}),
      ...(this.options.characterId !== undefined ? { characterId: this.options.characterId } : {}),
      ...(reconnect !== undefined ? { reconnect } : {}),
    };
    void inviteToken;
    const message = {
      v: NET_PROTOCOL_VERSION,
      type: 'INTENT_JOIN',
      seq: this.outboundSeq,
      from: this.playerId ?? this.clientId,
      payload,
    } as ClientIntentMessage;
    this.outboundSeq += 1;
    connection.send(encodeMessage(message));
  }

  private attach(connection: TransportConnection): void {
    this.connection = connection;
    this.inboundSeq.forget(connection.peerId);
    connection.onMessage((frame) => {
      this.handleFrame(frame);
    });
    connection.onClose(() => {
      if (this.connection !== connection) return;
      // A drop during the handshake must not leave `connect()`/`reconnect()`
      // pending forever: that is the silent hang REQ-026 forbids.
      if (this.joinResolver !== null) {
        const resolve = this.joinResolver;
        this.joinResolver = null;
        resolve({ ok: false, reason: 'connection-closed' });
      }
      if (this.status !== 'idle') this.setStatus('disconnected');
    });
  }

  private closeConnection(): void {
    this.connection?.close();
    this.connection = null;
  }

  private handleFrame(frame: string): void {
    const decoded = decodeMessage(frame);
    if (!decoded.ok) {
      this.options.onError?.('bad-frame', decoded.reason);
      return;
    }
    const message: NetMessage = decoded.message;
    if (!isHostEvent(message)) return;
    if (!this.inboundSeq.accept(message.from, message.seq)) return;

    switch (message.type) {
      case 'JOIN_PENDING':
        if (message.payload.playerId === this.clientId) {
          this.setStatus('pending-approval');
        }
        return;
      case 'JOIN_ACCEPTED': {
        this.playerId = message.payload.playerId;
        this.token = message.payload.reconnectToken ?? null;
        this.setStatus('joined');
        this.joinResolver?.({ ok: true, playerId: message.payload.playerId });
        this.joinResolver = null;
        return;
      }
      case 'JOIN_REJECTED':
        this.setStatus('rejected');
        this.options.onRejected?.(message.payload.reason);
        this.joinResolver?.({ ok: false, reason: message.payload.reason });
        this.joinResolver = null;
        return;
      case 'STATE_SNAPSHOT':
        this.latestState = message.payload.state;
        this.options.onState?.(message.payload.state);
        return;
      case 'STATE_EVENT':
        for (const event of message.payload.events) this.options.onEvent?.(event);
        return;
      case 'ROOM_INFO': {
        const payload = message.payload;
        this.options.onRoomInfo?.({
          roomCode: payload.roomCode,
          roomId: payload.roomId,
          hostPeerId: payload.hostPeerId,
          mapId: payload.mapId,
          config: payload.config,
          players: payload.players,
        });
        return;
      }
      case 'MINIGAME_START':
      case 'MINIGAME_RESULT':
      case 'TURN_START':
      case 'CHARACTER_TAKEN':
      case 'GAME_OVER':
        return;
      default:
        return;
    }
  }

  private setStatus(status: ClientStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.options.onStatus?.(status);
  }
}

/** Short non-cryptographic suffix; seat ids only need to be unique per room. */
function randomSuffix(): string {
  return Math.floor(Math.random() * 0x7fffffff).toString(36);
}
