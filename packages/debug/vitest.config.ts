import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `domTree.ts` is DOM introspection — its tests need a real document.
    environment: 'jsdom',
  },
});
