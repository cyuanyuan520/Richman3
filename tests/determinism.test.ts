import { describe, expect, it } from 'vitest';
import { decide } from '../src/engine/ai';
import type { ClientIntentMessage } from '../src/engine/contracts/net';
import { hashState } from '../src/engine/hash';
import { applyIntent, standings, startGame } from '../src/engine/reducer';
import type { GameSession } from '../src/engine/reducer';
import { makeSession } from './fixtures/content';

interface AutoPlayResult {
  readonly session: GameSession;
  readonly rejections: readonly string[];
  readonly steps: number;
}

/** Picks whoever the engine is currently waiting on. */
function nextActor(session: GameSession): string | null {
  const state = session.state;
  if (state.minigame !== null) {
    const waiting = state.minigame.participantIds.find(
      (id) => state.minigame?.submissions[id] === undefined,
    );
    return waiting ?? null;
  }
  if (state.pendingChoice !== null) return state.pendingChoice.playerId;
  return state.players[state.activePlayerIndex]?.id ?? null;
}

/** Drives a whole game with the AI until it ends or stops making progress. */
function autoPlay(seed: string, maxSteps = 600): AutoPlayResult {
  let session = startGame(makeSession({ seed })).session;
  const rejections: string[] = [];
  let steps = 0;

  while (steps < maxSteps && session.state.phase !== 'GAME_OVER') {
    const actor = nextActor(session);
    if (actor === null) break;
    const decision = decide(session, actor);
    if (decision === null) break;
    const intent = { ...decision, v: 1, seq: steps, from: actor } as ClientIntentMessage;
    const result = applyIntent(session, intent);
    if (result.rejected !== null) {
      rejections.push(`${decision.type}:${result.rejected}`);
      break;
    }
    session = result.session;
    steps += 1;
  }

  return { session, rejections, steps };
}

describe('determinism replay', () => {
  it('reproduces an identical state for the same seed and intent sequence', () => {
    const first = autoPlay('seed-alpha');
    const second = autoPlay('seed-alpha');
    expect(first.rejections).toEqual([]);
    expect(second.rejections).toEqual([]);
    expect(hashState(first.session.state)).toBe(hashState(second.session.state));
    expect(first.session.state).toEqual(second.session.state);
  });

  it('diverges for a different seed', () => {
    const alpha = autoPlay('seed-alpha');
    const beta = autoPlay('seed-beta');
    expect(hashState(alpha.session.state)).not.toBe(hashState(beta.session.state));
  });

  it('plays a full game to a terminal state with a winner', () => {
    const result = autoPlay('seed-alpha');
    expect(result.session.state.phase).toBe('GAME_OVER');
    expect(result.session.state.winnerId).not.toBeNull();
    expect(result.session.state.eventLog.length).toBeGreaterThan(10);
    expect(standings(result.session)).toHaveLength(4);
    expect(result.session.state.rngCursor).toBeGreaterThan(20);
  });

  it('keeps every state snapshot valid', () => {
    const result = autoPlay('seed-gamma');
    expect(result.rejections).toEqual([]);
    expect(result.session.state.phase).toBe('GAME_OVER');
  });

  it('never lets the event log grow past its cap', () => {
    const result = autoPlay('seed-delta', 2000);
    expect(result.session.state.eventLog.length).toBeLessThanOrEqual(400);
    expect(result.session.state.eventSeq).toBeGreaterThanOrEqual(
      result.session.state.eventLog.length,
    );
  });
});
