/**
 * Host-authoritative room (spec: REQ-002/003/004/011/026/028/029/030/034,
 * SEC-001/002/003/006, CON-019).
 *
 * The host owns the only `GameSession`. Clients send intents; the host binds each
 * intent's `from` to the seat behind the connection (it never trusts the frame),
 * applies it, and fans the resulting events out. Nothing else mutates game state.
 *
 * Two ways in, matching the credentials design:
 *  - a share link carries the 21-char invite token, which proves the holder saw
 *    the invite, so the join is accepted immediately;
 *  - a typed 6-char code proves nothing, so the host must approve it.
 * Both paths are rate limited per connection, and neither can mint a seat.
 *
 * Reconnect is the third path: a returning client presents its host-issued seat
 * token, the host rebinds the seat and replies with a full `STATE_SNAPSHOT`
 * (REQ-011).
 */

import type { ClientIntentMessage, JoinPayload, NetMessage } from '@/engine/contracts/net';
import { NET_PROTOCOL_VERSION, isClientIntent } from '@/engine/contracts/net';
import type { RoomConfig } from '@/engine/contracts/config';
import { DEFAULT_ROOM_CONFIG } from '@/engine/contracts/config';
import type { Character, ContentPack, MapDefinition } from '@/engine/contracts/content';
import type { GameEvent, GameState } from '@/engine/contracts/state';
import {
  addPlayer,
  applyIntent,
  createSession,
  forceResolveMiniGame,
  removePlayer,
  setPlayerConnected,
  startGame,
  type ApplyResult,
  type GameSession,
} from '@/engine/reducer';
import { encodeMessage } from './protocol';
import { SeqTracker } from './protocol';
import { hashState } from '@/engine/hash';
import type { RandomInt, RoomCredentials } from './credentials';
import { makeRoomCredentials } from './credentials';
import type {
  HostTransport,
  HostTransportHandlers,
  SignalConfig,
  TransportConnection,
} from './transport';
import { createPeerJsHost } from './transport';

/** Join throttling: 5 attempts per 10 seconds per connection. */
export const JOIN_ATTEMPT_LIMIT = 5;
export const JOIN_ATTEMPT_WINDOW_MS = 10_000;
/** How long a mini-game waits for missing submissions before the host forces it. */
export const MINIGAME_DEADLINE_MS = 30_000;
export const MAX_PLAYERS = 4;

export interface JoinRequest {
  readonly connectionPeerId: string;
  readonly nickname: string;
  readonly characterId: string | undefined;
  approve(): void;
  reject(): void;
}

export interface HostSessionOptions {
  readonly credentials: RoomCredentials;
  readonly pack: ContentPack;
  readonly map: MapDefinition;
  readonly roomConfig?: RoomConfig;
  readonly seed?: string;
  readonly hostNickname?: string;
  readonly hostCharacterId?: string;
  readonly signal?: SignalConfig;
  /** Injected by tests; production uses the PeerJS adapter. */
  readonly transport?: (
    peerId: string,
    signal: SignalConfig,
    handlers: HostTransportHandlers,
  ) => HostTransport;
  readonly randomInt?: RandomInt;
  readonly now?: () => number;
  /** Raised when a code-only join needs a human decision. */
  readonly onJoinRequest?: (request: JoinRequest) => void;
  readonly onEvent?: (event: GameEvent) => void;
  readonly onStateChanged?: (state: GameState) => void;
  readonly onError?: (code: string, detail: string) => void;
  readonly onPeersChanged?: (count: number) => void;
}

interface PeerLink {
  readonly peerId: string;
  readonly connection: TransportConnection;
  /** Seat this connection owns, once admitted. */
  playerId: string | null;
  /** Client-proposed id from `INTENT_JOIN.from`; becomes the seat id. */
  proposedId: string | null;
  attempts: number[];
  pending: JoinPayload | null;
  nickname: string | null;
}

