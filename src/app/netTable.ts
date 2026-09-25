import { decide } from '@/engine/ai';
import type { RoomConfig } from '@/engine/contracts/config';
import type { ClientIntent } from '@/engine/contracts/net';
import type { GameEvent, GameState } from '@/engine/contracts/state';

import type { ClientSession, ClientStatus, RoomInfo } from '@/net/client';
import type { HostSession, JoinRequest } from '@/net/host';
import type { TableSnapshot } from './session';
import type { TableView } from './useTable';

const HISTORY = 40;
const DEFAULT_AI_DELAY_MS = 700;

function rollFrom(events: readonly GameEvent[]): number | null {
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index];
    if (event === undefined) continue;
    const die = event.type === 'DICE_ROLLED' ? event.data.die : undefined;
    if (typeof die === 'number') return die;
  }
  return null;
}

/** Keeps the tail of the event stream plus the last die value for the 3D die. */
class EventTail {
  private events: GameEvent[] = [];
  private lastRoll: number | null = null;

  push(event: GameEvent): void {
    this.events.push(event);
    if (this.events.length > HISTORY) this.events = this.events.slice(-HISTORY);
    const die = event.type === 'DICE_ROLLED' ? event.data.die : undefined;
    if (typeof die === 'number') this.lastRoll = die;
  }

  reset(state: GameState): void {
    this.events = state.eventLog.slice(-HISTORY);
    this.lastRoll = rollFrom(this.events);
  }

  snapshot(state: GameState): TableSnapshot {
    return { state, events: this.events, lastRoll: this.lastRoll };
  }
}

/** The seat that must act next, mirroring the reducer's authority rules. */
export function nextActor(state: GameState): string | null {
  const minigame = state.minigame;
  if (minigame !== null) {
    const waiting = minigame.participantIds.find((id) => minigame.submissions[id] === undefined);
    return waiting ?? null;
  }
  const pending = state.pendingChoice;
  if (pending !== null) return pending.playerId;
  return state.players[state.activePlayerIndex]?.id ?? null;
}

/* ------------------------------------------------------------------- host */

/** Hooks the host session calls; the adapter passes them at construction time. */
export interface HostHooks {
  onEvent(event: GameEvent): void;
  onStateChanged(): void;
  onJoinRequest(request: JoinRequest): void;
}

export interface HostRoomView {
  roomId: string;
  roomCode: string;
  hostPeerId: string;
  mapId: string;
  config: RoomConfig;
  players: GameState['players'];
}

export interface HostTable extends TableView {
  readonly host: HostSession;
  info(): HostRoomView;
  requests(): readonly JoinRequest[];
  decideRequest(connectionPeerId: string, approve: boolean): void;
  addAi(): boolean;
  setConfig(config: RoomConfig): void;
  begin(): { ok: true } | { ok: false; reason: string };
  stop(): void;
}

export interface HostTableOptions {
  /** Builds the host session with the adapter's hooks already wired. */
  createHost(hooks: HostHooks): HostSession;
  aiDelayMs?: number;
  schedule?: (run: () => void, delayMs: number) => void;
}

/**
 * Adapts the host's authoritative session to the UI. The host both renders the
 * table and drives the AI seats, so its own view is immediate; remote clients
 * receive snapshots over the wire.
 */
