#!/usr/bin/env node
/**
 * SEC-007 / AC-037 copyright self-check.
 *
 * Scans every string in the shipped content data (`src/content/data/**`) for
 * names owned by the publisher of the classic series this game takes its design
 * language from. The shipped content is original; this guard exists so a future
 * edit cannot quietly reintroduce a protected name.
 *
 * Usage:
 *   node scripts/check-copyright.mjs [--root <dir>]
 *
 * Exit code 0 when clean, 1 when a protected name is found.
 */

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

/** Protected names: the publisher's marks and its character roster. */
export const COPYRIGHT_BLACKLIST = [
  // Publisher marks
  '大宇资讯',
  '大富翁4',
  '大富翁四',
  'Softstar',
  'softstar',
  // Character roster of the referenced classic title
  '阿土伯',
  '孙小美',
  '钱夫人',
  '忍太郎',
  '沙隆巴斯',
  '乌咪',
  '金贝贝',
  '约翰乔',
  '莎拉公主',
  '宫本宝藏',
  '糖糖',
  '小丹尼',
];

/** Returns the blacklist entries present in `text`. */
export function findViolations(text, blacklist = COPYRIGHT_BLACKLIST) {
  return blacklist.filter((name) => text.includes(name));
}

function collectStrings(value, out) {
  if (typeof value === 'string') {
    out.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const entry of value) collectStrings(entry, out);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const entry of Object.values(value)) collectStrings(entry, out);
  }
}

function listJsonFiles(dir) {
  const found = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      found.push(...listJsonFiles(full));
    } else if (entry.endsWith('.json')) {
      found.push(full);
    }
  }
  return found;
}

function main() {
  const rootIndex = process.argv.indexOf('--root');
  const root = rootIndex === -1 ? process.cwd() : (process.argv[rootIndex + 1] ?? process.cwd());
  const dataDir = join(root, 'src', 'content', 'data');

  let files;
  try {
    files = listJsonFiles(dataDir);
  } catch {
    console.error(`copyright-check: no content data directory at ${dataDir}`);
    process.exitCode = 1;
    return;
  }

  const violations = [];
  let scanned = 0;
  for (const file of files) {
    const strings = [];
    collectStrings(JSON.parse(readFileSync(file, 'utf8')), strings);
    scanned += strings.length;
    for (const text of strings) {
      for (const name of findViolations(text)) {
        violations.push({ file: relative(root, file), name, text });
      }
    }
  }

  if (violations.length > 0) {
    console.error(`copyright-check: ${String(violations.length)} protected name(s) found`);
    for (const violation of violations) {
      console.error(`  ${violation.file}: "${violation.name}" in "${violation.text}"`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(
    `copyright-check: clean (${String(scanned)} strings in ${String(files.length)} files)`,
  );
}

main();
