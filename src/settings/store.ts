import {
  DEFAULT_SETTINGS,
  SETTINGS_STORAGE_KEY,
  SettingsSchema,
  parseSettings,
  type Settings,
} from '@/engine/contracts/config';

/**
 * Settings live in `localStorage` only (CON-017) and are versioned by the
 * contract's `v` field, so a stale payload is replaced rather than migrated
 * blindly.
 */

export interface SettingsStore {
  get(): Settings;
  /** Merge a patch, persist it and notify subscribers. Returns the new value. */
  update(patch: Partial<Omit<Settings, 'v'>>): Settings;
  /** Replace everything with the shipped defaults. */
  reset(): Settings;
  subscribe(listener: (settings: Settings) => void): () => void;
}

export interface SettingsStoreOptions {
  /** Defaults to `window.localStorage`; pass `null` for an in-memory store. */
  storage?: Storage | null | undefined;
  initial?: Settings | undefined;
}

function resolveStorage(storage: Storage | null | undefined): Storage | null {
  if (storage !== undefined) return storage;
  try {
    return typeof window === 'undefined' ? null : window.localStorage;
  } catch {
    // Private browsing modes can throw on access; fall back to memory.
    return null;
  }
}

export function readStoredSettings(storage: Storage | null): Settings {
  if (storage === null) return DEFAULT_SETTINGS;
  let raw: string | null;
  try {
    raw = storage.getItem(SETTINGS_STORAGE_KEY);
  } catch {
    return DEFAULT_SETTINGS;
  }
  if (raw === null) return DEFAULT_SETTINGS;
  try {
    return parseSettings(JSON.parse(raw)) ?? DEFAULT_SETTINGS;
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export function createSettingsStore(options: SettingsStoreOptions = {}): SettingsStore {
  const storage = resolveStorage(options.storage);
  let current = options.initial ?? readStoredSettings(storage);
  const listeners = new Set<(settings: Settings) => void>();

  const commit = (next: Settings): Settings => {
    current = next;
    if (storage !== null) {
      try {
        storage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // A full or unavailable store must not break the game; the value stays
        // in memory for this session.
      }
    }
    for (const listener of listeners) listener(current);
    return current;
  };

  return {
    get: () => current,
    update(patch) {
      const merged = SettingsSchema.safeParse({ ...current, ...patch });
      if (!merged.success) return current;
      return commit(merged.data);
    },
    reset: () => commit(DEFAULT_SETTINGS),
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}
