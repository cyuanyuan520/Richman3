/**
 * P4 networking tests: room credentials, wire codec, and the host/client
 * protocol driven over the in-memory loopback transport.
 *
 * The loopback implements the same `Transport` interfaces as the PeerJS adapter,
 * so these tests exercise the production host/client logic; only the byte pipe is
 * simulated. The PeerJS adapter itself owns the remaining risk and is called out
 * in the phase log rather than faked here.
 */

import { describe, expect, it, vi } from 'vitest';

import { CONTENT_PACK, CITY_METRO } from '@/content';
import { forceResolveMiniGame, startGame } from '@/engine/reducer';
import type { NetMessage } from '@/engine/contracts/net';
import { NET_PROTOCOL_VERSION } from '@/engine/contracts/net';
import type { GameState, MiniGameState } from '@/engine/contracts/state';

import { makeRoomCredentials, parseInviteTarget, resolveJoinTarget } from '@/net/credentials';
import type { RandomInt } from '@/net/credentials';
import { SeqTracker, decodeMessage, encodeMessage } from '@/net/protocol';
import { HostSession, JOIN_ATTEMPT_LIMIT } from '@/net/host';
import { ClientSession } from '@/net/client';
import { createLoopbackNetwork, type LoopbackNetwork } from '@/net/loopback';
import { peerOptions, toTransportErrorCode } from '@/net/transport';

import { makeSession, patchSession } from './fixtures/content';

/** Deterministic, gap-free random source: `0, 1, 2, ...` modulo the bound. */
function counterRandomInt(): RandomInt {
  let index = 0;
  return (maxExclusive) => {
    if (maxExclusive <= 1) return 0;
    const value = index % maxExclusive;
    index += 1;
    return value;
  };
}

function credentials() {
  const value = makeRoomCredentials(counterRandomInt());
  if (value === null) throw new Error('credentials unavailable');
  return value;
}

function makeRoom() {
  const creds = credentials();
  const network = createLoopbackNetwork(creds.peerId);
  const errors: string[] = [];
  const joinRequests: { nickname: string; approve(): void; reject(): void }[] = [];
  const host = new HostSession({
    credentials: creds,
    pack: CONTENT_PACK,
    map: CITY_METRO,
    seed: 'net-seed',
    randomInt: counterRandomInt(),
    transport: (_peerId, _signal, handlers) => network.createHost(handlers),
    onError: (code, detail) => errors.push(`${code}:${detail}`),
    onJoinRequest: (request) => joinRequests.push(request),
  });
  host.start();
  return { creds, network, host, errors, joinRequests };
}

interface ClientHandles {
  readonly session: ClientSession;
  readonly states: GameState[];
  readonly events: string[];
  readonly statuses: string[];
  readonly rejections: string[];
}

function makeClient(
  network: LoopbackNetwork,
  nickname: string,
  characterId: string,
): ClientHandles {
  const states: GameState[] = [];
  const events: string[] = [];
  const statuses: string[] = [];
  const rejections: string[] = [];
  const session = new ClientSession({
    nickname,
    characterId,
    transport: () => network.createClient({ onError: () => {} }),
    onState: (state) => states.push(state),
    onEvent: (event) => events.push(event.type),
    onStatus: (status) => statuses.push(status),
    onRejected: (reason) => rejections.push(reason),
  });
  return { session, states, events, statuses, rejections };
}

/** A raw connection for tests that must send hand-crafted frames. */
async function rawConnect(network: LoopbackNetwork, peerId: string) {
  const transport = network.createClient({ onError: () => {} });
  const connection = await transport.connect(peerId);
  const received: NetMessage[] = [];
  connection.onMessage((frame) => {
    const decoded = decodeMessage(frame);
    if (decoded.ok) received.push(decoded.message);
  });
  const send = (message: Record<string, unknown>, seq: number): void => {
    connection.send(JSON.stringify({ ...message, v: NET_PROTOCOL_VERSION, seq }));
  };
  const waitFor = async (type: NetMessage['type']): Promise<NetMessage> => {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = received.find((message) => message.type === type);
      if (found !== undefined) return found;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`timed out waiting for ${type} (saw ${received.map((m) => m.type).join(',')})`);
  };
  return { connection, received, send, waitFor };
}

