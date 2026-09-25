/**
 * Regression tests for the second Oracle Gate 2 review.
 *
 * Findings 1–5 of that review were fixed in one pass; each test below fails on
 * the reviewed revision (`9a39b13`) and passes afterwards.
 */

import { describe, expect, it } from 'vitest';
import { decide } from '../src/engine/ai';
import type { Character, ChaosEvent, MapDefinition } from '../src/engine/contracts/content';
import type { ClientIntentMessage } from '../src/engine/contracts/net';
import type { GameSession } from '../src/engine/reducer';
import { applyIntent, resolveCurrentLanding, startGame } from '../src/engine/reducer';
import {
  makeSession,
  patchSession,
  placeOnRing,
  TEST_CHAOS_EVENTS,
  TEST_CHARACTERS,
  TEST_MAP,
} from './fixtures/content';

let sequence = 0;

function msg<T extends ClientIntentMessage['type']>(
  type: T,
  from: string,
  payload: Extract<ClientIntentMessage, { type: T }>['payload'],
): ClientIntentMessage {
  sequence += 1;
  return { v: 1, type, seq: sequence, from, payload } as ClientIntentMessage;
}

function boot(): GameSession {
  return startGame(makeSession()).session;
}

function activeId(session: GameSession): string | undefined {
  return session.state.players[session.state.activePlayerIndex]?.id;
}

/* ------------------------------------------------------------------ 1 */
/* A bankrupt active seat must always be able to end its turn, and the AI
   driver must offer that intent in every phase, not only AWAIT_END_TURN. */

function bankrupt(session: GameSession, playerId: string): GameSession {
  return patchSession(session, (state) => ({
    ...state,
    players: state.players.map((player) =>
      player.id === playerId ? { ...player, bankrupt: true } : player,
    ),
  }));
}

describe('finding 1 — bankrupt active seat cannot deadlock the table', () => {
  it('offers INTENT_END_TURN at AWAIT_ROLL', () => {
    const session = bankrupt(boot(), 'p1');
    expect(decide(session, 'p1')).toEqual({ type: 'INTENT_END_TURN', payload: {} });
  });

  it('offers INTENT_END_TURN while a purchase decision is pending', () => {
    const landed = resolveCurrentLanding(placeOnRing(boot(), 'p1', 1), 'p1').session;
    expect(landed.state.pendingChoice?.kind).toBe('BUY_PROPERTY');
    const session = bankrupt(landed, 'p1');
    expect(decide(session, 'p1')).toEqual({ type: 'INTENT_END_TURN', payload: {} });
  });

  it('offers INTENT_END_TURN while a mini-game is running', () => {
    const landed = resolveCurrentLanding(placeOnRing(boot(), 'p1', 11), 'p1').session;
    expect(landed.state.phase).toBe('MINIGAME');
    const session = bankrupt(landed, 'p1');
    expect(decide(session, 'p1')).toEqual({ type: 'INTENT_END_TURN', payload: {} });
  });

  it('still returns nothing for a bankrupt seat that is not active', () => {
    const session = bankrupt(boot(), 'p2');
    expect(decide(session, 'p2')).toBeNull();
  });

  it('accepts the hand-over and advances the turn in every stalled phase', () => {
    const bought = resolveCurrentLanding(placeOnRing(boot(), 'p1', 1), 'p1').session;
    for (const stalled of [bankrupt(boot(), 'p1'), bankrupt(bought, 'p1')]) {
      const result = applyIntent(stalled, msg('INTENT_END_TURN', 'p1', {}));
      expect(result.rejected).toBeNull();
      expect(result.session.state.phase).toBe('AWAIT_ROLL');
      expect(activeId(result.session)).not.toBe('p1');
    }
  });
});

/* ------------------------------------------------------------------ 2 */
/* ON_LAND used to fire twice when a WARP chain returned to the ring: once
   for the destination and once for the warp tile. */

const LAND_CHARACTER: Character = {
  ...(TEST_CHARACTERS[0] as Character),
  skill: {
    id: 'skill_land_bonus',
    name: '落地捡钱',
    desc: '每次停下捡 300。',
    type: 'PASSIVE',
    trigger: 'ON_LAND',
    effect: [{ kind: 'MONEY', value: 300 }],
  },
};

/** t3 becomes a one-way warp to the BONUS tile t9, so the landing recurses. */
const WARP_MAP: MapDefinition = {
  ...TEST_MAP,
  board: {
    ...TEST_MAP.board,
    ring: TEST_MAP.board.ring.map((tile) =>
      tile.id === 't3' ? { ...tile, type: 'WARP' as const } : tile,
    ),
    warps: [{ fromTileId: 't3', toTileId: 't9', bidirectional: false }],
  },
};