export function createHostTable(options: HostTableOptions): HostTable {
  const schedule = options.schedule ?? ((run, delayMs) => setTimeout(run, delayMs));
  const delay = options.aiDelayMs ?? DEFAULT_AI_DELAY_MS;
  const tail = new EventTail();
  const listeners = new Set<() => void>();
  const requests = new Map<string, JoinRequest>();
  let seq = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const publish = (): void => {
    for (const listener of listeners) listener();
  };

  const host = options.createHost({
    onEvent(event) {
      tail.push(event);
      publish();
    },
    onStateChanged() {
      publish();
      pump();
    },
    onJoinRequest(request) {
      requests.set(request.connectionPeerId, request);
      publish();
    },
  });

  function pump(): void {
    if (timer !== null) return;
    const state = host.state;
    if (state.phase === 'GAME_OVER' || state.phase === 'SETUP') return;

    const actor = nextActor(state);
    if (actor === null) return;
    const player = state.players.find((entry) => entry.id === actor);
    if (player === undefined || !player.isAI) return;

    timer = schedule(() => {
      timer = null;
      const intent = decide(host.gameSession, actor);
      if (intent === null) return;
      seq += 1;
      host.hostIntent({ ...intent, v: 1, seq, from: actor });
      pump();
    }, delay) as unknown as ReturnType<typeof setTimeout>;
  }

  tail.reset(host.state);
  const snap = (): TableSnapshot => tail.snapshot(host.state);

  return {
    host,
    getSnapshot: snap,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(intent) {
      const from = intent.from ?? host.state.players[0]?.id ?? '';
      seq += 1;
      host.hostIntent({ ...intent, v: 1, seq, from });
    },
    info: () => ({
      roomId: host.credentials.roomId,
      roomCode: host.credentials.roomCode,
      hostPeerId: host.credentials.peerId,
      mapId: host.state.mapId,
      config: host.state.roomConfig,
      players: host.state.players,
    }),
    requests: () => [...requests.values()],
    decideRequest(connectionPeerId, approve) {
      const request = requests.get(connectionPeerId);
      if (request === undefined) return;
      requests.delete(connectionPeerId);
      if (approve) request.approve();
      else request.reject();
      publish();
    },
    addAi: () => host.addAiPlayer(`电脑 ${host.state.players.length}`) !== null,
    setConfig(config) {
      host.setRoomConfig(config);
      publish();
    },
    begin: () => host.begin(),
    stop: () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      host.stop();
    },
  };
}

/* ----------------------------------------------------------------- client */

export interface ClientHooks {
  onStatus(status: ClientStatus): void;
  onState(state: GameState): void;
  onEvent(event: GameEvent): void;
  onRoomInfo(info: RoomInfo): void;
  onRejected(reason: string): void;
}

export interface ClientTable extends TableView {
  readonly client: ClientSession;
  status(): ClientStatus;
  info(): RoomInfo | null;
  playerId(): string | null;
  rejections(): readonly string[];
  close(): void;
}

const EMPTY_STATE = {
  version: 1,
  seed: '',
  mapId: '',
  turn: 0,
  activePlayerIndex: 0,
  phase: 'SETUP',
  players: [],
  board: { tiles: {} },
  economy: {},
  roomConfig: {},
  rngCursor: 0,
  eventSeq: 0,
  eventLog: [],
  pendingChoice: null,
  minigame: null,
  winnerId: null,
  chaosPool: [],
} as unknown as GameState;

export interface ClientTableOptions {
  createClient(hooks: ClientHooks): ClientSession;
}

export function createClientTable(options: ClientTableOptions): ClientTable {
  const tail = new EventTail();
  const listeners = new Set<() => void>();
  const rejections: string[] = [];
  let state: GameState | null = null;
  let info: RoomInfo | null = null;
  let status: ClientStatus = 'idle';

  const publish = (): void => {
    for (const listener of listeners) listener();
  };

  const client = options.createClient({
    onStatus(next) {
      status = next;
      publish();
    },
    onState(next) {
      state = next;
      tail.reset(next);
      publish();
    },
    onEvent(event) {
      tail.push(event);
      publish();
    },
    onRoomInfo(next) {
      info = next;
      publish();
    },
    onRejected(reason) {
      rejections.push(reason);
      publish();
    },
  });

  return {
    client,
    getSnapshot: () =>
      state === null ? { state: EMPTY_STATE, events: [], lastRoll: null } : tail.snapshot(state),
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch: (intent: ClientIntent) => {
      client.sendIntent(intent);
    },
    status: () => status,
    info: () => info,
    playerId: () => client.seatPlayerId,
    rejections: () => rejections,
    close: () => client.close(),
  };
}
