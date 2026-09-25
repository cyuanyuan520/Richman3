/**
 * Deterministic content used only by engine unit tests. The shipped pack lives
 * in `src/content`; these fixtures stay minimal so engine tests fail for engine
 * reasons, not because someone rebalanced the real map.
 */

import type {
  Character,
  ChaosEvent,
  MapDefinition,
  MiniGameDefinition,
} from '../../src/engine/contracts/content';
import type { RoomConfig } from '../../src/engine/contracts/config';
import type { GameState } from '../../src/engine/contracts/state';
import {
  createSession,
  type CreateGameInput,
  type GameSession,
  syncPlayerProperties,
} from '../../src/engine/reducer';

export const TEST_MAP: MapDefinition = {
  id: 'test_map',
  name: '测试市集',
  theme: 'modern-city',
  board: {
    ring: [
      { id: 't0', kind: 'ring', index: 0, type: 'START', name: '起点', pos: [0, 0, 0] },
      {
        id: 't1',
        kind: 'ring',
        index: 1,
        type: 'PROPERTY',
        name: '街角便利店',
        pos: [1, 0, 0],
        price: 600,
        group: 'blue',
      },
      {
        id: 't2',
        kind: 'ring',
        index: 2,
        type: 'PROPERTY',
        name: '奶茶铺',
        pos: [2, 0, 0],
        price: 600,
        group: 'blue',
      },
      { id: 't3', kind: 'ring', index: 3, type: 'CHANCE', name: '机会', pos: [3, 0, 0] },
      {
        id: 't4',
        kind: 'ring',
        index: 4,
        type: 'PROPERTY',
        name: '写字楼',
        pos: [4, 0, 0],
        price: 1000,
        group: 'red',
      },
      { id: 't5', kind: 'ring', index: 5, type: 'TAX', name: '税务局', pos: [5, 0, 0] },
      { id: 't6', kind: 'ring', index: 6, type: 'JAIL', name: '看守所', pos: [6, 0, 0] },
      { id: 't7', kind: 'ring', index: 7, type: 'WARP', name: '地铁口', pos: [7, 0, 0] },
      {
        id: 't8',
        kind: 'ring',
        index: 8,
        type: 'PROPERTY',
        name: '百货商场',
        pos: [8, 0, 0],
        price: 1000,
        group: 'red',
      },
      { id: 't9', kind: 'ring', index: 9, type: 'BONUS', name: '红包雨', pos: [9, 0, 0] },
      { id: 't10', kind: 'ring', index: 10, type: 'CHAOS', name: '整蛊屋', pos: [10, 0, 0] },
      { id: 't11', kind: 'ring', index: 11, type: 'MINIGAME', name: '游乐场', pos: [11, 0, 0] },
    ],
    center: [
      { id: 'c_wheel', kind: 'center', type: 'MINIGAME', name: '幸运转盘', payloadRef: 'mg_wheel' },
      { id: 'c_plaza', kind: 'center', type: 'EVENT', name: '中央广场', payloadRef: 'chaos_gain' },
      { id: 'c_exit', kind: 'center', type: 'TELEPORT', name: '直达电梯', payloadRef: 't0' },
      { id: 'c_shop', kind: 'center', type: 'SHOP', name: '道具铺', payloadRef: 'mg_gacha' },
    ],
    warps: [
      // One conforming warp: only WARP tiles may warp, only the first edge per
      // tile is honoured, and the piece always returns to its entry tile.
      { fromTileId: 't7', toTileId: 'c_wheel', bidirectional: true },
    ],
  },
  assets: [],
  rules: {
    chaosTriggerChance: { LOW: 1, MEDIUM: 1, HIGH: 1 },
  },
  events: ['chaos_gain', 'chaos_swap', 'chaos_toll'],
};

export const TEST_CHARACTERS: Character[] = [
  {
    id: 'char_farmer',
    name: '土伯·阿旺',
    archetype: 'farmer',
    modelRef: 'char_farmer',
    portraitRef: 'portrait_farmer',
    skill: {
      id: 'skill_farmer_salary',
      name: '起早贪黑',
      desc: '每回合开始额外领取 200。',
      type: 'PASSIVE',
      trigger: 'ON_TURN_START',
      effect: [{ kind: 'MONEY', value: 200 }],
    },
  },
  {
    id: 'char_girl',
    name: '元气小妹·果果',
    archetype: 'girl',
    modelRef: 'char_girl',
    portraitRef: 'portrait_girl',
    skill: {
      id: 'skill_girl_allowance',
      name: '撒娇要零花',
      desc: '主动技能：立刻获得 1500（冷却 2 回合）。',
      type: 'ACTIVE',
      cooldown: 2,
      effect: [{ kind: 'MONEY', value: 1500 }],
    },
  },
  {
    id: 'char_madame',
    name: '收租婆·珍姐',
    archetype: 'madame',
    modelRef: 'char_madame',
    portraitRef: 'portrait_madame',
    skill: {
      id: 'skill_madame_rent',
      name: '狮子大开口',
      desc: '收取租金时额外 +20%。',
      type: 'PASSIVE',
      trigger: 'ON_PAY',
      effect: [{ kind: 'STATUS', status: 'RENT_BOOST', duration: 1, value: 0.2 }],
    },
  },
  {
    id: 'char_ninja',
    name: '隐形忍·阿影',
    archetype: 'ninja',
    modelRef: 'char_ninja',
    portraitRef: 'portrait_ninja',
    skill: {
      id: 'skill_ninja_step',
      name: '影分身步',
      desc: '每回合掷骰后额外前进 1 格。',
      type: 'TRIGGER',
      trigger: 'ON_ROLL',
      effect: [{ kind: 'MOVE', value: 1 }],
    },
  },
];

