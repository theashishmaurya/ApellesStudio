/// <reference types="vitest" />
import { getViteConfig } from 'astro/config';

/**
 * Astro's own canonical Vitest setup (`getViteConfig`), so the test run resolves
 * .astro components exactly as the build does and the Container API can render
 * them for real.
 */
export default getViteConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    globals: false,
  },
});