function reasonOf(message: NetMessage): string {
  return message.type === 'JOIN_REJECTED'
    ? message.payload.reason
    : `not-a-rejection:${message.type}`;
}

describe('room credentials', () => {
  it('derives the code, peer id and invite token from one body', () => {
    const value = credentials();
    expect(value.roomCode).toHaveLength(6);
    expect(value.peerId).toBe(`rm3-${value.roomCode}`);
    expect(value.roomId).toBe(`rm3-${value.inviteToken}`);
    expect(value.inviteToken).toHaveLength(21);
    expect(value.inviteToken.startsWith(value.roomCode)).toBe(true);
  });

  it('round-trips an invite link back to the same host peer id', () => {
    const value = credentials();
    const target = parseInviteTarget(value.roomId);
    expect(target?.peerId).toBe(value.peerId);
    expect(target?.inviteToken).toBe(value.inviteToken);
  });

  it('treats a share link as proof but a typed code as only a locator', () => {
    const value = credentials();
    expect(resolveJoinTarget({ roomId: value.roomId })?.inviteToken).toBe(value.inviteToken);
    const typed = resolveJoinTarget({ roomCode: value.roomCode.toLowerCase() });
    expect(typed?.peerId).toBe(value.peerId);
    expect(typed?.inviteToken).toBeNull();
  });

  it('rejects garbage references', () => {
    expect(resolveJoinTarget({})).toBeNull();
    expect(resolveJoinTarget({ roomId: 'rm3-tooshort' })).toBeNull();
    expect(resolveJoinTarget({ roomCode: 'ABCDE' })).toBeNull();
    expect(resolveJoinTarget({ roomCode: 'AAAA0A' })).toBeNull();
  });
});

describe('wire codec', () => {
  const accepted: NetMessage = {
    v: NET_PROTOCOL_VERSION,
    type: 'JOIN_ACCEPTED',
    seq: 7,
    from: 'host',
    payload: { playerId: 'c1', seatIndex: 1, reconnectToken: 'a'.repeat(32) },
  };

  it('round-trips a message', () => {
    const decoded = decodeMessage(encodeMessage(accepted));
    expect(decoded.ok).toBe(true);
    if (decoded.ok) expect(decoded.message).toEqual(accepted);
  });

  it('rejects malformed, unknown and version-mismatched frames', () => {
    expect(decodeMessage('{').ok).toBe(false);
    expect(decodeMessage(JSON.stringify({ hello: 'world' })).ok).toBe(false);
    expect(decodeMessage(JSON.stringify({ ...accepted, v: 99 })).ok).toBe(false);
  });

  it('suppresses replayed sequence numbers per sender', () => {
    const tracker = new SeqTracker();
    expect(tracker.accept('a', 0)).toBe(true);
    expect(tracker.accept('a', 0)).toBe(false);
    expect(tracker.accept('a', 5)).toBe(true);
    expect(tracker.accept('a', 4)).toBe(false);
    expect(tracker.accept('b', 0)).toBe(true);
    tracker.forget('a');
    expect(tracker.accept('a', 0)).toBe(true);
  });
});

