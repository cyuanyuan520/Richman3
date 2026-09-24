/**
 * Shared primitive contract pieces (spec §4).
 */

import { z } from 'zod';

export const TILE_TYPES = [
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
] as const;
export const TileTypeSchema = z.enum(TILE_TYPES);
export type TileType = z.infer<typeof TileTypeSchema>;

export const CENTER_NODE_TYPES = ['MINIGAME', 'EVENT', 'SHOP', 'TELEPORT'] as const;
export const CenterNodeTypeSchema = z.enum(CENTER_NODE_TYPES);
export type CenterNodeType = z.infer<typeof CenterNodeTypeSchema>;

/** World position in the 3D scene, `[x, y, z]`. */
export const Vec3Schema = z.tuple([z.number().finite(), z.number().finite(), z.number().finite()]);
export type Vec3 = z.infer<typeof Vec3Schema>;

export const TARGETS = ['SELF', 'RANDOM_OPPONENT', 'ALL', 'LEADER'] as const;
export const TargetSchema = z.enum(TARGETS);
export type Target = z.infer<typeof TargetSchema>;

export const PLAYER_STATUSES = ['SHIELD', 'SILENCED', 'LUCKY', 'UNLUCKY', 'RENT_BOOST'] as const;
export const PlayerStatusSchema = z.enum(PLAYER_STATUSES);
export type PlayerStatus = z.infer<typeof PlayerStatusSchema>;

export const ARCHETYPES = ['farmer', 'girl', 'madame', 'ninja'] as const;
export const ArchetypeSchema = z.enum(ARCHETYPES);
export type Archetype = z.infer<typeof ArchetypeSchema>;

export const SKILL_TYPES = ['PASSIVE', 'ACTIVE', 'TRIGGER'] as const;
export const SkillTypeSchema = z.enum(SKILL_TYPES);
export type SkillType = z.infer<typeof SkillTypeSchema>;

export const SKILL_TRIGGERS = [
  'ON_ROLL',
  'ON_LAND',
  'ON_PAY',
  'ON_TURN_START',
  'ON_CHAOS',
] as const;
export const SkillTriggerSchema = z.enum(SKILL_TRIGGERS);
export type SkillTrigger = z.infer<typeof SkillTriggerSchema>;

export const MINIGAME_KINDS = ['WHEEL', 'RPS', 'GACHA'] as const;
export const MiniGameKindSchema = z.enum(MINIGAME_KINDS);
export type MiniGameKind = z.infer<typeof MiniGameKindSchema>;

export const QUALITY_LEVELS = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const QualitySchema = z.enum(QUALITY_LEVELS);
export type Quality = z.infer<typeof QualitySchema>;

export const EVENT_RATES = ['LOW', 'MEDIUM', 'HIGH'] as const;
export const EventRateSchema = z.enum(EVENT_RATES);
export type EventRate = z.infer<typeof EventRateSchema>;

/** Mirrors `src/lib/room-code.ts` (kept local to avoid a lib → engine import). */
export const ROOM_ID_SCHEMA = z.string().regex(/^rm3-[A-Za-z0-9_-]{21}$/, 'invalid room id');
export const ROOM_CODE_SCHEMA = z
  .string()
  .regex(/^[23456789ABCDEFGHJKMNPQRSTUVWXYZ]{6}$/, 'invalid room code');

export const PlayerIdSchema = z.string().min(1).max(64);
export const TileIdSchema = z.string().min(1).max(64);
export const NodeIdSchema = z.string().min(1).max(64);
export const ContentIdSchema = z.string().min(1).max(64);

/** Money is always an integer to keep arithmetic exact. */
export const MoneySchema = z.number().int();