export const TEST_CHAOS_EVENTS: ChaosEvent[] = [
  {
    id: 'chaos_gain',
    title: '天降横财',
    text: '捡到一只鼓鼓的钱包。',
    weight: 10,
    target: 'SELF',
    effect: [{ kind: 'MONEY', value: 500 }],
  },
  {
    id: 'chaos_swap',
    title: '乾坤大挪移',
    text: '你和别人交换了位置。',
    weight: 5,
    target: 'RANDOM_OPPONENT',
    effect: [{ kind: 'SWAP_POS' }],
  },
  {
    id: 'chaos_toll',
    title: '全员罚款',
    text: '大家都要交罚款。',
    weight: 5,
    target: 'ALL',
    effect: [{ kind: 'MONEY', value: -800 }],
  },
];

export const TEST_MINIGAMES: MiniGameDefinition[] = [
  {
    id: 'mg_wheel',
    kind: 'WHEEL',
    name: '幸运转盘',
    minPlayers: 2,
    maxPlayers: 4,
    rules: {},
    rewards: [{ kind: 'MONEY', value: 1000 }],
  },
  {
    id: 'mg_gacha',
    kind: 'GACHA',
    name: '欧气抽卡',
    minPlayers: 2,
    maxPlayers: 4,
    rules: {},
    rewards: [{ kind: 'MONEY', value: 800 }],
  },
];

export const TEST_ROOM_CONFIG: RoomConfig = {
  eventRate: 'MEDIUM',
  victory: { kind: 'ASSET_TARGET', value: 3 },
  requireApproval: false,
};

export type FixtureOptions = Partial<CreateGameInput>;

export function makeSession(options: FixtureOptions = {}): GameSession {
  return createSession({
    seed: options.seed ?? 'test-seed',
    map: options.map ?? TEST_MAP,
    roomConfig: options.roomConfig ?? TEST_ROOM_CONFIG,
    characters: options.characters ?? TEST_CHARACTERS,
    chaosEvents: options.chaosEvents ?? TEST_CHAOS_EVENTS,
    miniGames: options.miniGames ?? TEST_MINIGAMES,
    players: options.players ?? [
      { id: 'p1', nickname: '阿一', characterId: 'char_farmer', isAI: false },
      { id: 'p2', nickname: '阿二', characterId: 'char_girl', isAI: true },
      { id: 'p3', nickname: '阿三', characterId: 'char_madame', isAI: true },
      { id: 'p4', nickname: '阿四', characterId: 'char_ninja', isAI: true },
    ],
  });
}

/** Test-only structural patch helper. */
export function patchSession(
  session: GameSession,
  mutate: (state: GameState) => GameState,
): GameSession {
  return { ...session, state: syncPlayerProperties(mutate(session.state)) };
}

export function placeOnRing(session: GameSession, playerId: string, index: number): GameSession {
  return patchSession(session, (state) => ({
    ...state,
    players: state.players.map((player) =>
      player.id === playerId ? { ...player, position: { zone: 'ring', index } } : player,
    ),
  }));
}

export function placeInCenter(session: GameSession, playerId: string, nodeId: string): GameSession {
  return patchSession(session, (state) => ({
    ...state,
    players: state.players.map((player) =>
      player.id === playerId ? { ...player, position: { zone: 'center', nodeId } } : player,
    ),
  }));
}

export function setMoney(session: GameSession, playerId: string, money: number): GameSession {
  return patchSession(session, (state) => ({
    ...state,
    players: state.players.map((player) =>
      player.id === playerId ? { ...player, money } : player,
    ),
  }));
}

export function ownTile(
  session: GameSession,
  tileId: string,
  ownerId: string,
  level = 0,
  mortgaged = false,
): GameSession {
  return patchSession(session, (state) => ({
    ...state,
    board: {
      ...state.board,
      tiles: { ...state.board.tiles, [tileId]: { tileId, ownerId, level, mortgaged } },
    },
  }));
}
