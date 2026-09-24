/**
 * Stable, platform-independent serialization + hashing.
 *
 * Used by the determinism replay tests (REQ-005) and by the CI asset
 * idempotency checks in later phases. `JSON.stringify` is unsuitable because
 * object key order follows insertion order, so two logically identical states
 * could hash differently.
 */

import { fnv1a32 } from './rng';

function canonicalizeInto(value: unknown, out: string[]): void {
  if (value === null) {
    out.push('null');
    return;
  }

  switch (typeof value) {
    case 'boolean':
      out.push(value ? 'true' : 'false');
      return;
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new TypeError(`cannot canonicalize non-finite number: ${String(value)}`);
      }
      out.push(Number.isInteger(value) ? value.toFixed(0) : value.toString());
      return;
    }
    case 'string':
      out.push(JSON.stringify(value));
      return;
    case 'undefined':
      throw new TypeError('cannot canonicalize undefined');
    case 'bigint':
      out.push(`${value.toString()}n`);
      return;
    default:
      break;
  }

  if (Array.isArray(value)) {
    out.push('[');
    for (let i = 0; i < value.length; i += 1) {
      if (i > 0) out.push(',');
      canonicalizeInto(value[i], out);
    }
    out.push(']');
    return;
  }

  if (value instanceof Date) {
    out.push(JSON.stringify(value.toISOString()));
    return;
  }

  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    out.push('{');
    let first = true;
    for (const key of keys) {
      const entry = record[key];
      if (entry === undefined) continue;
      if (!first) out.push(',');
      first = false;
      out.push(JSON.stringify(key), ':');
      canonicalizeInto(entry, out);
    }
    out.push('}');
    return;
  }

  throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
}

/** Deterministic string form with lexicographically sorted object keys. */
export function canonicalize(value: unknown): string {
  const out: string[] = [];
  canonicalizeInto(value, out);
  return out.join('');
}

/**
 * Locale-independent string ordering.
 *
 * `String.prototype.localeCompare` depends on the runtime's ICU/locale data, so
 * using it to order state (property lists, insolvency order, tie-breaks) would
 * make `hashState` differ across platforms. Compare by UTF-16 code unit
 * instead — the same order in every JS engine.
 */
export function compareCodeUnits(a: string, b: string): number {
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/** Deterministic 8-hex-char digest of any canonicalizable value. */
export function hashValue(value: unknown): string {
  return fnv1a32(canonicalize(value)).toString(16).padStart(8, '0');
}

/**
 * Digest of the authoritative game state. Volatile presentation fields must not
 * be part of the state object; everything stored on `GameState` is fair game.
 */
export function hashState(state: unknown): string {
  return hashValue(state);
}
