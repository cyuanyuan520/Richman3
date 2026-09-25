import { describe, expect, it } from 'vitest';
import { CITY_METRO, CONTENT_PACK } from '../src/content';
import { decide } from '../src/engine/ai';
import type { RoomConfig, VictoryCondition } from '../src/engine/contracts/config';
import type { EventRate } from '../src/engine/contracts/primitives';
import type { ClientIntentMessage } from '../src/engine/contracts/net';
import { hashState } from '../src/engine/hash';
import {
  applyIntent,
  createSession,
  resolveCurrentLanding,
  startGame,
} from '../src/engine/reducer';
import type { GameSession } from '../src/engine/reducer';
import { patchSession, placeOnRing } from './fixtures/content';

/**
 * Pacing proxy for AC-014 — this is NOT a verification of it.
 *
 * AC-014 asks for a 60-90 minute session, which is a *human wall-clock*
 * property. What we can measure here is AI auto-play round counts, and the AI
 * never hesitates, so a human game is strictly longer.
 *
 * A round is four player turns; at ~25 s per turn including animations and
 * decisions that is roughly 1.75 minutes per round, putting the 60-90 minute
 * target at ~34-52 rounds.
 *
 * Measured with the shipped tuning over 30 seeds: 21/30 land inside the band,
 * the median is 48 rounds (~84 min), and the worst case is 68 rounds
 * (~119 min). That long tail is a real, recorded gap: the default
 * `ASSET_TARGET 3` preset can outlast the target on unlucky seeds, and it did
 * not move under any of the six economy variants probed (see the deepwork
 * file, §8e). Closing it needs human timing data, so AC-014 stays UNVERIFIED
 * and this test guards central pacing plus runaway/ stunted games rather than
 * the tail.
 */
const MINUTES_PER_ROUND = 1.75;
const SESSION_MIN_ROUNDS = Math.floor(60 / MINUTES_PER_ROUND);
const SESSION_MAX_ROUNDS = Math.ceil(90 / MINUTES_PER_ROUND);
/** ~131 minutes: beyond this a game is a runaway rather than merely long. */
const HARD_CEILING_ROUNDS = 75;
/** ~42 minutes: below this a game is stunted rather than merely brisk. */
const HARD_FLOOR_ROUNDS = 24;
const BAND_SEEDS = 30;
/** The measured tail means the band cannot be asserted seed by seed. */
const MIN_RUNS_IN_BAND = 0.7;

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

function newSession(
  seed: string,
  victory: VictoryCondition,
  eventRate: EventRate = 'MEDIUM',
): GameSession {
  const roomConfig: RoomConfig = { eventRate, victory, requireApproval: false };
  return createSession({
    seed,
    map: CITY_METRO,
    roomConfig,
    characters: CONTENT_PACK.characters,
    chaosEvents: CONTENT_PACK.chaosEvents,
    miniGames: CONTENT_PACK.miniGames,
    players: [
      { id: 'p1', nickname: '阿一', characterId: 'char_farmer', isAI: false },
      { id: 'p2', nickname: '阿二', characterId: 'char_girl', isAI: true },
      { id: 'p3', nickname: '阿三', characterId: 'char_madame', isAI: true },
      { id: 'p4', nickname: '阿四', characterId: 'char_ninja', isAI: true },
    ],
  });
}

interface AutoPlayResult {
  readonly session: GameSession;
  readonly steps: number;
  readonly eventTypes: Set<string>;
}

function autoPlay(session: GameSession, maxSteps = 4000): AutoPlayResult {
  let current = startGame(session).session;
  const eventTypes = new Set<string>();
  let steps = 0;
  while (steps < maxSteps && current.state.phase !== 'GAME_OVER') {
    const actor = nextActor(current);
    if (actor === null) break;
    const decision = decide(current, actor);
    if (decision === null) break;
    const intent = { ...decision, v: 1, seq: steps, from: actor } as ClientIntentMessage;
    const result = applyIntent(current, intent);
    if (result.rejected !== null) {
      throw new Error(`rejected ${decision.type}: ${result.rejected} at step ${String(steps)}`);
    }
    for (const event of result.events) eventTypes.add(event.type);
    current = result.session;
    steps += 1;
  }
  return { session: current, steps, eventTypes };
}

