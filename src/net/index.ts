/**
 * Networking layer (P4).
 *
 * `host.ts` and `client.ts` contain the protocol logic and speak only to the
 * `Transport` interfaces in `transport.ts`; the PeerJS adapter is the sole place
 * the `peerjs` dependency is touched. `loopback.ts` implements the same
 * interfaces in memory for tests and is intentionally not re-exported here.
 */

export * from './credentials';
export * from './protocol';
export * from './transport';
export * from './host';
export * from './client';
