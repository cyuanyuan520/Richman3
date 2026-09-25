import { QUALITY_LEVELS, type Quality } from '@/engine/contracts/primitives';

/**
 * Quality tiers only touch presentation (GUD-010): shadows, device pixel ratio
 * and antialiasing. Nothing here may change rules or timing.
 */
export interface QualityPreset {
  readonly level: Quality;
  readonly antialias: boolean;
  readonly shadows: boolean;
  /** Upper bound handed to `Canvas`'s `dpr`. */
  readonly maxDpr: number;
  readonly shadowMapSize: number;
  readonly toneMappingExposure: number;
}

const PRESETS: Record<Quality, QualityPreset> = {
  LOW: {
    level: 'LOW',
    antialias: false,
    shadows: false,
    maxDpr: 1,
    shadowMapSize: 512,
    toneMappingExposure: 1,
  },
  MEDIUM: {
    level: 'MEDIUM',
    antialias: true,
    shadows: true,
    maxDpr: 1.5,
    shadowMapSize: 1024,
    toneMappingExposure: 1.05,
  },
  HIGH: {
    level: 'HIGH',
    antialias: true,
    shadows: true,
    maxDpr: 2,
    shadowMapSize: 2048,
    toneMappingExposure: 1.1,
  },
};

export { QUALITY_LEVELS };

export const QUALITY_LABELS: Record<Quality, string> = {
  LOW: '省电',
  MEDIUM: '标准',
  HIGH: '高画质',
};

export function qualityPreset(level: Quality): QualityPreset {
  return PRESETS[level] ?? PRESETS.MEDIUM;
}

export const QUALITY_VALUES: readonly Quality[] = QUALITY_LEVELS;
