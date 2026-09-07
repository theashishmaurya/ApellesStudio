/**
 * @chroma/editor — a build-quality guard, not a behavior test (D-197).
 *
 * The React Compiler (D-091) auto-memoizes a component only when it can
 * *preserve* every hand-written `useMemo`/`useCallback` already in it. A
 * single dependency array it disagrees with makes it skip the WHOLE component
 * — silently: it logs a bailout line and emits the file uncompiled, so nothing
 * fails, the component just quietly loses all auto-memoization and re-renders
 * the old-fashioned way. `docs/notes/react-compiler-coverage.md` is the real
 * inventory of where that was happening; D-197 cleared it for the two files
 * where it costs the most.
 *
 * This test runs the exact same preset `app/vite.config.mjs` runs, over the
 * Edit tab's highest-update-frequency surfaces, and fails if any of them bails
 * out again. It is deliberately a *whitelist of hot files*, not the whole
 * package: the point is to defend the surfaces where a lost memoization is
 * felt during a drag/scrub, not to freeze the compiler's coverage everywhere.
 *
 * It does NOT check that the compiled output is correct or faster — the
 * compiler's own test suite owns that, and every behavioral guarantee for
 * these files lives in their own tests (`TimelinePane.marquee.dom.test.tsx`,
 * `timeline.test.ts`, `transformGeometry.test.ts`).
 */
import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { transformAsync } from '@babel/core';
import { reactCompilerPreset } from '@vitejs/plugin-react';

/** The files whose auto-memoization we actually defend, and why each is here.
 *  Adding one is cheap; removing one needs a real reason in the commit. */
const HOT_FILES = [
  // Every clip drag, trim, marquee, zoom and scrub tick re-renders this.
  'TimelinePane.tsx',
  // The on-canvas move/scale gesture in the preview — a pointermove-rate
  // component by construction.
  'TransformOverlay.tsx',
];

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

describe('React Compiler coverage on the Edit tab’s hot surfaces (D-197)', () => {
  for (const file of HOT_FILES) {
    it(`${file} compiles with no React Compiler bailout`, async () => {
      expect(await bailoutsFor(file)).toEqual([]);
    }, 30_000);
  }
});
