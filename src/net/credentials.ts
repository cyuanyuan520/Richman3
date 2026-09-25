/**
 * Room credentials (spec: REQ-029, SEC-003, SEC-006, CON-019).
 *
 * There is no server-side lookup, so the 6-char room code must *be* derivable
 * from the host's PeerJS id or a typed code could never find its host. The
 * design therefore generates the code first and makes the shareable `roomId`
 * the code plus 15 extra secret characters:
 *
 *   roomCode    `7K9Q2M`                        ~20 bits, transmittable by voice
 *   peerId      `rm3-7K9Q2M`                    the host's addressable id
 *   roomId      `rm3-7K9Q2M<15 secret chars>`   the share link, 21-char body
 *   inviteToken `<21 chars>`                    proof that the holder saw the link
 *
 * Consequences, and they are deliberate:
 *  - A link holder can derive the code from the token and connect directly, then
 *    present the token to skip approval.
 *  - A code-only entrant can connect but has no token, so the host must approve.
 *  - The code alone stays guessable; the token is not (SEC-003 / CON-019), and
 *    the host approves or rejects every code-only join.
 */

import {
  ROOM_CODE_ALPHABET,
  ROOM_CODE_LENGTH,
  ROOM_ID_BODY_LENGTH,
  ROOM_NAMESPACE,
  isValidRoomId,
  normalizeRoomCode,
} from '@/lib/room-code';

export interface RoomCredentials {
  /** 6 chars, spoken out loud; also the host peer id suffix. */
  readonly roomCode: string;
  /** `rm3-<21 chars>`: what the share link carries. */
  readonly roomId: string;
  /** `rm3-<roomCode>`: the host's PeerJS id. */
  readonly peerId: string;
  /** The 21-char body; possession of it proves the holder saw the invite. */
  readonly inviteToken: string;
}

export interface InviteTarget {
  readonly roomCode: string;
  readonly peerId: string;
  readonly inviteToken: string;
}

/** Draws a uniform integer in `[0, maxExclusive)`. Returns `null` when the platform has no CSPRNG. */
export type RandomInt = (maxExclusive: number) => number | null;

function defaultRandomInt(maxExclusive: number): number | null {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.getRandomValues === undefined) {
    return null;
  }
  // Rejection sampling keeps the distribution uniform for any alphabet size.
  const limit = Math.floor(0x100000000 / maxExclusive) * maxExclusive;
  const buffer = new Uint32Array(1);
  for (;;) {
    cryptoApi.getRandomValues(buffer);
    const value = buffer[0];
    if (value === undefined) return null;
    if (value < limit) return value % maxExclusive;
  }
}

function randomBody(length: number, randomInt: RandomInt): string | null {
  let body = '';
  for (let i = 0; i < length; i += 1) {
    const index = randomInt(ROOM_CODE_ALPHABET.length);
    if (index === null) return null;
    body += ROOM_CODE_ALPHABET[index];
  }
  return body;
}

/**
 * Generates a fresh room identity. Returns `null` when the platform has no
 * CSPRNG (`crypto.getRandomValues`) — callers must surface that as a hard
 * failure rather than fall back to `Math.random`, which would make room codes
 * predictable.
 *
 * This is the **only** supported producer of share links: `parseInviteTarget`
 * reads the host peer id from the first `ROOM_CODE_LENGTH` characters, so a
 * generic `makeRoomId(nanoid())` body would parse to `null` even though it
 * matches `ROOM_ID_PATTERN`.
 */
export function makeRoomCredentials(
  randomInt: RandomInt = defaultRandomInt,
): RoomCredentials | null {
  const body = randomBody(ROOM_ID_BODY_LENGTH, randomInt);
  if (body === null) return null;
  const roomCode = body.slice(0, ROOM_CODE_LENGTH);
  return {
    roomCode,
    roomId: `${ROOM_NAMESPACE}${body}`,
    peerId: `${ROOM_NAMESPACE}${roomCode}`,
    inviteToken: body,
  };
}

/**
 * Recovers the connection details carried by an invite `roomId`. Returns `null`
 * when the id is malformed *or* when its first six characters are not a valid
 * room code, which is the only case where the host peer id cannot be derived.
 */
export function parseInviteTarget(roomId: string): InviteTarget | null {
  if (!isValidRoomId(roomId)) {
    return null;
  }
  const token = roomId.slice(ROOM_NAMESPACE.length);
  const roomCode = normalizeRoomCode(token.slice(0, ROOM_CODE_LENGTH));
  if (roomCode === null) {
    return null;
  }
  return { roomCode, peerId: `${ROOM_NAMESPACE}${roomCode}`, inviteToken: token };
}

/**
 * Resolves what a user actually supplied into a connection target.
 *
 * - `roomId` (from `?room=`) yields both the peer id and an invite token, so the
 *   join can skip approval.
 * - `roomCode` (typed) yields only the peer id, so the host must approve.
 * - `roomId` wins when both are supplied.
 */
export function resolveJoinTarget(input: {
  roomId?: string | null | undefined;
  roomCode?: string | null | undefined;
}): { peerId: string; roomCode: string; inviteToken: string | null } | null {
  if (input.roomId) {
    const target = parseInviteTarget(input.roomId);
    if (target === null) return null;
    return { peerId: target.peerId, roomCode: target.roomCode, inviteToken: target.inviteToken };
  }
  if (input.roomCode) {
    const roomCode = normalizeRoomCode(input.roomCode);
    if (roomCode === null) return null;
    return { peerId: `${ROOM_NAMESPACE}${roomCode}`, roomCode, inviteToken: null };
  }
  return null;
}
