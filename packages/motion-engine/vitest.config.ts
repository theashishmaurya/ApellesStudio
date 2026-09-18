import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Individual `*.dom.test.tsx` files opt into `jsdom` themselves via a
    // `// @vitest-environment jsdom` pragma (matches `@apelles/player`) — the
    // rest of this package's tests are pure and don't need a DOM.
    environment: 'node',
  },
});
