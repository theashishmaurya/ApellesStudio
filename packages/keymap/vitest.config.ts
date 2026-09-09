import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `*.dom.test.tsx` mounts real React against real DOM events — the whole
    // point of this package's dispatcher tests is that a real `keydown` on
    // `window` reaches the right handler, which a node environment cannot show.
    environment: 'jsdom',
  },
});