export class HostSession {
  private readonly options: HostSessionOptions;
  private readonly randomInt: RandomInt;
  private readonly now: () => number;
  private session: GameSession;
  private readonly links = new Map<string, PeerLink>();
  private readonly seatTokens = new Map<string, string>();
  private readonly inboundSeq = new SeqTracker();
  private outboundSeq = 0;
  private transport: HostTransport | null = null;
  private minigameTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(options: HostSessionOptions) {
    this.options = options;
    this.randomInt = options.randomInt ?? defaultRandomInt;
    this.now = options.now ?? (() => Date.now());
    const hostId = 'p1';
    this.session = createSession({
      seed: options.seed ?? defaultSeed(this.randomInt),
      map: options.map,
      roomConfig: options.roomConfig ?? DEFAULT_ROOM_CONFIG,
      characters: options.pack.characters,
      chaosEvents: options.pack.chaosEvents,
      miniGames: options.pack.miniGames,
      players: [
        {
          id: hostId,
          nickname: options.hostNickname ?? '房主',
          characterId: options.hostCharacterId ?? firstCharacterId(options.pack),
          isAI: false,
        },
      ],
    });
    this.seatTokens.set(hostId, this.mintToken());
  }

  /* --------------------------------------------------------------- lifecycle */

  start(): void {
    const factory = this.options.transport ?? createPeerJsHost;
    this.transport = factory(this.options.credentials.peerId, this.options.signal ?? {}, {
      onConnection: (connection) => {
        this.acceptConnection(connection);
      },
      onError: (code, detail) => {
        this.options.onError?.(code, detail);
      },
    });
  }

  stop(): void {
    this.clearMinigameTimer();
    for (const link of this.links.values()) link.connection.close();
    this.links.clear();
    this.transport?.close();
    this.transport = null;
  }

  /* ------------------------------------------------------------------- state */

  get state(): GameState {
    return this.session.state;
  }

  get gameSession(): GameSession {
    return this.session;
  }

  get credentials(): RoomCredentials {
    return this.options.credentials;
  }

  connectedSeats(): number {
    return [...this.links.values()].filter((link) => link.playerId !== null).length;
  }

  seatToken(playerId: string): string | undefined {
    return this.seatTokens.get(playerId);
  }

  /* --------------------------------------------------------------- room setup */

  /** Adds an AI seat. AI seats are driven by the caller, never by the wire. */
  addAiPlayer(nickname: string, characterId?: string): string | null {
    if (this.session.state.players.length >= MAX_PLAYERS) return null;
    const id = this.nextSeatId();
    const result = addPlayer(this.session, {
      id,
      nickname,
      characterId: characterId ?? firstFreeCharacterId(this.session, this.options.pack.characters),
      isAI: true,
    });
    if (result.rejected !== null) return null;
    this.session = result.session;
    this.publish([]);
    return id;
  }

  /** Starts the match. Fails while any seat still has an unusable character. */
  begin(): { ok: true } | { ok: false; reason: string } {
    const result = startGame(this.session);
    if (result.rejected !== null) return { ok: false, reason: result.rejected };
    this.session = result.session;
    this.publish(result.events);
    return { ok: true };
  }

  setRoomConfig(roomConfig: RoomConfig): void {
    this.session = { ...this.session, state: { ...this.session.state, roomConfig } };
    this.broadcastRoomInfo();
    this.options.onStateChanged?.(this.session.state);
  }

  kick(playerId: string): void {
    const result = removePlayer(this.session, playerId);
    this.session = result.session;
    this.seatTokens.delete(playerId);
    for (const link of this.links.values()) {
      if (link.playerId === playerId) link.playerId = null;
    }
    this.publish([]);
  }

  /** Host-local intent application (the host plays too). */
  hostIntent(intent: ClientIntentMessage): ApplyResult {
    const result = applyIntent(this.session, intent);
    this.consume(result);
    return result;
  }

  /* ------------------------------------------------------------- join handling */

