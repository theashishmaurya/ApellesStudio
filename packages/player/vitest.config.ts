import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // `*.dom.test.tsx` mounts the real transport bar and clicks it — the rate
    // control's presets live behind a real Base UI popover, which no node
    // environment can open. `playbackRate.test.ts` is pure and does not care.
    environment: 'jsdom',
  },
});
