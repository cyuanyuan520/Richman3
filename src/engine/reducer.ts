/**
 * Host-authoritative rules engine (REQ-001/REQ-004/REQ-005).
 *
 * The reducer is pure and synchronous: `applyIntent` validates the intent
 * against the current phase and player, then returns a new session plus the
 * `GameEvent`s that the host must broadcast. All randomness flows through
 * `(state.seed, state.rngCursor)` so an identical seed and intent sequence
 * always produces an identical state hash.
 */

import type {
  ChaosEvent,
  Character,
  MapDefinition,
  MiniGameDefinition,
  RingTile,
} from './contracts/content';
import type { ClientIntentMessage } from './contracts/net';
import type { GameEvent, GameState, MiniGameState, PendingChoice, Player } from './contracts/state';
import { MAX_EVENT_LOG } from './contracts/state';
import type { RoomConfig } from './contracts/config';
import type { BoardGeometry } from './movement';
import {
  buildGeometry,
  outgoingWarp,
  resolveRingMove,
  withCenterPosition,
  withRingPosition,
} from './movement';
import { bonusFor, propertyInvested, rentFor, resolveEconomy, taxFor } from './economy';
import type { EffectNote } from './effects';
import { activeSkillEffects, applyEffects } from './effects';
import type { SkillRegistry } from './skills';
import { canUseSkill, rentMultiplier, triggerEffects } from './skills';
import { pickWeighted, rngFloat, rngInt, rngIntInclusive } from './rng';
import { MINIGAME_RESOLVERS } from './minigames';

export interface GameSession {
  readonly state: GameState;
  readonly map: MapDefinition;
  readonly registry: SkillRegistry;
  readonly geometry: BoardGeometry;
  readonly chaosById: ReadonlyMap<string, ChaosEvent>;
  readonly miniGameById: ReadonlyMap<string, MiniGameDefinition>;
  readonly priceByTileId: ReadonlyMap<string, number>;
}

export interface CreateGameInput {
  readonly seed: string;
  readonly map: MapDefinition;
  readonly roomConfig: RoomConfig;
  readonly characters: readonly Character[];
  readonly chaosEvents: readonly ChaosEvent[];
  readonly miniGames: readonly MiniGameDefinition[];
  readonly players: readonly {
    readonly id: string;
    readonly nickname: string;
    readonly characterId: string;
    readonly isAI: boolean;
  }[];
}

export interface ApplyResult {
  readonly session: GameSession;
  readonly events: readonly GameEvent[];
  /** Non-null when the intent was refused; the state is then unchanged. */
  readonly rejected: string | null;
}

/* --------------------------------------------------------------- emitter */

class Emitter {
  events: GameEvent[] = [];
  turn: number;
  private seq: number;

  constructor(state: GameState) {
    this.seq = state.eventSeq;
    this.turn = state.turn;
  }

  push(type: string, playerId: string | null, data: Record<string, unknown> = {}): void {
    this.events.push({ seq: this.seq, type, turn: this.turn, playerId, data });
    this.seq += 1;
  }
}

function flush(state: GameState, emitter: Emitter): GameState {
  if (emitter.events.length === 0) return state;
  const combined = [...state.eventLog, ...emitter.events];
  const trimmed =
    combined.length > MAX_EVENT_LOG ? combined.slice(combined.length - MAX_EVENT_LOG) : combined;
  const last = trimmed[trimmed.length - 1];
  return {
    ...state,
    eventLog: trimmed,
    eventSeq: last === undefined ? state.eventSeq : last.seq + 1,
    turn: emitter.turn,
  };
}

/* ------------------------------------------------------------- helpers */

function findPlayer(state: GameState, playerId: string): Player | undefined {
  return state.players.find((player) => player.id === playerId);
}

function replacePlayerState(state: GameState, next: Player): GameState {
  return {
    ...state,
    players: state.players.map((player) => (player.id === next.id ? next : player)),
  };
}

function activePlayer(state: GameState): Player | undefined {
  return state.players[state.activePlayerIndex];
}

function nonBankrupt(state: GameState): Player[] {
  return state.players.filter((player) => !player.bankrupt);
}

function syncProperties(state: GameState): GameState {
  const byOwner = new Map<string, Player['properties']>();
  for (const tileState of Object.values(state.board.tiles)) {
    if (tileState.ownerId === null) continue;
    const list = byOwner.get(tileState.ownerId) ?? [];
    list.push({ tileId: tileState.tileId, level: tileState.level, mortgaged: tileState.mortgaged });
    byOwner.set(tileState.ownerId, list);
  }
  return {
    ...state,
    players: state.players.map((player) => ({
      ...player,
      properties: [...(byOwner.get(player.id) ?? [])].sort((a, b) =>
        a.tileId.localeCompare(b.tileId),
      ),
    })),
  };
}

function netWorth(session: GameSession, player: Player): number {
  let total = player.money;
  for (const property of player.properties) {
    const price = session.priceByTileId.get(property.tileId);
    if (price === undefined) continue;
    total += propertyInvested(session.state.economy, price, property.level);
    // A mortgaged property is pledged: the loan must not count as net worth,
    // otherwise mortgaging would inflate the player towards the asset target.
    if (property.mortgaged) {
      total -= mortgageValueFor(session, price, property.level);
    }
  }
  return total;
}

function noteToEvent(note: EffectNote): {
  type: string;
  playerId: string | null;
  data: Record<string, unknown>;
} {
  switch (note.type) {
    case 'MONEY':
      return { type: 'MONEY_CHANGED', playerId: note.playerId, data: { amount: note.amount } };
    case 'SALARY':
      return { type: 'SALARY_PAID', playerId: note.playerId, data: { amount: note.amount } };
    case 'MOVE':
      return { type: 'PLAYER_MOVED', playerId: note.playerId, data: { steps: note.steps } };
    case 'SWAP_POS':
      return { type: 'POSITIONS_SWAPPED', playerId: note.a, data: { with: note.b } };
    case 'SKIP_TURN':
      return { type: 'TURN_SKIP_QUEUED', playerId: note.playerId, data: { turns: note.turns } };
    case 'STATUS':
      return {
        type: 'STATUS_APPLIED',
        playerId: note.playerId,
        data: { status: note.status, duration: note.duration },
      };
    case 'WARP':
      return { type: 'PLAYER_WARPED', playerId: note.playerId, data: { target: note.target } };
    case 'VISUAL':
      return { type: 'VISUAL_CUE', playerId: note.playerId, data: { visual: note.visual } };
    case 'SKILL':
      return { type: 'SKILL_TRIGGERED', playerId: note.playerId, data: { skillId: note.skillId } };
    case 'NOOP':
      return { type: 'EFFECT_SKIPPED', playerId: note.playerId, data: { reason: note.reason } };
    default:
      return { type: 'EFFECT_UNKNOWN', playerId: null, data: {} };
  }
}

