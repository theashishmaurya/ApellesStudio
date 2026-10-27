import { defineConfig, type Plugin } from 'vitest/config';
import { transformAsync } from '@babel/core';
import { reactCompilerPreset } from '@vitejs/plugin-react';

/**
 * B-282 — the app builds every component through the React Compiler (D-091,
 * `app/vite.config.mjs`), and that changes behavior: it memoizes what a render
 * reads, so a component reading mutable outside state during render works
 * uncompiled and goes stale compiled. A test of such a component that runs it
 * uncompiled proves nothing about the app, so this package's and the engine's
 * `.tsx` sources (never the tests themselves) go through the same preset here.
 * The compiler leaves TypeScript in place; Vite's own transform strips it next.
 */
const COMPILED_SOURCE = /\/packages\/motion(-engine)?\/src\/[^?]*\.tsx$/;

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
