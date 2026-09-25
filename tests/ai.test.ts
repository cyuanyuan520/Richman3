import { describe, expect, it } from 'vitest';
import { decide } from '../src/engine/ai';
import { applyIntent, resolveCurrentLanding, startGame } from '../src/engine/reducer';
import type { GameSession } from '../src/engine/reducer';
import { makeSession, patchSession, placeOnRing, setMoney } from './fixtures/content';

function boot(): GameSession {
  return startGame(makeSession()).session;
}

function withCursor(session: GameSession, cursor: number): GameSession {
  return patchSession(session, (state) => ({ ...state, rngCursor: cursor }));
}

describe('AI decision making', () => {
  it('rolls when it is the active player and the phase allows it', () => {
    expect(decide(boot(), 'p1')).toEqual({ type: 'INTENT_ROLL', payload: {} });
  });

  it('stays silent for players it does not control in this phase', () => {
    expect(decide(boot(), 'p2')).toBeNull();
  });

  it('buys an affordable property', () => {
    const session = resolveCurrentLanding(placeOnRing(boot(), 'p1', 1), 'p1').session;
    expect(session.state.pendingChoice?.kind).toBe('BUY_PROPERTY');
    expect(decide(session, 'p1')).toEqual({ type: 'INTENT_BUY', payload: { tileId: 't1' } });
  });

  it('declines a purchase it cannot afford', () => {
    let session = boot();
    session = placeOnRing(session, 'p1', 4);
    session = setMoney(session, 'p1', 50);
    session = resolveCurrentLanding(session, 'p1').session;
    const decision = decide(session, 'p1');
    expect(decision?.type).toBe('INTENT_CHOICE');
    expect(decision).toMatchObject({ payload: { option: 'DECLINE' } });
  });

  it('ends the turn once the phase allows it', () => {
    const session = patchSession(boot(), (state) => ({ ...state, phase: 'AWAIT_END_TURN' }));
    expect(decide(session, 'p1')).toEqual({ type: 'INTENT_END_TURN', payload: {} });
  });

  it('submits a mini-game action exactly once per participant', () => {
    let session = resolveCurrentLanding(placeOnRing(boot(), 'p1', 11), 'p1').session;
    expect(session.state.phase).toBe('MINIGAME');
    const participants = session.state.minigame?.participantIds ?? [];
    expect(participants.length).toBeGreaterThanOrEqual(2);
    for (const playerId of participants) {
      const decision = decide(session, playerId);
      expect(decision?.type).toBe('INTENT_MINIGAME_ACTION');
      const result = applyIntent(session, {
        ...(decision as {
          type: 'INTENT_MINIGAME_ACTION';
          payload: { minigameId: string; action: string };
        }),
        v: 1,
        seq: 0,
        from: playerId,
      });
      expect(result.rejected).toBeNull();
      session = result.session;
    }
    expect(session.state.minigame).toBeNull();
  });

  it('occasionally fires an active skill before rolling', () => {
    const base = patchSession(boot(), (state) => ({ ...state, activePlayerIndex: 1 }));
    const found = Array.from({ length: 400 }, (_, cursor) => cursor).some((cursor) => {
      const decision = decide(withCursor(base, cursor), 'p2');
      return decision?.type === 'INTENT_USE_SKILL';
    });
    expect(found).toBe(true);
  });

  it('hands the turn over when the active seat is bankrupt', () => {
    const session = patchSession(boot(), (state) => ({
      ...state,
      players: state.players.map((player) =>
        player.id === 'p1' ? { ...player, bankrupt: true } : player,
      ),
    }));
    expect(decide(session, 'p1')).toEqual({ type: 'INTENT_END_TURN', payload: {} });
  });

  it('never returns a decision for a bankrupt player who is not active', () => {
    const session = patchSession(boot(), (state) => ({
      ...state,
      players: state.players.map((player) =>
        player.id === 'p2' ? { ...player, bankrupt: true } : player,
      ),
    }));
    expect(decide(session, 'p2')).toBeNull();
  });
});
