/**
 * The shipped content pack (REQ-006, REQ-013, REQ-022, REQ-023).
 *
 * Content is authored as JSON so a new map is a data change, never an engine
 * change. This module is the single boundary where raw JSON becomes typed
 * contract data: zod parses it, `validateContentPack` runs the semantic and
 * topological rules, and both fail loudly so a broken pack can never ship.
 */

import type { z } from 'zod';
import { ThemeTokensSchema, type ThemeTokens } from '../engine/contracts/config';
import {
  ContentPackSchema,
  validateContentPack,
  type Character,
  type ChaosEvent,
  type ContentPack,
  type MapDefinition,
  type MiniGameDefinition,
} from '../engine/contracts/content';
import charactersRaw from './data/characters.json';
import chaosEventsRaw from './data/chaos-events.json';
import miniGamesRaw from './data/minigames.json';
import cityMetroRaw from './data/maps/city-metro.json';
import themeRaw from './data/theme.json';

/** Raw JSON as imported, kept together so callers can validate a whole pack. */
export function defaultContentPackRaw(): unknown {
  return {
    characters: charactersRaw,
    chaosEvents: chaosEventsRaw,
    miniGames: miniGamesRaw,
    maps: [cityMetroRaw],
  };
}

function formatIssues(issues: readonly z.core.$ZodIssue[]): string {
  return issues
    .map((issue) => `${issue.path.map(String).join('.') || '<root>'}: ${issue.message}`)
    .join('; ');
}

/** Schema-level validation. Throws with every zod issue listed. */
export function parseContentPack(raw: unknown): ContentPack {
  const result = ContentPackSchema.safeParse(raw);
  if (!result.success) {
    throw new Error(
      `content pack failed schema validation -> ${formatIssues(result.error.issues)}`,
    );
  }
  return result.data;
}

/** Semantic + topological validation. Returns every issue found. */
export function collectContentIssues(pack: ContentPack): string[] {
  return validateContentPack(pack);
}

/**
 * Parses and semantically validates a pack, throwing on the first problem
 * class. Content is static and CI-checked, so failing fast at import time is
 * preferable to shipping a map that silently does nothing.
 */
export function buildContentPack(raw: unknown): ContentPack {
  const pack = parseContentPack(raw);
  const issues = collectContentIssues(pack);
  if (issues.length > 0) {
    throw new Error(`content pack failed validation:\n- ${issues.join('\n- ')}`);
  }
  return pack;
}

export const CONTENT_PACK: ContentPack = buildContentPack(defaultContentPackRaw());

export const CHARACTERS: readonly Character[] = CONTENT_PACK.characters;
export const CHAOS_EVENTS: readonly ChaosEvent[] = CONTENT_PACK.chaosEvents;
export const MINI_GAMES: readonly MiniGameDefinition[] = CONTENT_PACK.miniGames;
export const MAPS: readonly MapDefinition[] = CONTENT_PACK.maps;

const firstMap = CONTENT_PACK.maps[0];
if (firstMap === undefined) {
  throw new Error('content pack contains no maps');
}
/** The launch map. `ContentPackSchema` guarantees at least one entry. */
export const CITY_METRO: MapDefinition = firstMap;

export const THEME_TOKENS: ThemeTokens = ((): ThemeTokens => {
  const result = ThemeTokensSchema.safeParse(themeRaw);
  if (!result.success) {
    throw new Error(
      `theme tokens failed schema validation -> ${formatIssues(result.error.issues)}`,
    );
  }
  return result.data;
})();

export type { Character, ChaosEvent, ContentPack, MapDefinition, MiniGameDefinition };
export type { ThemeTokens };
