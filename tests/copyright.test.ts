import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';

const SCRIPT = join(process.cwd(), 'scripts', 'check-copyright.mjs');

function runCheck(root: string) {
  const result = spawnSync(process.execPath, [SCRIPT, '--root', root], { encoding: 'utf8' });
  return { status: result.status, output: `${result.stdout}${result.stderr}` };
}

const tempDirs: string[] = [];

function makeContentRoot(charactersFile: string): string {
  const root = mkdtempSync(join(tmpdir(), 'richman3-copyright-'));
  const dataDir = join(root, 'src', 'content', 'data');
  mkdirSync(dataDir, { recursive: true });
  writeFileSync(join(dataDir, 'characters.json'), charactersFile, 'utf8');
  tempDirs.push(root);
  return root;
}

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

describe('copyright self-check (SEC-007 / AC-037)', () => {
  it('passes on the shipped content pack', () => {
    const { status, output } = runCheck(process.cwd());
    expect(output).toContain('copyright-check: clean');
    expect(status).toBe(0);
  });

  it('fails and names the offending string when a protected name is planted', () => {
    const root = makeContentRoot('[{"name":"元气小妹·糖糖"}]');
    const { status, output } = runCheck(root);
    expect(status).toBe(1);
    expect(output).toContain('protected name(s) found');
    expect(output).toContain('糖糖');
  });

  it('accepts original names that merely look similar', () => {
    const root = makeContentRoot('[{"name":"土伯·阿旺"},{"name":"元气小妹·果果"}]');
    expect(runCheck(root).status).toBe(0);
  });

  it('reports an unreadable data directory instead of passing silently', () => {
    const root = mkdtempSync(join(tmpdir(), 'richman3-copyright-empty-'));
    tempDirs.push(root);
    const { status, output } = runCheck(root);
    expect(status).toBe(1);
    expect(output).toContain('no content data directory');
  });
});