describe('launch content: full games with the AI', () => {
  it('is deterministic with the real pack', () => {
    const first = autoPlay(newSession('city-1', { kind: 'ASSET_TARGET', value: 2 }));
    const second = autoPlay(newSession('city-1', { kind: 'ASSET_TARGET', value: 2 }));
    expect(first.session.state.phase).toBe('GAME_OVER');
    expect(hashState(first.session.state)).toBe(hashState(second.session.state));
  });

  it('keeps the shipped default preset near the 60-90 minute band (AC-014 pacing proxy)', () => {
    const rounds: number[] = [];
    for (let index = 0; index < BAND_SEEDS; index += 1) {
      const { session } = autoPlay(
        newSession(`city-band-${String(index)}`, { kind: 'ASSET_TARGET', value: 3 }),
      );
      expect(session.state.phase).toBe('GAME_OVER');
      expect(session.state.winnerId).not.toBeNull();
      rounds.push(session.state.turn);
    }
    // Runaway and stunted games must not slip through, even seed by seed.
    for (const turn of rounds) {
      expect(turn).toBeGreaterThanOrEqual(HARD_FLOOR_ROUNDS);
      expect(turn).toBeLessThanOrEqual(HARD_CEILING_ROUNDS);
    }
    const sorted = [...rounds].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    expect(median).toBeGreaterThanOrEqual(SESSION_MIN_ROUNDS);
    expect(median).toBeLessThanOrEqual(SESSION_MAX_ROUNDS);
    const inBand = rounds.filter(
      (turn) => turn >= SESSION_MIN_ROUNDS && turn <= SESSION_MAX_ROUNDS,
    ).length;
    expect(inBand / rounds.length).toBeGreaterThanOrEqual(MIN_RUNS_IN_BAND);
  });

  it('reaches the classic 2x asset target quickly', () => {
    for (const seed of ['city-1', 'city-2', 'city-3']) {
      const { session } = autoPlay(newSession(seed, { kind: 'ASSET_TARGET', value: 2 }));
      expect(session.state.phase).toBe('GAME_OVER');
      expect(session.state.turn).toBeLessThan(60);
    }
  });

  it('honours the turn limit exactly for the classic presets', () => {
    for (const value of [30, 90] as const) {
      const { session } = autoPlay(newSession('city-limit', { kind: 'TURN_LIMIT', value }));
      expect(session.state.phase).toBe('GAME_OVER');
      expect(session.state.turn).toBe(value + 1);
    }
  });

  it('completes at every event-rate preset without a rejected intent', () => {
    for (const rate of ['LOW', 'MEDIUM', 'HIGH'] as const) {
      const { session } = autoPlay(
        newSession('city-rate', { kind: 'ASSET_TARGET', value: 2 }, rate),
      );
      expect(session.state.phase).toBe('GAME_OVER');
    }
  });

  it('uses character skills during a real game (AC-018/AC-019/AC-020)', () => {
    const observed = new Set<string>();
    for (const seed of ['city-1', 'city-2', 'city-3', 'city-4']) {
      const { eventTypes } = autoPlay(newSession(seed, { kind: 'ASSET_TARGET', value: 2 }));
      for (const type of eventTypes) observed.add(type);
    }
    // The AI owns an ACTIVE skill on exactly one seat, and passive/trigger
    // skills fire on turn start and after a roll.
    expect(observed.has('SKILL_TRIGGERED') || observed.has('SKILL_USED')).toBe(true);
    expect(observed.has('CHAOS_DRAWN')).toBe(true);
    expect(observed.has('MINIGAME_STARTED')).toBe(true);
    expect(observed.has('RENT_DUE')).toBe(true);
  });
});

describe('launch content: every chaos event resolves (AC-026)', () => {
  const cases = CONTENT_PACK.chaosEvents.map((event) => [event.id, event] as const);

  it.each(cases)('%s', (eventId) => {
    // A map whose pool contains exactly one event makes the draw deterministic.
    const singleEventMap = { ...CITY_METRO, events: [eventId] };
    const base = createSession({
      seed: `event-${eventId}`,
      map: singleEventMap,
      roomConfig: {
        eventRate: 'MEDIUM',
        victory: { kind: 'ASSET_TARGET', value: 10 },
        requireApproval: false,
      },
      characters: CONTENT_PACK.characters,
      chaosEvents: CONTENT_PACK.chaosEvents,
      miniGames: CONTENT_PACK.miniGames,
      players: [
        { id: 'p1', nickname: '阿一', characterId: 'char_farmer', isAI: false },
        { id: 'p2', nickname: '阿二', characterId: 'char_girl', isAI: true },
        { id: 'p3', nickname: '阿三', characterId: 'char_madame', isAI: true },
        { id: 'p4', nickname: '阿四', characterId: 'char_ninja', isAI: true },
      ],
    });
    // t03 is a CHANCE tile: landing always draws from the pool, with no trigger roll.
    const placed = placeOnRing(
      patchSession(base, (state) => ({ ...state, phase: 'AWAIT_ROLL' })),
      'p1',
      3,
    );
    const result = resolveCurrentLanding(placed, 'p1');
    expect(result.rejected).toBeNull();
    const drawn = result.events.find((event) => event.type === 'CHAOS_DRAWN');
    expect(drawn?.data.eventId).toBe(eventId);
    expect(result.session.state.phase).toBe('AWAIT_END_TURN');
  });
});
