/**
 * The release gate for the perf marks (D-437 S0a): bundle the real `editPerf.ts` the
 * way the app does, with the define off and on, and look at what ships. A release
 * bundle must contain no `apelles:edit:` string (the helpers stay as inert branches
 * behind a constant-false guard); a debug one must contain the names and the call.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { build } from 'vite';
import { describe, expect, it } from 'vitest';

const DEFINE_KEY = 'import.meta.env.APELLES_PERF_MARKS';

const ENTRY = `
import { EDIT_PERF, perfMark, perfMeasureAfterPaint } from ${JSON.stringify(path.resolve(__dirname, 'editPerf.ts'))};
perfMark(EDIT_PERF.commit);
perfMeasureAfterPaint(EDIT_PERF.commitPainted, EDIT_PERF.commit);
`;

async function bundle(marks: boolean): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), 'perf-marks-'));
  const entry = path.join(dir, 'entry.ts');
  writeFileSync(entry, ENTRY);
  const out = await build({
    configFile: false,
    logLevel: 'silent',
    define: { [DEFINE_KEY]: JSON.stringify(String(marks)) },
    build: { write: false, minify: true, lib: { entry, formats: ['es'], fileName: 'entry' } },
  });
  rmSync(dir, { recursive: true, force: true });
  const outputs = Array.isArray(out) ? out : [out];
  return outputs
    .flatMap((o) => ('output' in o ? o.output : []))
    .map((chunk) => ('code' in chunk ? chunk.code : ''))
    .join('\n');
}

describe('perf marks in a bundle', () => {
  it('a release bundle (marks off) contains no apelles:edit: string and a constant-false guard', async () => {
    const code = await bundle(false);
    expect(code).not.toContain('apelles:edit:');
    // the helpers survive as inert branches behind a constant-false guard (a few bytes)
    expect(code).toMatch(/=\s*\(\)\s*=>\s*!1/);
  }, 60_000);

  it('a debug bundle (marks on) contains the names and the mark call', async () => {
    const code = await bundle(true);
    expect(code).toContain('apelles:edit:commit-painted');
    expect(code).toContain('performance.mark');
  }, 60_000);
});