describe('joining a room', () => {
  it('admits a share-link holder without host approval and sends a snapshot', async () => {
    const { creds, network, host } = makeRoom();
    const client = makeClient(network, '阿伟', 'char_ninja');
    const result = await client.session.connect({ roomId: creds.roomId });
    expect(result.ok).toBe(true);
    expect(result.playerId).toBe(client.session.clientId);
    expect(host.state.players.map((player) => player.id)).toContain(client.session.clientId);
    expect(client.states.length).toBeGreaterThan(0);
    expect(host.seatToken(client.session.clientId)).toBeDefined();
    client.session.close();
    host.stop();
  });

  it('holds a code-only entrant for approval, then admits on approve', async () => {
    const { creds, network, host, joinRequests } = makeRoom();
    const client = makeClient(network, '小美', 'char_girl');
    const pending = client.session.connect({ roomCode: creds.roomCode });
    await vi.waitFor(() => expect(joinRequests).toHaveLength(1));
    expect(client.statuses).toContain('pending-approval');
    joinRequests[0]?.approve();
    const result = await pending;
    expect(result.ok).toBe(true);
    expect(host.state.players).toHaveLength(2);
    client.session.close();
    host.stop();
  });

  it('refuses a declined code-only entrant', async () => {
    const { creds, network, host, joinRequests } = makeRoom();
    const client = makeClient(network, '路人', 'char_farmer');
    const pending = client.session.connect({ roomCode: creds.roomCode });
    await vi.waitFor(() => expect(joinRequests).toHaveLength(1));
    joinRequests[0]?.reject();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('declined');
    expect(client.rejections).toContain('declined');
    expect(host.state.players).toHaveLength(1);
    client.session.close();
    host.stop();
  });

  it('rate limits repeated join attempts on one connection', async () => {
    const { creds, network, host } = makeRoom();
    const raw = await rawConnect(network, creds.peerId);
    for (let attempt = 0; attempt < JOIN_ATTEMPT_LIMIT + 1; attempt += 1) {
      raw.send(
        {
          type: 'INTENT_JOIN',
          from: `c${attempt}`,
          payload: { roomCode: creds.roomCode, nickname: `n${attempt}` },
        },
        attempt,
      );
    }
    const rejected = await raw.waitFor('JOIN_REJECTED');
    expect(reasonOf(rejected)).toBe('rate-limited');
    expect(host.state.players).toHaveLength(1);
    raw.connection.close();
    host.stop();
  });

  it('refuses a frame that claims another seat', async () => {
    const { creds, network, host } = makeRoom();
    const raw = await rawConnect(network, creds.peerId);
    raw.send(
      { type: 'INTENT_JOIN', from: 'c9', payload: { roomId: creds.roomId, nickname: '真身' } },
      0,
    );
    await raw.waitFor('JOIN_ACCEPTED');
    const before = host.stateHash();
    raw.send({ type: 'INTENT_ROLL', from: 'p1', payload: {} }, 1);
    const rejected = await raw.waitFor('JOIN_REJECTED');
    expect(reasonOf(rejected)).toBe('seat-mismatch');
    expect(host.stateHash()).toBe(before);
    raw.connection.close();
    host.stop();
  });

  it('refuses intents from a connection that never joined', async () => {
    const { creds, network, host } = makeRoom();
    const raw = await rawConnect(network, creds.peerId);
    raw.send({ type: 'INTENT_ROLL', from: 'c1', payload: {} }, 0);
    const rejected = await raw.waitFor('JOIN_REJECTED');
    expect(reasonOf(rejected)).toBe('not-joined');
    raw.connection.close();
    host.stop();
  });

  it('refuses a fifth seat', async () => {
    const { creds, network, host } = makeRoom();
    expect(host.addAiPlayer('AI-1', 'char_girl')).not.toBeNull();
    expect(host.addAiPlayer('AI-2', 'char_madame')).not.toBeNull();
    expect(host.addAiPlayer('AI-3', 'char_ninja')).not.toBeNull();
    expect(host.state.players).toHaveLength(4);
    const raw = await rawConnect(network, creds.peerId);
    raw.send(
      { type: 'INTENT_JOIN', from: 'c5', payload: { roomId: creds.roomId, nickname: '第五人' } },
      0,
    );
    const rejected = await raw.waitFor('JOIN_REJECTED');
    expect(reasonOf(rejected)).toBe('room-full');
    raw.connection.close();
    host.stop();
  });

  it('refuses a seat whose character is unknown to the registry', async () => {
    const { creds, network, host } = makeRoom();
    const raw = await rawConnect(network, creds.peerId);
    raw.send(
      {
        type: 'INTENT_JOIN',
        from: 'c7',
        payload: { roomId: creds.roomId, nickname: '未知角色', characterId: 'char_nope' },
      },
      0,
    );
    const rejected = await raw.waitFor('JOIN_REJECTED');
    expect(reasonOf(rejected)).toContain('unknown-character');
    expect(host.state.players).toHaveLength(1);
    raw.connection.close();
    host.stop();
  });
});

