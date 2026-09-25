#!/usr/bin/env node
/**
 * Run the procedural asset build.
 *
 * Blender is not on PATH on the development machine, and the CI runner installs
 * it somewhere else entirely, so the binary is resolved in one place:
 *
 *   1. `BLENDER_BIN` if set (the supported override, and what CI exports),
 *   2. `blender` on PATH,
 *   3. the Windows install directory as a last resort.
 *
 * The child is spawned with an argument list and no shell, so paths containing
 * spaces and the MSYS `/c` rewriting that breaks `cmd.exe /c` in Git Bash are
 * both non-issues.
 */

import { spawnSync } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import process from 'node:process';

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const REQUIRED_MAJOR_MINOR = '5.2';

/** Candidate executables, in priority order. */
function blenderCandidates() {
  const candidates = [];
  if (process.env.BLENDER_BIN) candidates.push(process.env.BLENDER_BIN);

  const onPath = process.platform === 'win32' ? 'blender.exe' : 'blender';
  for (const directory of (process.env.PATH ?? '').split(path.delimiter)) {
    if (directory) candidates.push(path.join(directory, onPath));
  }

  if (process.platform === 'win32') {
    candidates.push('D:\\Blender\\blender.exe');
  }
  return candidates;
}

function findBlender() {
  for (const candidate of blenderCandidates()) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      continue;
    }
  }
  return null;
}

function blenderVersion(binary) {
  const result = spawnSync(binary, ['--version'], { encoding: 'utf8' });
  if (result.status !== 0 || typeof result.stdout !== 'string') return null;
  const match = /Blender\s+(\d+\.\d+\.\d+)/.exec(result.stdout);
  return match ? match[1] : null;
}

function main() {
  const binary = findBlender();
  if (binary === null) {
    console.error(
      'blender not found. Set BLENDER_BIN to the executable, or install Blender ' +
        `${REQUIRED_MAJOR_MINOR} and put it on PATH.`,
    );
    return 1;
  }

  const version = blenderVersion(binary);
  if (version === null) {
    console.error(`could not read the Blender version from ${binary}`);
    return 1;
  }
  if (!version.startsWith(`${REQUIRED_MAJOR_MINOR}.`)) {
    console.error(
      `expected Blender ${REQUIRED_MAJOR_MINOR}.x, found ${version} at ${binary}. ` +
        'The scenes are generated for a pinned version; update the pin deliberately.',
    );
    return 1;
  }

  const config = JSON.parse(readFileSync(path.join(REPO_ROOT, 'assets.config.json'), 'utf8'));
  const seed = process.env.ASSET_SEED ?? '20260925';
  const outDir = process.env.ASSET_OUT ?? 'public/models';
  const args = [
    '--background',
    '--factory-startup',
    '-noaudio',
    '--python-exit-code',
    '1',
    '--python',
    'scripts/build_assets.py',
    '--',
    '--config',
    'assets.config.json',
    '--out',
    outDir,
    '--seed',
    seed,
  ];
  if (process.env.ASSET_ONLY) args.push('--only', process.env.ASSET_ONLY);

  console.log(`blender ${version} at ${binary}`);
  const result = spawnSync(binary, args, { cwd: REPO_ROOT, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`asset build failed with exit code ${result.status ?? 'null'}`);
    return result.status ?? 1;
  }

  const manifestPath = path.join(REPO_ROOT, outDir, config.manifestName);
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const total = manifest.assets.reduce((sum, asset) => sum + asset.bytes, 0);
  const oversized = manifest.assets.filter((asset) => asset.bytes > config.budgets.maxAssetBytes);

  console.log(`${manifest.assets.length} assets, ${(total / 1024).toFixed(1)} KiB total`);
  if (oversized.length > 0) {
    console.error(
      `over the per-asset budget (${config.budgets.maxAssetBytes} B): ` +
        oversized.map((asset) => `${asset.key}=${asset.bytes}`).join(', '),
    );
    return 1;
  }
  if (total > config.budgets.maxTotalBytes) {
    console.error(`over the total budget (${config.budgets.maxTotalBytes} B): ${total} B`);
    return 1;
  }
  return 0;
}

process.exit(main());
