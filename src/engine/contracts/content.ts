/**
 * Content contracts: board topology, characters/skills, chaos events and
 * mini-game definitions (spec §4).
 *
 * These schemas validate hand-authored or generated content. Semantic rules
 * that Zod cannot express (ring index contiguity, dangling warp endpoints,
 * PROPERTY without a price, …) live in `validateMapDefinition` and
 * `validateContentPack` so they can report *all* problems at once.
 */

import { z } from 'zod';
import { EconomyRulesOverrideSchema } from '../economy';
import { EffectListSchema, validateEffectList, type Effect } from './effects';
import {
  ArchetypeSchema,
  CenterNodeTypeSchema,
  ContentIdSchema,
  MiniGameKindSchema,
  MoneySchema,
  NodeIdSchema,
  SkillTriggerSchema,
  SkillTypeSchema,
  TileIdSchema,
  TileTypeSchema,
  Vec3Schema,
} from './primitives';

/* ------------------------------------------------------------------ board */

export const RingTileSchema = z.object({
  id: TileIdSchema,
  kind: z.literal('ring'),
  index: z.number().int().min(0),
  type: TileTypeSchema,
  name: z.string().min(1).max(32),
  pos: Vec3Schema,
  /** Required for `PROPERTY`, ignored otherwise. */
  price: MoneySchema.positive().optional(),
  /** Colour group used for the UI legend and value tiers. */
  group: z.string().min(1).max(32).optional(),
  modelRef: z.string().min(1).max(64).optional(),
  /** Extra effects applied on landing, after the tile type behaviour. */
  onEnter: EffectListSchema.optional(),
});
export type RingTile = z.infer<typeof RingTileSchema>;

export const CenterNodeSchema = z.object({
  id: NodeIdSchema,
  kind: z.literal('center'),
  type: CenterNodeTypeSchema,
  name: z.string().min(1).max(32),
  payloadRef: ContentIdSchema,
  pos: Vec3Schema.optional(),
});
export type CenterNode = z.infer<typeof CenterNodeSchema>;

/** A board node is either a ring tile or a center node (GUD-006). */
export type BoardNode = RingTile | CenterNode;

export const WarpSchema = z.object({
  fromTileId: TileIdSchema,
  /** Ring tile id or center node id. */
  toTileId: ContentIdSchema,
  bidirectional: z.boolean(),
  /** Free-form gate key; `undefined` means the warp always applies. */
  condition: z.string().min(1).max(64).optional(),
});
export type Warp = z.infer<typeof WarpSchema>;

export const BoardSchema = z.object({
  ring: z.array(RingTileSchema).min(8).max(200),
  center: z.array(CenterNodeSchema).max(32),
  warps: z.array(WarpSchema).max(64),
});
export type Board = z.infer<typeof BoardSchema>;

export const MapDefinitionSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1).max(48),
  theme: z.string().min(1).max(48),
  board: BoardSchema,
  /** Asset manifest keys referenced by this map. */
  assets: z.array(ContentIdSchema).max(256),
  rules: EconomyRulesOverrideSchema,
  /** Chaos event ids selectable on this map. */
  events: z.array(ContentIdSchema).max(256),
});
export type MapDefinition = z.infer<typeof MapDefinitionSchema>;

/* ------------------------------------------------- characters and skills */

export const SkillSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1).max(24),
  desc: z.string().min(1).max(160),
  type: SkillTypeSchema,
  trigger: SkillTriggerSchema.optional(),
  cooldown: z.number().int().min(0).max(99).optional(),
  cost: MoneySchema.min(0).optional(),
  effect: EffectListSchema.min(1),
});
export type Skill = z.infer<typeof SkillSchema>;

export const CharacterSchema = z.object({
  id: ContentIdSchema,
  name: z.string().min(1).max(24),
  archetype: ArchetypeSchema,
  modelRef: ContentIdSchema,
  portraitRef: ContentIdSchema,
  personality: z.string().min(1).max(96).optional(),
  skill: SkillSchema,
});
export type Character = z.infer<typeof CharacterSchema>;

/* --------------------------------------------------------- chaos events */

