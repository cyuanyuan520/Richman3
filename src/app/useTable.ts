import { useCallback } from 'react';
import { useSyncExternalStore } from 'react';

import type { ClientIntent } from '@/engine/contracts/net';

import type { TableSnapshot } from './session';

/** Anything the UI can render and drive: a local table or a networked one. */
export interface TableView {
  getSnapshot(): TableSnapshot;
  subscribe(listener: () => void): () => void;
  dispatch(intent: ClientIntent): void;
}

const EMPTY: TableSnapshot | null = null;

/**
 * Subscribes React to a table. `getSnapshot` must return a stable reference
 * between changes, which `GameTable`, `HostTable` and `ClientTable` all do.
 */
export function useTable(table: TableView | null): TableSnapshot | null {
  const subscribe = useCallback(
    (listener: () => void) => (table === null ? () => undefined : table.subscribe(listener)),
    [table],
  );
  const snapshot = useCallback(() => (table === null ? EMPTY : table.getSnapshot()), [table]);
  return useSyncExternalStore(subscribe, snapshot);
}
