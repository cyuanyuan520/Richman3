import type { Settings } from '@/engine/contracts/config';

import { BGM_TRACKS, createBgmPlayer, type BgmPlayer, type BgmTrack } from './bgm';
import { createSfxPlayer, type SfxKind, type SfxPlayer } from './sfx';

/**
 * Wires the two audio halves to the persisted settings so a single subscription
 * keeps volume and mute in sync. GUD-008: every synthesis parameter stays inside
 * this module tree.
 */
export interface AudioDirector {
  readonly bgm: BgmPlayer;
  readonly sfx: SfxPlayer;
  /** Call from a user gesture to unlock Web Audio and satisfy autoplay rules. */
  unlock(): void;
  playSfx(kind: SfxKind): void;
  startBgm(track?: BgmTrack): void;
  stopBgm(): void;
  /** Applies volume/mute from a settings snapshot. */
  applySettings(settings: Pick<Settings, 'bgmVolume' | 'sfxVolume' | 'muted'>): void;
  dispose(): void;
}

export interface AudioDirectorOptions {
  bgm?: BgmPlayer;
  sfx?: SfxPlayer;
}

export function createAudioDirector(options: AudioDirectorOptions = {}): AudioDirector {
  const bgm = options.bgm ?? createBgmPlayer();
  const sfx = options.sfx ?? createSfxPlayer();
  let started = false;

  const unlock = (): void => {
    void sfx.resume();
    if (started) bgm.play();
  };

  return {
    bgm,
    sfx,
    unlock,
    playSfx(kind) {
      sfx.play(kind);
    },
    startBgm(track) {
      started = true;
      bgm.play(track ?? BGM_TRACKS[0]);
    },
    stopBgm() {
      started = false;
      bgm.pause();
    },
    applySettings(settings) {
      // BGM and SFX scale independently (REQ-024), and mute silences both.
      bgm.setVolume(settings.bgmVolume);
      sfx.setVolume(settings.sfxVolume);
      bgm.setMuted(settings.muted);
      sfx.setMuted(settings.muted);
    },
    dispose() {
      bgm.dispose();
      sfx.dispose();
    },
  };
}
