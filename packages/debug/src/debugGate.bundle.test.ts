/**
 * The release gate for the debug tooling's frontend half (B-358, D-219): bundle the real
 * `useDebugControl.ts` the way the app does, with `APELLES_DEBUG_TOOLS` off and on, and look at
 * what ships. A release bundle must contain no `debug_*` op name; a debug bundle (`vite dev`,
 * `tauri build --debug`) must contain them, so the Rust ops always find a registry to answer.
 * Also pins `app/perfMarks.mjs`'s `buildDefines` to the Tauri env contract end to end.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build } from 'vite';
import { afterEach, describe, expect, it } from 'vitest';

// @ts-expect-error - plain .mjs build helper shared with the app's vite config, no typings
import { buildDefines } from '../../../app/perfMarks.mjs';

const OP_NAMES = ['debug_pointer', 'debug_perf_entries', 'debug_set_editor_layout'];

const ENTRY = `
import { useDebugControl } from ${JSON.stringify(path.resolve(__dirname, 'index.ts'))};
export default useDebugControl;
`;

async function bundle(define: Record<string, string>): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'debug-gate-'));
  const entry = path.join(dir, 'entry.ts');
  writeFileSync(entry, ENTRY);
  try {
    const out = await build({
      configFile: false,
      logLevel: 'silent',
      define,
      build: { write: false, minify: true, lib: { entry, formats: ['es'], fileName: 'entry' }, rollupOptions: { external: [/^@tauri-apps\//, 'react', /^@apelles\//] } },
    });
    const outputs = Array.isArray(out) ? out : [out];
    return outputs
      .flatMap((o) => ('output' in o ? o.output : []))
      .map((chunk) => ('code' in chunk ? chunk.code : ''))
      .join('\n');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const saved = process.env.TAURI_ENV_DEBUG;
afterEach(() => {
  if (saved === undefined) delete process.env.TAURI_ENV_DEBUG;
  else process.env.TAURI_ENV_DEBUG = saved;
});

describe('debug tooling in a bundle', () => {
  it('a release build (TAURI_ENV_DEBUG=false) contains no debug op name', async () => {
    process.env.TAURI_ENV_DEBUG = 'false';
    const code = await bundle(buildDefines('build'));
    for (const name of OP_NAMES) expect(code, name).not.toContain(name);
  }, 120_000);

  it('a Tauri debug build (TAURI_ENV_DEBUG=true) contains the debug ops', async () => {
    process.env.TAURI_ENV_DEBUG = 'true';
    const code = await bundle(buildDefines('build'));
    for (const name of OP_NAMES) expect(code, name).toContain(name);
  }, 120_000);
});
