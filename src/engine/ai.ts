/**
 * Single-difficulty AI opponent (REQ-016, REQ-018, AC-020).
 *
 * The spec sketches `decide(state, playerId, rng) -> Intent`. Rather than take
 * an injectable RNG, this implementation derives its coin flips from the seed
 * and current `rngCursor` without consuming the authoritative cursor. That
 * keeps AI decisions reproducible while leaving the game's random stream
 * untouched, which matters for replay hashing.
 */

import type { ClientIntentMessage } from './contracts/net';
import { canUseSkill, skillOf } from './skills';
import { rngFloat, rngInt } from './rng';
import type { GameSession } from './reducer';
import { RPS_ACTIONS } from './minigames';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

/** A client intent minus the transport envelope fields. */
export type AiIntent = DistributiveOmit<ClientIntentMessage, 'v' | 'seq' | 'from' | 'to'>;

function aiRandom(session: GameSession, playerId: string): number {
  return rngFloat(`${session.state.seed}:ai:${playerId}`, session.state.rngCursor);
}

function aiPick(session: GameSession, playerId: string, maxExclusive: number): number {
  return rngInt(`${session.state.seed}:ai:${playerId}`, session.state.rngCursor, maxExclusive);
}

function minigameAction(session: GameSession, playerId: string): string {
  const kind = session.state.minigame?.kind;
  if (kind === 'RPS') {
    const index = aiPick(session, playerId, RPS_ACTIONS.length);
    return RPS_ACTIONS[index] ?? RPS_ACTIONS[0];
  }
  if (kind === 'GACHA') return 'DRAW';
  return 'SPIN';
}

function activeSkillDecision(session: GameSession, playerId: string): AiIntent | null {
  const player = session.state.players.find((entry) => entry.id === playerId);
  if (player === undefined) return null;
  const skill = skillOf(player, session.registry);
  if (skill === null || skill.type !== 'ACTIVE') return null;
  if (!canUseSkill(player, skill, session.registry).ok) return null;
  if (aiRandom(session, playerId) > 0.35) return null;
  return { type: 'INTENT_USE_SKILL', payload: { skillId: skill.id } };
}

/** Next intent for an AI-controlled player, or `null` when nothing applies. */
export function decide(session: GameSession, playerId: string): AiIntent | null {
  const state = session.state;
  if (state.phase === 'GAME_OVER' || state.phase === 'SETUP') return null;
  const player = state.players.find((entry) => entry.id === playerId);
  if (player === undefined) return null;
  const isActive = state.players[state.activePlayerIndex]?.id === playerId;

  // A bankrupt active seat still has to hand the turn over, otherwise the
  // table deadlocks: every other intent is refused for it. The reducer accepts
  // `INTENT_END_TURN` from a bankrupt seat in any phase, so the AI must offer it
  // regardless of how the turn was interrupted (roll, pending choice, mini-game).
  if (player.bankrupt) {
    return isActive ? { type: 'INTENT_END_TURN', payload: {} } : null;
  }

  switch (state.phase) {
    case 'AWAIT_ROLL': {
      if (!isActive) return null;
      const skillIntent = activeSkillDecision(session, playerId);
      if (skillIntent !== null) return skillIntent;
      return { type: 'INTENT_ROLL', payload: {} };
    }

    case 'AWAIT_CHOICE': {
      const pending = state.pendingChoice;
      if (pending === null || pending.playerId !== playerId) return null;

      if (pending.kind === 'BUY_PROPERTY' && pending.tileId !== undefined) {
        const price = session.priceByTileId.get(pending.tileId) ?? 0;
        const reserve = state.economy.startingMoney * (0.12 + 0.18 * aiRandom(session, playerId));
        if (player.money - price >= reserve) {
          return { type: 'INTENT_BUY', payload: { tileId: pending.tileId } };
        }
        return { type: 'INTENT_CHOICE', payload: { choice: 'BUY_PROPERTY', option: 'DECLINE' } };
      }

      if (pending.kind === 'UPGRADE_PROPERTY' && pending.tileId !== undefined) {
        const price = session.priceByTileId.get(pending.tileId) ?? 0;
        const level = state.board.tiles[pending.tileId]?.level ?? 0;
        const cost = Math.max(1, Math.round(price * state.economy.upgradeCostRatio * (level + 1)));
        const reserve = state.economy.startingMoney * (0.25 + 0.25 * aiRandom(session, playerId));
        if (player.money - cost >= reserve) {
          return { type: 'INTENT_UPGRADE', payload: { tileId: pending.tileId } };
        }
        return { type: 'INTENT_CHOICE', payload: { choice: 'UPGRADE_PROPERTY', option: 'SKIP' } };
      }

      if (pending.kind === 'CENTER_EXIT') {
        // The host pins the only permitted destination on the pending.
        if (pending.nodeId === undefined) return null;
        return { type: 'INTENT_ENTER_CENTER', payload: { nodeId: pending.nodeId } };
      }

      if (pending.kind === 'MINIGAME') {
        return {
          type: 'INTENT_MINIGAME_ACTION',
          payload: {
            minigameId: pending.minigameId ?? '',
            action: minigameAction(session, playerId),
          },
        };
      }
      return null;
    }

    case 'MINIGAME': {
      const minigame = state.minigame;
      if (minigame === null) return null;
      if (!minigame.participantIds.includes(playerId)) return null;
      if (minigame.submissions[playerId] !== undefined) return null;
      return {
        type: 'INTENT_MINIGAME_ACTION',
        payload: { minigameId: minigame.minigameId, action: minigameAction(session, playerId) },
      };
    }

    case 'AWAIT_END_TURN': {
      if (!isActive) return null;
      return { type: 'INTENT_END_TURN', payload: {} };
    }

    default:
      return null;
  }
}
