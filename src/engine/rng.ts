/**
 * Deterministic pseudo-random number generation.
 *
 * Design (REQ-005): every random draw is a pure function of `(seed, cursor)`.
 * The authoritative state only stores the integer `rngCursor`, so a replay of
 * the same seed plus the same intent sequence reproduces the same draws on any
 * platform. No `Math.random`, no `Date.now`, no mutable generator state.
 */

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const GOLDEN_GAMMA = 0x9e3779b9;
const UINT32_RANGE = 0x1_0000_0000;

/** FNV-1a hash over UTF-16 code units. Stable across platforms. */
export function fnv1a32(input: string, basis: number = FNV_OFFSET_BASIS): number {
  let hash = basis >>> 0;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/** Avalanche mixer (splitmix32 finalizer). */
function mix32(value: number): number {
  let hash = value >>> 0;
  hash = Math.imul(hash ^ (hash >>> 16), 0x7feb352d) >>> 0;
  hash = Math.imul(hash ^ (hash >>> 15), 0x846ca68b) >>> 0;
  return (hash ^ (hash >>> 16)) >>> 0;
}

function assertCursor(cursor: number): number {
  if (!Number.isInteger(cursor) || cursor < 0) {
    throw new RangeError(`rngCursor must be a non-negative integer, received ${String(cursor)}`);
  }
  return cursor;
}

/** Raw 32-bit draw at `cursor`. */
export function rngUint32(seed: string, cursor: number): number {
  const base = fnv1a32(seed);
  const offset = (assertCursor(cursor) + GOLDEN_GAMMA) >>> 0;
  return mix32((base ^ Math.imul(offset, 0x85ebca6b)) >>> 0);
}

/** Float in `[0, 1)` at `cursor`. */
export function rngFloat(seed: string, cursor: number): number {
  return rngUint32(seed, cursor) / UINT32_RANGE;
}

/** Integer in `[0, maxExclusive)`. Throws when `maxExclusive <= 0`. */
export function rngInt(seed: string, cursor: number, maxExclusive: number): number {
  if (!Number.isInteger(maxExclusive) || maxExclusive <= 0) {
    throw new RangeError(
      `maxExclusive must be a positive integer, received ${String(maxExclusive)}`,
    );
  }
  return rngUint32(seed, cursor) % maxExclusive;
}

/** Integer in `[min, max]`, both inclusive. */
export function rngIntInclusive(seed: string, cursor: number, min: number, max: number): number {
  if (!Number.isInteger(min) || !Number.isInteger(max) || max < min) {
    throw new RangeError(`invalid inclusive range [${String(min)}, ${String(max)}]`);
  }
  return min + rngInt(seed, cursor, max - min + 1);
}

export interface WeightedEntry<T> {
  readonly weight: number;
  readonly value: T;
}

/**
 * Weighted pick driven by an explicit `roll` in `[0, 1)` so callers control the
 * cursor. Returns `null` when there is nothing to pick.
 */
export function pickWeighted<T>(entries: readonly WeightedEntry<T>[], roll: number): T | null {
  const usable = entries.filter((entry) => entry.weight > 0);
  if (usable.length === 0) return null;
  const total = usable.reduce((sum, entry) => sum + entry.weight, 0);
  const threshold = roll * total;
  let accumulated = 0;
  for (const entry of usable) {
    accumulated += entry.weight;
    if (threshold < accumulated) return entry.value;
  }
  const last = usable[usable.length - 1];
  return last === undefined ? null : last.value;
}
