import type { RoomConfig } from '@/engine/contracts/config';
import type {
  Character,
  ChaosEvent,
  MapDefinition,
  MiniGameDefinition,
} from '@/engine/contracts/content';
import type { ClientIntent } from '@/engine/contracts/net';
import type { GameEvent, GameState } from '@/engine/contracts/state';
import { decide } from '@/engine/ai';
import { applyIntent, createSession, startGame, type GameSession } from '@/engine/reducer';

/**
 * Drives a table on one machine: the human seat, the AI seats, and the loop that
 * lets the AI take its turn. It is deliberately free of React and of the network
 * so the same logic serves single-player today and a host with AI seats later.
 *
 * AI actions are scheduled on a timer rather than applied inside a state
 * notification: applying while the reducer is still unwinding would re-enter it,
 * and a small delay is what makes an AI turn watchable.
 */

export interface TableContent {
  readonly map: MapDefinition;
  readonly characters: readonly Character[];
  readonly chaosEvents: readonly ChaosEvent[];
  readonly miniGames: readonly MiniGameDefinition[];
}

export interface SeatSpec {
  readonly id: string;
  readonly nickname: string;
  readonly characterId: string;
  readonly isAI: boolean;
}

export interface CreateTableOptions {
  readonly content: TableContent;
  readonly roomConfig: RoomConfig;
  readonly seats: readonly SeatSpec[];
  readonly seed: string;
  /** Milliseconds between AI actions; tests pass 0. */
  readonly aiDelayMs?: number;
  readonly schedule?: (run: () => void, delayMs: number) => () => void;
}

export interface TableSnapshot {
  readonly state: GameState;
  readonly events: readonly GameEvent[];
  /** Most recent die face, for the 3D die. */
  readonly lastRoll: number | null;
}

export interface GameTable {
  getSnapshot(): TableSnapshot;
  subscribe(listener: () => void): () => void;
  /** Apply a human intent; refusals are reported through the snapshot's events. */
  dispatch(intent: ClientIntent): void;
  /** True while an AI action is queued, so the UI can show "思考中". */
  isThinking(): boolean;
  dispose(): void;
}

function defaultSchedule(run: () => void, delayMs: number): () => void {
  const handle = setTimeout(run, delayMs);
  return () => clearTimeout(handle);
}

/** The seat that must act next, if it is an AI seat; null means "wait for a human". */
export function nextAiActor(session: GameSession): string | null {
  const state = session.state;
  if (state.phase === 'GAME_OVER' || state.phase === 'SETUP') return null;

  const minigame = state.minigame;
  if (minigame !== null) {
    const missing = minigame.participantIds.find((id) => minigame.submissions[id] === undefined);
    if (missing !== undefined) {
      return session.state.players.find((player) => player.id === missing)?.isAI === true
        ? missing
        : null;
    }
    return null;
  }

  const pending = state.pendingChoice;
  if (pending !== null) {
    return session.state.players.find((player) => player.id === pending.playerId)?.isAI === true
      ? pending.playerId
      : null;
  }

  const active = state.players[state.activePlayerIndex];
  if (active === undefined || !active.isAI) return null;
  return active.id;
}

export function createGameTable(options: CreateTableOptions): GameTable {
  const schedule = options.schedule ?? defaultSchedule;
  const aiDelayMs = options.aiDelayMs ?? 650;

  let session = createSession({
    seed: options.seed,
    map: options.content.map,
    roomConfig: options.roomConfig,
    characters: options.content.characters,
    chaosEvents: options.content.chaosEvents,
    miniGames: options.content.miniGames,
    players: options.seats,
  });

  let lastRoll: number | null = null;
  const listeners = new Set<() => void>();
  let cancelScheduled: (() => void) | null = null;
  let disposed = false;
  let snapshot: TableSnapshot = { state: session.state, events: [], lastRoll };

  const notify = (): void => {
    snapshot = { state: session.state, events: snapshot.events, lastRoll };
    for (const listener of listeners) listener();
  };

  const publish = (events: readonly GameEvent[]): void => {
    for (const event of events) {
      if (event.type === 'DICE_ROLLED') {
        const die = event.data['die'];
        if (typeof die === 'number') lastRoll = die;
      }
    }
    snapshot = { state: session.state, events, lastRoll };
    for (const listener of listeners) listener();
  };

  const pump = (): void => {
    if (disposed) return;
    cancelScheduled = null;
    const actor = nextAiActor(session);
    if (actor === null) {
      notify();
      return;
    }
    const intent = decide(session, actor);
    if (intent === null) {
      notify();
      return;
    }
    const result = applyIntent(session, { ...intent, v: 1, seq: 0, from: actor });
    session = result.session;
    publish(result.events);
    cancelScheduled = schedule(pump, aiDelayMs);
  };

  const started = startGame(session);
  if (started.rejected !== null) {
    // A table that cannot start must fail loudly: otherwise the UI would sit in
    // SETUP forever with no explanation.
    throw new Error(`table could not start: ${started.rejected}`);
  }
  session = started.session;
  publish(started.events);
  pump();

  return {
    getSnapshot: () => snapshot,
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    dispatch(intent) {
      if (disposed) return;
      const result = applyIntent(session, intent);
      session = result.session;
      if (result.rejected !== null) {
        snapshot = { ...snapshot, state: session.state, events: result.events, lastRoll };
        for (const listener of listeners) listener();
      } else {
        publish(result.events);
      }
      if (cancelScheduled === null) pump();
    },
    isThinking: () => cancelScheduled !== null,
    dispose() {
      disposed = true;
      cancelScheduled?.();
      cancelScheduled = null;
      listeners.clear();
    },
  };
}
