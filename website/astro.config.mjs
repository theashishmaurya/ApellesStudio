// @ts-check
import { defineConfig } from 'astro/config';

/**
 * Chroma's marketing + docs website (D-255).
 *
 * What it is: a static Astro site, built independently of the desktop app's own
 * npm workspace (see website/README.md for why).
 * What it does NOT do: talk to the app, ship any app code, or run a server —
 * `astro build` emits pure static HTML/CSS + two tiny client islands.
 *
 * `site` is the canonical origin used for absolute URLs in the sitemap/OG tags.
 * It is a placeholder until a real domain exists (tracked in docs/04-roadmap.md).
 */
export default defineConfig({
  site: 'https://chroma.video',
  output: 'static',
  build: {
    // One stylesheet, inlined — the whole site's CSS is a few KB and a separate
    // request costs more than it saves.
    inlineStylesheets: 'always',
  },
  devToolbar: { enabled: false },
});
