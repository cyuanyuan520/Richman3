import { describe, expect, it } from 'vitest';
import {
  buildContentPack,
  collectContentIssues,
  defaultContentPackRaw,
  CHARACTERS,
  CHAOS_EVENTS,
  CITY_METRO,
  CONTENT_PACK,
  MINI_GAMES,
  THEME_TOKENS,
} from '../src/content';
import { PLAYER_STATUSES } from '../src/engine/contracts/primitives';
import { EFFECT_KINDS } from '../src/engine/contracts/effects';

/** Deep-mutable copy of the shipped pack, used to build broken variants. */
function mutablePack(): Record<string, unknown> {
  return JSON.parse(JSON.stringify(defaultContentPackRaw())) as Record<string, unknown>;
}

function withPack(mutate: (pack: Record<string, unknown>) => void): unknown {
  const pack = mutablePack();
  mutate(pack);
  return pack;
}

function firstMapOf(pack: Record<string, unknown>): Record<string, unknown> {
  const maps = pack.maps as Record<string, unknown>[];
  const map = maps[0];
  if (map === undefined) throw new Error('test pack has no map');
  return map;
}

function boardOf(pack: Record<string, unknown>): Record<string, unknown> {
  return firstMapOf(pack).board as Record<string, unknown>;
}

describe('content pack: shipped data', () => {
  it('passes schema and semantic validation', () => {
    expect(collectContentIssues(CONTENT_PACK)).toEqual([]);
    expect(() => buildContentPack(defaultContentPackRaw())).not.toThrow();
  });

  it('ships the classic quartet from the spec (REQ-022)', () => {
    expect(CHARACTERS).toHaveLength(4);
    expect(CHARACTERS.map((character) => character.archetype).sort()).toEqual([
      'farmer',
      'girl',
      'madame',
      'ninja',
    ]);
    expect(new Set(CHARACTERS.map((character) => character.id)).size).toBe(4);
    expect(new Set(CHARACTERS.map((character) => character.skill.id)).size).toBe(4);
    for (const character of CHARACTERS) {
      expect(character.skill.effect.length).toBeGreaterThan(0);
      expect(character.name.length).toBeGreaterThan(0);
    }
  });

  it('ships 20-30 chaos events (REQ-023)', () => {
    expect(CHAOS_EVENTS.length).toBeGreaterThanOrEqual(20);
    expect(CHAOS_EVENTS.length).toBeLessThanOrEqual(30);
    for (const event of CHAOS_EVENTS) {
      expect(event.text.length).toBeGreaterThan(4);
      expect(event.weight).toBeGreaterThan(0);
      expect(event.effect.length).toBeGreaterThan(0);
    }
  });

  it('ships the three light mini-games from the spec (REQ-015)', () => {
    expect(MINI_GAMES).toHaveLength(3);
    expect(MINI_GAMES.map((game) => game.kind).sort()).toEqual(['GACHA', 'RPS', 'WHEEL']);
    for (const game of MINI_GAMES) {
      expect(game.rewards.length).toBeGreaterThan(0);
      expect(game.minPlayers).toBeLessThanOrEqual(game.maxPlayers);
    }
  });

  it('ships exactly one launch map with a ring, a centre and warps', () => {
    expect(CONTENT_PACK.maps).toHaveLength(1);
    expect(CITY_METRO.id).toBe('city_metro');
    expect(CITY_METRO.board.ring.length).toBe(32);
    expect(CITY_METRO.board.center.length).toBeGreaterThanOrEqual(4);
    expect(CITY_METRO.board.warps.length).toBeGreaterThanOrEqual(4);
    expect(CITY_METRO.board.ring.filter((tile) => tile.type === 'START')).toHaveLength(1);
  });

  it('covers the balance of tile types the engine implements', () => {
    const types = new Set(CITY_METRO.board.ring.map((tile) => tile.type));
    for (const type of [
      'START',
      'PROPERTY',
      'CHANCE',
      'CHAOS',
      'TAX',
      'EVENT',
      'JAIL',
      'BONUS',
      'MINIGAME',
      'WARP',
    ]) {
      expect(types.has(type as never), `missing tile type ${type}`).toBe(true);
    }
  });

  it('covers every centre node type the engine implements except unused ones', () => {
    const types = new Set(CITY_METRO.board.center.map((node) => node.type));
    expect(types).toEqual(new Set(['MINIGAME', 'SHOP', 'EVENT', 'TELEPORT']));
  });

  it('exercises every effect kind exactly as the DSL defines them (REQ-023)', () => {
    const used = new Set<string>();
    for (const event of CHAOS_EVENTS) {
      for (const effect of event.effect) used.add(effect.kind);
    }
    for (const character of CHARACTERS) {
      for (const effect of character.skill.effect) used.add(effect.kind);
    }
    for (const game of MINI_GAMES) {
      for (const effect of game.rewards) used.add(effect.kind);
    }
    for (const tile of CITY_METRO.board.ring) {
      for (const effect of tile.onEnter ?? []) used.add(effect.kind);
    }
    expect([...used].sort()).toEqual([...EFFECT_KINDS].sort());
  });

  it('only uses statuses the engine actually honours', () => {
    // Guards against re-adding an enum member that no rule reads: content could
    // author it and the effect would silently do nothing.
    expect([...PLAYER_STATUSES]).toEqual(['SHIELD', 'SILENCED', 'RENT_BOOST']);
    const usedStatuses = new Set<string>();
    const collect = (effects: readonly { kind: string; status?: string }[]): void => {
      for (const effect of effects) {
        if (effect.kind === 'STATUS' && effect.status !== undefined) {
          usedStatuses.add(effect.status);
        }
      }
    };
    for (const event of CHAOS_EVENTS) collect(event.effect);
    for (const character of CHARACTERS) collect(character.skill.effect);
    for (const game of MINI_GAMES) collect(game.rewards);
    for (const status of usedStatuses) {
      expect(PLAYER_STATUSES as readonly string[]).toContain(status);
    }
  });

  it('keeps UI palette, tile groups and character colours in sync (GUD-012)', () => {
    const colors = THEME_TOKENS.colors;
    const groups = new Set(
      CITY_METRO.board.ring
        .map((tile) => tile.group)
        .filter((group): group is string => group !== undefined),
    );
    expect(groups.size).toBeGreaterThanOrEqual(4);
    for (const group of groups) {
      const key = `group${group.charAt(0).toUpperCase()}${group.slice(1)}`;
      expect(colors[key], `missing palette entry ${key}`).toBeDefined();
    }
    for (const character of CHARACTERS) {
      expect(
        colors[`player_${character.archetype}`],
        `missing palette entry player_${character.archetype}`,
      ).toBeDefined();
    }
  });

  it('references only assets it declares', () => {
    const declared = new Set(CITY_METRO.assets);
    for (const tile of CITY_METRO.board.ring) {
      if (tile.modelRef !== undefined) {
        expect(declared.has(tile.modelRef), `undeclared asset ${tile.modelRef}`).toBe(true);
      }
    }
    for (const character of CHARACTERS) {
      expect(declared.has(character.modelRef)).toBe(true);
      expect(declared.has(character.portraitRef)).toBe(true);
    }
  });

  it('places every ring tile at a unique world position', () => {
    const positions = CityMetroPositions();
    expect(positions.size).toBe(CITY_METRO.board.ring.length);
  });

  it('gives every ring tile a non-empty name and a unique id', () => {
    const ids = new Set<string>();
    for (const tile of CITY_METRO.board.ring) {
      expect(tile.name.length).toBeGreaterThan(0);
      expect(ids.has(tile.id)).toBe(false);
      ids.add(tile.id);
    }
  });

  it('routes every warp from a WARP tile to a reachable centre node', () => {
    const ringById = new Map(CITY_METRO.board.ring.map((tile) => [tile.id, tile]));
    const centre = new Set(CITY_METRO.board.center.map((node) => node.id));
    for (const warp of CITY_METRO.board.warps) {
      expect(ringById.get(warp.fromTileId)?.type).toBe('WARP');
      expect(centre.has(warp.toTileId)).toBe(true);
      expect(warp.bidirectional).toBe(true);
    }
    // Every centre node is reachable, so no content is stranded.
    const targets = new Set(CITY_METRO.board.warps.map((warp) => warp.toTileId));
    for (const node of CITY_METRO.board.center) {
      expect(targets.has(node.id), `centre node ${node.id} is unreachable`).toBe(true);
    }
  });

  it('uses the whole chaos pool on the launch map (AC-026)', () => {
    const declared = new Set(CHAOS_EVENTS.map((event) => event.id));
    expect([...CITY_METRO.events].sort()).toEqual([...declared].sort());
  });
});

