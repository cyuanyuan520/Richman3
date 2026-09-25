/**
 * Guards the generated asset manifest against the content that references it.
 *
 * These assertions need no Blender: they check that what was committed covers
 * every model and portrait the shipped content declares, that the files are
 * really on disk at the recorded size, and that the size budgets hold. The
 * deeper structural rebuild check lives in `scripts/check-assets.mjs`.
 *
 * Both JSON files are parsed through Zod rather than cast, so a malformed build
 * config or manifest fails with a readable issue list instead of `undefined`
 * comparisons.
 */

import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';
import { z } from 'zod';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');

const BuildConfigSchema = z.object({
  themeTokens: z.string().min(1),
  manifestName: z.string().min(1),
  sources: z.object({
    map: z.string().min(1),
    characters: z.string().min(1),
  }),
  budgets: z.object({
    maxTotalBytes: z.number().int().positive(),
    maxAssetBytes: z.number().int().positive(),
  }),
});

const MeshAssetSchema = z.object({
  key: z.string().min(1),
  glbPath: z.string().min(1),
  bytes: z.number().int().positive(),
  scale: z.number().positive(),
  tags: z.array(z.string()),
  animated: z.boolean(),
  vertices: z.number().int().positive(),
  triangles: z.number().int().positive(),
  materials: z.array(z.string()).min(1),
  bounds: z.tuple([z.number().positive(), z.number().positive(), z.number().positive()]),
});

const PortraitAssetSchema = z.object({
  key: z.string().min(1),
  pngPath: z.string().min(1),
  bytes: z.number().int().positive(),
  scale: z.number().positive(),
  tags: z.array(z.string()),
  animated: z.boolean(),
});

const ManifestSchema = z.object({
  version: z.literal(1),
  seed: z.number().int(),
  blender: z.string().regex(/^5\.2\.\d+/),
  assets: z.array(z.union([MeshAssetSchema, PortraitAssetSchema])),
});

const MapAssetsSchema = z.object({ assets: z.array(z.string().min(1)) });
const CharactersSchema = z.array(
  z.object({ modelRef: z.string().min(1), portraitRef: z.string().min(1) }),
);

function readJson<T>(relative: string, schema: z.ZodType<T>): T {
  const raw: unknown = JSON.parse(readFileSync(path.join(REPO_ROOT, relative), 'utf8'));
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${relative} is malformed:\n${JSON.stringify(parsed.error.issues, null, 2)}`);
  }
  return parsed.data;
}

const config = readJson('assets.config.json', BuildConfigSchema);
const manifest = readJson(path.join('public/models', config.manifestName), ManifestSchema);
const byKey = new Map(manifest.assets.map((asset) => [asset.key, asset]));

/** Every model and portrait the shipped content says must exist. */
function declaredKeys(): string[] {
  const keys = new Set<string>(readJson(config.sources.map, MapAssetsSchema).assets);
  for (const character of readJson(config.sources.characters, CharactersSchema)) {
    keys.add(character.modelRef);
    keys.add(character.portraitRef);
  }
  return [...keys].sort();
}

function assetPath(asset: (typeof manifest.assets)[number]): string {
  return 'glbPath' in asset ? asset.glbPath : asset.pngPath;
}

describe('asset manifest', () => {
  it('covers exactly the assets the content declares', () => {
    expect([...byKey.keys()].sort()).toEqual(declaredKeys());
  });

  it('has no duplicate keys', () => {
    expect(byKey.size).toBe(manifest.assets.length);
  });

  it('records a pinned Blender version and seed', () => {
    expect(manifest.blender).toMatch(/^5\.2\.\d+/);
    expect(Number.isInteger(manifest.seed)).toBe(true);
  });

  it('points every entry at a file that exists at the recorded size', () => {
    for (const asset of manifest.assets) {
      const relative = assetPath(asset);
      const absolute = path.join(REPO_ROOT, relative);
      expect(existsSync(absolute), `${asset.key} missing at ${relative}`).toBe(true);
      expect(statSync(absolute).size, `${asset.key} size drifted`).toBe(asset.bytes);
    }
  });

  it('stays inside the declared size budgets', () => {
    const total = manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
    expect(total).toBeLessThanOrEqual(config.budgets.maxTotalBytes);
    for (const asset of manifest.assets) {
      expect(asset.bytes, `${asset.key} exceeds the per-asset budget`).toBeLessThanOrEqual(
        config.budgets.maxAssetBytes,
      );
    }
  });

  it('labels every character and portrait with its archetype', () => {
    for (const key of declaredKeys()) {
      const asset = byKey.get(key);
      if (asset === undefined) continue;
      if (key.startsWith('char_') || key.startsWith('portrait_')) {
        const archetype = key.replace(/^(char|portrait)_/, '');
        expect(asset.tags, `${key} is missing its archetype tag`).toContain(
          `archetype:${archetype}`,
        );
      }
    }
  });

  it('tags the four property upgrade levels', () => {
    for (const level of [1, 2, 3, 4]) {
      expect(byKey.get(`city.house_${level}`)?.tags).toContain(`level:${level}`);
    }
  });
});

describe('committed binaries', () => {
  it('are valid glTF 2.0 containers whose declared length matches the file', () => {
    for (const asset of manifest.assets) {
      if (!('glbPath' in asset)) continue;
      const bytes = readFileSync(asset.glbPath);
      expect(bytes.toString('ascii', 0, 4), asset.key).toBe('glTF');
      expect(bytes.readUInt32LE(4), asset.key).toBe(2);
      expect(bytes.readUInt32LE(8), asset.key).toBe(bytes.length);
    }
  });

  it('are valid PNGs for every portrait', () => {
    const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    for (const asset of manifest.assets) {
      if (!('pngPath' in asset)) continue;
      const bytes = readFileSync(asset.pngPath);
      expect(bytes.subarray(0, 8).equals(signature), asset.key).toBe(true);
    }
  });
});