/* ------------------------------------------------------------ creation */

export function createSession(input: CreateGameInput): GameSession {
  const economy = resolveEconomy(input.map.rules);
  const geometry = buildGeometry(input.map);

  const tiles: Record<
    string,
    { tileId: string; ownerId: string | null; level: number; mortgaged: boolean }
  > = {};
  for (const tile of input.map.board.ring) {
    tiles[tile.id] = { tileId: tile.id, ownerId: null, level: 0, mortgaged: false };
  }

  const registry: SkillRegistry = {
    bySkillId: new Map(input.characters.map((character) => [character.skill.id, character.skill])),
    byCharacterId: new Map(input.characters.map((character) => [character.id, character])),
  };

  const startIndex = input.map.board.ring.findIndex((tile) => tile.type === 'START');

  const state: GameState = {
    version: 1,
    seed: input.seed,
    mapId: input.map.id,
    turn: 1,
    activePlayerIndex: 0,
    phase: 'SETUP',
    players: input.players.map((player) => ({
      id: player.id,
      nickname: player.nickname,
      characterId: player.characterId,
      isAI: player.isAI,
      money: economy.startingMoney,
      position: { zone: 'ring', index: startIndex < 0 ? 0 : startIndex },
      bankrupt: false,
      skipTurns: 0,
      properties: [],
      statuses: [],
      skillCooldowns: {},
      connected: true,
    })),
    board: { tiles },
    economy,
    roomConfig: input.roomConfig,
    rngCursor: 0,
    eventSeq: 0,
    eventLog: [],
    pendingChoice: null,
    winnerId: null,
    chaosPool: [...input.map.events],
    minigame: null,
  };

  return {
    state: syncProperties(state),
    map: input.map,
    registry,
    geometry,
    chaosById: new Map(input.chaosEvents.map((event) => [event.id, event])),
    miniGameById: new Map(input.miniGames.map((entry) => [entry.id, entry])),
    priceByTileId: new Map(
      input.map.board.ring
        .filter((tile) => tile.price !== undefined)
        .map((tile) => [tile.id, tile.price ?? 0] as const),
    ),
  };
}

/** Moves a session from SETUP to the first turn. */
export function startGame(session: GameSession): ApplyResult {
  const emitter = new Emitter(session.state);
  if (session.state.phase !== 'SETUP') {
    return { session, events: [], rejected: 'game-already-started' };
  }
  if (session.state.players.length < 2) {
    return { session, events: [], rejected: 'not-enough-players' };
  }
  const uniqueCharacters = new Set(session.state.players.map((player) => player.characterId));
  if (uniqueCharacters.size !== session.state.players.length) {
    return { session, events: [], rejected: 'duplicate-characters' };
  }

  let state: GameState = { ...session.state, phase: 'AWAIT_ROLL' };
  emitter.push('GAME_STARTED', null, { seed: state.seed, mapId: state.mapId });
  state = applyTurnStartTriggers({ ...session, state }, emitter);
  emitter.push('TURN_START', activePlayer(state)?.id ?? null, { turn: state.turn });
  return {
    session: { ...session, state: flush(state, emitter) },
    events: emitter.events,
    rejected: null,
  };
}

/* ------------------------------------------------------- trigger helpers */

function applyTurnStartTriggers(session: GameSession, emitter: Emitter): GameState {
  let state = session.state;
  const player = activePlayer(state);
  if (player === undefined) return state;
  const effects = triggerEffects(player, session.registry, 'ON_TURN_START');
  if (effects.length === 0) return state;
  const outcome = applyEffects(
    state,
    player.id,
    player.id,
    effects,
    session.geometry,
    session.registry,
  );
  state = outcome.state;
  for (const note of outcome.notes) {
    const event = noteToEvent(note);
    emitter.push(event.type, event.playerId, event.data);
  }
  state = settleInsolvency({ ...session, state }, player.id, null, emitter);
  return state;
}

function tickStatuses(state: GameState, playerId: string): GameState {
  const player = findPlayer(state, playerId);
  if (player === undefined) return state;
  const statuses = player.statuses
    .map((status) => ({ ...status, remainingTurns: status.remainingTurns - 1 }))
    .filter((status) => status.remainingTurns > 0);
  const cooldowns: Record<string, number> = {};
  for (const [skillId, turns] of Object.entries(player.skillCooldowns)) {
    if (turns > 1) cooldowns[skillId] = turns - 1;
  }
  return replacePlayerState(state, { ...player, statuses, skillCooldowns: cooldowns });
}

/* --------------------------------------------------------------- money */

/**
 * Auto-mortgages the player's properties (lowest tile id first) until the
 * balance is non-negative, then declares bankruptcy if it still is not.
 */
function settleInsolvency(
  session: GameSession,
  playerId: string,
  creditorId: string | null,
  emitter: Emitter,
): GameState {
  let state = session.state;
  let player = findPlayer(state, playerId);
  if (player === undefined || player.bankrupt || player.money >= 0) return state;

  const ordered = [...player.properties].sort((a, b) => a.tileId.localeCompare(b.tileId));
  for (const property of ordered) {
    if (player.money >= 0) break;
    if (property.mortgaged) continue;
    const price = session.priceByTileId.get(property.tileId) ?? 0;
    const value = mortgageValueFor(session, price, property.level);
    state = setTileState(state, property.tileId, { mortgaged: true });
    state = syncProperties(state);
    player = findPlayer(state, playerId);
    if (player === undefined) break;
    state = replacePlayerState(state, { ...player, money: player.money + value });
    emitter.push('PROPERTY_MORTGAGED', playerId, {
      tileId: property.tileId,
      amount: value,
      automatic: true,
    });
  }

  player = findPlayer(state, playerId);
  if (player === undefined || player.money >= 0) return state;

  // Bankruptcy: remaining assets go to the creditor, or back to the bank.
  for (const property of player.properties) {
    if (creditorId === null) {
      state = setTileState(state, property.tileId, { ownerId: null, level: 0, mortgaged: false });
    } else {
      state = setTileState(state, property.tileId, { ownerId: creditorId, mortgaged: false });
    }
  }
  state = replacePlayerState(state, {
    ...player,
    money: 0,
    bankrupt: true,
    properties: [],
    statuses: [],
    skipTurns: 0,
  });
  state = syncProperties(state);
  emitter.push('PLAYER_BANKRUPT', playerId, { creditorId });
  return checkVictory({ ...session, state }, emitter);
}