function CityMetroPositions(): Set<string> {
  return new Set(CITY_METRO.board.ring.map((tile) => tile.pos.join(',')));
}

describe('content pack: the JSON boundary rejects broken data', () => {
  it('rejects duplicate character ids', () => {
    const broken = withPack((pack) => {
      const characters = pack.characters as Record<string, unknown>[];
      const first = characters[0];
      if (first === undefined) throw new Error('no character');
      characters[1] = { ...first };
    });
    expect(() => buildContentPack(broken)).toThrow(/duplicate character id/);
  });

  it('rejects a map that references an unknown chaos event', () => {
    const broken = withPack((pack) => {
      firstMapOf(pack).events = ['chaos_does_not_exist'];
    });
    expect(() => buildContentPack(broken)).toThrow(/unknown chaos event chaos_does_not_exist/);
  });

  it('rejects a centre node that references an unknown mini-game', () => {
    const broken = withPack((pack) => {
      const center = boardOf(pack).center as Record<string, unknown>[];
      const node = center[0];
      if (node === undefined) throw new Error('no centre node');
      node.payloadRef = 'mg_missing';
    });
    expect(() => buildContentPack(broken)).toThrow(/references unknown minigame mg_missing/);
  });

  it('rejects a PROPERTY tile without a price', () => {
    const broken = withPack((pack) => {
      const ring = boardOf(pack).ring as Record<string, unknown>[];
      const property = ring.find((tile) => tile.type === 'PROPERTY');
      if (property === undefined) throw new Error('no property');
      delete property.price;
    });
    expect(() => buildContentPack(broken)).toThrow(/missing a price/);
  });

  it('rejects a ring index that does not match its position', () => {
    const broken = withPack((pack) => {
      const ring = boardOf(pack).ring as Record<string, unknown>[];
      const tile = ring[3];
      if (tile === undefined) throw new Error('no tile');
      tile.index = 99;
    });
    expect(() => buildContentPack(broken)).toThrow(/expected 3/);
  });

  it('rejects two START tiles', () => {
    const broken = withPack((pack) => {
      const ring = boardOf(pack).ring as Record<string, unknown>[];
      const tile = ring[1];
      if (tile === undefined) throw new Error('no tile');
      tile.type = 'START';
      delete tile.price;
      delete tile.group;
    });
    expect(() => buildContentPack(broken)).toThrow(/exactly one START tile/);
  });

  it('rejects a warp declared on a tile that is not a WARP tile', () => {
    const broken = withPack((pack) => {
      const ring = boardOf(pack).ring as Record<string, unknown>[];
      const tile = ring[1];
      if (tile === undefined) throw new Error('no tile');
      tile.type = 'CHANCE';
      delete tile.price;
      delete tile.group;
      boardOf(pack).warps = [{ fromTileId: 't01', toTileId: 'c_wheel', bidirectional: true }];
    });
    expect(() => buildContentPack(broken)).toThrow(/only WARP tiles can warp/);
  });

  it('rejects two outgoing warps from the same tile', () => {
    const broken = withPack((pack) => {
      const warps = boardOf(pack).warps as Record<string, unknown>[];
      const first = warps[0];
      if (first === undefined) throw new Error('no warp');
      warps.push({ ...first, toTileId: 'c_rps' });
    });
    expect(() => buildContentPack(broken)).toThrow(/only the first is used/);
  });

  it('rejects a one-way warp the engine cannot honour', () => {
    const broken = withPack((pack) => {
      const warps = boardOf(pack).warps as Record<string, unknown>[];
      const first = warps[0];
      if (first === undefined) throw new Error('no warp');
      first.bidirectional = false;
    });
    expect(() => buildContentPack(broken)).toThrow(/one-way warps are not supported/);
  });

  it('rejects an out-of-range effect payload', () => {
    const broken = withPack((pack) => {
      const events = pack.chaosEvents as Record<string, unknown>[];
      const event = events[0];
      if (event === undefined) throw new Error('no event');
      event.effect = [{ kind: 'SKIP_TURN', value: 9 }];
    });
    expect(() => buildContentPack(broken)).toThrow(/schema validation/);
  });

  it('rejects an ACTIVE skill without a cooldown', () => {
    const broken = withPack((pack) => {
      const characters = pack.characters as Record<string, unknown>[];
      const active = characters.find(
        (character) => (character.skill as Record<string, unknown>).type === 'ACTIVE',
      );
      if (active === undefined) throw new Error('no ACTIVE skill');
      const skill = active.skill as Record<string, unknown>;
      delete skill.cooldown;
    });
    expect(() => buildContentPack(broken)).toThrow(/ACTIVE skills require cooldown >= 1/);
  });

  it('rejects a VISUAL-only unknown visual cue is still schema-valid', () => {
    // VISUAL cues are presentation-only, so any non-empty token is acceptable;
    // this documents that the boundary deliberately does not police cue names.
    const broken = withPack((pack) => {
      const events = pack.chaosEvents as Record<string, unknown>[];
      const event = events[0];
      if (event === undefined) throw new Error('no event');
      event.effect = [{ kind: 'VISUAL', visual: 'not-a-known-cue' }];
    });
    expect(() => buildContentPack(broken)).not.toThrow();
  });
});