describe('reconnect', () => {
  it('marks a dropped seat disconnected and rebinds it with the seat token', async () => {
    const { creds, network, host } = makeRoom();
    const client = makeClient(network, '阿影', 'char_ninja');
    const first = await client.session.connect({ roomId: creds.roomId });
    expect(first.ok).toBe(true);
    const seatId = client.session.clientId;
    network.dropAll();
    await vi.waitFor(() => {
      expect(host.state.players.find((player) => player.id === seatId)?.connected).toBe(false);
    });
    const again = await client.session.reconnect();
    expect(again.ok).toBe(true);
    expect(host.state.players.find((player) => player.id === seatId)?.connected).toBe(true);
    expect(host.state.players).toHaveLength(2);
    client.session.close();
    host.stop();
  });

  it('refuses a forged seat token', async () => {
    const { creds, network, host } = makeRoom();
    const raw = await rawConnect(network, creds.peerId);
    raw.send(
      {
        type: 'INTENT_JOIN',
        from: 'c1',
        payload: {
          roomCode: creds.roomCode,
          nickname: '冒充者',
          reconnect: { playerId: 'p1', token: 'f'.repeat(32) },
        },
      },
      0,
    );
    const rejected = await raw.waitFor('JOIN_REJECTED');
    expect(reasonOf(rejected)).toBe('unknown-seat-token');
    raw.connection.close();
    host.stop();
  });
});

describe('authority', () => {
  it('never applies an out-of-turn intent and reports the refusal locally', async () => {
    const { creds, network, host, errors } = makeRoom();
    const client = makeClient(network, '客户', 'char_ninja');
    const joined = await client.session.connect({ roomId: creds.roomId });
    expect(joined.ok).toBe(true);
    // Seats can only be added while the table is in SETUP, so join first.
    expect(host.addAiPlayer('AI-1', 'char_girl')).not.toBeNull();
    expect(host.begin().ok).toBe(true);
    const before = host.stateHash();
    client.session.sendIntent({ type: 'INTENT_ROLL', payload: {} });
    await vi.waitFor(() => expect(errors.join('|')).toContain('not-your-turn'));
    expect(host.stateHash()).toBe(before);
    client.session.close();
    host.stop();
  });

  it('broadcasts state events to every seated client', async () => {
    const { creds, network, host } = makeRoom();
    const watcher = makeClient(network, '观众', 'char_madame');
    const joined = await watcher.session.connect({ roomId: creds.roomId });
    expect(joined.ok).toBe(true);
    expect(host.addAiPlayer('AI-1', 'char_girl')).not.toBeNull();
    expect(host.begin().ok).toBe(true);
    await vi.waitFor(() => expect(watcher.events.length).toBeGreaterThan(0));
    watcher.session.close();
    host.stop();
  });
});

