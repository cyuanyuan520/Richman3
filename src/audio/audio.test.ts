import { describe, expect, it, vi } from 'vitest';

import { BGM_TRACKS, createBgmPlayer } from './bgm';
import { createAudioDirector } from './director';
import { SFX_KINDS, createSfxPlayer } from './sfx';

interface FakeAudio {
  element: HTMLAudioElement;
  play: ReturnType<typeof vi.fn>;
  pause: ReturnType<typeof vi.fn>;
}

function fakeAudioFactory(): { created: FakeAudio[]; create: (src: string) => HTMLAudioElement } {
  const created: FakeAudio[] = [];
  const create = (src: string): HTMLAudioElement => {
    const play = vi.fn(() => Promise.resolve());
    const pause = vi.fn();
    const element = {
      src,
      loop: false,
      preload: '',
      volume: 1,
      play,
      pause,
    } as unknown as HTMLAudioElement;
    created.push({ element, play, pause });
    return element;
  };
  return { created, create };
}

describe('background music', () => {
  it('creates no audio element until asked to play', () => {
    const { created, create } = fakeAudioFactory();
    const player = createBgmPlayer({ createAudio: create });
    expect(player.isLoaded()).toBe(false);
    expect(created).toHaveLength(0);

    player.play();
    expect(created).toHaveLength(1);
    expect(created[0]?.element.src).toBe(BGM_TRACKS[0]);
    expect(created[0]?.element.loop).toBe(true);
    expect(player.isLoaded()).toBe(true);
  });

  it('reuses the element for the same track and swaps for a different one', () => {
    const { created, create } = fakeAudioFactory();
    const player = createBgmPlayer({ createAudio: create });
    player.play(BGM_TRACKS[0]);
    player.play(BGM_TRACKS[0]);
    expect(created).toHaveLength(1);
    player.play(BGM_TRACKS[1]);
    expect(created).toHaveLength(2);
    expect(created[0]?.pause).toHaveBeenCalled();
  });

  it('applies mute and volume without creating an element', () => {
    const { created, create } = fakeAudioFactory();
    const player = createBgmPlayer({ createAudio: create, initialVolume: 0.5 });
    player.setMuted(true);
    player.setVolume(0.9);
    expect(created).toHaveLength(0);
    player.play();
    expect(created[0]?.element.volume).toBe(0);
    player.setMuted(false);
    expect(created[0]?.element.volume).toBe(0.9);
  });

  it('swallows a rejected play', () => {
    const element = {
      src: '',
      loop: false,
      preload: '',
      volume: 1,
      play: vi.fn(() => Promise.reject(new Error('blocked'))),
      pause: vi.fn(),
    } as unknown as HTMLAudioElement;
    const player = createBgmPlayer({ createAudio: () => element });
    expect(() => player.play()).not.toThrow();
  });
});

describe('sound effects', () => {
  it('is a silent no-op when Web Audio is unavailable', () => {
    const player = createSfxPlayer({ createContext: () => null });
    for (const kind of SFX_KINDS) expect(() => player.play(kind)).not.toThrow();
    expect(() => player.setVolume(2)).not.toThrow();
    expect(() => player.dispose()).not.toThrow();
  });

  it('schedules a graph per kind once a context exists', async () => {
    const started: number[] = [];
    const oscillators: OscillatorType[] = [];
    const close = vi.fn(() => Promise.resolve());
    const context = {
      currentTime: 0,
      sampleRate: 48000,
      state: 'running',
      destination: {},
      resume: vi.fn(() => Promise.resolve()),
      close,
      createGain: () => ({
        gain: {
          value: 1,
          setValueAtTime: vi.fn(),
          exponentialRampToValueAtTime: vi.fn(),
        },
        connect: vi.fn(),
      }),
      createOscillator: () => {
        const oscillator = {
          type: 'sine' as OscillatorType,
          frequency: {
            setValueAtTime: vi.fn(),
            exponentialRampToValueAtTime: vi.fn(),
          },
          connect: vi.fn(),
          start: vi.fn(() => started.push(1)),
          stop: vi.fn(),
        };
        Object.defineProperty(oscillator, 'type', {
          get: () => 'sine',
          set: (value: OscillatorType) => oscillators.push(value),
        });
        return oscillator;
      },
      createBuffer: (_channels: number, frames: number) => ({
        getChannelData: () => new Float32Array(frames),
      }),
      createBufferSource: () => ({
        buffer: null,
        connect: vi.fn(),
        start: vi.fn(() => started.push(1)),
        stop: vi.fn(),
      }),
      createBiquadFilter: () => ({
        type: 'lowpass',
        frequency: { setValueAtTime: vi.fn(), exponentialRampToValueAtTime: vi.fn() },
        connect: vi.fn(),
      }),
    } as unknown as AudioContext;

    const player = createSfxPlayer({ createContext: () => context });
    for (const kind of SFX_KINDS) player.play(kind);
    expect(started.length).toBeGreaterThan(0);
    expect(oscillators).toContain('square');
    await player.resume();
    player.setMuted(true);
    player.setVolume(0.3);
    player.dispose();
    expect(close).toHaveBeenCalled();
  });

  it('remembers a failed context and stops retrying', () => {
    const create = vi.fn(() => null);
    const player = createSfxPlayer({ createContext: create });
    player.play('CLICK');
    player.play('CLICK');
    expect(create).toHaveBeenCalledTimes(1);
  });
});

describe('audio director', () => {
  it('mirrors settings onto both halves and unlocks on demand', () => {
    const { created, create } = fakeAudioFactory();
    const bgm = createBgmPlayer({ createAudio: create });
    const sfx = createSfxPlayer({ createContext: () => null });
    const director = createAudioDirector({ bgm, sfx });

    director.applySettings({ bgmVolume: 0.3, sfxVolume: 0.7, muted: false });
    director.startBgm();
    expect(created[0]?.element.volume).toBeCloseTo(0.3);

    director.applySettings({ bgmVolume: 0.3, sfxVolume: 0.7, muted: true });
    expect(created[0]?.element.volume).toBe(0);

    director.unlock();
    expect(created[0]?.play).toHaveBeenCalled();

    director.stopBgm();
    expect(created[0]?.pause).toHaveBeenCalled();
    expect(() => director.playSfx('CLICK')).not.toThrow();
    director.dispose();
  });
});
