/**
 * Regression tests for the Oracle Gate 2 findings (F1–F8).
 *
 * Each test below fails on the pre-remediation engine and passes after the fix,
 * so the regression is locked down rather than merely repaired.
 */

import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Character, MiniGameDefinition, Skill } from '../src/engine/contracts/content';
import { validateContentPack, validateMapDefinition } from '../src/engine/contracts/content';
import type { ClientIntentMessage } from '../src/engine/contracts/net';
import { compareCodeUnits } from '../src/engine/hash';
import type { GameSession } from '../src/engine/reducer';
import {
  addPlayer,
  applyIntent,
  removePlayer,
  resolveCurrentLanding,
  sessionNetWorth,
  setPlayerConnected,
  startGame,
} from '../src/engine/reducer';
import {
  makeSession,
  ownTile,
  patchSession,
  placeInCenter,
  placeOnRing,
  setMoney,
  TEST_CHARACTERS,
  TEST_CHAOS_EVENTS,
  TEST_MINIGAMES,
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

function characterById(id: string): Character {
  const found = TEST_CHARACTERS.find((entry) => entry.id === id);
  if (found === undefined) throw new Error(`missing fixture character ${id}`);
  return found;
}

function activeId(session: GameSession): string | undefined {
  return session.state.players[session.state.activePlayerIndex]?.id;
}

function boot(options: Parameters<typeof makeSession>[0] = {}): GameSession {
  const started = startGame(makeSession(options));
  expect(started.rejected).toBeNull();
  return started.session;
}

/* F1 — a bankrupt active player must still be able to end the turn. */
describe('F1 bankrupt active seat', () => {
  it('lets a bankrupted active player hand the turn over', () => {
    const session = setMoney(placeOnRing(ownTile(boot(), 't1', 'p2'), 'p1', 1), 'p1', 0);
    const landed = resolveCurrentLanding(session, 'p1');
    expect(landed.session.state.players.find((player) => player.id === 'p1')?.bankrupt).toBe(true);
    expect(landed.session.state.phase).toBe('AWAIT_END_TURN');

    const ended = applyIntent(landed.session, msg('INTENT_END_TURN', 'p1', {}));
    expect(ended.rejected).toBeNull();
    expect(activeId(ended.session)).not.toBe('p1');
    expect(ended.session.state.phase).toBe('AWAIT_ROLL');
  });
});

/* F2 — landing effects must never strand a player in the centre. */
describe('F2 centre stranding', () => {
  it('queues a centre exit when a stranded player rolls', () => {
    const stranded = patchSession(placeInCenter(boot(), 'p1', 'c_plaza'), (state) => ({
      ...state,
      phase: 'AWAIT_ROLL',
      pendingChoice: null,
    }));
    const rolled = applyIntent(stranded, msg('INTENT_ROLL', 'p1', {}));
    expect(rolled.rejected).toBeNull();
    expect(rolled.session.state.pendingChoice?.kind).toBe('CENTER_EXIT');
    expect(rolled.session.state.pendingChoice?.nodeId).toBe('t0');
  });

  it('returns a player warped into the centre by a tile effect', () => {
    const map = {
      ...TEST_MAP,
      board: {
        ...TEST_MAP.board,
        ring: TEST_MAP.board.ring.map((tile) =>
          tile.id === 't3'
            ? { ...tile, onEnter: [{ kind: 'WARP' as const, nodeId: 'c_plaza' }] }
            : tile,
        ),
      },
    };
    const session = placeOnRing(boot({ map }), 'p1', 3);
    const landed = resolveCurrentLanding(session, 'p1');
    const player = landed.session.state.players.find((entry) => entry.id === 'p1');
    expect(player?.position.zone).toBe('ring');
    expect(landed.session.state.pendingChoice).toBeNull();
    expect(landed.session.state.phase).toBe('AWAIT_END_TURN');
  });
});

/* F4 — turn-start effects must not clobber GAME_OVER or leave a dead seat active. */
describe('F4 turn-start outcomes', () => {
  const broke: Character = {
    id: 'char_broke',
    name: '破产哥',
    archetype: 'farmer',
    modelRef: 'char_broke',
    portraitRef: 'portrait_broke',
    skill: {
      id: 'skill_drain',
      name: '漏财命',
      desc: '每回合开始失去全部现金。',
      type: 'PASSIVE',
      trigger: 'ON_TURN_START',
      effect: [{ kind: 'MONEY', value: -1_000_000 }],
    },
  };

  it('skips a seat bankrupted by its own turn-start trigger', () => {
    const characters = [
      characterById('char_farmer'),
      broke,
      characterById('char_madame'),
      characterById('char_ninja'),
    ];
    const session = patchSession(
      boot({
        characters,
        players: [
          { id: 'p1', nickname: '阿一', characterId: 'char_farmer', isAI: false },
          { id: 'p2', nickname: '阿二', characterId: 'char_broke', isAI: true },
          { id: 'p3', nickname: '阿三', characterId: 'char_madame', isAI: true },
          { id: 'p4', nickname: '阿四', characterId: 'char_ninja', isAI: true },
        ],
      }),
      (state) => ({ ...state, phase: 'AWAIT_END_TURN' }),
    );
    const ended = applyIntent(session, msg('INTENT_END_TURN', 'p1', {}));
    expect(ended.rejected).toBeNull();
    expect(ended.session.state.players.find((player) => player.id === 'p2')?.bankrupt).toBe(true);
    expect(activeId(ended.session)).toBe('p3');
    expect(ended.session.state.phase).toBe('AWAIT_ROLL');
  });

  it('keeps GAME_OVER when the turn-start trigger ends the game', () => {
    const session = patchSession(
      boot({
        characters: [characterById('char_farmer'), broke],
        players: [
          { id: 'p1', nickname: '阿一', characterId: 'char_farmer', isAI: false },
          { id: 'p2', nickname: '阿二', characterId: 'char_broke', isAI: true },
        ],
      }),
      (state) => ({ ...state, phase: 'AWAIT_END_TURN' }),
    );
    const ended = applyIntent(session, msg('INTENT_END_TURN', 'p1', {}));
    expect(ended.session.state.phase).toBe('GAME_OVER');
    expect(ended.session.state.winnerId).toBe('p1');
  });
});

/* F5 — a creditor inherits the pledged state of the deed. */
describe('F5 bankruptcy inheritance', () => {
  it('keeps the mortgage on inherited property', () => {
    const base = setMoney(
      placeOnRing(ownTile(ownTile(boot(), 't1', 'p2'), 't4', 'p1', 0, true), 'p1', 1),
      'p1',
      0,
    );
    const before = sessionNetWorth(base, 'p2');
    const landed = resolveCurrentLanding(base, 'p1');
    expect(landed.session.state.board.tiles['t4']).toMatchObject({
      ownerId: 'p2',
      mortgaged: true,
      level: 0,
    });
    // Rent (60) plus the deed's equity (1000 invested - 500 loan), not the
    // full invested value.
    expect(sessionNetWorth(landed.session, 'p2')).toBe(before + 60 + 500);
  });
});

/* F6a — no off-turn mortgage, for humans or AI. */
describe('F6a off-turn mortgage', () => {
  it('refuses an AI seat mortgaging out of turn', () => {
    const session = patchSession(ownTile(boot(), 't4', 'p4'), (state) => ({
      ...state,
      activePlayerIndex: 1,
    }));
    expect(applyIntent(session, msg('INTENT_MORTGAGE', 'p4', { tileId: 't4' })).rejected).toBe(
      'not-your-turn',
    );
  });
});

/* F6b — character ids must exist in the content pack. */
describe('F6b unknown characters', () => {
  it('refuses a character id that is not in the pack', () => {
    const result = applyIntent(
      makeSession(),
      msg('INTENT_SELECT_CHARACTER', 'p1', { characterId: 'char_nope' }),
    );
    expect(result.rejected).toBe('unknown-character:char_nope');
  });

  it('refuses to start with an unknown character', () => {
    const started = startGame(
      makeSession({
        players: [
          { id: 'p1', nickname: 'a', characterId: 'char_nope', isAI: false },
          { id: 'p2', nickname: 'b', characterId: 'char_farmer', isAI: true },
        ],
      }),
    );
    expect(started.rejected).toBe('unknown-character:char_nope');
  });
});

/* F7 — deterministic ordering and an uncorrelated target draw. */
describe('F7 determinism hazards', () => {
  it('orders strings by code unit, not locale', () => {
    expect(compareCodeUnits('Z', 'a')).toBe(-1);
    expect(compareCodeUnits('a', 'Z')).toBe(1);
    expect(compareCodeUnits('x', 'x')).toBe(0);
  });

  it('never uses localeCompare inside the engine', () => {
    const dir = join(process.cwd(), 'src', 'engine');
    const offenders = (readdirSync(dir, { recursive: true }) as string[])
      .filter((file) => file.endsWith('.ts'))
      .filter((file) => readFileSync(join(dir, file), 'utf8').includes('.localeCompare('));
    expect(offenders).toEqual([]);
  });

  it('consumes the cursor for a random chaos target', () => {
    const map = { ...TEST_MAP, events: ['chaos_swap'] };
    const session = setMoney(placeOnRing(boot({ map }), 'p1', 3), 'p1', 50_000);
    expect(session.state.rngCursor).toBe(0);
    const landed = resolveCurrentLanding(session, 'p1');
    // One draw for the event, one for the target: reusing the same cursor
    // value would correlate the pick with the next random draw.
    expect(landed.session.state.rngCursor).toBe(2);
  });
});

/* F9 — newly wired trigger points and content validation. */
describe('F9 triggers and validation', () => {
  const skillList = (skill: Skill): Character[] =>
    TEST_CHARACTERS.map((entry) => (entry.id === 'char_farmer' ? { ...entry, skill } : entry));

  it('fires ON_LAND once the landing resolves', () => {
    const characters = skillList({
      id: 'skill_land',
      name: '落地生财',
      desc: '落格时获得 300。',
      type: 'TRIGGER',
      trigger: 'ON_LAND',
      effect: [{ kind: 'MONEY', value: 300 }],
    });
    const session = placeOnRing(makeSession({ characters }), 'p1', 0);
    const landed = resolveCurrentLanding(session, 'p1');
    // START bonus (2000) plus the ON_LAND trigger (300).
    expect(landed.session.state.players.find((player) => player.id === 'p1')?.money).toBe(22_300);
  });

  it('fires ON_CHAOS when a chaos event resolves on the player', () => {
    const characters = skillList({
      id: 'skill_chaos',
      name: '乐子人',
      desc: '遇到整蛊事件时额外获得 100。',
      type: 'TRIGGER',
      trigger: 'ON_CHAOS',
      effect: [{ kind: 'MONEY', value: 100 }],
    });
    const map = { ...TEST_MAP, events: ['chaos_gain'] };
    const session = placeOnRing(makeSession({ characters, map }), 'p1', 3);
    const landed = resolveCurrentLanding(session, 'p1');
    // chaos_gain pays 500, the ON_CHAOS trigger adds 100.
    expect(landed.session.state.players.find((player) => player.id === 'p1')?.money).toBe(20_600);
  });

  it('rejects an ACTIVE skill with no cooldown', () => {
    const characters = skillList({
      id: 'skill_bad',
      name: '无限提款',
      desc: '没有冷却的主动技能。',
      type: 'ACTIVE',
      effect: [{ kind: 'MONEY', value: 100 }],
    });
    const issues = validateContentPack({
      characters,
      chaosEvents: TEST_CHAOS_EVENTS,
      miniGames: TEST_MINIGAMES,
      maps: [TEST_MAP],
    });
    expect(issues).toContain('skill skill_bad: ACTIVE skills require cooldown >= 1');
  });

  it('rejects a conditional warp and a targetless WARP effect', () => {
    const map = {
      ...TEST_MAP,
      board: {
        ...TEST_MAP.board,
        warps: [
          ...TEST_MAP.board.warps,
          { fromTileId: 't7', toTileId: 'c_plaza', bidirectional: false, condition: 'has-key' },
        ],
      },
    };
    expect(
      validateMapDefinition(map).some((issue) =>
        issue.includes('conditional warps are not supported'),
      ),
    ).toBe(true);

    const issues = validateContentPack({
      characters: TEST_CHARACTERS,
      chaosEvents: [
        {
          id: 'chaos_broken',
          title: '坏事件',
          text: '没有目标。',
          weight: 1,
          target: 'SELF',
          effect: [{ kind: 'WARP' }],
        },
      ],
      miniGames: TEST_MINIGAMES,
      maps: [TEST_MAP],
    });
    expect(issues.some((issue) => issue.includes('WARP requires tileId and/or nodeId'))).toBe(true);
  });
});

/* F8a — the landing player always takes part in the mini-game. */
describe('F8a mini-game seating', () => {
  it('seats the actor in a two-player mini-game', () => {
    const miniGames: MiniGameDefinition[] = [
      {
        id: 'mg_duel',
        kind: 'WHEEL',
        name: '两人转盘',
        minPlayers: 2,
        maxPlayers: 2,
        rules: {},
        rewards: [{ kind: 'MONEY', value: 1000 }],
      },
    ];
    const map = {
      ...TEST_MAP,
      board: {
        ...TEST_MAP.board,
        center: TEST_MAP.board.center.map((node) =>
          node.id === 'c_wheel' ? { ...node, payloadRef: 'mg_duel' } : node,
        ),
      },
    };
    const session = patchSession(
      placeOnRing(makeSession({ map, miniGames }), 'p3', 11),
      (state) => ({
        ...state,
        activePlayerIndex: 2,
      }),
    );
    const landed = resolveCurrentLanding(session, 'p3');
    expect(landed.session.state.minigame?.participantIds).toContain('p3');
  });
});

/* F8c — every player sharing the best rank is rewarded. */
describe('F8c mini-game tie rewards', () => {
  it('rewards every rank-1 player', () => {
    const miniGames: MiniGameDefinition[] = [
      ...TEST_MINIGAMES,
      {
        id: 'mg_rps',
        kind: 'RPS',
        name: '猜拳',
        minPlayers: 2,
        maxPlayers: 4,
        rules: {},
        rewards: [{ kind: 'MONEY', value: 1000 }],
      },
    ];
    const session = patchSession(makeSession({ miniGames }), (state) => ({
      ...state,
      phase: 'MINIGAME',
      minigame: {
        minigameId: 'mg_rps',
        kind: 'RPS',
        participantIds: ['p1', 'p2', 'p3', 'p4'],
        submissions: { p1: 'ROCK', p2: 'ROCK', p3: 'ROCK' },
      },
    }));
    const before = session.state.players.map((player) => player.money);
    const result = applyIntent(
      session,
      msg('INTENT_MINIGAME_ACTION', 'p4', { minigameId: 'mg_rps', action: 'ROCK' }),
    );
    expect(result.rejected).toBeNull();
    result.session.state.players.forEach((player, index) => {
      expect(player.money).toBe((before[index] ?? 0) + 1000);
    });
  });
});

/* F10 — host-side seat APIs and reserved sequence numbers. */
describe('F10 seat management', () => {
  it('adds, connects and removes seats through the reducer', () => {
    let session = makeSession({
      players: [
        { id: 'p1', nickname: 'a', characterId: 'char_farmer', isAI: false },
        { id: 'p2', nickname: 'b', characterId: 'char_girl', isAI: true },
      ],
    });
    const added = addPlayer(session, {
      id: 'p3',
      nickname: 'c',
      characterId: 'char_madame',
      isAI: false,
    });
    expect(added.rejected).toBeNull();
    session = added.session;
    expect(session.state.players.map((player) => player.id)).toContain('p3');

    expect(
      addPlayer(session, { id: 'p3', nickname: 'dup', characterId: 'char_ninja', isAI: false })
        .rejected,
    ).toBe('player-id-taken');
    expect(
      addPlayer(session, { id: 'p9', nickname: 'x', characterId: 'char_nope', isAI: false })
        .rejected,
    ).toBe('unknown-character:char_nope');

    const disconnected = setPlayerConnected(session, 'p3', false);
    expect(disconnected.session.state.players.find((player) => player.id === 'p3')?.connected).toBe(
      false,
    );

    const removed = removePlayer(session, 'p3');
    expect(removed.session.state.players.map((player) => player.id)).not.toContain('p3');
  });

  it('reserves a sequence number for a rejected character pick', () => {
    const session = makeSession();
    const result = applyIntent(
      session,
      msg('INTENT_SELECT_CHARACTER', 'p2', { characterId: 'char_farmer' }),
    );
    expect(result.rejected).toBe('character-taken');
    expect(result.session.state.eventSeq).toBeGreaterThan(session.state.eventSeq);
  });
});
