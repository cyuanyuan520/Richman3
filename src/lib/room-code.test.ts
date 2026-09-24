import { describe, expect, it } from 'vitest';
import {
  buildShareUrl,
  isValidRoomId,
  makeRoomId,
  normalizeRoomCode,
  readRoomIdFromSearch,
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_ID_BODY_LENGTH,
  ROOM_NAMESPACE,
} from './room-code';

const VALID_ROOM_ID = `${ROOM_NAMESPACE}V1StGXR8Z5jdHi6B-myTz`;

describe('room id fixture', () => {
  it('matches the documented shape (namespace + 21-char nanoid)', () => {
    expect(VALID_ROOM_ID).toHaveLength(ROOM_NAMESPACE.length + ROOM_ID_BODY_LENGTH);
  });
});

describe('isValidRoomId', () => {
  it('accepts a namespaced 21-char nanoid', () => {
    expect(isValidRoomId(VALID_ROOM_ID)).toBe(true);
  });

  it('rejects a missing namespace prefix', () => {
    expect(isValidRoomId('V1StGXR8Z5jdHi6B-myT')).toBe(false);
  });

  it('rejects a wrong body length', () => {
    expect(isValidRoomId(`${ROOM_NAMESPACE}tooshort`)).toBe(false);
  });

  it('rejects characters outside the nanoid alphabet', () => {
    expect(isValidRoomId(`${ROOM_NAMESPACE}!!!!!!!!!!!!!!!!!!!!!`)).toBe(false);
  });
});

describe('makeRoomId', () => {
  it('builds a valid room id from a 21-char body', () => {
    expect(makeRoomId('V1StGXR8Z5jdHi6B-myTz')).toBe(VALID_ROOM_ID);
  });

  it('returns null for a body of the wrong length', () => {
    expect(makeRoomId('abc')).toBeNull();
  });
});

describe('buildShareUrl', () => {
  it('appends the room query parameter', () => {
    expect(buildShareUrl('https://example.vercel.app', VALID_ROOM_ID)).toBe(
      `https://example.vercel.app/?room=${VALID_ROOM_ID}`,
    );
  });

  it('does not double the slash when the origin already ends with one', () => {
    expect(buildShareUrl('https://example.vercel.app/', VALID_ROOM_ID)).toBe(
      `https://example.vercel.app/?room=${VALID_ROOM_ID}`,
    );
  });

  it('percent-encodes the room id', () => {
    expect(buildShareUrl('http://localhost:5173', VALID_ROOM_ID)).toContain(
      `?room=${encodeURIComponent(VALID_ROOM_ID)}`,
    );
  });
});

describe('readRoomIdFromSearch', () => {
  it('reads a valid room id', () => {
    expect(readRoomIdFromSearch(`?room=${VALID_ROOM_ID}`)).toBe(VALID_ROOM_ID);
  });

  it('ignores unrelated parameters', () => {
    expect(readRoomIdFromSearch(`?foo=1&room=${VALID_ROOM_ID}&bar=2`)).toBe(VALID_ROOM_ID);
  });

  it('returns null when the parameter is absent', () => {
    expect(readRoomIdFromSearch('?foo=1')).toBeNull();
    expect(readRoomIdFromSearch('')).toBeNull();
  });

  it('returns null for a malformed room id', () => {
    expect(readRoomIdFromSearch('?room=not-a-room')).toBeNull();
  });
});

describe('normalizeRoomCode', () => {
  const validCode = ROOM_CODE_ALPHABET.slice(0, ROOM_CODE_LENGTH);

  it('uppercases and strips separators', () => {
    expect(normalizeRoomCode(validCode.toLowerCase())).toBe(validCode);
    expect(normalizeRoomCode(` ${validCode.slice(0, 3)}-${validCode.slice(3)} `)).toBe(validCode);
  });

  it('rejects codes of the wrong length', () => {
    expect(normalizeRoomCode(validCode.slice(0, 5))).toBeNull();
    expect(normalizeRoomCode(`${validCode}X`)).toBeNull();
  });

  it('rejects ambiguous characters such as O, 0, I and 1', () => {
    for (const bad of ['O', '0', 'I', '1', 'L']) {
      expect(normalizeRoomCode(bad.repeat(ROOM_CODE_LENGTH))).toBeNull();
    }
  });

  it('rejects empty input', () => {
    expect(normalizeRoomCode('')).toBeNull();
  });
});
