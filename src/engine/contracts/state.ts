/**
 * Authoritative state contract (spec §4). `STATE_SNAPSHOT` carries exactly this
 * object, so the schema is the single source of truth for host/client parity.
 */

import { z } from 'zod';
import { EconomyRulesSchema } from '../economy';
import { RoomConfigSchema } from './config';
import {
  ContentIdSchema,
  MiniGameKindSchema,
  MoneySchema,
  NodeIdSchema,
  PlayerIdSchema,
  PlayerStatusSchema,
  TileIdSchema,
} from './primitives';

export const GAME_PHASES = [
  'SETUP',
  'AWAIT_ROLL',
  'AWAIT_CHOICE',
  'AWAIT_END_TURN',
  'MINIGAME',
  'GAME_OVER',
] as const;
export const GamePhaseSchema = z.enum(GAME_PHASES);
export type GamePhase = z.infer<typeof GamePhaseSchema>;

export const PlayerPositionSchema = z.discriminatedUnion('zone', [
  z.object({ zone: z.literal('ring'), index: z.number().int().min(0) }),
  z.object({
    zone: z.literal('center'),
    nodeId: NodeIdSchema,
    /** Ring tile the player must return to after the center node resolves. */
    entryTileId: TileIdSchema.optional(),
  }),
]);
export type PlayerPosition = z.infer<typeof PlayerPositionSchema>;

export const OwnedPropertySchema = z.object({
  tileId: TileIdSchema,
  level: z.number().int().min(0).max(8),
  mortgaged: z.boolean(),
});
export type OwnedProperty = z.infer<typeof OwnedPropertySchema>;

export const ActiveStatusSchema = z.object({
  status: PlayerStatusSchema,
  remainingTurns: z.number().int().min(1),
  value: z.number().optional(),
});
export type ActiveStatus = z.infer<typeof ActiveStatusSchema>;

export const PlayerSchema = z.object({
  id: PlayerIdSchema,
  nickname: z.string().min(1).max(24),
  characterId: ContentIdSchema,
  isAI: z.boolean(),
  money: MoneySchema,
  position: PlayerPositionSchema,
  bankrupt: z.boolean(),
  skipTurns: z.number().int().min(0),
  properties: z.array(OwnedPropertySchema).max(64),
  statuses: z.array(ActiveStatusSchema).max(16),
  skillCooldowns: z.record(z.string().min(1), z.number().int().min(0)),
  /** Transport-level flag mirrored into state for the room UI. */
  connected: z.boolean(),
});
export type Player = z.infer<typeof PlayerSchema>;

export const TileStateSchema = z.object({
  tileId: TileIdSchema,
  ownerId: PlayerIdSchema.nullable(),
  level: z.number().int().min(0).max(8),
  mortgaged: z.boolean(),
});
export type TileState = z.infer<typeof TileStateSchema>;

export const BoardStateSchema = z.object({
  tiles: z.record(TileIdSchema, TileStateSchema),
});
export type BoardState = z.infer<typeof BoardStateSchema>;

export const PENDING_CHOICE_KINDS = [
  'BUY_PROPERTY',
  'UPGRADE_PROPERTY',
  'MINIGAME',
  'CENTER_EXIT',
] as const;
export const PendingChoiceKindSchema = z.enum(PENDING_CHOICE_KINDS);
export type PendingChoiceKind = z.infer<typeof PendingChoiceKindSchema>;

export const PendingChoiceSchema = z.object({
  kind: PendingChoiceKindSchema,
  playerId: PlayerIdSchema,
  tileId: TileIdSchema.optional(),
  nodeId: NodeIdSchema.optional(),
  minigameId: ContentIdSchema.optional(),
  options: z.array(z.string().min(1).max(64)).min(1).max(8),
});
export type PendingChoice = z.infer<typeof PendingChoiceSchema>;

/**
 * In-flight mini-game. `submissions` accumulates one entry per participant
 * until every participant has answered, then the host resolves and clears it.
 */
export const MiniGameStateSchema = z.object({
  minigameId: ContentIdSchema,
  kind: MiniGameKindSchema,
  participantIds: z.array(PlayerIdSchema).min(2).max(4),
  submissions: z.record(PlayerIdSchema, z.string().min(1).max(32)),
});
export type MiniGameState = z.infer<typeof MiniGameStateSchema>;

export const GameEventSchema = z.object({
  seq: z.number().int().min(0),
  type: z.string().min(1).max(48),
  turn: z.number().int().min(1),
  playerId: PlayerIdSchema.nullable(),
  data: z.record(z.string(), z.unknown()),
});
export type GameEvent = z.infer<typeof GameEventSchema>;

export const MAX_EVENT_LOG = 400;
export const MAX_SEED_LENGTH = 128;

export const GameStateSchema = z.object({
  version: z.literal(1),
  seed: z.string().min(1).max(MAX_SEED_LENGTH),
  mapId: ContentIdSchema,
  turn: z.number().int().min(1),
  activePlayerIndex: z.number().int().min(0),
  phase: GamePhaseSchema,
  players: z.array(PlayerSchema).min(2).max(4),
  board: BoardStateSchema,
  /** Fully resolved economy, so replay never re-reads the map definition. */
  economy: EconomyRulesSchema,
  roomConfig: RoomConfigSchema,
  rngCursor: z.number().int().min(0),
  eventSeq: z.number().int().min(0),
  eventLog: z.array(GameEventSchema).max(MAX_EVENT_LOG),
  pendingChoice: PendingChoiceSchema.nullable(),
  minigame: MiniGameStateSchema.nullable(),
  winnerId: PlayerIdSchema.nullable(),
  /** Chaos event ids available on this map; the draw picks from this pool. */
  chaosPool: z.array(ContentIdSchema),
});
export type GameState = z.infer<typeof GameStateSchema>;
