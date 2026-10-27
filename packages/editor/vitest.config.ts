import { defineConfig, type Plugin } from 'vitest/config';
import { transformAsync } from '@babel/core';
import { reactCompilerPreset } from '@vitejs/plugin-react';

/**
 * B-287 — the app builds every component through the React Compiler (D-091,
 * `app/vite.config.mjs`), and that changes behaviour: it memoizes what a render
 * reads, which also changes WHEN closures and effects observe new values. A
 * DOM test that runs `TimelinePane` uncompiled is not testing the component the
 * app ships, so this package's `.tsx` sources (never the tests themselves) go
 * through the same preset here — the B-282 precedent `packages/motion`'s config
 * set. The compiler leaves TypeScript in place; Vite's own transform strips it
 * next.
 */
const COMPILED_SOURCE = /\/packages\/editor\/src\/[^?]*\.tsx$/;

function reactCompiler(): Plugin {
  return {
    name: 'apelles:react-compiler',
    enforce: 'pre',
    async transform(code, id) {
      if (!COMPILED_SOURCE.test(id) || id.includes('.test.')) return null;
      const out = await transformAsync(code, {
        filename: id,
        babelrc: false,
        configFile: false,
        sourceMaps: true,
        parserOpts: { plugins: ['typescript', 'jsx'] },
        presets: [reactCompilerPreset().preset],
      });
      return out?.code ? { code: out.code, map: out.map } : null;
    },
  };
}

export default defineConfig({
  plugins: [reactCompiler()],
  test: {
    environment: 'node',
  },
});
