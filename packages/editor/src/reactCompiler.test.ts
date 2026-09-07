/**
 * @chroma/editor — a build-quality guard, not a behavior test (D-201).
 *
 * The React Compiler (D-091) auto-memoizes a component only when it can
 * *preserve* every hand-written `useMemo`/`useCallback` already in it. A
 * single dependency array it disagrees with makes it skip the WHOLE component
 * — silently: it logs a bailout line and emits the file uncompiled, so nothing
 * fails, the component just quietly loses all auto-memoization and re-renders
 * the old-fashioned way. `docs/notes/react-compiler-coverage.md` is the real
 * inventory of where that was happening; D-201 cleared it for the two files
 * where it costs the most.
 *
 * This test runs the exact same preset `app/vite.config.mjs` runs, over EVERY
 * source file in this package, and fails if any of them bails out. The whole
 * package is clean as of D-201, so the bar is "keep it that way" rather than a
 * whitelist that would quietly let the hot files drift back.
 *
 * It does NOT check that the compiled output is correct or faster — the
 * compiler's own test suite owns that, and every behavioral guarantee for
 * these files lives in their own tests (`TimelinePane.marquee.dom.test.tsx`,
 * `timeline.test.ts`, `transformGeometry.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transformAsync } from '@babel/core';
import { reactCompilerPreset } from '@vitejs/plugin-react';

/** Every `.ts`/`.tsx` in this package except the tests themselves. Read from
 *  disk rather than listed by hand so a newly-added file is covered the day it
 *  lands, not whenever someone remembers to update a list. */
const SRC_DIR = fileURLToPath(new URL('.', import.meta.url));
const SOURCE_FILES = (await readdir(SRC_DIR))
  .filter((f) => (f.endsWith('.ts') || f.endsWith('.tsx')) && !f.includes('.test.'))
  .sort();

async function bailoutsFor(file: string): Promise<string[]> {
  const filename = fileURLToPath(new URL(file, import.meta.url));
  const code = await readFile(filename, 'utf8');
  const reasons: string[] = [];
  await transformAsync(code, {
    filename,
    babelrc: false,
    configFile: false,
    parserOpts: { plugins: ['typescript', 'jsx'] },
    presets: [
      reactCompilerPreset({
        // Parameter types come from the preset's own `logger` contract by
        // contextual typing — annotating them by hand would mean restating
        // `LoggerEvent`'s whole union here just to read one field off it.
        logger: {
          logEvent(_filename, event) {
            if (event.kind !== 'CompileError') return;
            const detail = (event as { detail?: { reason?: string; description?: string } }).detail;
            reasons.push(detail?.reason ?? detail?.description ?? event.kind);
          },
        },
      }).preset,
    ],
  });
  return [...new Set(reasons)];
}

describe('React Compiler coverage across @chroma/editor (D-201)', () => {
  it('found source files to check', () => {
    expect(SOURCE_FILES.length).toBeGreaterThan(10);
  });

  for (const file of SOURCE_FILES) {
    it(`${file} compiles with no React Compiler bailout`, async () => {
      expect(await bailoutsFor(file)).toEqual([]);
    }, 30_000);
  }
});
