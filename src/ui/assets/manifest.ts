import { z } from 'zod';

/**
 * The Blender pipeline writes `public/models/assets.manifest.json`; this module
 * is the single place the browser reads it. Paths in the manifest are
 * repository-relative, so they are rewritten to fetchable URLs here rather than
 * being duplicated in the JSON.
 */

/**
 * Meshes and portraits are different shapes: a mesh carries geometry stats and
 * a `glbPath`, a portrait carries only a `pngPath`. Modelling them as a union
 * rather than one permissive object is what makes the checker honest, and the
 * E2E run is what caught it when this module assumed every entry had a
 * `glbPath`.
 */
const MeshEntrySchema = z.object({
  key: z.string().min(1),
  glbPath: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  scale: z.number().positive(),
  tags: z.array(z.string()),
  animated: z.boolean(),
  animations: z.array(z.string()),
  vertices: z.number().int().nonnegative(),
  triangles: z.number().int().nonnegative(),
  materials: z.array(z.string()),
  bounds: z.tuple([z.number(), z.number(), z.number()]),
});

const PortraitEntrySchema = z.object({
  key: z.string().min(1),
  pngPath: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  scale: z.number().positive(),
  tags: z.array(z.string()),
  animated: z.boolean(),
  animations: z.array(z.string()),
});

const AssetEntrySchema = z.union([MeshEntrySchema, PortraitEntrySchema]);

export const AssetManifestSchema = z.object({
  version: z.literal(1),
  seed: z.number().int(),
  blender: z.string().min(1),
  assets: z.array(AssetEntrySchema),
});

export type MeshAsset = z.infer<typeof MeshEntrySchema>;
export type PortraitAsset = z.infer<typeof PortraitEntrySchema>;
export type AssetEntry = z.infer<typeof AssetEntrySchema>;
export type AssetManifest = z.infer<typeof AssetManifestSchema>;

export function isMeshAsset(asset: AssetEntry): asset is MeshAsset {
  return 'glbPath' in asset;
}

/** The fetchable URL for whichever file an entry points at. */
export function assetUrl(asset: AssetEntry): string {
  return webPath(isMeshAsset(asset) ? asset.glbPath : asset.pngPath);
}

export const MANIFEST_URL = '/models/assets.manifest.json';

/** `public/models/x.glb` is served at `/models/x.glb`. */
export function webPath(glbPath: string): string {
  return glbPath.replace(/^public\//, '/');
}

export class ManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ManifestError';
  }
}

export function parseManifest(raw: unknown): AssetManifest {
  const parsed = AssetManifestSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`);
    throw new ManifestError(`asset manifest is invalid\n${issues.join('\n')}`);
  }
  const keys = new Set<string>();
  for (const asset of parsed.data.assets) {
    if (keys.has(asset.key)) throw new ManifestError(`duplicate asset key: ${asset.key}`);
    keys.add(asset.key);
  }
  return parsed.data;
}

export function assetByKey(manifest: AssetManifest, key: string): AssetEntry | undefined {
  return manifest.assets.find((asset) => asset.key === key);
}

export interface LoadManifestOptions {
  fetchImpl?: typeof fetch;
  url?: string;
}

export async function loadManifest(options: LoadManifestOptions = {}): Promise<AssetManifest> {
  const doFetch = options.fetchImpl ?? fetch;
  const url = options.url ?? MANIFEST_URL;
  const response = await doFetch(url);
  if (!response.ok) {
    throw new ManifestError(`could not load ${url} (HTTP ${response.status})`);
  }
  return parseManifest(await response.json());
}

/** Keys the board needs: every ring tile model plus the dice. */
export function boardModelKeys(
  manifest: AssetManifest,
  tileModelRefs: readonly string[],
): string[] {
  const wanted = new Set<string>(tileModelRefs);
  wanted.add('city.dice');
  return manifest.assets
    .filter(
      (asset) =>
        wanted.has(asset.key) && (asset.tags.includes('tile') || asset.key === 'city.dice'),
    )
    .map((asset) => asset.key);
}