function mortgageValueFor(session: GameSession, price: number, level: number): number {
  const invested = propertyInvested(session.state.economy, price, level);
  return Math.round(invested * session.state.economy.mortgageRatio);
}

function setTileState(
  state: GameState,
  tileId: string,
  patch: Partial<{ ownerId: string | null; level: number; mortgaged: boolean }>,
): GameState {
  const current = state.board.tiles[tileId];
  if (current === undefined) return state;
  return {
    ...state,
    board: { ...state.board, tiles: { ...state.board.tiles, [tileId]: { ...current, ...patch } } },
  };
}

function transferMoney(
  session: GameSession,
  payerId: string,
  amount: number,
  payeeId: string | null,
  emitter: Emitter,
): GameState {
  if (amount <= 0) return session.state;
  let state = session.state;
  const payer = findPlayer(state, payerId);
  if (payer === undefined) return state;
  state = replacePlayerState(state, { ...payer, money: payer.money - amount });
  emitter.push('MONEY_PAID', payerId, { amount, payeeId });
  if (payeeId !== null) {
    const payee = findPlayer(state, payeeId);
    if (payee !== undefined) {
      state = replacePlayerState(state, { ...payee, money: payee.money + amount });
    }
  }
  return settleInsolvency({ ...session, state }, payerId, payeeId, emitter);
}

/* -------------------------------------------------------------- movement */

function moveBy(
  session: GameSession,
  playerId: string,
  steps: number,
  emitter: Emitter,
): GameState {
  let state = session.state;
  const player = findPlayer(state, playerId);
  if (player === undefined || player.position.zone !== 'ring') return state;
  const { index, laps } = resolveRingMove(player.position.index, steps, session.geometry.ringSize);
  state = replacePlayerState(state, withRingPosition(player, index));
  emitter.push('PLAYER_MOVED', playerId, { steps, to: index });
  if (laps > 0) {
    const amount = laps * state.economy.salary;
    const moved = findPlayer(state, playerId);
    if (moved !== undefined) {
      state = replacePlayerState(state, { ...moved, money: moved.money + amount });
      emitter.push('SALARY_PAID', playerId, { amount, laps });
    }
  }
  return state;
}

/* ------------------------------------------------------------- chaos draw */

function resolveTargets(
  session: GameSession,
  state: GameState,
  triggerId: string,
  target: ChaosEvent['target'],
): string[] {
  switch (target) {
    case 'SELF':
      return [triggerId];
    case 'ALL':
      return nonBankrupt(state).map((player) => player.id);
    case 'LEADER': {
      const candidates = nonBankrupt(state);
      if (candidates.length === 0) return [];
      let best = candidates[0]!;
      for (const player of candidates) {
        if (netWorth(session, player) > netWorth(session, best)) best = player;
      }
      return [best.id];
    }
    case 'RANDOM_OPPONENT': {
      const others = nonBankrupt(state).filter((player) => player.id !== triggerId);
      if (others.length === 0) return [];
      return [others[rngInt(state.seed, state.rngCursor, others.length)]!.id];
    }
    default:
      return [];
  }
}

function drawChaosEvent(
  session: GameSession,
  state: GameState,
  triggerId: string,
  emitter: Emitter,
): GameState {
  const pool = state.chaosPool
    .map((id) => session.chaosById.get(id))
    .filter((event): event is ChaosEvent => event !== undefined);
  if (pool.length === 0) {
    emitter.push('CHAOS_POOL_EMPTY', triggerId, {});
    return state;
  }
  const cursor = state.rngCursor;
  const picked = pickWeighted(
    pool.map((event) => ({ weight: event.weight, value: event })),
    rngFloat(state.seed, cursor),
  );
  let next: GameState = { ...state, rngCursor: cursor + 1 };
  if (picked === null) return next;
  emitter.push('CHAOS_DRAWN', triggerId, {
    eventId: picked.id,
    title: picked.title,
    text: picked.text,
  });
  const targets = resolveTargets(session, next, triggerId, picked.target);
  for (const targetId of targets) {
    const outcome = applyEffects(
      next,
      targetId,
      triggerId,
      picked.effect,
      session.geometry,
      session.registry,
    );
    next = outcome.state;
    for (const note of outcome.notes) {
      const event = noteToEvent(note);
      emitter.push(event.type, event.playerId, event.data);
    }
    next = settleInsolvency({ ...session, state: next }, targetId, null, emitter);
  }
  return next;
}

/* ------------------------------------------------------------- landing */

function setPending(
  state: GameState,
  pending: PendingChoice | null,
  phase: GameState['phase'],
): GameState {
  return { ...state, pendingChoice: pending, phase };
}

function resolveRingLanding(
  session: GameSession,
  state: GameState,
  playerId: string,
  emitter: Emitter,
  depth = 0,
): GameState {
  if (depth > 8) return state;
  const player = findPlayer(state, playerId);
  if (player === undefined || player.position.zone !== 'ring') return state;
  const tile = session.map.board.ring[player.position.index];
  if (tile === undefined) return state;

  let next = applyTileBehaviour(session, state, playerId, tile, emitter, depth);
  if (tile.onEnter !== undefined && tile.onEnter.length > 0) {
    const outcome = applyEffects(
      next,
      playerId,
      playerId,
      tile.onEnter,
      session.geometry,
      session.registry,
    );
    next = outcome.state;
    for (const note of outcome.notes) {
      const event = noteToEvent(note);
      emitter.push(event.type, event.playerId, event.data);
    }
    next = settleInsolvency({ ...session, state: next }, playerId, null, emitter);
  }
  return next;
}

