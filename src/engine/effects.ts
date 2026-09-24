/**
 * Effect DSL executor (GUD-009).
 *
 * Pure: takes an authoritative state and returns a new one plus a list of
 * notes that the reducer turns into `GameEvent`s. No clock, no randomness —
 * every stochastic decision happens in the reducer through `rngCursor`.
 */

import type { Effect } from './contracts/effects';
import type { PlayerStatus } from './contracts/primitives';
import type { GameState, Player } from './contracts/state';
import type { BoardGeometry } from './movement';
import { resolveRingMove, withCenterPosition, withRingPosition } from './movement';
import type { SkillRegistry } from './skills';
import { skillOf } from './skills';

export type EffectNote =
  | { readonly type: 'MONEY'; readonly playerId: string; readonly amount: number }
  | { readonly type: 'SALARY'; readonly playerId: string; readonly amount: number }
  | { readonly type: 'MOVE'; readonly playerId: string; readonly steps: number }
  | { readonly type: 'SWAP_POS'; readonly a: string; readonly b: string }
  | { readonly type: 'SKIP_TURN'; readonly playerId: string; readonly turns: number }
  | {
      readonly type: 'STATUS';
      readonly playerId: string;
      readonly status: PlayerStatus;
      readonly duration: number;
    }
  | { readonly type: 'WARP'; readonly playerId: string; readonly target: string }
  | { readonly type: 'VISUAL'; readonly playerId: string; readonly visual: string }
  | { readonly type: 'SKILL'; readonly playerId: string; readonly skillId: string }
  | { readonly type: 'NOOP'; readonly playerId: string; readonly reason: string };

const MAX_SKILL_DEPTH = 4;

export interface EffectOutcome {
  readonly state: GameState;
  readonly notes: readonly EffectNote[];
}

function findPlayer(state: GameState, playerId: string): Player | undefined {
  return state.players.find((player) => player.id === playerId);
}

function replacePlayer(state: GameState, next: Player): GameState {
  return {
    ...state,
    players: state.players.map((player) => (player.id === next.id ? next : player)),
  };
}

function grantStatus(
  player: Player,
  status: PlayerStatus,
  duration: number,
  value?: number,
): Player {
  const existing = player.statuses.filter((entry) => entry.status !== status);
  const entry =
    value === undefined
      ? { status, remainingTurns: duration }
      : { status, remainingTurns: duration, value };
  return { ...player, statuses: [...existing, entry] };
}

/**
 * Applies `effects` to `subjectId`. `sourceId` is the player who caused them and
 * is the counterpart for `SWAP_POS`.
 */
