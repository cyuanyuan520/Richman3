/**
 * Sound effects are synthesised at runtime (REQ-019) so the game ships with no
 * audio assets beyond the two BGM tracks. Every recipe is a short oscillator or
 * noise gesture; nothing is sampled.
 */

export type SfxKind =
  'CLICK' | 'DICE' | 'MOVE' | 'LAND' | 'BUY' | 'PAY' | 'WIN' | 'LOSE' | 'CHAOS' | 'MINIGAME';

export const SFX_KINDS: readonly SfxKind[] = [
  'CLICK',
  'DICE',
  'MOVE',
  'LAND',
  'BUY',
  'PAY',
  'WIN',
  'LOSE',
  'CHAOS',
  'MINIGAME',
];

interface ToneStep {
  readonly kind: 'tone';
  readonly wave: OscillatorType;
  readonly from: number;
  readonly to: number;
  readonly start: number;
  readonly duration: number;
  readonly gain: number;
}

interface NoiseStep {
  readonly kind: 'noise';
  readonly start: number;
  readonly duration: number;
  readonly gain: number;
  readonly filterFrom: number;
  readonly filterTo: number;
}

type Step = ToneStep | NoiseStep;

const RECIPES: Record<SfxKind, readonly Step[]> = {
  CLICK: [
    { kind: 'tone', wave: 'square', from: 880, to: 660, start: 0, duration: 0.06, gain: 0.18 },
  ],
  DICE: [
    { kind: 'noise', start: 0, duration: 0.22, gain: 0.22, filterFrom: 2600, filterTo: 700 },
    { kind: 'tone', wave: 'square', from: 520, to: 300, start: 0.16, duration: 0.1, gain: 0.14 },
  ],
  MOVE: [{ kind: 'tone', wave: 'sine', from: 520, to: 620, start: 0, duration: 0.07, gain: 0.16 }],
  LAND: [
    { kind: 'tone', wave: 'triangle', from: 340, to: 180, start: 0, duration: 0.14, gain: 0.2 },
  ],
  BUY: [
    { kind: 'tone', wave: 'triangle', from: 660, to: 660, start: 0, duration: 0.09, gain: 0.18 },
    { kind: 'tone', wave: 'triangle', from: 990, to: 990, start: 0.09, duration: 0.14, gain: 0.18 },
  ],
  PAY: [
    { kind: 'tone', wave: 'sawtooth', from: 320, to: 140, start: 0, duration: 0.2, gain: 0.16 },
  ],
  WIN: [
    { kind: 'tone', wave: 'triangle', from: 523, to: 523, start: 0, duration: 0.12, gain: 0.18 },
    { kind: 'tone', wave: 'triangle', from: 659, to: 659, start: 0.12, duration: 0.12, gain: 0.18 },
    { kind: 'tone', wave: 'triangle', from: 784, to: 784, start: 0.24, duration: 0.12, gain: 0.18 },
    {
      kind: 'tone',
      wave: 'triangle',
      from: 1046,
      to: 1046,
      start: 0.36,
      duration: 0.28,
      gain: 0.2,
    },
  ],
  LOSE: [
    { kind: 'tone', wave: 'sawtooth', from: 420, to: 150, start: 0, duration: 0.35, gain: 0.16 },
    { kind: 'tone', wave: 'sine', from: 210, to: 90, start: 0.22, duration: 0.3, gain: 0.14 },
  ],
  CHAOS: [
    { kind: 'tone', wave: 'square', from: 220, to: 880, start: 0, duration: 0.18, gain: 0.16 },
    { kind: 'noise', start: 0.14, duration: 0.24, gain: 0.16, filterFrom: 900, filterTo: 3200 },
    { kind: 'tone', wave: 'square', from: 760, to: 260, start: 0.24, duration: 0.22, gain: 0.15 },
  ],
  MINIGAME: [
    { kind: 'tone', wave: 'sine', from: 784, to: 784, start: 0, duration: 0.08, gain: 0.16 },
    { kind: 'tone', wave: 'sine', from: 988, to: 988, start: 0.08, duration: 0.08, gain: 0.16 },
    { kind: 'tone', wave: 'sine', from: 1175, to: 1175, start: 0.16, duration: 0.14, gain: 0.16 },
  ],
};