describe('forceResolveMiniGame', () => {
  function miniGameSession(kind: 'WHEEL' | 'GACHA'): ReturnType<typeof makeSession> {
    const base = startGame(makeSession()).session;
    const minigame: MiniGameState = {
      minigameId: kind === 'WHEEL' ? 'mg_wheel' : 'mg_gacha',
      kind,
      participantIds: ['p1', 'p2'],
      submissions: {},
    };
    return patchSession(base, (state) => ({
      ...state,
      phase: 'MINIGAME',
      minigame,
      pendingChoice: {
        kind: 'MINIGAME',
        playerId: 'p1',
        minigameId: minigame.minigameId,
        options: ['ok'],
      },
    }));
  }

  it('fills every missing submission and resolves', () => {
    const result = forceResolveMiniGame(miniGameSession('WHEEL'));
    expect(result.rejected).toBeNull();
    expect(result.session.state.minigame).toBeNull();
    const forced = result.events.filter((event) => event.type === 'MINIGAME_FORCED');
    expect(forced).toHaveLength(2);
    expect(result.events.some((event) => event.type === 'MINIGAME_FINISHED')).toBe(true);
  });

  it('honours explicit actions over the fallback', () => {
    const result = forceResolveMiniGame(miniGameSession('GACHA'), { p2: 'DRAW' });
    const forced = result.events.filter((event) => event.type === 'MINIGAME_FORCED');
    expect(forced.map((event) => event.playerId)).toEqual(['p1']);
  });

  it('refuses when no mini-game is running', () => {
    expect(forceResolveMiniGame(makeSession()).rejected).toBe('no-minigame-running');
  });

  it('is deterministic for a fixed seed and action set', () => {
    const first = forceResolveMiniGame(miniGameSession('WHEEL'));
    const second = forceResolveMiniGame(miniGameSession('WHEEL'));
    expect(first.session.state.players).toEqual(second.session.state.players);
  });
});