/** Type-specific landing behaviour, before the tile's own `onEnter` effects. */
function applyTileBehaviour(
  session: GameSession,
  state: GameState,
  playerId: string,
  tile: RingTile,
  emitter: Emitter,
  depth: number,
): GameState {
  const player = findPlayer(state, playerId);
  if (player === undefined) return state;
  let next = state;

  switch (tile.type) {
    case 'START': {
      const amount = bonusFor(next.economy);
      next = replacePlayerState(next, { ...player, money: player.money + amount });
      emitter.push('START_BONUS', playerId, { amount });
      return setPending(next, null, 'AWAIT_END_TURN');
    }

    case 'PROPERTY': {
      const tileState = next.board.tiles[tile.id];
      if (tileState === undefined) return setPending(next, null, 'AWAIT_END_TURN');
      if (tileState.ownerId === null) {
        return setPending(
          next,
          { kind: 'BUY_PROPERTY', playerId, tileId: tile.id, options: ['BUY', 'DECLINE'] },
          'AWAIT_CHOICE',
        );
      }
      if (tileState.ownerId === playerId) {
        if (tileState.level < next.economy.maxLevel && !tileState.mortgaged) {
          return setPending(
            next,
            { kind: 'UPGRADE_PROPERTY', playerId, tileId: tile.id, options: ['UPGRADE', 'SKIP'] },
            'AWAIT_CHOICE',
          );
        }
        return setPending(next, null, 'AWAIT_END_TURN');
      }
      const owner = findPlayer(next, tileState.ownerId);
      if (owner === undefined || tileState.mortgaged)
        return setPending(next, null, 'AWAIT_END_TURN');
      if (owner.statuses.some((status) => status.status === 'SHIELD')) {
        const stripped = owner.statuses.filter((status) => status.status !== 'SHIELD');
        next = replacePlayerState(next, { ...owner, statuses: stripped });
        emitter.push('RENT_SHIELDED', tileState.ownerId, { tileId: tile.id });
        return setPending(next, null, 'AWAIT_END_TURN');
      }
      const price = session.priceByTileId.get(tile.id) ?? 0;
      const multiplier = rentMultiplier(owner, session.registry);
      const amount = Math.round(rentFor(next.economy, price, tileState.level) * multiplier);
      emitter.push('RENT_DUE', playerId, {
        tileId: tile.id,
        amount,
        ownerId: owner.id,
        multiplier,
      });
      next = transferMoney({ ...session, state: next }, playerId, amount, owner.id, emitter);
      return setPending(next, null, 'AWAIT_END_TURN');
    }

    case 'TAX': {
      const payer = findPlayer(next, playerId);
      const amount = payer === undefined ? 0 : taxFor(next.economy, payer.money);
      emitter.push('TAX_DUE', playerId, { amount });
      next = transferMoney({ ...session, state: next }, playerId, amount, null, emitter);
      return setPending(next, null, 'AWAIT_END_TURN');
    }

    case 'JAIL': {
      const jailed = findPlayer(next, playerId);
      if (jailed !== undefined) {
        next = replacePlayerState(next, {
          ...jailed,
          skipTurns: jailed.skipTurns + next.economy.jailTurns,
        });
      }
      emitter.push('PLAYER_JAILED', playerId, { turns: next.economy.jailTurns });
      return setPending(next, null, 'AWAIT_END_TURN');
    }

    case 'BONUS': {
      const target = findPlayer(next, playerId);
      if (target !== undefined) {
        const amount = bonusFor(next.economy);
        next = replacePlayerState(next, { ...target, money: target.money + amount });
        emitter.push('BONUS_GRANTED', playerId, { amount });
      }
      return setPending(next, null, 'AWAIT_END_TURN');
    }

    case 'MINIGAME': {
      // A ring mini-game tile routes into the map's centre mini-game node so the
      // node (not the tile) owns the mini-game reference.
      const node = session.map.board.center.find((entry) => entry.type === 'MINIGAME');
      if (node === undefined) {
        const fallback = session.miniGameById.values().next().value;
        if (fallback === undefined) return setPending(next, null, 'AWAIT_END_TURN');
        return startMiniGame(next, fallback, null, emitter);
      }
      const minigame = session.miniGameById.get(node.payloadRef);
      if (minigame === undefined) return setPending(next, null, 'AWAIT_END_TURN');
      const actor = findPlayer(next, playerId);
      if (actor !== undefined) {
        next = replacePlayerState(next, withCenterPosition(actor, node.id, tile.id));
      }
      return startMiniGame(next, minigame, node.id, emitter);
    }

    case 'WARP': {
      const warp = outgoingWarp(session.geometry, tile.id);
      if (warp === undefined) return setPending(next, null, 'AWAIT_END_TURN');
      return followWarp(session, next, playerId, warp.toTileId, tile.id, emitter, depth + 1);
    }

    case 'CHANCE':
    case 'EVENT': {
      next = drawChaosEvent(session, next, playerId, emitter);
      return setPending(next, null, 'AWAIT_END_TURN');
    }

    case 'CHAOS': {
      const chance = next.economy.chaosTriggerChance[next.roomConfig.eventRate];
      const roll = rngFloat(next.seed, next.rngCursor);
      next = { ...next, rngCursor: next.rngCursor + 1 };
      if (roll >= chance) {
        emitter.push('CHAOS_FIZZLED', playerId, { roll, chance });
        return setPending(next, null, 'AWAIT_END_TURN');
      }
      next = drawChaosEvent(session, next, playerId, emitter);
      return setPending(next, null, 'AWAIT_END_TURN');
    }

    default:
      return setPending(next, null, 'AWAIT_END_TURN');
  }
}

function followWarp(
  session: GameSession,
  state: GameState,
  playerId: string,
  targetId: string,
  fromTileId: string,
  emitter: Emitter,
  depth: number,
): GameState {
  let next = state;
  const player = findPlayer(next, playerId);
  if (player === undefined) return next;

  const ringIndex = session.geometry.ringIndexById[targetId];
  if (ringIndex !== undefined) {
    next = replacePlayerState(next, withRingPosition(player, ringIndex));
    emitter.push('PLAYER_WARPED', playerId, { target: targetId });
    return resolveRingLanding(session, next, playerId, emitter, depth + 1);
  }

  const node = session.map.board.center.find((entry) => entry.id === targetId);
  if (node === undefined) {
    emitter.push('WARP_TARGET_MISSING', playerId, { target: targetId });
    return setPending(next, null, 'AWAIT_END_TURN');
  }

  next = replacePlayerState(next, withCenterPosition(player, node.id, fromTileId));
  emitter.push('PLAYER_WARPED', playerId, { target: node.id });

  if (node.type === 'TELEPORT') {
    const destination = session.geometry.ringIndexById[node.payloadRef];
    if (destination === undefined) return setPending(next, null, 'AWAIT_END_TURN');
    const inCenter = findPlayer(next, playerId);
    if (inCenter === undefined) return next;
    next = replacePlayerState(next, withRingPosition(inCenter, destination));
    emitter.push('PLAYER_TELEPORTED', playerId, { target: node.payloadRef });
    return resolveRingLanding(session, next, playerId, emitter, depth + 1);
  }

  const minigame = session.miniGameById.get(node.payloadRef);
  if (node.type === 'MINIGAME' && minigame !== undefined) {
    return startMiniGame(next, minigame, node.id, emitter);
  }
  if (node.type === 'EVENT') {
    next = drawChaosEvent(session, next, playerId, emitter);
  }
  return exitCenter(session, next, playerId, fromTileId);
}