export interface SfxPlayer {
  play(kind: SfxKind): void;
  /** Unlocks the context from a user gesture; safe to call repeatedly. */
  resume(): Promise<void>;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

export interface SfxPlayerOptions {
  /** Test seam: return `null` when Web Audio is unavailable. */
  createContext?: () => AudioContext | null;
  initialVolume?: number;
  initialMuted?: boolean;
}

type AudioContextConstructor = new () => AudioContext;

function defaultContext(): AudioContext | null {
  const scope = globalThis as {
    AudioContext?: AudioContextConstructor;
    webkitAudioContext?: AudioContextConstructor;
  };
  const Constructor = scope.AudioContext ?? scope.webkitAudioContext;
  if (Constructor === undefined) return null;
  try {
    return new Constructor();
  } catch {
    return null;
  }
}

/**
 * A player that degrades to silence when Web Audio is missing (older browsers,
 * jsdom, or a blocked context). Nothing in the game may depend on a sound
 * having played.
 */
export function createSfxPlayer(options: SfxPlayerOptions = {}): SfxPlayer {
  const create = options.createContext ?? defaultContext;
  let context: AudioContext | null = null;
  let master: GainNode | null = null;
  let volume = options.initialVolume ?? 0.8;
  let muted = options.initialMuted ?? false;
  let failed = false;

  const ensure = (): { context: AudioContext; master: GainNode } | null => {
    if (failed) return null;
    if (context !== null && master !== null) return { context, master };
    const created = create();
    if (created === null) {
      failed = true;
      return null;
    }
    context = created;
    master = created.createGain();
    master.gain.value = muted ? 0 : volume;
    master.connect(created.destination);
    return { context, master };
  };

  const schedule = (ctx: AudioContext, destination: GainNode, step: Step): void => {
    const startAt = ctx.currentTime + step.start;
    const endAt = startAt + step.duration;
    const envelope = ctx.createGain();
    envelope.gain.setValueAtTime(0.0001, startAt);
    envelope.gain.exponentialRampToValueAtTime(
      Math.max(step.gain, 0.0002),
      startAt + step.duration * 0.15,
    );
    envelope.gain.exponentialRampToValueAtTime(0.0001, endAt);
    envelope.connect(destination);

    if (step.kind === 'tone') {
      const oscillator = ctx.createOscillator();
      oscillator.type = step.wave;
      oscillator.frequency.setValueAtTime(step.from, startAt);
      if (step.to !== step.from) {
        oscillator.frequency.exponentialRampToValueAtTime(Math.max(step.to, 1), endAt);
      }
      oscillator.connect(envelope);
      oscillator.start(startAt);
      oscillator.stop(endAt + 0.02);
      return;
    }

    const frames = Math.max(1, Math.floor(ctx.sampleRate * step.duration));
    const buffer = ctx.createBuffer(1, frames, ctx.sampleRate);
    const channel = buffer.getChannelData(0);
    for (let index = 0; index < frames; index += 1) {
      channel[index] = Math.random() * 2 - 1;
    }
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    const filter = ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(step.filterFrom, startAt);
    filter.frequency.exponentialRampToValueAtTime(Math.max(step.filterTo, 40), endAt);
    source.connect(filter);
    filter.connect(envelope);
    source.start(startAt);
    source.stop(endAt + 0.02);
  };

  return {
    play(kind) {
      const live = ensure();
      if (live === null) return;
      const recipe = RECIPES[kind];
      for (const step of recipe) schedule(live.context, live.master, step);
    },
    async resume() {
      const live = ensure();
      if (live === null) return;
      if (live.context.state === 'suspended') {
        try {
          await live.context.resume();
        } catch {
          // A rejected resume just means no sound until the next gesture.
        }
      }
    },
    setVolume(next) {
      volume = Math.min(Math.max(next, 0), 1);
      if (master !== null && !muted) master.gain.value = volume;
    },
    setMuted(next) {
      muted = next;
      if (master !== null) master.gain.value = muted ? 0 : volume;
    },
    dispose() {
      if (context !== null) {
        void context.close().catch(() => undefined);
      }
      context = null;
      master = null;
    },
  };
}