export const ChaosEventSchema = z.object({
  id: ContentIdSchema,
  title: z.string().min(1).max(24),
  text: z.string().min(1).max(200),
  weight: z.number().int().min(1).max(1000),
  target: z.enum(['SELF', 'RANDOM_OPPONENT', 'ALL', 'LEADER']),
  effect: EffectListSchema.min(1),
});
export type ChaosEvent = z.infer<typeof ChaosEventSchema>;

/* ------------------------------------------------------------- minigames */

export const MiniGameDefinitionSchema = z.object({
  id: ContentIdSchema,
  kind: MiniGameKindSchema,
  name: z.string().min(1).max(24),
  minPlayers: z.number().int().min(2).max(4),
  maxPlayers: z.number().int().min(2).max(4),
  /**
   * Optional per-kind tuning consumed by the matching resolver — currently
   * `WHEEL.spinMax`. Unknown keys and omitted values fall back to the
   * resolver's own defaults, so this stays a tuning surface rather than a
   * second source of truth.
   */
  rules: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])).optional(),
  /** Effects granted to the winner; runners-up receive nothing. */
  rewards: EffectListSchema,
});
export type MiniGameDefinition = z.infer<typeof MiniGameDefinitionSchema>;

/* ------------------------------------------------------------- content pack */

export const ContentPackSchema = z.object({
  characters: z.array(CharacterSchema).min(1).max(16),
  chaosEvents: z.array(ChaosEventSchema).min(1).max(256),
  miniGames: z.array(MiniGameDefinitionSchema).min(1).max(16),
  maps: z.array(MapDefinitionSchema).min(1).max(32),
});
export type ContentPack = z.infer<typeof ContentPackSchema>;

/* ------------------------------------------------------------- validation */

function duplicateIds(ids: readonly string[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) duplicates.add(id);
    seen.add(id);
  }
  return [...duplicates].sort();
}

/**
 * Indices of `WARP` effects whose declared targets are not present in the
 * supplied id sets. `validateEffectList` only checks that *some* target was
 * declared; a target that does not exist would silently NOOP at runtime.
 */
function danglingWarpEffects(
  effects: readonly Effect[],
  ringIds: ReadonlySet<string>,
  centerIds: ReadonlySet<string>,
): number[] {
  const dangling: number[] = [];
  effects.forEach((effect, index) => {
    if (effect.kind !== 'WARP') return;
    const tileOk = effect.tileId === undefined || ringIds.has(effect.tileId);
    const nodeOk = effect.nodeId === undefined || centerIds.has(effect.nodeId);
    if (!tileOk || !nodeOk) dangling.push(index);
  });
  return dangling;
}