/**
 * Returns a player from the center zone to the ring. When the entry tile is
 * known the move is automatic; otherwise a `CENTER_EXIT` pending choice is
 * raised and the player must send `INTENT_ENTER_CENTER`.
 */
function exitCenter(
  session: GameSession,
  state: GameState,
  playerId: string,
  entryTileId: string | undefined,
): GameState {
  const player = findPlayer(state, playerId);
  if (player === undefined) return state;
  if (entryTileId !== undefined) {
    const index = session.geometry.ringIndexById[entryTileId];
    if (index !== undefined) {
      return setPending(
        replacePlayerState(state, withRingPosition(player, index)),
        null,
        'AWAIT_END_TURN',
      );
    }
  }
  return setPending(
    state,
    { kind: 'CENTER_EXIT', playerId, options: ['RING_RETURN'] },
    'AWAIT_CHOICE',
  );
}

/* ------------------------------------------------------------ minigames */

function startMiniGame(
  state: GameState,
  definition: MiniGameDefinition,
  nodeId: string | null,
  emitter: Emitter,
): GameState {
  const participants = nonBankrupt(state).map((player) => player.id);
  const capped = participants.slice(0, definition.maxPlayers);
  const minigame: MiniGameState = {
    minigameId: definition.id,
    kind: definition.kind,
    participantIds: capped,
    submissions: {},
  };
  emitter.push('MINIGAME_STARTED', null, { minigameId: definition.id, kind: definition.kind });
  const actor = state.players[state.activePlayerIndex];
  const pending: PendingChoice = {
    kind: 'MINIGAME',
    playerId: actor?.id ?? capped[0] ?? '',
    minigameId: definition.id,
    options: ['SUBMIT'],
    ...(nodeId === null ? {} : { nodeId }),
  };
  return setPending({ ...state, minigame }, pending, 'MINIGAME');
}

function resolveMiniGame(session: GameSession, state: GameState, emitter: Emitter): GameState {
  const minigame = state.minigame;
  if (minigame === null) return state;
  const definition = session.miniGameById.get(minigame.minigameId);
  const resolver = MINIGAME_RESOLVERS[minigame.kind];
  if (definition === undefined || resolver === undefined) {
    return finishMiniGame(session, state, emitter, minigame.minigameId, []);
  }
  const outcome = resolver({
    seed: state.seed,
    cursor: state.rngCursor,
    participantIds: minigame.participantIds,
    submissions: minigame.submissions,
  });
  let next: GameState = { ...state, rngCursor: outcome.cursor };
  const ranked = [...outcome.ranks].sort((a, b) => a[1] - b[1]);
  const winnerId = ranked[0]?.[0];
  if (winnerId !== undefined) {
    const result = applyEffects(
      next,
      winnerId,
      winnerId,
      definition.rewards,
      session.geometry,
      session.registry,
    );
    next = result.state;
    for (const note of result.notes) {
      const event = noteToEvent(note);
      emitter.push(event.type, event.playerId, event.data);
    }
    next = settleInsolvency({ ...session, state: next }, winnerId, null, emitter);
  }
  for (const [playerId, rank] of ranked) {
    emitter.push('MINIGAME_RANKED', playerId, { rank, minigameId: minigame.minigameId });
  }
  return finishMiniGame(
    session,
    next,
    emitter,
    minigame.minigameId,
    ranked.map(([playerId, rank]) => ({ playerId, rank })),
  );
}

function finishMiniGame(
  session: GameSession,
  state: GameState,
  emitter: Emitter,
  minigameId: string,
  placements: readonly { playerId: string; rank: number }[],
): GameState {
  emitter.push('MINIGAME_FINISHED', null, { minigameId, placements });
  const cleared: GameState = { ...state, minigame: null, pendingChoice: null };
  const actor = activePlayer(cleared);
  if (actor !== undefined && actor.position.zone === 'center') {
    return exitCenter(session, cleared, actor.id, actor.position.entryTileId);
  }
  return setPending(cleared, null, 'AWAIT_END_TURN');
}

/* -------------------------------------------------------------- victory */

export function checkVictory(session: GameSession, emitter: Emitter): GameState {
  const state = session.state;
  if (state.phase === 'GAME_OVER') return state;
  const survivors = nonBankrupt(state);
  if (survivors.length <= 1) {
    return finishGame(session, emitter, survivors[0]?.id ?? null);
  }
  if (state.roomConfig.victory.kind === 'ASSET_TARGET') {
    const target = state.economy.startingMoney * state.roomConfig.victory.value;
    let best: Player | undefined;
    for (const player of survivors) {
      if (netWorth(session, player) >= target) {
        if (best === undefined || netWorth(session, player) > netWorth(session, best))
          best = player;
      }
    }
    if (best !== undefined) return finishGame(session, emitter, best.id);
  }
  return state;
}

function finishGame(session: GameSession, emitter: Emitter, winnerId: string | null): GameState {
  const standings = session.state.players
    .map((player) => ({
      playerId: player.id,
      netWorth: netWorth(session, player),
      bankrupt: player.bankrupt,
    }))
    .sort((a, b) => b.netWorth - a.netWorth);
  emitter.push('GAME_OVER', winnerId, { winnerId, standings });
  return { ...session.state, phase: 'GAME_OVER', winnerId, pendingChoice: null, minigame: null };
}

/* --------------------------------------------------------- turn advance */

