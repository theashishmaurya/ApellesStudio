/**
 * website/src/seo/sitemap.ts — what each sitemap entry says beyond its URL.
 *
 * What it is: the `serialize` hook for `@astrojs/sitemap` (astro.config.mjs).
 * It adds, per page:
 *  - `lastmod`: the last commit that changed the page's own content, i.e. the
 *    page file plus the components and data it imports (followed recursively),
 *    but not the shared chrome (the layout, nav, footer, styles). A nav tweak
 *    does not claim every page changed. A file with uncommitted edits counts as
 *    changed now, so a local build never under-reports.
 *  - image entries for the real app captures a page shows (`TABS[].shot`).
 *  - video entries for the YouTube videos the home page embeds (`PROOF_VIDEOS`).
 * What it does NOT do: set `changefreq` or `priority`. Google ignores both, and
 * a guessed value is noise; `lastmod` is the signal crawlers actually use.
 * Everything here is read from the same data the pages render, so the sitemap
 * cannot describe an image or a video the page does not show.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { TABS } from '../data/product.ts';
import { PROOF_VIDEOS } from '../data/proof.ts';

const SRC = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PAGES = join(SRC, 'pages');

/** Shared chrome: changes here are not a change to any one page's content. */
const CHROME = new Set(['layouts/Base.astro', 'components/Nav.astro', 'components/Footer.astro']);

/** The source file Astro built a route from: `/` → `index.astro`, `/inside/` → `inside.astro`. */
export function pageFile(pathname: string): string | undefined {
  const slug = pathname.replace(/^\/|\/$/g, '') || 'index';
  const file = join(PAGES, `${slug}.astro`);
  return existsSync(file) ? file : undefined;
}

/** The page file and every component/data module it imports, transitively, minus the chrome. */
export function contentFiles(entry: string): string[] {
  const seen = new Set<string>();
  const visit = (file: string) => {
    if (seen.has(file) || !existsSync(file)) return;
    if (CHROME.has(relative(SRC, file))) return;
    seen.add(file);
    const text = readFileSync(file, 'utf8');
    for (const m of text.matchAll(/^\s*import\s[^'"]*['"](\.{1,2}\/[^'"]+)['"]/gm)) {
      const target = resolve(dirname(file), m[1]);
      if (/\.(astro|ts)$/.test(target)) visit(target);
    }
  };
  visit(entry);
  return [...seen];
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: SRC, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/** The newest of the files' last-commit times, or now if any has uncommitted edits. */
export function lastModified(files: string[]): Date | undefined {
  if (files.length === 0) return undefined;
  if (git(['status', '--porcelain', '--', ...files]) !== '') return new Date();
  const stamps = files
    .map((f) => git(['log', '-1', '--format=%cI', '--', f]) || statSync(f).mtime.toISOString())
    .map((s) => new Date(s).getTime());
  return new Date(Math.max(...stamps));
}

interface Item {
  url: string;
  lastmod?: string;
  [key: string]: unknown;
}

/** `@astrojs/sitemap`'s `serialize`: decorates one entry; `site` is the canonical origin. */
export function serialize(item: Item, site: string): Item {
  const { pathname } = new URL(item.url);
  const file = pageFile(pathname);
  const out: Item = { ...item };
  if (file) out.lastmod = lastModified(contentFiles(file))?.toISOString();

  // Where the room captures render: the home page's Rooms and /inside/.
  if (pathname === '/' || pathname === '/inside/') {
    out.img = TABS.flatMap((t) =>
      t.shot ? [{ url: new URL(t.shot.src, site).href, caption: t.shot.alt, title: `Apelles ${t.name}` }] : [],
    );
  }

  if (pathname === '/') {
    out.video = PROOF_VIDEOS.map((v) => ({
      title: v.title,
      description: v.note,
      thumbnail_loc: `https://i.ytimg.com/vi/${v.id}/maxresdefault.jpg`,
      player_loc: `https://www.youtube-nocookie.com/embed/${v.id}`,
      family_friendly: 'yes',
      requires_subscription: 'no',
      live: 'no',
    }));
  }
  return out;
}
