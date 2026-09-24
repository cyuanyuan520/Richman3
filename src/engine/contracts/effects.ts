/**
 * The shared effect DSL used by chaos events and character skills (GUD-009).
 *
 * The spec lists the kind set as `MONEY | MOVE | SWAP_POS | SKIP_TURN | STATUS |
 * VISUAL | WARP | SKILL`. Each kind keeps that exact discriminant and adds
 * explicitly typed fields instead of the spec's loose `{ value, duration? }`
 * so the reducer cannot misread a payload.
 */

import { z } from 'zod';
import { PlayerStatusSchema } from './primitives';

export const EFFECT_KINDS = [
  'MONEY',
  'MOVE',
  'SWAP_POS',
  'SKIP_TURN',
  'STATUS',
  'VISUAL',
  'WARP',
  'SKILL',
] as const;

/** Signed integer cash delta. */
export const MoneyEffectSchema = z.object({
  kind: z.literal('MONEY'),
  value: z.number().int(),
});

/** Signed ring steps; negative moves backwards without paying salary. */
export const MoveEffectSchema = z.object({
  kind: z.literal('MOVE'),
  value: z.number().int(),
});

/** Swap board positions with the currently resolved target. */
export const SwapPosEffectSchema = z.object({
  kind: z.literal('SWAP_POS'),
});

export const SkipTurnEffectSchema = z.object({
  kind: z.literal('SKIP_TURN'),
  value: z.number().int().min(1),
});

export const StatusEffectSchema = z.object({
  kind: z.literal('STATUS'),
  status: PlayerStatusSchema,
  duration: z.number().int().min(1),
  /** Magnitude for statuses that need one (`RENT_BOOST` = 0.2 means +20%). */
  value: z.number().optional(),
});

/** Purely presentational cue; never mutates rules state. */
export const VisualEffectSchema = z.object({
  kind: z.literal('VISUAL'),
  visual: z.string().min(1).max(64),
  duration: z.number().int().min(1).optional(),
});

/**
 * Teleport to a ring tile and/or a center node.
 *
 * Both fields stay optional here so this member remains a plain object inside
 * the discriminated union; the "at least one target" rule is enforced by
 * `EffectListSchema` and by the reducer.
 */
export const WarpEffectSchema = z.object({
  kind: z.literal('WARP'),
  tileId: z.string().min(1).max(64).optional(),
  nodeId: z.string().min(1).max(64).optional(),
});

/** Trigger or grant a skill by content id. */
export const SkillEffectSchema = z.object({
  kind: z.literal('SKILL'),
  skillId: z.string().min(1).max(64),
});

export const EffectSchema = z.discriminatedUnion('kind', [
  MoneyEffectSchema,
  MoveEffectSchema,
  SwapPosEffectSchema,
  SkipTurnEffectSchema,
  StatusEffectSchema,
  VisualEffectSchema,
  WarpEffectSchema,
  SkillEffectSchema,
]);

export type Effect = z.infer<typeof EffectSchema>;
export type EffectKind = Effect['kind'];

/**
 * Plain array schema (no refinements) so callers can compose `.min(1)` etc.
 * Cross-member rules live in `validateEffectList` and are enforced at content
 * load time plus inside the reducer.
 */
export const EffectListSchema = z.array(EffectSchema);

/** Returns human-readable problems; empty array means valid. */
export function validateEffectList(effects: readonly Effect[]): string[] {
  const issues: string[] = [];
  effects.forEach((effect, index) => {
    if (effect.kind === 'WARP' && effect.tileId === undefined && effect.nodeId === undefined) {
      issues.push(`effect[${index}]: WARP requires tileId and/or nodeId`);
    }
    if (effect.kind === 'STATUS' && effect.status === 'RENT_BOOST' && effect.value === undefined) {
      issues.push(`effect[${index}]: RENT_BOOST status requires value`);
    }
    if (
      effect.kind === 'STATUS' &&
      effect.status !== 'RENT_BOOST' &&
      effect.value !== undefined &&
      effect.value !== 0
    ) {
      issues.push(`effect[${index}]: status ${effect.status} does not accept a magnitude`);
    }
  });
  return issues;
}
