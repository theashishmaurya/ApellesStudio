// Vitest for the `app` workspace (D-268).
//
// `app/` had no test runner at all until this pass, which is why
// `useSessionStore` — the store gating EVERY project operation in the product,
// for both the GUI and the MCP layer — shipped with zero tests and B-132 got
// as far as a live session. Same `vitest run` / `environment: 'node'` shape
// every `packages/*` workspace already uses; nothing bespoke.
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
  },
});