/** Semantic + topological map validation. Returns all problems found. */
export function validateMapDefinition(map: MapDefinition): string[] {
  const issues: string[] = [];
  const { ring, center, warps } = map.board;

  for (const id of duplicateIds(ring.map((tile) => tile.id))) {
    issues.push(`duplicate ring tile id: ${id}`);
  }
  for (const id of duplicateIds(center.map((node) => node.id))) {
    issues.push(`duplicate center node id: ${id}`);
  }
  for (const id of duplicateIds([...ring.map((t) => t.id), ...center.map((n) => n.id)])) {
    issues.push(`board id shared by ring and center: ${id}`);
  }

  const startTiles = ring.filter((tile) => tile.type === 'START');
  if (startTiles.length !== 1) {
    issues.push(`exactly one START tile is required, found ${String(startTiles.length)}`);
  }

  ring.forEach((tile, position) => {
    if (tile.index !== position) {
      issues.push(
        `ring tile ${tile.id} has index ${String(tile.index)}, expected ${String(position)}`,
      );
    }
    if (tile.type === 'PROPERTY' && tile.price === undefined) {
      issues.push(`PROPERTY tile ${tile.id} is missing a price`);
    }
    if (tile.type === 'PROPERTY' && tile.group === undefined) {
      // The UI legend and value tiers key on the group, so a missing group is
      // silently unrenderable content rather than a styling choice.
      issues.push(`PROPERTY tile ${tile.id} is missing a group`);
    }
    if (tile.type !== 'PROPERTY' && tile.price !== undefined) {
      issues.push(`non-PROPERTY tile ${tile.id} must not declare a price`);
    }
  });

  const ringIds = new Set(ring.map((tile) => tile.id));
  const centerIds = new Set(center.map((node) => node.id));
  const warpSourceCounts = new Map<string, number>();
  for (const warp of warps) {
    if (!ringIds.has(warp.fromTileId)) {
      issues.push(`warp source ${warp.fromTileId} is not a ring tile`);
    } else {
      const source = ring.find((tile) => tile.id === warp.fromTileId);
      // `applyTileBehaviour` only follows a warp when the tile type is WARP, so
      // a warp declared on any other tile type would silently never fire.
      if (source !== undefined && source.type !== 'WARP') {
        issues.push(
          `warp source ${warp.fromTileId} is a ${source.type} tile; only WARP tiles can warp`,
        );
      }
      warpSourceCounts.set(warp.fromTileId, (warpSourceCounts.get(warp.fromTileId) ?? 0) + 1);
    }
    if (!ringIds.has(warp.toTileId) && !centerIds.has(warp.toTileId)) {
      issues.push(`warp target ${warp.toTileId} does not exist on the board`);
    }
    // `condition` has no evaluator yet; accepting it would silently make the
    // warp unconditional at runtime.
    if (warp.condition !== undefined) {
      issues.push(
        `warp ${warp.fromTileId} -> ${warp.toTileId}: conditional warps are not supported`,
      );
    }
    // The reducer always returns a centre visitor to the tile they entered from,
    // so a one-way declaration would be a lie rather than a rule.
    if (!warp.bidirectional) {
      issues.push(
        `warp ${warp.fromTileId} -> ${warp.toTileId}: one-way warps are not supported (the piece always returns to its entry tile)`,
      );
    }
  }
  // Insertion order follows the `warps` array, so the message order is stable.
  for (const [tileId, count] of warpSourceCounts) {
    // `outgoingWarp` returns the first match only, so extra edges are dead content.
    if (count > 1) {
      issues.push(
        `tile ${tileId} declares ${String(count)} outgoing warps; only the first is used`,
      );
    }
  }

  for (const tile of ring) {
    if (tile.onEnter === undefined) continue;
    for (const issue of validateEffectList(tile.onEnter)) {
      issues.push(`ring tile ${tile.id} onEnter: ${issue}`);
    }
    for (const index of danglingWarpEffects(tile.onEnter, ringIds, centerIds)) {
      issues.push(`ring tile ${tile.id} onEnter: effect[${String(index)}] WARP target is unknown`);
    }
  }

  for (const node of center) {
    // `c_exit`-style teleports read `payloadRef` as a ring tile id; a typo would
    // silently return the visitor to their entry tile instead.
    if (node.type === 'TELEPORT' && !ringIds.has(node.payloadRef)) {
      issues.push(`center node ${node.id} teleports to unknown ring tile ${node.payloadRef}`);
    }
  }

  for (const id of duplicateIds(map.events)) {
    issues.push(`duplicate chaos event reference: ${id}`);
  }

  return issues;
}

