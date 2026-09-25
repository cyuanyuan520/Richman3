/**
 * In-memory transport used by the networking tests.
 *
 * It is a genuine implementation of the same interfaces the PeerJS adapter
 * implements, so the host/client protocol logic under test is the production
 * logic; only the byte pipe is simulated. Kept out of `src/net/index.ts` so it
 * never reaches the application bundle.
 */

import type {
  ClientTransport,
  ClientTransportHandlers,
  HostTransport,
  HostTransportHandlers,
  TransportConnection,
} from './transport';

interface Pipe {
  hostSide: LoopbackConnection;
  clientSide: LoopbackConnection;
  open: boolean;
}

class LoopbackConnection implements TransportConnection {
  private readonly messageHandlers: ((frame: string) => void)[] = [];
  private readonly closeHandlers: (() => void)[] = [];
  private closed = false;

  constructor(
    readonly peerId: string,
    private readonly pipe: Pipe,
    private readonly side: 'host' | 'client',
  ) {}

  send(frame: string): void {
    if (this.closed) return;
    const other = this.side === 'host' ? this.pipe.clientSide : this.pipe.hostSide;
    if (!this.pipe.open) return;
    // Delivered asynchronously so tests exercise the same ordering assumptions
    // as a real DataChannel.
    queueMicrotask(() => {
      if (this.pipe.open) other.deliver(frame);
    });
  }

  deliver(frame: string): void {
    if (this.closed) return;
    for (const handler of this.messageHandlers) handler(frame);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.pipe.open = false;
    const other = this.side === 'host' ? this.pipe.clientSide : this.pipe.hostSide;
    other.remoteClose();
  }

  remoteClose(): void {
    if (this.closed) return;
    this.closed = true;
    for (const handler of this.closeHandlers) handler();
  }

  onMessage(handler: (frame: string) => void): void {
    this.messageHandlers.push(handler);
  }

  onClose(handler: () => void): void {
    this.closeHandlers.push(handler);
  }
}

export interface LoopbackNetwork {
  readonly hostPeerId: string;
  createHost(handlers: HostTransportHandlers): HostTransport;
  createClient(handlers: ClientTransportHandlers): ClientTransport;
  /** Simulates the host's peer id being unavailable (another host owns it). */
  setHostAvailable(available: boolean): void;
  /** Simulates a network drop for every live connection. */
  dropAll(): void;
  /** Number of live connections. */
  connectionCount(): number;
  /** Every frame the host has received, for assertions about rejection paths. */
  readonly hostInbox: { from: string; frame: string }[];
}

export function createLoopbackNetwork(hostPeerId: string): LoopbackNetwork {
  const pipes: Pipe[] = [];
  const hostInbox: { from: string; frame: string }[] = [];
  let hostHandlers: HostTransportHandlers | null = null;
  let hostAvailable = true;

  const createClient = (handlers: ClientTransportHandlers): ClientTransport => {
    let closed = false;
    return {
      peerId: `client-${pipes.length + 1}`,
      connect(targetPeerId: string, _timeoutMs?: number): Promise<TransportConnection> {
        if (!hostAvailable || hostHandlers === null || targetPeerId !== hostPeerId) {
          handlers.onError('peer-unavailable', `no peer ${targetPeerId}`);
          return Promise.reject(new Error('peer-unavailable'));
        }
        return new Promise<TransportConnection>((resolve) => {
          if (closed) return;
          queueMicrotask(() => {
            if (closed) return;
            const clientId = `client-${pipes.length + 1}`;
            const pipe: Pipe = {
              open: true,
              hostSide: undefined as unknown as LoopbackConnection,
              clientSide: undefined as unknown as LoopbackConnection,
            };
            const hostSide = new LoopbackConnection(clientId, pipe, 'host');
            const clientSide = new LoopbackConnection(hostPeerId, pipe, 'client');
            pipe.hostSide = hostSide;
            pipe.clientSide = clientSide;
            pipes.push(pipe);
            hostSide.onMessage((frame) => {
              hostInbox.push({ from: clientId, frame });
            });
            const handler = hostHandlers;
            handler?.onConnection(hostSide);
            resolve(clientSide);
          });
        });
      },
      close(): void {
        closed = true;
      },
    };
  };

  return {
    hostPeerId,
    createHost(handlers: HostTransportHandlers): HostTransport {
      hostHandlers = handlers;
      return {
        peerId: hostPeerId,
        close(): void {
          hostHandlers = null;
        },
      };
    },
    createClient,
    setHostAvailable(available: boolean): void {
      hostAvailable = available;
    },
    dropAll(): void {
      for (const pipe of pipes) {
        pipe.open = false;
        pipe.hostSide.remoteClose();
        pipe.clientSide.remoteClose();
      }
    },
    connectionCount(): number {
      return pipes.filter((pipe) => pipe.open).length;
    },
    hostInbox,
  };
}
