/**
 * Character skill evaluation (REQ-009/REQ-018).
 *
 * PASSIVE and TRIGGER skills are evaluated at their trigger point; ACTIVE
 * skills are issued by the player through `INTENT_USE_SKILL` and are subject to
 * silence, cooldown and money cost.
 */

import type { Character, Skill } from './contracts/content';
import type { Effect } from './contracts/effects';
import type { SkillTrigger } from './contracts/primitives';
import type { Player } from './contracts/state';

export interface SkillRegistry {
  readonly bySkillId: ReadonlyMap<string, Skill>;
  readonly byCharacterId: ReadonlyMap<string, Character>;
}

export function buildSkillRegistry(characters: readonly Character[]): SkillRegistry {
  const bySkillId = new Map<string, Skill>();
  const byCharacterId = new Map<string, Character>();
  for (const character of characters) {
    byCharacterId.set(character.id, character);
    bySkillId.set(character.skill.id, character.skill);
  }
  return { bySkillId, byCharacterId };
}

export function skillOf(player: Player, registry: SkillRegistry): Skill | null {
  const character = registry.byCharacterId.get(player.characterId);
  return character === undefined ? null : character.skill;
}

export function hasStatus(player: Player, status: Player['statuses'][number]['status']): boolean {
  return player.statuses.some((entry) => entry.status === status);
}

/**
 * Effects that fire for `trigger`. ACTIVE skills are excluded because they only
 * apply when explicitly used.
 */
export function triggerEffects(
  player: Player,
  registry: SkillRegistry,
  trigger: SkillTrigger,
): readonly Effect[] {
  const skill = skillOf(player, registry);
  if (skill === null) return [];
  if (skill.type === 'ACTIVE') return [];
  if (skill.trigger !== trigger) return [];
  return skill.effect;
}

/**
 * Rent is multiplied by every `RENT_BOOST` the owner currently carries, plus
 * any `RENT_BOOST` declared by an `ON_PAY` skill (passive or trigger type).
 */
export function rentMultiplier(player: Player, registry: SkillRegistry): number {
  let multiplier = 1;
  for (const status of player.statuses) {
    if (status.status === 'RENT_BOOST' && status.value !== undefined) {
      multiplier *= 1 + status.value;
    }
  }
  const skill = skillOf(player, registry);
  if (skill !== null && skill.type !== 'ACTIVE' && skill.trigger === 'ON_PAY') {
    for (const effect of skill.effect) {
      if (
        effect.kind === 'STATUS' &&
        effect.status === 'RENT_BOOST' &&
        effect.value !== undefined
      ) {
        multiplier *= 1 + effect.value;
      }
    }
  }
  return multiplier;
}

export interface SkillUseCheck {
  readonly ok: boolean;
  readonly reason?: string;
}

export function canUseSkill(player: Player, skill: Skill, registry: SkillRegistry): SkillUseCheck {
  const owned = skillOf(player, registry);
  if (owned === null || owned.id !== skill.id) {
    return { ok: false, reason: 'skill-not-owned' };
  }
  if (skill.type !== 'ACTIVE') {
    return { ok: false, reason: 'skill-not-active' };
  }
  if (player.bankrupt) {
    return { ok: false, reason: 'player-bankrupt' };
  }
  if (hasStatus(player, 'SILENCED')) {
    return { ok: false, reason: 'silenced' };
  }
  const cooldown = player.skillCooldowns[skill.id] ?? 0;
  if (cooldown > 0) {
    return { ok: false, reason: 'cooldown' };
  }
  if (skill.cost !== undefined && player.money < skill.cost) {
    return { ok: false, reason: 'insufficient-funds' };
  }
  return { ok: true };
}
