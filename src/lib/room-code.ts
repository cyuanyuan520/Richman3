/**
 * Room identifier contracts (spec: REQ-029, SEC-003, SEC-006).
 *
 * Two ways exist to join a room:
 *  - a share link carrying a high-entropy `roomId` (`/?room=rm3-<nanoid21>`)
 *  - a 6-char human-readable `roomCode` spoken out loud, which only acts as a
 *    locator and must be confirmed by the host (see CON-019)
 *
 * All identifiers carry the `rm3-` namespace prefix so they cannot collide with
 * other applications sharing the public PeerJS cloud.
 */

/** Namespace prefix for peer ids / room ids (SEC-006). */
export const ROOM_NAMESPACE = 'rm3-';

/** Default nanoid length used for room ids. */
export const ROOM_ID_BODY_LENGTH = 21;

/** Room ids look like `rm3-V1StGXR8Z5jdHi6B-myTz` (namespace + 21-char nanoid). */
export const ROOM_ID_PATTERN = /^rm3-[A-Za-z0-9_-]{21}$/;

/**
 * Alphabet for human-transmitted room codes: no `0/O`, `1/I/L` confusables.
 * Codes are always matched case-insensitively.
 */
export const ROOM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';

/** Room codes are exactly this many characters. */
export const ROOM_CODE_LENGTH = 6;

/** Query-string parameter that carries a room id. */
export const ROOM_QUERY_PARAM = 'room';

/** Returns true when `value` is a well-formed namespaced room id. */
export function isValidRoomId(value: string): boolean {
  return ROOM_ID_PATTERN.test(value);
}

/** Joins a 21-char nanoid body with the namespace prefix. */
export function makeRoomId(body: string): string | null {
  const candidate = `${ROOM_NAMESPACE}${body}`;
  return isValidRoomId(candidate) ? candidate : null;
}

/** Builds the shareable URL for a room: `<origin>/?room=<roomId>`.
 *
 * Returns `null` for a malformed `roomId` so a broken invite link can never be
 * produced. Callers must handle the `null` case (there is no throw).
 */
export function buildShareUrl(origin: string, roomId: string): string | null {
  if (!isValidRoomId(roomId)) {
    return null;
  }
  const base = origin.endsWith('/') ? origin : `${origin}/`;
  return `${base}?${ROOM_QUERY_PARAM}=${encodeURIComponent(roomId)}`;
}

/**
 * Derives the namespaced PeerJS id of the host that owns a room code (SEC-006).
 *
 * A typed 6-char room code is only a *locator*: without any server-side lookup,
 * the only way it can find a host is if the host's peer id is derivable from the
 * code. Namespacing (`rm3-`) keeps these ids from colliding with unrelated apps
 * on the public PeerJS cloud.
 *
 * Returns `null` when `roomCode` is not a valid code.
 */
export function makePeerId(roomCode: string): string | null {
  const code = normalizeRoomCode(roomCode);
  if (!code) {
    return null;
  }
  return `${ROOM_NAMESPACE}${code}`;
}

/**
 * Reads and validates a room id from a `location.search` string.
 * Returns `null` when absent or malformed (no room discovery, SEC-003).
 */
export function readRoomIdFromSearch(search: string): string | null {
  const raw = new URLSearchParams(search).get(ROOM_QUERY_PARAM);
  if (!raw) {
    return null;
  }
  return isValidRoomId(raw) ? raw : null;
}

/**
 * Normalizes user-typed room-code input: trims, uppercases, drops spaces and
 * dashes. Returns `null` when the result is not a valid room code.
 */
export function normalizeRoomCode(input: string): string | null {
  const cleaned = input.trim().toUpperCase().replace(/[\s-]/g, '');
  if (cleaned.length !== ROOM_CODE_LENGTH) {
    return null;
  }
  for (const char of cleaned) {
    if (!ROOM_CODE_ALPHABET.includes(char)) {
      return null;
    }
  }
  return cleaned;
}
