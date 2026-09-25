import { describe, expect, it, vi } from 'vitest';

import { DEFAULT_SETTINGS, SETTINGS_STORAGE_KEY } from '@/engine/contracts/config';

import { createSettingsStore, readStoredSettings } from './store';

function memoryStorage(seed?: string): Storage {
  const map = new Map<string, string>();
  if (seed !== undefined) map.set(SETTINGS_STORAGE_KEY, seed);
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  } satisfies Storage;
}

describe('settings store', () => {
  it('falls back to the shipped defaults on an empty store', () => {
    const store = createSettingsStore({ storage: memoryStorage() });
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('replaces a stale payload rather than trusting it', () => {
    const stale = JSON.stringify({ v: 0, nickname: 'old' });
    const store = createSettingsStore({ storage: memoryStorage(stale) });
    expect(store.get()).toEqual(DEFAULT_SETTINGS);
  });

  it('persists a patch and notifies subscribers', () => {
    const storage = memoryStorage();
    const store = createSettingsStore({ storage });
    const seen: string[] = [];
    const unsubscribe = store.subscribe((settings) => seen.push(settings.nickname));

    const next = store.update({ nickname: '阿伟', sfxVolume: 0.4 });
    expect(next.nickname).toBe('阿伟');
    expect(seen).toEqual(['阿伟']);
    expect(JSON.parse(storage.getItem(SETTINGS_STORAGE_KEY) ?? '{}')).toMatchObject({
      v: 1,
      nickname: '阿伟',
      sfxVolume: 0.4,
    });

    unsubscribe();
    store.update({ nickname: '小美' });
    expect(seen).toEqual(['阿伟']);
  });

  it('rejects an out-of-range patch without mutating state', () => {
    const store = createSettingsStore({ storage: memoryStorage() });
    const before = store.get();
    expect(store.update({ sfxVolume: 5 })).toEqual(before);
    expect(store.get()).toEqual(before);
  });

  it('works without a storage backend', () => {
    const store = createSettingsStore({ storage: null });
    expect(store.update({ muted: true }).muted).toBe(true);
    expect(store.reset().muted).toBe(false);
  });

  it('survives a storage that throws on write', () => {
    const hostile: Storage = {
      ...memoryStorage(),
      getItem: () => null,
      setItem: () => {
        throw new Error('quota exceeded');
      },
    };
    const store = createSettingsStore({ storage: hostile });
    expect(store.update({ nickname: '仍然可用' }).nickname).toBe('仍然可用');
  });

  it('treats unreadable JSON as defaults', () => {
    expect(readStoredSettings(memoryStorage('{not json'))).toEqual(DEFAULT_SETTINGS);
  });

  it('parses a stored payload', () => {
    const seed = JSON.stringify({ ...DEFAULT_SETTINGS, nickname: '存过的' });
    const spy = vi.fn();
    const store = createSettingsStore({ storage: memoryStorage(seed) });
    store.subscribe(spy);
    expect(store.get().nickname).toBe('存过的');
    expect(spy).not.toHaveBeenCalled();
  });
});