function advanceTurn(session: GameSession, emitter: Emitter): GameState {
  let state = session.state;
  let guard = 0;
  for (;;) {
    guard += 1;
    if (guard > 64) break;
    const size = state.players.length;
    const nextIndex = (state.activePlayerIndex + 1) % size;
    if (nextIndex === 0) {
      state = { ...state, turn: state.turn + 1 };
      emitter.turn = state.turn;
    }
    const candidate = state.players[nextIndex];
    if (candidate === undefined) break;
    state = { ...state, activePlayerIndex: nextIndex };
    if (candidate.bankrupt) continue;
    if (candidate.skipTurns > 0) {
      state = replacePlayerState(state, { ...candidate, skipTurns: candidate.skipTurns - 1 });
      emitter.push('TURN_SKIPPED', candidate.id, { remaining: candidate.skipTurns - 1 });
      continue;
    }
    state = tickStatuses(state, candidate.id);
    break;
  }

  if (
    state.roomConfig.victory.kind === 'TURN_LIMIT' &&
    state.turn > state.roomConfig.victory.value
  ) {
    const survivors = nonBankrupt(state);
    let best: Player | undefined;
    for (const player of survivors) {
      if (
        best === undefined ||
        netWorth({ ...session, state }, player) > netWorth({ ...session, state }, best)
      ) {
        best = player;
      }
    }
    return finishGame({ ...session, state }, emitter, best?.id ?? null);
  }

  const nextActive = activePlayer(state);
  emitter.push('TURN_START', nextActive?.id ?? null, { turn: state.turn });
  state = applyTurnStartTriggers({ ...session, state }, emitter);
  return { ...state, phase: 'AWAIT_ROLL', pendingChoice: null };
}

/* ----------------------------------------------------------- intent API */

function reject(session: GameSession, reason: string): ApplyResult {
  return { session, events: [], rejected: reason };
}

function requireTurn(session: GameSession, intent: ClientIntentMessage): ApplyResult | null {
  if (session.state.phase === 'GAME_OVER') return reject(session, 'game-over');
  const player = activePlayer(session.state);
  if (player === undefined) return reject(session, 'no-active-player');
  if (player.id !== intent.from) return reject(session, 'not-your-turn');
  if (player.bankrupt) return reject(session, 'player-bankrupt');
  return null;
}

export function applyIntent(session: GameSession, intent: ClientIntentMessage): ApplyResult {
  const emitter = new Emitter(session.state);

  switch (intent.type) {
    case 'INTENT_SELECT_CHARACTER':
      return applySelectCharacter(session, intent, emitter);

    case 'INTENT_ROLL':
      return applyRoll(session, intent, emitter);

    case 'INTENT_BUY':
      return applyBuy(session, intent, emitter);

    case 'INTENT_UPGRADE':
      return applyUpgrade(session, intent, emitter);

    case 'INTENT_CHOICE':
      return applyChoice(session, intent, emitter);

    case 'INTENT_END_TURN':
      return applyEndTurn(session, intent, emitter);

    case 'INTENT_MORTGAGE':
      return applyMortgage(session, intent, emitter, true);

    case 'INTENT_REDEEM':
      return applyMortgage(session, intent, emitter, false);

    case 'INTENT_MINIGAME_ACTION':
      return applyMiniGameAction(session, intent, emitter);

    case 'INTENT_ENTER_CENTER':
      return applyEnterCenter(session, intent, emitter);

    case 'INTENT_USE_SKILL':
      return applyUseSkill(session, intent, emitter);

    case 'INTENT_JOIN':
      return reject(session, 'join-handled-by-transport');

    default:
      return reject(session, 'unsupported-intent');
  }
}

function applySelectCharacter(
  session: GameSession,
  intent: Extract<ClientIntentMessage, { type: 'INTENT_SELECT_CHARACTER' }>,
  emitter: Emitter,
): ApplyResult {
  if (session.state.phase !== 'SETUP') return reject(session, 'not-in-setup');
  const player = findPlayer(session.state, intent.from);
  if (player === undefined) return reject(session, 'unknown-player');
  const taken = session.state.players.find(
    (entry) => entry.id !== player.id && entry.characterId === intent.payload.characterId,
  );
  if (taken !== undefined) {
    emitter.push('CHARACTER_TAKEN', player.id, {
      characterId: intent.payload.characterId,
      byPlayerId: taken.id,
    });
    return { session, events: emitter.events, rejected: 'character-taken' };
  }
  const state = replacePlayerState(session.state, {
    ...player,
    characterId: intent.payload.characterId,
  });
  emitter.push('CHARACTER_SELECTED', player.id, { characterId: intent.payload.characterId });
  return {
    session: { ...session, state: flush(state, emitter) },
    events: emitter.events,
    rejected: null,
  };
}

function applyRoll(
  session: GameSession,
  intent: Extract<ClientIntentMessage, { type: 'INTENT_ROLL' }>,
  emitter: Emitter,
): ApplyResult {
  const guard = requireTurn(session, intent);
  if (guard !== null) return guard;
  if (session.state.phase !== 'AWAIT_ROLL') return reject(session, 'not-awaiting-roll');

  const state = session.state;
  const die = rngIntInclusive(state.seed, state.rngCursor, 1, 6);
  let next: GameState = { ...state, rngCursor: state.rngCursor + 1 };
  emitter.push('DICE_ROLLED', intent.from, { die });

  next = applyRollTriggers({ ...session, state: next }, intent.from, emitter);
  next = moveBy({ ...session, state: next }, intent.from, die, emitter);
  next = resolveRingLanding({ ...session, state: next }, next, intent.from, emitter);
  next = checkVictory({ ...session, state: next }, emitter);
  return {
    session: { ...session, state: flush(next, emitter) },
    events: emitter.events,
    rejected: null,
  };
}

function applyRollTriggers(session: GameSession, playerId: string, emitter: Emitter): GameState {
  const state = session.state;
  const player = findPlayer(state, playerId);
  if (player === undefined) return state;
  const effects = triggerEffects(player, session.registry, 'ON_ROLL');
  if (effects.length === 0) return state;
  const outcome = applyEffects(
    state,
    playerId,
    playerId,
    effects,
    session.geometry,
    session.registry,
  );
  for (const note of outcome.notes) {
    const event = noteToEvent(note);
    emitter.push(event.type, event.playerId, event.data);
  }
  return settleInsolvency({ ...session, state: outcome.state }, playerId, null, emitter);
}

