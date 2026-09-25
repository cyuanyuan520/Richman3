/**
 * Background music uses the two tracks committed under `public/bgm` (REQ-019).
 * Per CON-015 the files total ~8.6 MB, so the element is only created on the
 * first play request — never during boot — and any failure is silent.
 */

export const BGM_TRACKS = ['/bgm/double-sixes.mp3', '/bgm/top-hat-and-thimble.mp3'] as const;

export type BgmTrack = (typeof BGM_TRACKS)[number];

export const BGM_TRACK_LABELS: Record<BgmTrack, string> = {
  '/bgm/double-sixes.mp3': '双六进行曲',
  '/bgm/top-hat-and-thimble.mp3': '礼帽与顶针',
};

export interface BgmPlayer {
  /** True once an audio element has actually been created. */
  isLoaded(): boolean;
  current(): BgmTrack | null;
  /** Creates the element on demand; a rejected play() is swallowed. */
  play(track?: BgmTrack): void;
  pause(): void;
  setVolume(volume: number): void;
  setMuted(muted: boolean): void;
  dispose(): void;
}

export interface BgmPlayerOptions {
  /** Test seam; must mirror the production defaults when omitted. */
  createAudio?: (src: string) => HTMLAudioElement;
  initialVolume?: number;
  initialMuted?: boolean;
}

function defaultAudio(src: string): HTMLAudioElement {
  const element = new Audio(src);
  element.preload = 'auto';
  element.loop = true;
  return element;
}

export function createBgmPlayer(options: BgmPlayerOptions = {}): BgmPlayer {
  const create = options.createAudio ?? defaultAudio;
  let element: HTMLAudioElement | null = null;
  let track: BgmTrack | null = null;
  let volume = options.initialVolume ?? 0.6;
  let muted = options.initialMuted ?? false;

  const applyVolume = (): void => {
    if (element !== null) element.volume = muted ? 0 : volume;
  };

  return {
    isLoaded: () => element !== null,
    current: () => track,
    play(next) {
      const wanted = next ?? track ?? BGM_TRACKS[0];
      if (element === null || track !== wanted) {
        element?.pause();
        const created = create(wanted);
        // Set on every element, not just the default factory's, so a injected
        // factory cannot silently produce a non-looping track.
        created.loop = true;
        created.preload = 'auto';
        element = created;
        track = wanted;
      }
      applyVolume();
      try {
        void element.play().catch(() => undefined);
      } catch {
        // Autoplay policies reject before a gesture; the next call retries.
      }
    },
    pause() {
      element?.pause();
    },
    setVolume(next) {
      volume = Math.min(Math.max(next, 0), 1);
      applyVolume();
    },
    setMuted(next) {
      muted = next;
      applyVolume();
    },
    dispose() {
      element?.pause();
      element = null;
      track = null;
    },
  };
}
