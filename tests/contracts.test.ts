import { describe, expect, it } from 'vitest';
import { canonicalize, hashState, hashValue } from '../src/engine/hash';
import {
  CharacterSchema,
  ClientIntentMessageSchema,
  ChaosEventSchema,
  GameStateSchema,
  HostEventMessageSchema,
  MapDefinitionSchema,
  RoomConfigSchema,
  SettingsSchema,
  parseSettings,
  validateContentPack,
  validateEffectList,
  validateMapDefinition,
} from '../src/engine';
import type { ContentPack } from '../src/engine';
import {
  TEST_CHAOS_EVENTS,
  TEST_CHARACTERS,
  TEST_MAP,
  TEST_MINIGAMES,
  TEST_ROOM_CONFIG,
  makeSession,
} from './fixtures/content';

describe('stable hashing', () => {
  it('sorts object keys so insertion order does not matter', () => {
    expect(canonicalize({ b: 1, a: 2 })).toBe(canonicalize({ a: 2, b: 1 }));
    expect(hashValue({ b: 1, a: 2 })).toBe(hashValue({ a: 2, b: 1 }));
  });

  it('keeps array order significant', () => {
    expect(hashValue([1, 2])).not.toBe(hashValue([2, 1]));
  });

  it('rejects non-canonicalizable values', () => {
    expect(() => canonicalize(Number.NaN)).toThrow(TypeError);
    expect(() => canonicalize(undefined)).toThrow(TypeError);
  });
});

describe('content contracts', () => {
  it('accepts the fixture map and finds no topology issues', () => {
    expect(MapDefinitionSchema.safeParse(TEST_MAP).success).toBe(true);
    expect(validateMapDefinition(TEST_MAP)).toEqual([]);
  });

  it('accepts the fixture content pack', () => {
    const pack: ContentPack = {
      characters: TEST_CHARACTERS,
      chaosEvents: TEST_CHAOS_EVENTS,
      miniGames: TEST_MINIGAMES,
      maps: [TEST_MAP],
    };
    expect(validateContentPack(pack)).toEqual([]);
  });

  it('reports ring index gaps, duplicate ids and dangling warps', () => {
    const broken = {
      ...TEST_MAP,
      board: {
        ...TEST_MAP.board,
        ring: TEST_MAP.board.ring.map((tile) => (tile.id === 't3' ? { ...tile, index: 42 } : tile)),
        warps: [{ fromTileId: 't0', toTileId: 'nowhere', bidirectional: true }],
      },
    };
    const issues = validateMapDefinition(broken);
    expect(issues.some((issue) => issue.includes('expected 3'))).toBe(true);
    expect(issues.some((issue) => issue.includes('nowhere'))).toBe(true);
  });

  it('requires a price on PROPERTY tiles only', () => {
    const broken = {
      ...TEST_MAP,
      board: {
        ...TEST_MAP.board,
        ring: TEST_MAP.board.ring.map((tile) =>
          tile.id === 't1' ? { ...tile, price: undefined } : tile,
        ),
      },
    };
    const issues = validateMapDefinition(broken);
    expect(issues.some((issue) => issue.includes('missing a price'))).toBe(true);
  });

  it('rejects a skill with no effects and an event with weight 0', () => {
    expect(
      CharacterSchema.safeParse({
        ...TEST_CHARACTERS[0],
        skill: { ...TEST_CHARACTERS[0]!.skill, effect: [] },
      }).success,
    ).toBe(false);
    expect(ChaosEventSchema.safeParse({ ...TEST_CHAOS_EVENTS[0], weight: 0 }).success).toBe(false);
  });

  it('flags a WARP effect without a target', () => {
    expect(validateEffectList([{ kind: 'WARP' }])).toHaveLength(1);
    expect(validateEffectList([{ kind: 'WARP', tileId: 't0' }])).toEqual([]);
  });
});

describe('room config and settings', () => {
  it('accepts only the classic preset values', () => {
    expect(RoomConfigSchema.safeParse(TEST_ROOM_CONFIG).success).toBe(true);
    expect(
      RoomConfigSchema.safeParse({
        ...TEST_ROOM_CONFIG,
        victory: { kind: 'ASSET_TARGET', value: 4 },
      }).success,
    ).toBe(false);
    expect(
      RoomConfigSchema.safeParse({
        ...TEST_ROOM_CONFIG,
        victory: { kind: 'TURN_LIMIT', value: 100 },
      }).success,
    ).toBe(false);
    expect(
      RoomConfigSchema.safeParse({
        ...TEST_ROOM_CONFIG,
        victory: { kind: 'TURN_LIMIT', value: 365 },
      }).success,
    ).toBe(true);
  });

  it('round-trips settings and rejects stale payloads', () => {
    const settings = {
      v: 1,
      nickname: '阿伟',
      bgmVolume: 0.6,
      sfxVolume: 0.8,
      quality: 'HIGH',
      muted: false,
    };
    expect(SettingsSchema.safeParse(settings).success).toBe(true);
    expect(parseSettings(settings)).toEqual(settings);
    expect(parseSettings({ ...settings, v: 2 })).toBeNull();
    expect(parseSettings({ ...settings, bgmVolume: 2 })).toBeNull();
    expect(parseSettings(null)).toBeNull();
  });
});

describe('wire contracts', () => {
  it('parses a client intent and rejects unknown types', () => {
    const intent = {
      v: 1,
      type: 'INTENT_BUY',
      seq: 42,
      from: 'p1',
      payload: { tileId: 't1' },
    };
    expect(ClientIntentMessageSchema.safeParse(intent).success).toBe(true);
    expect(ClientIntentMessageSchema.safeParse({ ...intent, type: 'INTENT_HACK' }).success).toBe(
      false,
    );
    expect(
      ClientIntentMessageSchema.safeParse({ ...intent, payload: { tileId: '' } }).success,
    ).toBe(false);
  });

  it('carries a full state snapshot', () => {
    const session = makeSession();
    expect(GameStateSchema.safeParse(session.state).success).toBe(true);
    const event = {
      v: 1,
      type: 'STATE_SNAPSHOT',
      seq: 1,
      from: 'host',
      payload: { state: session.state },
    };
    expect(HostEventMessageSchema.safeParse(event).success).toBe(true);
  });

  it('salts the snapshot hash by turn', () => {
    const session = makeSession();
    const advanced = { ...session.state, turn: session.state.turn + 1 };
    expect(hashState(session.state)).not.toBe(hashState(advanced));
  });
});
