/**
 * Wire contract (spec §4): the client→host intents and host→all events carried
 * inside the `NetMessage` envelope `{ v, type, seq, from, to?, payload }`.
 *
 * The envelope is a discriminated union on `type` so both ends of the wire get
 * exhaustive narrowing instead of casting `payload`.
 */

import { z } from 'zod';
import { RoomConfigSchema } from './config';
import { MiniGameKindSchema, PlayerIdSchema, ROOM_CODE_SCHEMA, ROOM_ID_SCHEMA } from './primitives';
import { GameEventSchema, GameStateSchema, PendingChoiceKindSchema, PlayerSchema } from './state';

export const NET_PROTOCOL_VERSION = 1;

const EnvelopeFields = {
  v: z.literal(NET_PROTOCOL_VERSION),
  seq: z.number().int().min(0),
  from: PlayerIdSchema,
};

const RouteFields = {
  to: PlayerIdSchema.optional(),
};

/* ------------------------------------------------------- client → host */

export const JoinPayloadSchema = z.object({
  roomId: ROOM_ID_SCHEMA.optional(),
  roomCode: ROOM_CODE_SCHEMA.optional(),
  nickname: z.string().min(1).max(24),
  characterId: z.string().min(1).max(64).optional(),
});
export type JoinPayload = z.infer<typeof JoinPayloadSchema>;

export const ClientIntentMessageSchema = z.discriminatedUnion('type', [
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('INTENT_JOIN'),
    payload: JoinPayloadSchema,
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('INTENT_SELECT_CHARACTER'),
    payload: z.object({ characterId: z.string().min(1).max(64) }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('INTENT_ROLL'),
    payload: z.object({}),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('INTENT_BUY'),
    payload: z.object({ tileId: z.string().min(1).max(64) }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('INTENT_UPGRADE'),
    payload: z.object({ tileId: z.string().min(1).max(64) }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('INTENT_MORTGAGE'),
    payload: z.object({ tileId: z.string().min(1).max(64) }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('INTENT_REDEEM'),
    payload: z.object({ tileId: z.string().min(1).max(64) }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('INTENT_CHOICE'),
    payload: z.object({
      choice: PendingChoiceKindSchema,
      option: z.string().min(1).max(64),
    }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('INTENT_END_TURN'),
    payload: z.object({}),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('INTENT_ENTER_CENTER'),
    payload: z.object({ nodeId: z.string().min(1).max(64) }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('INTENT_MINIGAME_ACTION'),
    payload: z.object({
      minigameId: z.string().min(1).max(64),
      action: z.string().min(1).max(64),
    }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('INTENT_USE_SKILL'),
    payload: z.object({
      skillId: z.string().min(1).max(64),
      targetPlayerId: PlayerIdSchema.optional(),
    }),
  }),
]);
export type ClientIntentMessage = z.infer<typeof ClientIntentMessageSchema>;
export type ClientIntent = ClientIntentMessage;
export type ClientIntentType = ClientIntentMessage['type'];

export const CLIENT_INTENT_TYPES = [
  'INTENT_JOIN',
  'INTENT_SELECT_CHARACTER',
  'INTENT_ROLL',
  'INTENT_BUY',
  'INTENT_UPGRADE',
  'INTENT_MORTGAGE',
  'INTENT_REDEEM',
  'INTENT_CHOICE',
  'INTENT_END_TURN',
  'INTENT_ENTER_CENTER',
  'INTENT_MINIGAME_ACTION',
  'INTENT_USE_SKILL',
] as const satisfies readonly ClientIntentType[];

/* ------------------------------------------------------- host → all */

export const RoomPlayerSummarySchema = PlayerSchema.pick({
  id: true,
  nickname: true,
  characterId: true,
  isAI: true,
  connected: true,
});
export type RoomPlayerSummary = z.infer<typeof RoomPlayerSummarySchema>;

export const HostEventMessageSchema = z.discriminatedUnion('type', [
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('STATE_EVENT'),
    payload: z.object({ events: z.array(GameEventSchema) }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('STATE_SNAPSHOT'),
    payload: z.object({ state: GameStateSchema }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('ROOM_INFO'),
    payload: z.object({
      roomId: z.string().min(1).max(64),
      roomCode: ROOM_CODE_SCHEMA,
      hostPeerId: z.string().min(1).max(64),
      mapId: z.string().min(1).max(64),
      config: RoomConfigSchema,
      players: z.array(RoomPlayerSummarySchema).max(4),
    }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('TURN_START'),
    payload: z.object({ playerId: PlayerIdSchema, turn: z.number().int().min(1) }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('MINIGAME_START'),
    payload: z.object({
      minigameId: z.string().min(1).max(64),
      kind: MiniGameKindSchema,
      playerIds: z.array(PlayerIdSchema).min(2).max(4),
    }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('MINIGAME_RESULT'),
    payload: z.object({
      minigameId: z.string().min(1).max(64),
      results: z.array(
        z.object({ playerId: PlayerIdSchema, rank: z.number().int().min(1).max(4) }),
      ),
    }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('JOIN_PENDING'),
    payload: z.object({ playerId: PlayerIdSchema, nickname: z.string().min(1).max(24) }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('JOIN_ACCEPTED'),
    payload: z.object({ playerId: PlayerIdSchema, seatIndex: z.number().int().min(0).max(3) }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('JOIN_REJECTED'),
    payload: z.object({ playerId: PlayerIdSchema, reason: z.string().min(1).max(96) }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('CHARACTER_TAKEN'),
    payload: z.object({ characterId: z.string().min(1).max(64), byPlayerId: PlayerIdSchema }),
  }),
  z.object({
    ...EnvelopeFields,
    ...RouteFields,
    type: z.literal('GAME_OVER'),
    payload: z.object({
      winnerId: PlayerIdSchema.nullable(),
      standings: z.array(
        z.object({
          playerId: PlayerIdSchema,
          netWorth: z.number().int(),
          bankrupt: z.boolean(),
        }),
      ),
    }),
  }),
]);
export type HostEventMessage = z.infer<typeof HostEventMessageSchema>;
export type HostEventType = HostEventMessage['type'];

export const HOST_EVENT_TYPES = [
  'STATE_EVENT',
  'STATE_SNAPSHOT',
  'ROOM_INFO',
  'TURN_START',
  'MINIGAME_START',
  'MINIGAME_RESULT',
  'JOIN_PENDING',
  'JOIN_ACCEPTED',
  'JOIN_REJECTED',
  'CHARACTER_TAKEN',
  'GAME_OVER',
] as const satisfies readonly HostEventType[];

/* -------------------------------------------------------------- envelope */

/** Loose envelope used for routing before the concrete type is known. */
export const NetMessageEnvelopeSchema = z.object({
  v: z.literal(NET_PROTOCOL_VERSION),
  type: z.string().min(1).max(48),
  seq: z.number().int().min(0),
  from: PlayerIdSchema,
  to: PlayerIdSchema.optional(),
  payload: z.unknown(),
});
export type NetMessageEnvelope = z.infer<typeof NetMessageEnvelopeSchema>;

export const NetMessageSchema = z.union([ClientIntentMessageSchema, HostEventMessageSchema]);
export type NetMessage = z.infer<typeof NetMessageSchema>;

/** Type guard for host→all traffic. */
export function isHostEvent(message: NetMessage): message is HostEventMessage {
  return (HOST_EVENT_TYPES as readonly string[]).includes(message.type);
}

/** Type guard for client→host traffic. */
export function isClientIntent(message: NetMessage): message is ClientIntentMessage {
  return (CLIENT_INTENT_TYPES as readonly string[]).includes(message.type);
}
