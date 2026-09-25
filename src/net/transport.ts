/**
 * Transport abstraction over PeerJS DataChannels (spec: REQ-003, REQ-026, CON-004,
 * CON-008, SEC-002).
 *
 * The host/client protocol logic never touches `peerjs` directly — it talks to
 * these interfaces, which keeps the interesting behaviour (approval, rate
 * limiting, reconnect, dedupe) testable without a network and keeps the PeerJS
 * dependency to one file.
 *
 * There is deliberately no TURN server: `iceServers` is injectable so a relay
 * can be added later without touching this surface (CON-008). STUN, however, is
 * not optional — without it only same-LAN peers can connect, so the default is
 * a public STUN list and passing `iceServers: []` is the explicit opt-out.
 */

import Peer, { type DataConnection } from 'peerjs';

export interface SignalConfig {
  /** PeerJS server host; `undefined` means the public cloud `0.peerjs.com`. */
  readonly host?: string | undefined;
  readonly port?: number | undefined;
  readonly path?: string | undefined;
  readonly key?: string | undefined;
  readonly secure?: boolean | undefined;
  /**
   * ICE servers. Omitted means STUN-only (hole punching, no relay — CON-008);
   * pass `[]` to disable even STUN, or supply TURN entries to add a relay.
   */
  readonly iceServers?: readonly RTCIceServer[] | undefined;
}

/** Public cloud + direct P2P. Self-hosting is a config swap (CON-004). */
export const DEFAULT_SIGNAL_CONFIG: SignalConfig = {};

/**
 * Hole punching needs a STUN server to learn the public candidate. PeerJS only
 * applies its own defaults when `config` is absent, and this adapter always
 * sends `config`, so the default has to be spelled out here or every
 * non-LAN session silently degrades to "P2P unsupported" (REQ-003, AC-029).
 */
export const DEFAULT_STUN_SERVERS: readonly RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
];

export type TransportErrorCode =
  | 'unavailable-id'
  | 'peer-unavailable'
  | 'network'
  | 'server-error'
  | 'browser-incompatible'
  | 'ice-failed'
  | 'timeout'
  | 'unknown';

export function toTransportErrorCode(type: string | undefined): TransportErrorCode {
  switch (type) {
    case 'unavailable-id':
    case 'peer-unavailable':
    case 'network':
    case 'server-error':
    case 'browser-incompatible':
      return type;
    // ICE never completed / negotiation was abandoned: the AC-029 case, which
    // must be distinguishable from an unknown internal failure.
    case 'webrtc':
    case 'negotiation-failed':
      return 'ice-failed';
    case 'socket-error':
      return 'network';
    case 'invalid-id':
    case 'invalid-key':
      return 'unavailable-id';
    default:
      return 'unknown';
  }
}

export interface TransportConnection {
  readonly peerId: string;
  send(frame: string): void;
  close(): void;
  onMessage(handler: (frame: string) => void): void;
  onClose(handler: () => void): void;
}

export interface HostTransportHandlers {
  onConnection(connection: TransportConnection): void;
  onError(code: TransportErrorCode, detail: string): void;
}

export interface HostTransport {
  readonly peerId: string;
  close(): void;
}

export interface ClientTransportHandlers {
  onError(code: TransportErrorCode, detail: string): void;
}

export interface ClientTransport {
  readonly peerId: string | null;
  connect(targetPeerId: string, timeoutMs?: number): Promise<TransportConnection>;
  close(): void;
}

export const DEFAULT_CONNECT_TIMEOUT_MS = 12_000;

export function peerOptions(signal: SignalConfig): Record<string, unknown> {
  const options: Record<string, unknown> = {};
  if (signal.host !== undefined) options['host'] = signal.host;
  if (signal.port !== undefined) options['port'] = signal.port;
  if (signal.path !== undefined) options['path'] = signal.path;
  if (signal.key !== undefined) options['key'] = signal.key;
  if (signal.secure !== undefined) options['secure'] = signal.secure;
  // `allow_discovery` is a server-side flag; the client never discovers peers
  // (SEC-002). Only explicit ids are ever dialled.
  options['config'] = {
    iceServers: [...(signal.iceServers ?? DEFAULT_STUN_SERVERS)],
  };
  return options;
}