describe('Gate 4 remediation', () => {
  it('drops malformed and hostile frames without touching authoritative state', async () => {
    const { creds, network, host, errors } = makeRoom();
    const before = host.stateHash();
    const raw = network.createClient({ onError: () => {} });
    const connection = await raw.connect(creds.peerId);
    connection.send('{ not json');
    connection.send(
      JSON.stringify({
        v: NET_PROTOCOL_VERSION,
        type: 'INTENT_JOIN',
        seq: 0,
        from: 'c1',
        payload: null,
      }),
    );
    connection.send(
      JSON.stringify({
        v: NET_PROTOCOL_VERSION,
        type: 'INTENT_JOIN',
        seq: 1,
        from: 'c2',
        payload: { roomId: creds.roomId, nickname: 42 },
      }),
    );
    await vi.waitFor(() =>
      expect(errors.filter((entry) => entry.startsWith('bad-frame')).length).toBe(3),
    );
    expect(host.stateHash()).toBe(before);
    expect(host.state.players).toHaveLength(1);
    connection.close();
    host.stop();
  });

  it('accepts a hand-typed lowercase room code', async () => {
    const { creds, network, host, joinRequests } = makeRoom();
    const client = makeClient(network, '小写', 'char_ninja');
    const pending = client.session.connect({ roomCode: creds.roomCode.toLowerCase() });
    await vi.waitFor(() => expect(joinRequests).toHaveLength(1));
    expect(client.statuses).toContain('pending-approval');
    joinRequests[0]?.approve();
    expect((await pending).ok).toBe(true);
    client.session.close();
    host.stop();
  });

  it('advances a client mirror after a host intent', async () => {
    const { creds, network, host } = makeRoom();
    const client = makeClient(network, '镜像', 'char_ninja');
    expect((await client.session.connect({ roomId: creds.roomId })).ok).toBe(true);
    expect(host.addAiPlayer('AI-1', 'char_girl')).not.toBeNull();
    expect(host.begin().ok).toBe(true);
    const before = client.session.currentState;
    expect(before).not.toBeNull();
    host.hostIntent({
      type: 'INTENT_ROLL',
      payload: {},
      v: NET_PROTOCOL_VERSION,
      seq: 0,
      from: 'p1',
    });
    await vi.waitFor(() => {
      expect(client.session.currentState?.rngCursor).not.toBe(before?.rngCursor);
    });
    client.session.close();
    host.stop();
  });

  it('publishes seat lifecycle events to seated clients', async () => {
    const { creds, network, host } = makeRoom();
    const client = makeClient(network, '旁观', 'char_ninja');
    expect((await client.session.connect({ roomId: creds.roomId })).ok).toBe(true);
    expect(host.addAiPlayer('AI-1', 'char_girl')).not.toBeNull();
    await vi.waitFor(() => expect(client.events).toContain('PLAYER_SEATED'));
    client.session.close();
    host.stop();
  });

  it('refuses a second entrant for a taken character', async () => {
    const { creds, network, host } = makeRoom();
    const first = makeClient(network, '先到', 'char_ninja');
    expect((await first.session.connect({ roomId: creds.roomId })).ok).toBe(true);
    const second = makeClient(network, '后到', 'char_ninja');
    const result = await second.session.connect({ roomId: creds.roomId });
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('character-taken');
    expect(host.state.players).toHaveLength(2);
    first.session.close();
    second.session.close();
    host.stop();
  });

  it('tells a seated client when its character choice is taken', async () => {
    const { creds, network, host } = makeRoom();
    const first = makeClient(network, '先到', 'char_ninja');
    expect((await first.session.connect({ roomId: creds.roomId })).ok).toBe(true);
    const second = makeClient(network, '后到', 'char_girl');
    expect((await second.session.connect({ roomId: creds.roomId })).ok).toBe(true);
    second.session.sendIntent({
      type: 'INTENT_SELECT_CHARACTER',
      payload: { characterId: 'char_ninja' },
    });
    await vi.waitFor(() => expect(second.events).toContain('CHARACTER_TAKEN'));
    expect(
      host.state.players.find((player) => player.id === second.session.clientId)?.characterId,
    ).toBe('char_girl');
    first.session.close();
    second.session.close();
    host.stop();
  });

  it('settles a join that drops while pending approval', async () => {
    const { creds, network, host, joinRequests } = makeRoom();
    const client = makeClient(network, '掉了', 'char_ninja');
    const pending = client.session.connect({ roomCode: creds.roomCode });
    await vi.waitFor(() => expect(joinRequests).toHaveLength(1));
    network.dropAll();
    const result = await pending;
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('connection-closed');
    // Approving a ghost must not seat anyone.
    joinRequests[0]?.approve();
    expect(host.state.players).toHaveLength(1);
    client.session.close();
    host.stop();
  });

  it('exposes a seat token that a refreshed session can reuse', async () => {
    const { creds, network, host } = makeRoom();
    const first = makeClient(network, '刷新', 'char_ninja');
    expect((await first.session.connect({ roomId: creds.roomId })).ok).toBe(true);
    const seat = first.session.seatToken;
    expect(seat).not.toBeNull();
    const restored = new ClientSession({
      nickname: '刷新',
      characterId: 'char_ninja',
      transport: () => network.createClient({ onError: () => {} }),
      seat: seat as { playerId: string; token: string },
      target: { roomId: creds.roomId },
    });
    const again = await restored.reconnect();
    expect(again.ok).toBe(true);
    expect(restored.currentStatus).toBe('joined');
    expect(host.state.players).toHaveLength(2);
    // The token is rotated on rebind, so the stale one is no longer accepted.
    expect(restored.seatToken?.token).not.toBe(seat?.token);
    first.session.close();
    restored.close();
    host.stop();
  });
});

describe('transport configuration', () => {
  it('defaults to STUN so hole punching can work, and allows an opt-out', () => {
    const options = peerOptions({}) as { config: { iceServers: { urls: string }[] } };
    expect(options.config.iceServers.length).toBeGreaterThan(0);
    expect(options.config.iceServers[0]?.urls).toContain('stun:');
    const disabled = peerOptions({ iceServers: [] }) as { config: { iceServers: unknown[] } };
    expect(disabled.config.iceServers).toEqual([]);
  });

  it('maps the PeerJS errors that matter for REQ-026', () => {
    expect(toTransportErrorCode('webrtc')).toBe('ice-failed');
    expect(toTransportErrorCode('negotiation-failed')).toBe('ice-failed');
    expect(toTransportErrorCode('socket-error')).toBe('network');
    expect(toTransportErrorCode('invalid-key')).toBe('unavailable-id');
    expect(toTransportErrorCode('peer-unavailable')).toBe('peer-unavailable');
    expect(toTransportErrorCode(undefined)).toBe('unknown');
  });
});