/** Semantic content-pack validation across characters, events, minigames, maps. */
export function validateContentPack(pack: ContentPack): string[] {
  const issues: string[] = [];

  for (const id of duplicateIds(pack.characters.map((entry) => entry.id))) {
    issues.push(`duplicate character id: ${id}`);
  }
  for (const id of duplicateIds(pack.characters.map((entry) => entry.skill.id))) {
    issues.push(`duplicate skill id: ${id}`);
  }
  for (const id of duplicateIds(pack.chaosEvents.map((entry) => entry.id))) {
    issues.push(`duplicate chaos event id: ${id}`);
  }
  for (const id of duplicateIds(pack.miniGames.map((entry) => entry.id))) {
    issues.push(`duplicate minigame id: ${id}`);
  }
  for (const id of duplicateIds(pack.maps.map((entry) => entry.id))) {
    issues.push(`duplicate map id: ${id}`);
  }

  const characterIds = new Set(pack.characters.map((entry) => entry.id));
  if (characterIds.size < 2) issues.push('at least two characters are required');

  const eventIds = new Set(pack.chaosEvents.map((entry) => entry.id));
  const skillIds = new Set(pack.characters.map((entry) => entry.skill.id));
  const activeSkillIds = new Set(
    pack.characters.filter((entry) => entry.skill.type === 'ACTIVE').map((entry) => entry.skill.id),
  );
  // Effect-level WARP targets are global (a skill or chaos event can be used on
  // any map), so they only need to resolve on at least one board.
  const boardRingIds = new Set<string>();
  const boardCenterIds = new Set<string>();
  for (const map of pack.maps) {
    for (const tile of map.board.ring) boardRingIds.add(tile.id);
    for (const node of map.board.center) boardCenterIds.add(node.id);
  }

  /** Cross-references that a skill or chaos event can silently fail on. */
  function checkEffectReferences(where: string, effects: readonly Effect[]): void {
    for (const index of danglingWarpEffects(effects, boardRingIds, boardCenterIds)) {
      issues.push(`${where}: effect[${String(index)}] WARP target is unknown on every map`);
    }
    for (const effect of effects) {
      if (effect.kind !== 'SKILL') continue;
      if (!skillIds.has(effect.skillId)) {
        issues.push(`${where}: unknown skill ${effect.skillId}`);
      } else if (activeSkillIds.has(effect.skillId)) {
        // Invoking an ACTIVE skill through the effect DSL would bypass its
        // cooldown, which is the only thing keeping it finite.
        issues.push(`${where}: must not invoke ACTIVE skill ${effect.skillId}`);
      }
    }
  }

  for (const map of pack.maps) {
    for (const issue of validateMapDefinition(map)) {
      issues.push(`map ${map.id}: ${issue}`);
    }
    for (const eventId of map.events) {
      if (!eventIds.has(eventId)) {
        issues.push(`map ${map.id}: unknown chaos event ${eventId}`);
      }
    }
    for (const node of map.board.center) {
      if (node.type === 'EVENT' && !eventIds.has(node.payloadRef)) {
        issues.push(
          `map ${map.id}: center node ${node.id} references unknown chaos event ${node.payloadRef}`,
        );
      }
    }
  }

  for (const character of pack.characters) {
    const { skill } = character;
    for (const issue of validateEffectList(skill.effect)) {
      issues.push(`skill ${skill.id}: ${issue}`);
    }
    if (skill.type === 'ACTIVE') {
      if (skill.trigger !== undefined) {
        issues.push(`skill ${skill.id}: ACTIVE skills must not declare a trigger`);
      }
      // ACTIVE skills are always given a cooldown floor by the reducer, but
      // content should say so explicitly rather than rely on the fallback.
      if ((skill.cooldown ?? 0) < 1) {
        issues.push(`skill ${skill.id}: ACTIVE skills require cooldown >= 1`);
      }
    } else if (skill.trigger === undefined) {
      issues.push(`skill ${skill.id}: ${skill.type} skills require a trigger`);
    }
    if (skill.type !== 'ACTIVE' && skill.trigger === 'ON_PAY') {
      // Only the rent-multiplier path is wired up for ON_PAY; anything else
      // would silently do nothing.
      const unsupported = skill.effect.some(
        (effect) => !(effect.kind === 'STATUS' && effect.status === 'RENT_BOOST'),
      );
      if (unsupported) {
        issues.push(`skill ${skill.id}: ON_PAY supports only STATUS RENT_BOOST effects`);
      }
    }
    checkEffectReferences(`skill ${skill.id}`, skill.effect);
  }

  for (const event of pack.chaosEvents) {
    for (const issue of validateEffectList(event.effect)) {
      issues.push(`chaos event ${event.id}: ${issue}`);
    }
    checkEffectReferences(`chaos event ${event.id}`, event.effect);
  }

  for (const minigame of pack.miniGames) {
    for (const issue of validateEffectList(minigame.rewards)) {
      issues.push(`minigame ${minigame.id}: ${issue}`);
    }
    checkEffectReferences(`minigame ${minigame.id}`, minigame.rewards);
    if (minigame.minPlayers > minigame.maxPlayers) {
      issues.push(`minigame ${minigame.id}: minPlayers exceeds maxPlayers`);
    }
  }

  const miniGameIds = new Set(pack.miniGames.map((entry) => entry.id));
  for (const map of pack.maps) {
    for (const node of map.board.center) {
      if ((node.type === 'MINIGAME' || node.type === 'SHOP') && !miniGameIds.has(node.payloadRef)) {
        issues.push(
          `map ${map.id}: center node ${node.id} references unknown minigame ${node.payloadRef}`,
        );
      }
    }
  }

  return issues;
}
