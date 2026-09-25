#!/usr/bin/env node
/**
 * Structural idempotency check for the generated asset kit.
 *
 * Byte-for-byte GLB comparison is not a usable guarantee: float formatting and
 * exporter internals differ between Blender builds and platforms. What must stay
 * stable is the *shape* of what is produced — the asset set, triangle and vertex
 * counts, materials, rounded bounds and tags. This rebuilds into a scratch
 * directory and compares exactly those fields against the committed manifest.
 *
 * Requires Blender. The manifest-only guard that runs in the normal test suite
 * is `tests/assets.test.ts`; this script is the deeper check CI runs.
 */

import { spawnSync } from 'node:child_process';
import { readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const COMMITTED = path.join(REPO_ROOT, 'public/models/assets.manifest.json');
const SCRATCH = '.tmp/assets-check';

const STRUCTURAL_FIELDS = [
  'key',
  'scale',
  'tags',
  'animated',
  'animations',
  'vertices',
  'triangles',
  'materials',
  'bounds',
];

function fingerprint(asset) {
  const picked = {};
  for (const field of STRUCTURAL_FIELDS) {
    picked[field] = asset[field] ?? null;
  }
  return JSON.stringify(picked);
}

function main() {
  const committed = JSON.parse(readFileSync(COMMITTED, 'utf8'));

  rmSync(path.join(REPO_ROOT, SCRATCH), { recursive: true, force: true });
  const build = spawnSync(process.execPath, ['scripts/build-models.mjs'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
    env: { ...process.env, ASSET_OUT: SCRATCH },
  });
  if (build.status !== 0) {
    console.error(`rebuild into ${SCRATCH} failed`);
    return build.status ?? 1;
  }

  const rebuilt = JSON.parse(
    readFileSync(path.join(REPO_ROOT, SCRATCH, 'assets.manifest.json'), 'utf8'),
  );

  const failures = [];
  if (rebuilt.seed !== committed.seed) {
    failures.push(`seed drifted: ${committed.seed} -> ${rebuilt.seed}`);
  }
  if (rebuilt.blender !== committed.blender) {
    failures.push(`Blender version drifted: ${committed.blender} -> ${rebuilt.blender}`);
  }

  const before = new Map(committed.assets.map((asset) => [asset.key, asset]));
  const after = new Map(rebuilt.assets.map((asset) => [asset.key, asset]));
  for (const key of before.keys()) {
    if (!after.has(key)) failures.push(`asset disappeared: ${key}`);
  }
  for (const key of after.keys()) {
    if (!before.has(key)) failures.push(`asset appeared: ${key}`);
  }
  for (const [key, asset] of before) {
    const next = after.get(key);
    if (next === undefined) continue;
    if (fingerprint(asset) !== fingerprint(next)) {
      failures.push(
        `structure changed for ${key}:\n    committed ${fingerprint(asset)}\n    rebuilt   ${fingerprint(next)}`,
      );
    }
  }

  rmSync(path.join(REPO_ROOT, SCRATCH), { recursive: true, force: true });

  if (failures.length > 0) {
    console.error(`asset drift detected (${failures.length}):`);
    for (const failure of failures) console.error(`  - ${failure}`);
    console.error('Run `pnpm build:models` and commit the regenerated assets.');
    return 1;
  }
  console.log(`assets are structurally identical (${before.size} assets, ${committed.blender})`);
  return 0;
}

process.exit(main());
