import { defineConfig } from 'vitest/config';
import { buildDefines } from '../../app/perfMarks.mjs';

export default defineConfig({
  // the debug tooling is ON in tests (a vitest run is `serve`), as under `vite dev`
  define: buildDefines('serve'),
  test: {
    // `domTree.ts` is DOM introspection — its tests need a real document.
    environment: 'jsdom',
  },
});
