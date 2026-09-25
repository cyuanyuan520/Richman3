import { describe, expect, it } from 'vitest';
import { CITY_METRO, CONTENT_PACK } from '../src/content';
import { decide } from '../src/engine/ai';
import type { ClientIntentMessage } from '../src/engine/contracts/net';
import { applyIntent, createSession, startGame } from '../src/engine/reducer';
import type { GameSession } from '../src/engine/reducer';

/**
 * Win-share guard for the launch roster (AC-025 is only about the four
 * characters being distinguishable; this is stricter and is what the Gate 3
 * review asked for after the first tuning gave 果果 a 55% win rate).
 *
 * Each seed rotates which seat holds which archetype, so seat order cannot
 * flatter a character. Seat 1 is always the human seat and is driven by the
 * same `decide()` as the rest, so the measurement is "four equally-scripted
 * players with different passives".
 *
 * Measured with the shipped tuning over 60 rotated seeds: 农夫 37% / 果果 38% /
 * 珍姐 13% / 阿影 12%. Skill strength is a design dial, not a rule; the bounds
 * below exist so a future edit cannot silently recreate the 55% outlier the
 * Gate 3 review caught, and so nobody becomes unplayable. The rent-dependent
 * 珍姐 and the movement-based 阿影 sit at the low end by design: both scale with
 * how often opponents land on their properties or how often the dice matter.
 */
const SEEDS = Array.from({ length: 60 }, (_, index) => `balance-${String(index)}`);
const ARCHETYPES = ['char_farmer', 'char_girl', 'char_madame', 'char_ninja'] as const;
const MAX_WIN_SHARE = 0.45;
const MIN_WIN_SHARE = 0.05;
const MAX_STEPS = 6000;

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

function autoPlay(session: GameSession): GameSession {
  let current = startGame(session).session;
  let steps = 0;
  while (steps < MAX_STEPS && current.state.phase !== 'GAME_OVER') {
    const actor = nextActor(current);
    if (actor === null) break;
    const decision = decide(current, actor);
    if (decision === null) break;
    const intent = { ...decision, v: 1, seq: steps, from: actor } as ClientIntentMessage;
    const result = applyIntent(current, intent);
    if (result.rejected !== null) {
      throw new Error(`${decision.type} rejected: ${result.rejected} at step ${String(steps)}`);
    }
    current = result.session;
    steps += 1;
  }
  return current;
}

function winnerCharacterId(seed: string, rotation: number): string {
  const seated = ARCHETYPES.map((_, index) => ARCHETYPES[(index + rotation) % 4] ?? 'char_farmer');
  const session = createSession({
    seed,
    map: CITY_METRO,
    roomConfig: {
      eventRate: 'MEDIUM',
      victory: { kind: 'ASSET_TARGET', value: 3 },
      requireApproval: false,
    },
    characters: CONTENT_PACK.characters,
    chaosEvents: CONTENT_PACK.chaosEvents,
    miniGames: CONTENT_PACK.miniGames,
    players: seated.map((characterId, index) => ({
      id: `p${String(index + 1)}`,
      nickname: `阿${String(index + 1)}`,
      characterId,
      isAI: index > 0,
    })),
  });
  const finished = autoPlay(session);
  const winnerId = finished.state.winnerId;
  if (winnerId === null) throw new Error(`seed ${seed} finished without a winner`);
  const winner = finished.state.players.find((player) => player.id === winnerId);
  if (winner === undefined) throw new Error(`seed ${seed} winner ${winnerId} is not seated`);
  return winner.characterId;
}

describe('launch roster: no character dominates or is unplayable', () => {
  it('keeps every win share inside the tuned bounds over 60 rotated seeds', () => {
    const wins = new Map<string, number>();
    for (const archetype of ARCHETYPES) wins.set(archetype, 0);
    SEEDS.forEach((seed, index) => {
      const characterId = winnerCharacterId(seed, index % 4);
      wins.set(characterId, (wins.get(characterId) ?? 0) + 1);
    });

    const shares = new Map<string, number>();
    for (const [characterId, count] of wins) shares.set(characterId, count / SEEDS.length);

    for (const [characterId, share] of shares) {
      expect(share, `${characterId} win share`).toBeLessThanOrEqual(MAX_WIN_SHARE);
      expect(share, `${characterId} win share`).toBeGreaterThanOrEqual(MIN_WIN_SHARE);
    }
    // Every seat must win at least once, i.e. no character is a dead pick.
    for (const [characterId, count] of wins) {
      expect(count, `${characterId} wins`).toBeGreaterThan(0);
    }
  }, 300_000);
});