describe('finding 2 — ON_LAND fires once across a warp chain', () => {
  it('applies the landing reward exactly once', () => {
    const withSkill = startGame(
      makeSession({
        map: WARP_MAP,
        characters: [LAND_CHARACTER, ...TEST_CHARACTERS.slice(1)],
      }),
    ).session;
    const without = startGame(makeSession({ map: WARP_MAP })).session;

    const moneyOf = (session: GameSession): number =>
      session.state.players.find((player) => player.id === 'p1')?.money ?? 0;

    const startWith = moneyOf(withSkill);
    const startWithout = moneyOf(without);
    const landedWith = resolveCurrentLanding(placeOnRing(withSkill, 'p1', 3), 'p1').session;
    const landedWithout = resolveCurrentLanding(placeOnRing(without, 'p1', 3), 'p1').session;

    expect(landedWith.state.players[0]?.position).toEqual({ zone: 'ring', index: 9 });
    // Both runs receive the same BONUS tile payout, so the difference in the
    // landing deltas is exactly one ON_LAND application (600 would mean the
    // warp tile fired the trigger a second time).
    expect(moneyOf(landedWith) - startWith - (moneyOf(landedWithout) - startWithout)).toBe(300);
  });
});

/* ------------------------------------------------------------------ 3 */
/* Active skills must be a turn action; a non-active seat could previously
   buff itself (and even win) during someone else's turn. */

describe('finding 3 — only the active seat may use an active skill', () => {
  it('rejects an off-turn INTENT_USE_SKILL', () => {
    const session = boot();
    expect(activeId(session)).toBe('p1');
    const before = session.state.players[1]?.money ?? 0;
    const result = applyIntent(
      session,
      msg('INTENT_USE_SKILL', 'p2', { skillId: 'skill_girl_allowance' }),
    );
    expect(result.rejected).toBe('not-your-turn');
    expect(result.session.state.players[1]?.money).toBe(before);
  });

  it('allows the active seat to use its own active skill', () => {
    const session = patchSession(boot(), (state) => ({ ...state, activePlayerIndex: 1 }));
    const result = applyIntent(
      session,
      msg('INTENT_USE_SKILL', 'p2', { skillId: 'skill_girl_allowance' }),
    );
    expect(result.rejected).toBeNull();
  });
});

/* ------------------------------------------------------------------ 4 */
/* The centre-exit path is only valid while the piece is actually in the
   centre; a chaos WARP back to the ring used to be discarded. */

const WARP_CHAOS: ChaosEvent[] = [
  {
    id: 'chaos_warp_ring',
    title: '紧急传送',
    text: '把你传到红包雨。',
    weight: 1,
    target: 'SELF',
    effect: [{ kind: 'WARP', tileId: 't9' }],
  },
];

/** t5 becomes a warp into the EVENT centre node; the chaos pool always warps. */
const CENTER_MAP: MapDefinition = {
  ...TEST_MAP,
  board: {
    ...TEST_MAP.board,
    ring: TEST_MAP.board.ring.map((tile) =>
      tile.id === 't5' ? { ...tile, type: 'WARP' as const } : tile,
    ),
    warps: [{ fromTileId: 't5', toTileId: 'c_plaza', bidirectional: false }],
  },
  events: ['chaos_warp_ring'],
};

describe('finding 4 — exitCenter only moves a piece that is in the centre', () => {
  it('keeps the ring destination granted by a chaos warp', () => {
    const session = startGame(makeSession({ map: CENTER_MAP, chaosEvents: WARP_CHAOS })).session;
    const landed = resolveCurrentLanding(placeOnRing(session, 'p1', 5), 'p1').session;
    const player = landed.state.players.find((entry) => entry.id === 'p1');
    expect(player?.position).toEqual({ zone: 'ring', index: 9 });
    expect(landed.state.phase).not.toBe('AWAIT_CHOICE');
  });
});

/* ------------------------------------------------------------------ 5 */
/* A fixed 64-iteration guard could declare GAME_OVER while seats still had
   queued skips left; the loop is now bounded by rounds without progress. */

describe('finding 5 — long skip chains still reach a playable seat', () => {
  it('does not end the game while queued skips remain', () => {
    const session = patchSession(boot(), (state) => ({
      ...state,
      phase: 'AWAIT_END_TURN',
      players: state.players.map((player) => ({ ...player, skipTurns: 17 })),
    }));
    const result = applyIntent(session, msg('INTENT_END_TURN', 'p1', {}));
    expect(result.rejected).toBeNull();
    expect(result.session.state.phase).toBe('AWAIT_ROLL');
    expect(result.session.state.turn).toBeGreaterThan(1);
  });

  it('still ends the game when every seat is bankrupt', () => {
    const session = patchSession(boot(), (state) => ({
      ...state,
      phase: 'AWAIT_END_TURN',
      players: state.players.map((player) => ({ ...player, bankrupt: true })),
    }));
    const result = applyIntent(session, msg('INTENT_END_TURN', 'p1', {}));
    expect(result.session.state.phase).toBe('GAME_OVER');
  });
});

// Keep the import used even if the fixture list order changes.
void TEST_CHAOS_EVENTS;
