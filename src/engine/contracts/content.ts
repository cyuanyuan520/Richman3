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
import { EffectListSchema } from './effects';
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
  /** Free-form per-kind tuning consumed by the matching resolver. */
  rules: z.record(z.string(), z.union([z.number(), z.string(), z.boolean()])),
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
    if (tile.type !== 'PROPERTY' && tile.price !== undefined) {
      issues.push(`non-PROPERTY tile ${tile.id} must not declare a price`);
    }
  });

  const ringIds = new Set(ring.map((tile) => tile.id));
  const centerIds = new Set(center.map((node) => node.id));
  for (const warp of warps) {
    if (!ringIds.has(warp.fromTileId)) {
      issues.push(`warp source ${warp.fromTileId} is not a ring tile`);
    }
    if (!ringIds.has(warp.toTileId) && !centerIds.has(warp.toTileId)) {
      issues.push(`warp target ${warp.toTileId} does not exist on the board`);
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
  for (const map of pack.maps) {
    for (const issue of validateMapDefinition(map)) {
      issues.push(`map ${map.id}: ${issue}`);
    }
    for (const eventId of map.events) {
      if (!eventIds.has(eventId)) {
        issues.push(`map ${map.id}: unknown chaos event ${eventId}`);
      }
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
