/**
 * Room presets (REQ-027/REQ-032) and local settings (REQ-024/REQ-025).
 */

import { z } from 'zod';
import { EventRateSchema, QualitySchema } from './primitives';

/** Classic 《大富翁4》 win conditions: own cash multiple of the starting funds. */
export const ASSET_TARGET_MULTIPLIERS = [2, 3, 5, 10] as const;
/** Classic time limits in turns, where one turn is one day. */
export const TURN_LIMIT_VALUES = [30, 90, 180, 365, 730] as const;

export const AssetTargetValueSchema = z.union([
  z.literal(2),
  z.literal(3),
  z.literal(5),
  z.literal(10),
]);
export const TurnLimitValueSchema = z.union([
  z.literal(30),
  z.literal(90),
  z.literal(180),
  z.literal(365),
  z.literal(730),
]);

export const VictoryConditionSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('ASSET_TARGET'), value: AssetTargetValueSchema }),
  z.object({ kind: z.literal('TURN_LIMIT'), value: TurnLimitValueSchema }),
]);
export type VictoryCondition = z.infer<typeof VictoryConditionSchema>;

export const RoomConfigSchema = z.object({
  eventRate: EventRateSchema,
  victory: VictoryConditionSchema,
  /** When true, room-code joins must be accepted by the host (REQ-030). */
  requireApproval: z.boolean(),
});
export type RoomConfig = z.infer<typeof RoomConfigSchema>;

export const DEFAULT_ROOM_CONFIG: RoomConfig = {
  eventRate: 'MEDIUM',
  victory: { kind: 'ASSET_TARGET', value: 3 },
  requireApproval: false,
};

/* ----------------------------------------------------------------- settings */

export const SETTINGS_STORAGE_KEY = 'richman3.settings';

export const SettingsSchema = z.object({
  v: z.literal(1),
  nickname: z.string().min(1).max(24),
  bgmVolume: z.number().min(0).max(1),
  sfxVolume: z.number().min(0).max(1),
  quality: QualitySchema,
  muted: z.boolean(),
});
export type Settings = z.infer<typeof SettingsSchema>;

export const DEFAULT_SETTINGS: Settings = {
  v: 1,
  nickname: '玩家',
  bgmVolume: 0.6,
  sfxVolume: 0.8,
  quality: 'HIGH',
  muted: false,
};

/**
 * Parses persisted settings. Returns `null` for anything that does not match
 * the current version so callers fall back to `DEFAULT_SETTINGS` instead of
 * crashing on a stale or corrupt entry (edge case in spec §9).
 */
export function parseSettings(raw: unknown): Settings | null {
  const result = SettingsSchema.safeParse(raw);
  return result.success ? result.data : null;
}

/* -------------------------------------------------------------- theme tokens */

export const ThemeTokensSchema = z.object({
  colors: z.record(z.string().min(1).max(32), z.string().regex(/^#[0-9a-fA-F]{6}$/)),
  lightIntensity: z.number().min(0).max(10),
  shadowSoftness: z.number().min(0).max(1),
});
export type ThemeTokens = z.infer<typeof ThemeTokensSchema>;