export function applyEffects(
  state: GameState,
  subjectId: string,
  sourceId: string,
  effects: readonly Effect[],
  geometry: BoardGeometry,
  registry: SkillRegistry,
  depth = 0,
): EffectOutcome {
  const notes: EffectNote[] = [];
  let next = state;

  for (const effect of effects) {
    const subject = findPlayer(next, subjectId);
    if (subject === undefined) break;

    switch (effect.kind) {
      case 'MONEY': {
        if (effect.value === 0) break;
        next = replacePlayer(next, { ...subject, money: subject.money + effect.value });
        notes.push({ type: 'MONEY', playerId: subject.id, amount: effect.value });
        break;
      }

      case 'MOVE': {
        if (effect.value === 0) break;
        if (subject.position.zone !== 'ring') {
          notes.push({ type: 'NOOP', playerId: subject.id, reason: 'move-while-in-center' });
          break;
        }
        const { index, laps } = resolveRingMove(
          subject.position.index,
          effect.value,
          geometry.ringSize,
        );
        next = replacePlayer(next, withRingPosition(subject, index));
        notes.push({ type: 'MOVE', playerId: subject.id, steps: effect.value });
        if (laps > 0) {
          const amount = laps * next.economy.salary;
          const moved = findPlayer(next, subject.id);
          if (moved !== undefined) {
            next = replacePlayer(next, { ...moved, money: moved.money + amount });
            notes.push({ type: 'SALARY', playerId: subject.id, amount });
          }
        }
        break;
      }

      case 'SWAP_POS': {
        if (subject.id === sourceId) {
          notes.push({ type: 'NOOP', playerId: subject.id, reason: 'swap-with-self' });
          break;
        }
        const counterpart = findPlayer(next, sourceId);
        if (counterpart === undefined) {
          notes.push({ type: 'NOOP', playerId: subject.id, reason: 'swap-target-missing' });
          break;
        }
        const subjectNext = { ...subject, position: counterpart.position };
        const counterpartNext = { ...counterpart, position: subject.position };
        next = replacePlayer(replacePlayer(next, subjectNext), counterpartNext);
        notes.push({ type: 'SWAP_POS', a: subject.id, b: counterpart.id });
        break;
      }

      case 'SKIP_TURN': {
        next = replacePlayer(next, { ...subject, skipTurns: subject.skipTurns + effect.value });
        notes.push({ type: 'SKIP_TURN', playerId: subject.id, turns: effect.value });
        break;
      }

      case 'STATUS': {
        next = replacePlayer(
          next,
          grantStatus(subject, effect.status, effect.duration, effect.value),
        );
        notes.push({
          type: 'STATUS',
          playerId: subject.id,
          status: effect.status,
          duration: effect.duration,
        });
        break;
      }

      case 'VISUAL': {
        notes.push({ type: 'VISUAL', playerId: subject.id, visual: effect.visual });
        break;
      }

      case 'WARP': {
        if (effect.nodeId !== undefined) {
          next = replacePlayer(next, withCenterPosition(subject, effect.nodeId));
          notes.push({ type: 'WARP', playerId: subject.id, target: effect.nodeId });
          break;
        }
        if (effect.tileId !== undefined) {
          const index = geometry.ringIndexById[effect.tileId];
          if (index === undefined) {
            notes.push({
              type: 'NOOP',
              playerId: subject.id,
              reason: `unknown-tile:${effect.tileId}`,
            });
            break;
          }
          next = replacePlayer(next, withRingPosition(subject, index));
          notes.push({ type: 'WARP', playerId: subject.id, target: effect.tileId });
        }
        break;
      }

      case 'SKILL': {
        if (depth >= MAX_SKILL_DEPTH) {
          notes.push({ type: 'NOOP', playerId: subject.id, reason: 'skill-recursion-limit' });
          break;
        }
        const skill = registry.bySkillId.get(effect.skillId);
        if (skill === undefined) {
          notes.push({
            type: 'NOOP',
            playerId: subject.id,
            reason: `unknown-skill:${effect.skillId}`,
          });
          break;
        }
        notes.push({ type: 'SKILL', playerId: subject.id, skillId: skill.id });
        if (skill.cost !== undefined && skill.cost > 0) {
          next = replacePlayer(next, { ...subject, money: subject.money - skill.cost });
          notes.push({ type: 'MONEY', playerId: subject.id, amount: -skill.cost });
        }
        const nested = applyEffects(
          next,
          subject.id,
          subject.id,
          skill.effect,
          geometry,
          registry,
          depth + 1,
        );
        next = nested.state;
        notes.push(...nested.notes);
        break;
      }

      default: {
        notes.push({ type: 'NOOP', playerId: subject.id, reason: 'unsupported-effect' });
        break;
      }
    }
  }

  return { state: next, notes };
}

/** Convenience: the subject's own skill effects, used by `INTENT_USE_SKILL`. */
export function activeSkillEffects(
  player: Player,
  skillId: string,
  registry: SkillRegistry,
): readonly Effect[] {
  const skill = skillOf(player, registry);
  if (skill === null || skill.id !== skillId || skill.type !== 'ACTIVE') return [];
  return skill.effect;
}
