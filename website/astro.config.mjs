// @ts-check
import { defineConfig } from 'astro/config';
import sitemap from '@astrojs/sitemap';
import { serialize } from './src/seo/sitemap.ts';

/**
 * Apelles's marketing + docs website (D-255, rebuilt under the new brand by
 * D-264; SEO pass D-288).
 *
 * What it is: a static Astro site, built independently of the desktop app's own
 * npm workspace (see website/README.md for why).
 * What it does NOT do: talk to the app, ship any app code, or run a server —
 * `astro build` emits pure static HTML/CSS + two tiny client islands.
 *
 * `site` is the canonical origin used for absolute URLs in the canonical/OG
 * tags and the sitemap below. It is `apelles.studio` — the domain D-265
 * records the owner as having actually bought — not a placeholder; it was
 * wrongly left as `apelles.video` (an earlier placeholder) until D-288 caught
 * the drift.
 *
 * The sitemap's per-page `lastmod`, image and video entries come from
 * `src/seo/sitemap.ts`, read off the same data the pages render.
 */
const SITE = 'https://apelles.studio';

export default defineConfig({
  site: SITE,
  output: 'static',
  integrations: [
    sitemap({
      // The waitlist landing pages (D-426) are noindex and carry no content to find.
      filter: (page) => !new URL(page).pathname.startsWith('/waitlist/'),
      serialize: (item) => serialize(item, SITE),
    }),
  ],
  build: {
    // One stylesheet, inlined — the whole site's CSS is a few KB and a separate
    // request costs more than it saves.
    inlineStylesheets: 'always',
  },
  devToolbar: { enabled: false },
});