function applyBuy(
  session: GameSession,
  intent: Extract<ClientIntentMessage, { type: 'INTENT_BUY' }>,
  emitter: Emitter,
): ApplyResult {
  const guard = requireTurn(session, intent);
  if (guard !== null) return guard;
  const pending = session.state.pendingChoice;
  if (
    session.state.phase !== 'AWAIT_CHOICE' ||
    pending === null ||
    pending.kind !== 'BUY_PROPERTY'
  ) {
    return reject(session, 'no-purchase-pending');
  }
  if (pending.tileId !== intent.payload.tileId) return reject(session, 'tile-mismatch');
  const price = session.priceByTileId.get(intent.payload.tileId);
  if (price === undefined) return reject(session, 'not-a-property');
  const player = findPlayer(session.state, intent.from);
  if (player === undefined) return reject(session, 'unknown-player');
  if (player.money < price) return reject(session, 'insufficient-funds');

  let next: GameState = replacePlayerState(session.state, {
    ...player,
    money: player.money - price,
  });
  next = setTileState(next, intent.payload.tileId, {
    ownerId: player.id,
    level: 0,
    mortgaged: false,
  });
  next = syncProperties(next);
  emitter.push('PROPERTY_BOUGHT', player.id, { tileId: intent.payload.tileId, price });
  next = setPending(next, null, 'AWAIT_END_TURN');
  next = checkVictory({ ...session, state: next }, emitter);
  return {
    session: { ...session, state: flush(next, emitter) },
    events: emitter.events,
    rejected: null,
  };
}

function applyUpgrade(
  session: GameSession,
  intent: Extract<ClientIntentMessage, { type: 'INTENT_UPGRADE' }>,
  emitter: Emitter,
): ApplyResult {
  const guard = requireTurn(session, intent);
  if (guard !== null) return guard;
  const pending = session.state.pendingChoice;
  if (
    session.state.phase !== 'AWAIT_CHOICE' ||
    pending === null ||
    pending.kind !== 'UPGRADE_PROPERTY'
  ) {
    return reject(session, 'no-upgrade-pending');
  }
  if (pending.tileId !== intent.payload.tileId) return reject(session, 'tile-mismatch');
  const tileState = session.state.board.tiles[intent.payload.tileId];
  const price = session.priceByTileId.get(intent.payload.tileId);
  const player = findPlayer(session.state, intent.from);
  if (tileState === undefined || price === undefined || player === undefined)
    return reject(session, 'not-a-property');
  if (tileState.ownerId !== player.id) return reject(session, 'not-the-owner');
  if (tileState.level >= session.state.economy.maxLevel) return reject(session, 'max-level');
  const cost = upgradeCostFor(session, price, tileState.level);
  if (player.money < cost) return reject(session, 'insufficient-funds');

  let next: GameState = replacePlayerState(session.state, {
    ...player,
    money: player.money - cost,
  });
  next = setTileState(next, intent.payload.tileId, { level: tileState.level + 1 });
  next = syncProperties(next);
  emitter.push('PROPERTY_UPGRADED', player.id, {
    tileId: intent.payload.tileId,
    level: tileState.level + 1,
    cost,
  });
  next = setPending(next, null, 'AWAIT_END_TURN');
  next = checkVictory({ ...session, state: next }, emitter);
  return {
    session: { ...session, state: flush(next, emitter) },
    events: emitter.events,
    rejected: null,
  };
}

function upgradeCostFor(session: GameSession, price: number, level: number): number {
  const ratio = session.state.economy.upgradeCostRatio;
  return Math.max(1, Math.round(price * ratio * (level + 1)));
}

function applyChoice(
  session: GameSession,
  intent: Extract<ClientIntentMessage, { type: 'INTENT_CHOICE' }>,
  emitter: Emitter,
): ApplyResult {
  const guard = requireTurn(session, intent);
  if (guard !== null) return guard;
  const pending = session.state.pendingChoice;
  if (pending === null) return reject(session, 'no-pending-choice');
  if (pending.kind !== intent.payload.choice) return reject(session, 'choice-mismatch');
  if (!pending.options.includes(intent.payload.option)) return reject(session, 'invalid-option');
  if (pending.kind === 'MINIGAME') return reject(session, 'use-minigame-action');

  const option = intent.payload.option;
  if (option === 'DECLINE' || option === 'SKIP') {
    emitter.push('CHOICE_DECLINED', intent.from, { kind: pending.kind });
    const next = setPending(session.state, null, 'AWAIT_END_TURN');
    return {
      session: { ...session, state: flush(next, emitter) },
      events: emitter.events,
      rejected: null,
    };
  }
  return reject(session, 'unsupported-option');
}

function applyEndTurn(
  session: GameSession,
  intent: Extract<ClientIntentMessage, { type: 'INTENT_END_TURN' }>,
  emitter: Emitter,
): ApplyResult {
  const guard = requireTurn(session, intent);
  if (guard !== null) return guard;
  if (session.state.phase !== 'AWAIT_END_TURN') return reject(session, 'not-awaiting-end-turn');
  const next = advanceTurn(session, emitter);
  return {
    session: { ...session, state: flush(next, emitter) },
    events: emitter.events,
    rejected: null,
  };
}

function applyMortgage(
  session: GameSession,
  intent: Extract<ClientIntentMessage, { type: 'INTENT_MORTGAGE' | 'INTENT_REDEEM' }>,
  emitter: Emitter,
  mortgage: boolean,
): ApplyResult {
  const state = session.state;
  if (state.phase === 'GAME_OVER' || state.phase === 'SETUP')
    return reject(session, 'phase-not-allowed');
  const player = findPlayer(state, intent.from);
  if (player === undefined) return reject(session, 'unknown-player');
  if (player.bankrupt) return reject(session, 'player-bankrupt');
  if (!player.isAI && state.players[state.activePlayerIndex]?.id !== player.id) {
    return reject(session, 'not-your-turn');
  }
  const tileState = state.board.tiles[intent.payload.tileId];
  const price = session.priceByTileId.get(intent.payload.tileId);
  if (tileState === undefined || price === undefined) return reject(session, 'not-a-property');
  if (tileState.ownerId !== player.id) return reject(session, 'not-the-owner');

  if (mortgage) {
    if (tileState.mortgaged) return reject(session, 'already-mortgaged');
    const value = mortgageValueFor(session, price, tileState.level);
    let next = setTileState(state, intent.payload.tileId, { mortgaged: true });
    const owner = findPlayer(next, player.id);
    if (owner !== undefined)
      next = replacePlayerState(next, { ...owner, money: owner.money + value });
    next = syncProperties(next);
    emitter.push('PROPERTY_MORTGAGED', player.id, { tileId: intent.payload.tileId, amount: value });
    return {
      session: { ...session, state: flush(next, emitter) },
      events: emitter.events,
      rejected: null,
    };
  }

  if (!tileState.mortgaged) return reject(session, 'not-mortgaged');
  const cost = Math.round(
    mortgageValueFor(session, price, tileState.level) * (1 + state.economy.redeemInterestRatio),
  );
  if (player.money < cost) return reject(session, 'insufficient-funds');
  let next = replacePlayerState(state, { ...player, money: player.money - cost });
  next = setTileState(next, intent.payload.tileId, { mortgaged: false });
  next = syncProperties(next);
  emitter.push('PROPERTY_REDEEMED', player.id, { tileId: intent.payload.tileId, cost });
  return {
    session: { ...session, state: flush(next, emitter) },
    events: emitter.events,
    rejected: null,
  };
}

