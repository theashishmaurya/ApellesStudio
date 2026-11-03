// @apelles/bridge — the frontend↔backend boundary ratchet (D-447).
//
// What it is: a repo scan that fails when a source file outside
// `packages/bridge/` imports `@tauri-apps/*` directly and is not on the
// committed allowlist (`tauriImportAllowlist.json`, the files that already
// did on 2026-11-03).
//
// Why: every backend call should go through one typed seam, so the transport
// (Tauri IPC today, HTTP / WebSocket later, roadmap 00i) can be swapped
// without touching the UI. New code adds a typed binding here instead of
// calling `invoke` itself.
//
// What it does NOT do: it doesn't check *what* bridge exposes, and it doesn't
// scan tests (they mock `@tauri-apps/*` freely). The allowlist only shrinks.
// A file that no longer imports Tauri must be removed from it, so the debt
// count stays honest.
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import allowlist from './tauriImportAllowlist.json';

const REPO_ROOT = resolve(__dirname, '../../..');
const SCAN_ROOTS = ['app/src', 'packages'];
const SOURCE_FILE = /\.(ts|tsx)$/;
const TEST_FILE = /\.test\.tsx?$/;
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'coverage']);
const BRIDGE_PREFIX = 'packages/bridge/';
const TAURI_IMPORT = /(?:from\s+|import\s*\(\s*)['"]@tauri-apps\//;

function walk(dir: string, out: string[]): void {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name), out);
    } else if (SOURCE_FILE.test(entry.name) && !TEST_FILE.test(entry.name)) {
      out.push(join(dir, entry.name));
    }
  }
}

function directTauriImporters(): string[] {
  const files: string[] = [];
  for (const root of SCAN_ROOTS) walk(join(REPO_ROOT, root), files);
  return files
    .map((file) => relative(REPO_ROOT, file))
    .filter((file) => !file.startsWith(BRIDGE_PREFIX))
    // Only each package's own `src/` is product code.
    .filter((file) => file.startsWith('app/src/') || /^packages\/[^/]+\/src\//.test(file))
    .filter((file) => TAURI_IMPORT.test(readFileSync(join(REPO_ROOT, file), 'utf8')))
    .sort();
}

describe('frontend↔backend boundary (D-447)', () => {
  const found = directTauriImporters();
  const allowed = new Set<string>(allowlist);

  it('adds no new direct @tauri-apps import outside @apelles/bridge', () => {
    const added = found.filter((file) => !allowed.has(file));
    expect(
      added,
      'Call the backend through a typed binding in @apelles/bridge instead of importing @tauri-apps/* here (D-447, roadmap 00i)',
    ).toEqual([]);
  });

  it('keeps the allowlist honest: files that no longer import Tauri are removed from it', () => {
    const present = new Set(found);
    const stale = [...allowed].filter((file) => !present.has(file));
    expect(stale, 'Remove these from tauriImportAllowlist.json; the debt went down').toEqual([]);
  });
});
