/**
 * Termination regressions for `advanceTurn` after the third Gate 2 review.
 *
 * A passive `ON_TURN_START` skill that queues `SKIP_TURN` on its owner used to
 * be consumed inside the same loop iteration, so `skipsThisRound` never reached
 * zero and the host froze in an unbounded `for (;;)`. A skip queued by the
 * active player's own turn-start trigger must apply on their NEXT turn.
 */

import { describe, expect, it } from 'vitest';
import type { Character } from '../src/engine/contracts/content';
import type { ClientIntentMessage } from '../src/engine/contracts/net';
import type { RoomConfig } from '../src/engine/contracts/config';
import type { GameSession } from '../src/engine/reducer';
import { applyIntent, startGame } from '../src/engine/reducer';
import { makeSession, patchSession, TEST_ROOM_CONFIG } from './fixtures/content';

const SELF_SKIP: Character = {
  id: 'char_self_skip',
  name: '摸鱼大师·老赖',
  archetype: 'farmer',
  modelRef: 'char_self_skip',
  portraitRef: 'portrait_self_skip',
  skill: {
    id: 'skill_self_skip',
    name: '再睡五分钟',
    desc: '每回合开始时给自己叠加一次「跳过」。',
    type: 'PASSIVE',
    trigger: 'ON_TURN_START',
    effect: [{ kind: 'SKIP_TURN', value: 1 }],
  },
};

const TURN_LIMIT_30: RoomConfig = {
  eventRate: 'MEDIUM',
  victory: { kind: 'TURN_LIMIT', value: 30 },
  requireApproval: false,
};

let sequence = 0;

function msg<T extends ClientIntentMessage['type']>(
  type: T,
  from: string,
  payload: Extract<ClientIntentMessage, { type: T }>['payload'],
): ClientIntentMessage {
  sequence += 1;
  return { v: 1, type, seq: sequence, from, payload } as ClientIntentMessage;
}

function selfSkipSession(roomConfig: RoomConfig = TEST_ROOM_CONFIG): GameSession {
  return patchSession(
    startGame(
      makeSession({
        characters: [SELF_SKIP],
        roomConfig,
        players: [
          { id: 'p1', nickname: '阿一', characterId: SELF_SKIP.id, isAI: false },
          { id: 'p2', nickname: '阿二', characterId: SELF_SKIP.id, isAI: true },
        ],
      }),
    ).session,
    (state) => ({ ...state, activePlayerIndex: 0, phase: 'AWAIT_END_TURN' }),
  );
}

describe('advanceTurn termination', () => {
  it('defers a self-queued ON_TURN_START skip instead of consuming it in place', () => {
    const session = selfSkipSession();

    const result = applyIntent(session, msg('INTENT_END_TURN', 'p1', {}));

    expect(result.rejected).toBeNull();
    expect(result.session.state.phase).toBe('AWAIT_ROLL');
    const active = result.session.state.players[result.session.state.activePlayerIndex];
    expect(active?.id).toBe('p2');
    // The skip granted by p2's own turn-start trigger waits for p2's next turn.
    expect(active?.skipTurns).toBe(1);
    expect(result.events.map((event) => event.type)).not.toContain('TURN_SKIPPED');
  });

  it('still consumes skips queued by other players before the turn starts', () => {
    const session = patchSession(selfSkipSession(), (state) => ({
      ...state,
      activePlayerIndex: 0,
      phase: 'AWAIT_END_TURN',
      players: state.players.map((player) =>
        player.id === 'p2' ? { ...player, skipTurns: 1 } : player,
      ),
    }));

    const result = applyIntent(session, msg('INTENT_END_TURN', 'p1', {}));

    expect(result.rejected).toBeNull();
    expect(result.events.map((event) => event.type)).toContain('TURN_SKIPPED');
    // p2 was skipped, so p1 gets the table again.
    const active = result.session.state.players[result.session.state.activePlayerIndex];
    expect(active?.id).toBe('p1');
  });

  it('reaches GAME_OVER inside a bounded number of intents despite self-queued skips', () => {
    const session = selfSkipSession(TURN_LIMIT_30);
    let current = session;

    for (let attempt = 0; attempt < 40 && current.state.phase !== 'GAME_OVER'; attempt += 1) {
      // Only the turn hand-over matters here, so force the seat back to the
      // point where it can end its turn and let `advanceTurn` do the work.
      const ready = patchSession(current, (state) => ({
        ...state,
        phase: 'AWAIT_END_TURN',
        pendingChoice: null,
        minigame: null,
      }));
      const active = ready.state.players[ready.state.activePlayerIndex];
      expect(active).toBeDefined();
      const result = applyIntent(ready, msg('INTENT_END_TURN', active?.id ?? 'p1', {}));
      expect(result.rejected).toBeNull();
      current = result.session;
    }

    expect(current.state.phase).toBe('GAME_OVER');
    expect(current.state.winnerId).toBeTruthy();
    expect(current.state.turn).toBeGreaterThan(30);
  });
});