function wrapConnection(connection: DataConnection): TransportConnection {
  const messageHandlers: ((frame: string) => void)[] = [];
  const closeHandlers: (() => void)[] = [];
  connection.on('data', (data: unknown) => {
    if (typeof data !== 'string') return;
    for (const handler of messageHandlers) handler(data);
  });
  connection.on('close', () => {
    for (const handler of closeHandlers) handler();
  });
  connection.on('error', () => {
    for (const handler of closeHandlers) handler();
  });
  return {
    peerId: connection.peer,
    send(frame: string): void {
      // PeerJS returns a promise; a rejected send surfaces through the
      // connection's `error`/`close` events, which are wired above.
      if (connection.open) void connection.send(frame);
    },
    close(): void {
      connection.close();
    },
    onMessage(handler: (frame: string) => void): void {
      messageHandlers.push(handler);
    },
    onClose(handler: () => void): void {
      closeHandlers.push(handler);
    },
  };
}

/**
 * Creates the host peer. The caller supplies the id (derived from the room code
 * by `credentials.ts`), so a collision on the shared cloud surfaces as
 * `unavailable-id` and the caller regenerates a code.
 */
export function createPeerJsHost(
  peerId: string,
  signal: SignalConfig,
  handlers: HostTransportHandlers,
): HostTransport {
  const peer = new Peer(peerId, peerOptions(signal));
  peer.on('connection', (connection: DataConnection) => {
    handlers.onConnection(wrapConnection(connection));
  });
  peer.on('error', (error: Error & { type?: string }) => {
    handlers.onError(toTransportErrorCode(error.type), error.message);
  });
  return {
    peerId,
    close(): void {
      peer.destroy();
    },
  };
}

/** Creates an anonymous client peer and dials one explicit target id. */
export function createPeerJsClient(
  signal: SignalConfig,
  handlers: ClientTransportHandlers,
): ClientTransport {
  const peer = new Peer(peerOptions(signal));
  let currentId: string | null = null;
  let failPendingDial: ((code: TransportErrorCode) => void) | null = null;
  peer.on('open', (id: string) => {
    currentId = id;
  });
  peer.on('error', (error: Error & { type?: string }) => {
    const code = toTransportErrorCode(error.type);
    // A dial in flight is already known to be doomed (`peer-unavailable`,
    // `network`, …); settle it now rather than making the caller wait out the
    // full timeout, which is what REQ-026 calls a silent hang.
    if (failPendingDial !== null) {
      const fail = failPendingDial;
      failPendingDial = null;
      fail(code);
    }
    handlers.onError(code, error.message);
  });
  return {
    get peerId(): string | null {
      return currentId;
    },
    connect(
      targetPeerId: string,
      timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS,
    ): Promise<TransportConnection> {
      return new Promise<TransportConnection>((resolve, reject) => {
        let settled = false;
        const timer = setTimeout(() => {
          if (settled) return;
          settled = true;
          failPendingDial = null;
          reject(new Error('timeout'));
        }, timeoutMs);
        const finish = (): boolean => {
          if (settled) return false;
          settled = true;
          clearTimeout(timer);
          failPendingDial = null;
          return true;
        };
        failPendingDial = (code: TransportErrorCode): void => {
          if (finish()) reject(new Error(code));
        };
        const dial = (): void => {
          let connection: DataConnection;
          try {
            connection = peer.connect(targetPeerId, { reliable: true });
          } catch {
            if (finish()) reject(new Error('unknown'));
            return;
          }
          connection.on('open', () => {
            if (!finish()) {
              connection.close();
              return;
            }
            resolve(wrapConnection(connection));
          });
          connection.on('error', (error: Error & { type?: string }) => {
            if (finish()) reject(new Error(toTransportErrorCode(error.type)));
          });
        };
        if (currentId === null) {
          peer.once('open', dial);
        } else {
          dial();
        }
      });
    },
    close(): void {
      peer.destroy();
    },
  };
}
