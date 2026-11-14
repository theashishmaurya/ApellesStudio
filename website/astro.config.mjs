// @ts-check
import { defineConfig } from 'astro/config';
import { rehypeHeadingIds } from '@astrojs/markdown-remark';
import sitemap from '@astrojs/sitemap';
import { serialize } from './src/seo/sitemap.ts';
import { rehypeReleaseNotes } from './src/md/release-notes.ts';

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
  markdown: {
    // The only markdown this site renders is the release notes in
    // `docs/releases/`, published by `/changelog/` (D-459). This plugin makes a
    // document written to stand alone sit inside a page that already has an h1
    // and a per-release h2; it no-ops on anything that is not a release note.
    //
    // `rehypeHeadingIds` is Astro's own pass, listed explicitly because Astro
    // otherwise runs it AFTER the user's plugins — which would hand two
    // releases the same `id="download"`. Running it first means the ids exist
    // for `rehypeReleaseNotes` to namespace by version, and Astro's own run
    // leaves a heading that already has an id alone.
    rehypePlugins: [rehypeHeadingIds, rehypeReleaseNotes],
  },
  build: {
    // One stylesheet, inlined — the whole site's CSS is a few KB and a separate
    // request costs more than it saves.
    inlineStylesheets: 'always',
  },
  devToolbar: { enabled: false },
});