function applyMiniGameAction(
  session: GameSession,
  intent: Extract<ClientIntentMessage, { type: 'INTENT_MINIGAME_ACTION' }>,
  emitter: Emitter,
): ApplyResult {
  const state = session.state;
  if (state.phase !== 'MINIGAME' || state.minigame === null)
    return reject(session, 'no-minigame-running');
  const minigame = state.minigame;
  if (minigame.minigameId !== intent.payload.minigameId)
    return reject(session, 'minigame-mismatch');
  if (!minigame.participantIds.includes(intent.from)) return reject(session, 'not-a-participant');
  if (minigame.submissions[intent.from] !== undefined) return reject(session, 'already-submitted');

  const submissions = { ...minigame.submissions, [intent.from]: intent.payload.action };
  emitter.push('MINIGAME_SUBMITTED', intent.from, { minigameId: minigame.minigameId });
  let next: GameState = { ...state, minigame: { ...minigame, submissions } };
  const complete = minigame.participantIds.every((id) => submissions[id] !== undefined);
  if (complete) {
    next = resolveMiniGame(session, next, emitter);
  }
  next = checkVictory({ ...session, state: next }, emitter);
  return {
    session: { ...session, state: flush(next, emitter) },
    events: emitter.events,
    rejected: null,
  };
}

function applyEnterCenter(
  session: GameSession,
  intent: Extract<ClientIntentMessage, { type: 'INTENT_ENTER_CENTER' }>,
  emitter: Emitter,
): ApplyResult {
  const state = session.state;
  const player = findPlayer(state, intent.from);
  if (player === undefined) return reject(session, 'unknown-player');
  if (player.position.zone !== 'center') return reject(session, 'not-in-center');

  const pending = state.pendingChoice;
  const isPendingExit =
    pending !== null && pending.kind === 'CENTER_EXIT' && pending.playerId === intent.from;
  const isActive = state.players[state.activePlayerIndex]?.id === intent.from;
  if (!isPendingExit && !isActive) return reject(session, 'not-your-turn');
  if (state.phase === 'GAME_OVER') return reject(session, 'game-over');

  const index = session.geometry.ringIndexById[intent.payload.nodeId];
  if (index === undefined) return reject(session, 'unknown-ring-tile');
  let next = replacePlayerState(state, withRingPosition(player, index));
  emitter.push('CENTER_EXITED', player.id, { tileId: intent.payload.nodeId });
  next = setPending(next, null, 'AWAIT_END_TURN');
  return {
    session: { ...session, state: flush(next, emitter) },
    events: emitter.events,
    rejected: null,
  };
}

function applyUseSkill(
  session: GameSession,
  intent: Extract<ClientIntentMessage, { type: 'INTENT_USE_SKILL' }>,
  emitter: Emitter,
): ApplyResult {
  const state = session.state;
  if (state.phase === 'GAME_OVER' || state.phase === 'SETUP')
    return reject(session, 'phase-not-allowed');
  const player = findPlayer(state, intent.from);
  if (player === undefined) return reject(session, 'unknown-player');
  const skill = session.registry.bySkillId.get(intent.payload.skillId);
  if (skill === undefined) return reject(session, 'unknown-skill');
  const check = canUseSkill(player, skill, session.registry);
  if (!check.ok) return reject(session, check.reason ?? 'skill-unavailable');

  let next: GameState = state;
  if (skill.cost !== undefined && skill.cost > 0) {
    next = replacePlayerState(next, { ...player, money: player.money - skill.cost });
  }
  const effects = activeSkillEffects(player, skill.id, session.registry);
  const outcome = applyEffects(
    next,
    player.id,
    player.id,
    effects,
    session.geometry,
    session.registry,
  );
  next = outcome.state;
  for (const note of outcome.notes) {
    const event = noteToEvent(note);
    emitter.push(event.type, event.playerId, event.data);
  }
  const cooldown = skill.cooldown ?? 0;
  const used = findPlayer(next, player.id);
  if (used !== undefined && cooldown > 0) {
    next = replacePlayerState(next, {
      ...used,
      skillCooldowns: { ...used.skillCooldowns, [skill.id]: cooldown + 1 },
    });
  }
  emitter.push('SKILL_USED', player.id, { skillId: skill.id });
  next = settleInsolvency({ ...session, state: next }, player.id, null, emitter);
  next = checkVictory({ ...session, state: next }, emitter);
  return {
    session: { ...session, state: flush(next, emitter) },
    events: emitter.events,
    rejected: null,
  };
}

/* --------------------------------------------------------------- exports */

/**
 * Recomputes every player's `properties` from the board. Host-side utility:
 * ownership is authoritative on the board, and the per-player list is a
 * derived convenience for the UI and the AI.
 */
export function syncPlayerProperties(state: GameState): GameState {
  return syncProperties(state);
}

/**
 * Resolves the tile the player is standing on and returns the resulting
 * session. Used internally by `INTENT_ROLL`/warps; also useful when the host
 * has to re-resolve after a state repair.
 */
export function resolveCurrentLanding(session: GameSession, playerId: string): ApplyResult {
  const emitter = new Emitter(session.state);
  let next = resolveRingLanding(session, session.state, playerId, emitter);
  next = checkVictory({ ...session, state: next }, emitter);
  return {
    session: { ...session, state: flush(next, emitter) },
    events: emitter.events,
    rejected: null,
  };
}

/** Net worth helper reused by the UI and AI. */
export function sessionNetWorth(session: GameSession, playerId: string): number {
  const player = findPlayer(session.state, playerId);
  return player === undefined ? 0 : netWorth(session, player);
}

/** Player ids in finishing order (winner first). */
export function standings(
  session: GameSession,
): { playerId: string; netWorth: number; bankrupt: boolean }[] {
  return session.state.players
    .map((player) => ({
      playerId: player.id,
      netWorth: netWorth(session, player),
      bankrupt: player.bankrupt,
    }))
    .sort((a, b) => b.netWorth - a.netWorth);
}
