/**
 * Wire codec and duplicate suppression (spec §4, REQ-004).
 *
 * Everything crossing the DataChannel is a JSON-encoded `NetMessage` envelope
 * `{ v, type, seq, from, to?, payload }`. Both ends validate with the shared Zod
 * schema, so a malformed or version-mismatched frame is dropped at the boundary
 * and can never reach the reducer.
 */

import { NET_PROTOCOL_VERSION, NetMessageSchema, type NetMessage } from '@/engine/contracts/net';

export type DecodeResult =
  | { readonly ok: true; readonly message: NetMessage }
  | { readonly ok: false; readonly reason: string };

/** Serializes a message for the wire. Kept tiny: JSON, no framing bytes. */
export function encodeMessage(message: NetMessage): string {
  return JSON.stringify(message);
}

/** Parses and validates one frame. Never throws. */
export function decodeMessage(raw: unknown): DecodeResult {
  if (typeof raw !== 'string') {
    return { ok: false, reason: 'not-a-string-frame' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, reason: 'malformed-json' };
  }
  const result = NetMessageSchema.safeParse(parsed);
  if (!result.success) {
    return { ok: false, reason: 'schema-violation' };
  }
  if (result.data.v !== NET_PROTOCOL_VERSION) {
    return { ok: false, reason: 'protocol-version-mismatch' };
  }
  return { ok: true, message: result.data };
}

/**
 * Tracks the highest accepted `seq` per sender so a replayed or reordered frame
 * is ignored rather than re-applied. Sequence numbers come from a single
 * monotonic counter on each end, and the host reserves numbers for rejected
 * intents too, so a gap is not an error — only a value at or below the high
 * water mark is a duplicate.
 */
export class SeqTracker {
  private readonly highest = new Map<string, number>();

  /** Registers `seq` for `from`. Returns `false` when it is a duplicate. */
  accept(from: string, seq: number): boolean {
    const previous = this.highest.get(from);
    if (previous !== undefined && seq <= previous) {
      return false;
    }
    this.highest.set(from, seq);
    return true;
  }

  /** Highest accepted sequence number for a sender, or `undefined`. */
  highestFor(from: string): number | undefined {
    return this.highest.get(from);
  }

  /** Drops tracking for a sender that left, so a rejoining peer starts clean. */
  forget(from: string): void {
    this.highest.delete(from);
  }

  reset(): void {
    this.highest.clear();
  }
}
