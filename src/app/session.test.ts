import { describe, expect, it, vi } from 'vitest';

import type { ClientIntentMessage as ClientIntent } from '@/engine/contracts/net';

import { CITY_METRO, CONTENT_PACK } from '@/content';
import { DEFAULT_ROOM_CONFIG } from '@/engine/contracts/config';
import { hashState } from '@/engine/hash';

import { createGameTable, type CreateTableOptions } from './session';

function seats(humanCharacter = 'char_farmer', aiCount = 3) {
  const archetypes = ['char_farmer', 'char_girl', 'char_madame', 'char_ninja'].filter(
    (id) => id !== humanCharacter,
  );
  return [
    { id: 'p1', nickname: '玩家', characterId: humanCharacter, isAI: false },
    ...archetypes.slice(0, aiCount).map((id, index) => ({
      id: `ai${index + 1}`,
      nickname: `AI-${index + 1}`,
      characterId: id,
      isAI: true,
    })),
  ];
}

function tableOptions(overrides: Partial<CreateTableOptions> = {}): CreateTableOptions {
  return {
    content: {
      map: CITY_METRO,
      characters: CONTENT_PACK.characters,
      chaosEvents: CONTENT_PACK.chaosEvents,
      miniGames: CONTENT_PACK.miniGames,
    },
    roomConfig: DEFAULT_ROOM_CONFIG,
    seats: seats(),
    seed: 'p6-seed',
    aiDelayMs: 0,
    // Manual scheduler keeps every test synchronous and deterministic.
    schedule: () => () => undefined,
    ...overrides,
  };
}

describe('nextAiActor', () => {
  it('does not act for the human seat', () => {
    const table = createGameTable(tableOptions());
    // The table starts with p1 (human) active, so no AI action should be queued.
    expect(table.isThinking()).toBe(false);
    table.dispose();
  });

  it('never auto-plays a human decision', () => {
    const table = createGameTable(tableOptions({ seats: seats('char_farmer', 3) }));
    // The loop only advances on its own for AI seats; a human turn parks it.
    expect(table.isThinking()).toBe(false);
    table.dispose();
  });
});

describe('game table', () => {
  it('starts a game and reports the opening state', () => {
    const table = createGameTable(tableOptions());
    const snapshot = table.getSnapshot();
    expect(snapshot.state.phase).toBe('AWAIT_ROLL');
    expect(snapshot.state.players).toHaveLength(4);
    expect(snapshot.state.mapId).toBe(CITY_METRO.id);
    table.dispose();
  });

  it('notifies subscribers when a human intent lands', () => {
    const table = createGameTable(tableOptions());
    const listener = vi.fn();
    table.subscribe(listener);
    const before = table.getSnapshot().state.rngCursor;
    // The UI emits a bare intent; the table is responsible for stamping the
    // envelope with its own seat, exactly as the host does.
    table.dispatch({ type: 'INTENT_ROLL' } as ClientIntent);
    const after = table.getSnapshot();
    expect(listener).toHaveBeenCalled();
    expect(after.state.rngCursor).toBeGreaterThan(before);
    expect(after.lastRoll).toBeGreaterThanOrEqual(1);
    expect(after.lastRoll).toBeLessThanOrEqual(6);
    table.dispose();
  });

  it('surfaces a refusal without advancing the game', () => {
    const table = createGameTable(tableOptions());
    const before = hashState(table.getSnapshot().state);
    // Ending a turn is refused while the roll is still pending, so this
    // exercises the refusal path without relying on a spoofed sender.
    table.dispatch({ type: 'INTENT_END_TURN' } as ClientIntent);
    expect(hashState(table.getSnapshot().state)).toBe(before);
    table.dispose();
  });

  it('stops notifying after dispose', () => {
    const table = createGameTable(tableOptions());
    const listener = vi.fn();
    table.subscribe(listener);
    table.dispose();
    table.dispatch({ type: 'INTENT_ROLL', v: 1, seq: 1, from: 'p1', payload: {} });
    expect(listener).not.toHaveBeenCalled();
  });

  it('is deterministic for the same seed and seats', () => {
    const first = createGameTable(tableOptions());
    const second = createGameTable(tableOptions());
    expect(hashState(first.getSnapshot().state)).toBe(hashState(second.getSnapshot().state));
    first.dispose();
    second.dispose();
  });

  it('rejects a seat list the engine refuses', () => {
    expect(() =>
      createGameTable(
        tableOptions({
          seats: [{ id: 'solo', nickname: '独', characterId: 'char_farmer', isAI: false }],
        }),
      ),
    ).toThrow();
  });
});