  private acceptConnection(connection: TransportConnection): void {
    const link: PeerLink = {
      peerId: connection.peerId,
      connection,
      playerId: null,
      proposedId: null,
      attempts: [],
      pending: null,
      nickname: null,
    };
    this.links.set(connection.peerId, link);
    this.inboundSeq.forget(connection.peerId);
    connection.onMessage((frame) => {
      this.handleFrame(link, frame);
    });
    connection.onClose(() => {
      this.handleDisconnect(connection.peerId);
    });
  }

  private handleFrame(link: PeerLink, frame: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(frame);
    } catch {
      return;
    }
    const message = parsed as NetMessage;
    if (message.v !== NET_PROTOCOL_VERSION) {
      this.options.onError?.('protocol-version-mismatch', link.peerId);
      return;
    }
    if (!this.inboundSeq.accept(link.peerId, message.seq)) return;

    if (message.type === 'INTENT_JOIN') {
      this.handleJoin(link, message.from, message.payload);
      return;
    }
    if (!isClientIntent(message)) {
      this.reject(link, 'not-a-client-intent');
      return;
    }
    if (link.playerId === null) {
      this.reject(link, 'not-joined');
      return;
    }
    if (message.from !== link.playerId) {
      // The frame claims a seat it does not own. Dropped, and the seat is told.
      this.reject(link, 'seat-mismatch');
      return;
    }
    const result = applyIntent(this.session, message);
    this.consume(result);
  }

  private handleJoin(link: PeerLink, proposedId: string, payload: JoinPayload): void {
    if (this.rateLimited(link)) {
      this.reject(link, 'rate-limited', proposedId);
      return;
    }
    if (link.playerId !== null) {
      // Already seated on this connection: a second join is a protocol error.
      this.reject(link, 'already-joined', proposedId);
      return;
    }
    if (this.reconnectSeat(link, payload)) return;

    link.nickname = payload.nickname;
    if (this.hasInviteToken(payload)) {
      this.admit(link, proposedId, payload);
      return;
    }
    if (this.session.state.players.length >= MAX_PLAYERS) {
      this.reject(link, 'room-full', proposedId);
      return;
    }
    link.proposedId = proposedId;
    link.pending = payload;
    // The joiner is not seated yet, so `broadcastMessage` (which only talks to
    // seated links) would skip it. Tell it directly that it is waiting, then
    // fan the notice out so the host UI can render the request too.
    this.send(link, 'JOIN_PENDING', { playerId: proposedId, nickname: payload.nickname });
    this.broadcastMessage('JOIN_PENDING', { playerId: proposedId, nickname: payload.nickname });
    this.options.onJoinRequest?.({
      connectionPeerId: link.peerId,
      nickname: payload.nickname,
      characterId: payload.characterId,
      approve: () => {
        this.settlePending(link, true);
      },
      reject: () => {
        this.settlePending(link, false);
      },
    });
  }

  /** The share link carries the invite token, so possession of it is the proof. */
  private hasInviteToken(payload: JoinPayload): boolean {
    const roomId = payload.roomId;
    if (roomId === undefined) return false;
    return roomId.slice(roomId.indexOf('-') + 1) === this.options.credentials.inviteToken;
  }

  /**
   * REQ-011: a returning client presents the seat id plus the host-issued token.
   * A nickname alone never rebinds a seat, so a stranger cannot hijack one.
   */
  private reconnectSeat(link: PeerLink, payload: JoinPayload): boolean {
    const reconnect = payload.reconnect;
    if (reconnect === undefined) return false;
    const expected = this.seatTokens.get(reconnect.playerId);
    if (expected === undefined || expected !== reconnect.token) {
      this.reject(link, 'unknown-seat-token', reconnect.playerId);
      return true;
    }
    const seatIndex = this.session.state.players.findIndex(
      (player) => player.id === reconnect.playerId,
    );
    if (seatIndex < 0) {
      this.reject(link, 'unknown-seat', reconnect.playerId);
      return true;
    }
    this.session = setPlayerConnected(this.session, reconnect.playerId, true).session;
    link.playerId = reconnect.playerId;
    link.pending = null;
    this.send(link, 'JOIN_ACCEPTED', {
      playerId: reconnect.playerId,
      seatIndex,
      reconnectToken: expected,
    });
    this.send(link, 'STATE_SNAPSHOT', { state: this.session.state });
    this.broadcastRoomInfo();
    this.options.onPeersChanged?.(this.connectedSeats());
    return true;
  }

  private settlePending(link: PeerLink, approve: boolean): void {
    const payload = link.pending;
    const proposedId = link.proposedId;
    if (payload === null || proposedId === null) return;
    link.pending = null;
    link.proposedId = null;
    if (!approve) {
      this.reject(link, 'declined', proposedId);
      return;
    }
    if (this.session.state.players.length >= MAX_PLAYERS) {
      this.reject(link, 'room-full', proposedId);
      return;
    }
    this.admit(link, proposedId, payload);
  }

  /**
   * Creates the seat. The id is the one the client proposed in `INTENT_JOIN.from`
   * — the host verifies it is free rather than trusting it, so a client cannot
   * overwrite an existing seat.
   */
  private admit(link: PeerLink, proposedId: string, payload: JoinPayload): void {
    if (this.session.state.players.some((player) => player.id === proposedId)) {
      this.reject(link, 'seat-taken', proposedId);
      return;
    }
    const characterId =
      payload.characterId ?? firstFreeCharacterId(this.session, this.options.pack.characters);
    const result = addPlayer(this.session, {
      id: proposedId,
      nickname: payload.nickname,
      characterId,
      isAI: false,
    });
    if (result.rejected !== null) {
      this.reject(link, result.rejected, proposedId);
      return;
    }
    this.session = result.session;
    const token = this.mintToken();
    this.seatTokens.set(proposedId, token);
    link.playerId = proposedId;
    link.pending = null;
    link.proposedId = null;
    const seatIndex = this.session.state.players.findIndex((player) => player.id === proposedId);
    this.send(link, 'JOIN_ACCEPTED', { playerId: proposedId, seatIndex, reconnectToken: token });
    this.send(link, 'STATE_SNAPSHOT', { state: this.session.state });
    this.publish([]);
    this.broadcastRoomInfo();
    this.options.onPeersChanged?.(this.connectedSeats());
  }

  /** Rejects a join on a specific connection, naming the seat being refused. */
  private reject(link: PeerLink, reason: string, playerId?: string): void {
    this.send(link, 'JOIN_REJECTED', {
      playerId: playerId ?? link.playerId ?? link.proposedId ?? 'unknown',
      reason,
    });
  }

  private rateLimited(link: PeerLink): boolean {
    const now = this.now();
    link.attempts = link.attempts.filter((at) => now - at < JOIN_ATTEMPT_WINDOW_MS);
    link.attempts.push(now);
    return link.attempts.length > JOIN_ATTEMPT_LIMIT;
  }

  private handleDisconnect(peerId: string): void {
    const link = this.links.get(peerId);
    this.links.delete(peerId);
    if (link?.playerId == null) return;
    const result = setPlayerConnected(this.session, link.playerId, false);
    this.session = result.session;
    this.publish([]);
    this.options.onPeersChanged?.(this.connectedSeats());
  }

  /* --------------------------------------------------------------- broadcast */

  private consume(result: ApplyResult): void {
    this.session = result.session;
    if (result.rejected !== null) {
      // No dedicated wire event exists for a refusal (spec §4 has none), so the
      // host surfaces it locally and simply does not broadcast anything: the
      // client's mirror is unchanged, which is the correct outcome.
      this.options.onError?.('intent-rejected', result.rejected);
      return;
    }
    this.publish(result.events);
  }

  /** Fans the produced events out, then re-arms the mini-game deadline. */
  private publish(events: readonly GameEvent[]): void {
    for (const event of events) this.options.onEvent?.(event);
    if (events.length > 0) {
      this.broadcastMessage('STATE_EVENT', { events: [...events] });
    }
    this.options.onStateChanged?.(this.session.state);
    this.syncMinigameTimer();
  }

  private broadcastMessage(type: NetMessage['type'], payload: unknown): void {
    for (const link of this.links.values()) {
      if (link.playerId === null) continue;
      this.send(link, type, payload);
    }
  }

  private broadcastRoomInfo(): void {
    const state = this.session.state;
    this.broadcastMessage('ROOM_INFO', {
      roomId: this.options.credentials.roomId,
      roomCode: this.options.credentials.roomCode,
      hostPeerId: this.options.credentials.peerId,
      mapId: state.mapId,
      config: state.roomConfig,
      players: state.players.map(({ id, nickname, characterId, isAI, connected }) => ({
        id,
        nickname,
        characterId,
        isAI,
        connected,
      })),
    });
  }

  broadcastSnapshot(): void {
    this.broadcastMessage('STATE_SNAPSHOT', { state: this.session.state });
  }

  private send(link: PeerLink, type: NetMessage['type'], payload: unknown): void {
    link.connection.send(encodeMessage(this.envelope(type, payload)));
  }

  private envelope(type: NetMessage['type'], payload: unknown): NetMessage {
    const message = {
      v: NET_PROTOCOL_VERSION,
      type,
      seq: this.outboundSeq,
      from: 'host',
      payload,
    } as NetMessage;
    this.outboundSeq += 1;
    return message;
  }

  /* ---------------------------------------------------------- mini-game timer */

  private syncMinigameTimer(): void {
    const { phase, minigame } = this.session.state;
    if (phase !== 'MINIGAME' || minigame === null) {
      this.clearMinigameTimer();
      return;
    }
    if (this.minigameTimer !== null) return;
    this.minigameTimer = setTimeout(() => {
      this.minigameTimer = null;
      this.consume(forceResolveMiniGame(this.session));
    }, MINIGAME_DEADLINE_MS);
  }

  private clearMinigameTimer(): void {
    if (this.minigameTimer !== null) {
      clearTimeout(this.minigameTimer);
      this.minigameTimer = null;
    }
  }

  /** Test seam: fire the mini-game deadline immediately. */
  forceMinigameDeadline(): void {
    this.clearMinigameTimer();
    this.consume(forceResolveMiniGame(this.session));
  }

  /* ------------------------------------------------------------------ helpers */

  stateHash(): string {
    return hashState(this.session.state);
  }

  private nextSeatId(): string {
    let index = this.session.state.players.length + 1;
    for (;;) {
      const id = `p${index}`;
      if (!this.session.state.players.some((player) => player.id === id)) return id;
      index += 1;
    }
  }

  private mintToken(): string {
    let token = '';
    for (let i = 0; i < 4; i += 1) {
      token += (this.randomInt(0x1_0000_0000) ?? 0).toString(16).padStart(8, '0');
    }
    return token;
  }
}

/* -------------------------------------------------------------------- helpers */

function firstCharacterId(pack: ContentPack): string {
  return pack.characters[0]?.id ?? 'char_farmer';
}

function firstFreeCharacterId(session: GameSession, characters: readonly Character[]): string {
  const taken = new Set(session.state.players.map((player) => player.characterId));
  const free = characters.find((character) => !taken.has(character.id));
  return free?.id ?? characters[0]?.id ?? 'char_farmer';
}

function defaultRandomInt(maxExclusive: number): number | null {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues === undefined) return null;
  const buffer = new Uint32Array(1);
  cryptoApi.getRandomValues(buffer);
  const value = buffer[0];
  return value === undefined ? null : value % maxExclusive;
}

function defaultSeed(randomInt: RandomInt): string {
  let seed = '';
  for (let i = 0; i < 16; i += 1) {
    seed += (randomInt(36) ?? 0).toString(36);
  }
  return `room-${seed}`;
}

/** Room credentials for a brand-new room. Returns `null` without a CSPRNG. */
export function makeHostCredentials(randomInt?: RandomInt): RoomCredentials | null {
  return makeRoomCredentials(randomInt ?? defaultRandomInt);
}
