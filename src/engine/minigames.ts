/**
 * Host-authoritative mini-game resolvers (REQ-015).
 *
 * The content pack declares *what* a mini-game is (id, kind, tuning, rewards);
 * the resolver is code, registered here by kind. Resolvers are pure functions
 * of `(seed, cursor, participants, submissions)` so replays stay deterministic.
 */

import type { MiniGameKind } from './contracts/primitives';
import { compareCodeUnits } from './hash';
import { rngFloat, rngInt } from './rng';

export interface MiniGameResolutionInput {
  readonly seed: string;
  readonly cursor: number;
  readonly participantIds: readonly string[];
  readonly submissions: Readonly<Record<string, string>>;
}

export interface MiniGameResolution {
  readonly cursor: number;
  /** `playerId -> rank`, 1 is best; ties share the lower (better) rank. */
  readonly ranks: readonly (readonly [string, number])[];
  readonly detail: Readonly<Record<string, number>>;
}

export type MiniGameResolver = (input: MiniGameResolutionInput) => MiniGameResolution;

export const RPS_ACTIONS = ['ROCK', 'PAPER', 'SCISSORS'] as const;
export type RpsAction = (typeof RPS_ACTIONS)[number];

function isRpsAction(value: string): value is RpsAction {
  return (RPS_ACTIONS as readonly string[]).includes(value);
}

/** Competition ranking: 1, 2, 2, 4 style by descending score. */
function rankByScore(
  participantIds: readonly string[],
  scores: Readonly<Record<string, number>>,
): (readonly [string, number])[] {
  const ordered = participantIds
    .map((id) => ({ id, score: scores[id] ?? 0 }))
    .sort((a, b) => b.score - a.score || compareCodeUnits(a.id, b.id));
  const ranks: (readonly [string, number])[] = [];
  let previousScore: number | null = null;
  let previousRank = 0;
  ordered.forEach((entry, position) => {
    const rank =
      previousScore !== null && entry.score === previousScore ? previousRank : position + 1;
    previousScore = entry.score;
    previousRank = rank;
    ranks.push([entry.id, rank] as const);
  });
  return ranks;
}

/** Each participant spins 0–99; highest spin wins. */
export const resolveWheel: MiniGameResolver = ({ seed, cursor, participantIds }) => {
  let workingCursor = cursor;
  const scores: Record<string, number> = {};
  for (const id of participantIds) {
    scores[id] = rngInt(seed, workingCursor, 100);
    workingCursor += 1;
  }
  return { cursor: workingCursor, ranks: rankByScore(participantIds, scores), detail: scores };
};

/** Rock-paper-scissors; score is the number of opponents beaten. */
export const resolveRps: MiniGameResolver = ({ cursor, participantIds, submissions }) => {
  const scores: Record<string, number> = {};
  for (const id of participantIds) {
    const action = submissions[id];
    let wins = 0;
    for (const opponent of participantIds) {
      if (opponent === id) continue;
      const other = submissions[opponent];
      if (
        action === undefined ||
        other === undefined ||
        !isRpsAction(action) ||
        !isRpsAction(other)
      )
        continue;
      if (beats(action, other)) wins += 1;
    }
    scores[id] = wins;
  }
  // No tie-break draw: a genuine draw is a tie, and `rankByScore` shares the
  // best rank so every tied player is rewarded.
  return { cursor, ranks: rankByScore(participantIds, scores), detail: scores };
};

function beats(a: RpsAction, b: RpsAction): boolean {
  return (
    (a === 'ROCK' && b === 'SCISSORS') ||
    (a === 'PAPER' && b === 'ROCK') ||
    (a === 'SCISSORS' && b === 'PAPER')
  );
}

/** Each participant draws a float; highest wins. */
export const resolveGacha: MiniGameResolver = ({ seed, cursor, participantIds }) => {
  let workingCursor = cursor;
  const scores: Record<string, number> = {};
  for (const id of participantIds) {
    scores[id] = Math.round(rngFloat(seed, workingCursor) * 1_000_000);
    workingCursor += 1;
  }
  return { cursor: workingCursor, ranks: rankByScore(participantIds, scores), detail: scores };
};

export const MINIGAME_RESOLVERS: Readonly<Record<MiniGameKind, MiniGameResolver>> = {
  WHEEL: resolveWheel,
  RPS: resolveRps,
  GACHA: resolveGacha,
};
