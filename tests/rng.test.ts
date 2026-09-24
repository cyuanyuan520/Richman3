import { describe, expect, it } from 'vitest';
import {
  fnv1a32,
  pickWeighted,
  rngFloat,
  rngInt,
  rngIntInclusive,
  rngUint32,
} from '../src/engine/rng';

describe('deterministic rng', () => {
  it('is a pure function of (seed, cursor)', () => {
    expect(rngUint32('abc', 5)).toBe(rngUint32('abc', 5));
    expect(rngUint32('abc', 5)).not.toBe(rngUint32('abc', 6));
    expect(rngUint32('abc', 5)).not.toBe(rngUint32('abd', 5));
    expect(rngUint32('abc', 5)).not.toBe(rngUint32('abc', 1_000_005));
  });

  it('produces floats inside [0, 1)', () => {
    const samples = new Set<number>();
    for (let cursor = 0; cursor < 500; cursor += 1) {
      const value = rngFloat('seed', cursor);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      samples.add(value);
    }
    expect(samples.size).toBeGreaterThan(400);
  });

  it('produces integers inside the requested range', () => {
    const seen = new Set<number>();
    for (let cursor = 0; cursor < 300; cursor += 1) {
      const value = rngInt('seed', cursor, 6);
      expect(Number.isInteger(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(6);
      seen.add(value);
    }
    expect([...seen].sort()).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it('supports inclusive ranges', () => {
    for (let cursor = 0; cursor < 200; cursor += 1) {
      const value = rngIntInclusive('seed', cursor, 1, 6);
      expect(value).toBeGreaterThanOrEqual(1);
      expect(value).toBeLessThanOrEqual(6);
    }
  });

  it('rejects invalid ranges', () => {
    expect(() => rngInt('seed', 0, 0)).toThrow(RangeError);
    expect(() => rngInt('seed', 0, -1)).toThrow(RangeError);
    expect(() => rngInt('seed', 0, 2.5)).toThrow(RangeError);
    expect(() => rngFloat('seed', -1)).toThrow(RangeError);
    expect(() => rngIntInclusive('seed', 0, 5, 1)).toThrow(RangeError);
  });

  it('picks weighted entries by cumulative weight', () => {
    const entries = [
      { weight: 1, value: 'a' as const },
      { weight: 3, value: 'b' as const },
    ];
    expect(pickWeighted(entries, 0)).toBe('a');
    expect(pickWeighted(entries, 0.24)).toBe('a');
    expect(pickWeighted(entries, 0.25)).toBe('b');
    expect(pickWeighted(entries, 0.999_999)).toBe('b');
  });

  it('returns null when nothing is pickable', () => {
    expect(pickWeighted([], 0.5)).toBeNull();
    expect(pickWeighted([{ weight: 0, value: 'a' }], 0.5)).toBeNull();
  });

  it('hashes strings stably', () => {
    expect(fnv1a32('richman3')).toBe(fnv1a32('richman3'));
    expect(fnv1a32('richman3')).not.toBe(fnv1a32('richman4'));
    expect(fnv1a32('')).toBe(0x811c9dc5);
  });
});
