/**
 * build-output.test.ts — a real broken-link check over the real build (D-255).
 *
 * Runs against `dist/`, so it verifies what actually ships rather than what a
 * component renders in isolation: every internal href resolves to a page that
 * was emitted, every in-page anchor target exists, and every referenced asset
 * is on disk. Requires `astro build` first — `npm run verify` does that in
 * order, and this test says so plainly rather than silently passing on nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

let pages: Array<{ route: string; file: string; html: string }> = [];
let assets = new Set<string>();

beforeAll(() => {
  if (!existsSync(DIST)) {
    throw new Error('dist/ is missing — run `npm run build` before the tests (or `npm run verify`)');
  }
  const files = walk(DIST);
  assets = new Set(files.map((f) => '/' + relative(DIST, f).split('\\').join('/')));
  pages = files
    .filter((f) => f.endsWith('.html'))
    .map((f) => {
      const rel = '/' + relative(DIST, f).split('\\').join('/');
      return {
        route: rel.replace(/index\.html$/, '').replace(/\.html$/, '/'),
        file: rel,
        html: readFileSync(f, 'utf8'),
      };
    });
});

describe('the build emits the expected pages', () => {
  it('built at least the home page and the MCP docs page', () => {
    const routes = pages.map((p) => p.route);
    expect(routes).toContain('/');
    expect(routes).toContain('/docs/mcp/');
  });

  it('every page has a title and a meta description', () => {
    for (const p of pages) {
      const d = parseHTML(p.html).document;
      expect(d.querySelector('title')?.textContent?.trim(), `${p.file} title`).toBeTruthy();
      expect(
        d.querySelector('meta[name="description"]')?.getAttribute('content'),
        `${p.file} description`,
      ).toBeTruthy();
    }
  });

  it('every page declares a language and a canonical URL', () => {
    for (const p of pages) {
      expect(p.html).toContain('<html lang="en"');
      expect(parseHTML(p.html).document.querySelector('link[rel="canonical"]')).not.toBeNull();
    }
  });

  it('has exactly one h1 per page', () => {
    for (const p of pages) {
      const n = parseHTML(p.html).document.querySelectorAll('h1').length;
      expect(n, `${p.file} should have exactly one h1, found ${n}`).toBe(1);
    }
  });
});

describe('no broken internal links', () => {
  it('every internal href resolves to a built page or asset', () => {
    const routes = new Set(pages.map((p) => p.route));
    const broken: string[] = [];

    for (const p of pages) {
      const d = parseHTML(p.html).document;
      for (const a of d.querySelectorAll('a[href]')) {
        const href = a.getAttribute('href') ?? '';
        if (!href.startsWith('/')) continue; // external, mailto, or in-page — handled below
        const [path] = href.split('#');
        if (path === '') continue;
        const withSlash = path.endsWith('/') ? path : `${path}/`;
        if (routes.has(withSlash) || assets.has(path)) continue;
        broken.push(`${p.file} → ${href}`);
      }
    }
    expect(broken, `broken internal links:\n${broken.join('\n')}`).toEqual([]);
  });

  it('every in-page anchor target exists on the page it points at', () => {
    const byRoute = new Map(pages.map((p) => [p.route, p.html]));
    const broken: string[] = [];

    for (const p of pages) {
      const d = parseHTML(p.html).document;
      for (const a of d.querySelectorAll('a[href*="#"]')) {
        const href = a.getAttribute('href') ?? '';
        const [path, hash] = href.split('#');
        if (!hash) continue;
        if (path && !path.startsWith('/')) continue;
        const targetRoute = path === '' || path === undefined ? p.route : path.endsWith('/') ? path : `${path}/`;
        const targetHtml = byRoute.get(targetRoute);
        if (targetHtml === undefined) {
          broken.push(`${p.file} → ${href} (no such page)`);
          continue;
        }
        if (!parseHTML(targetHtml).document.querySelector(`#${hash}`)) {
          broken.push(`${p.file} → ${href} (no #${hash} on that page)`);
        }
      }
    }
    expect(broken, `broken anchors:\n${broken.join('\n')}`).toEqual([]);
  });

  it('every referenced local image was emitted', () => {
    const missing: string[] = [];
    for (const p of pages) {
      for (const img of parseHTML(p.html).document.querySelectorAll('img[src]')) {
        const src = img.getAttribute('src') ?? '';
        if (!src.startsWith('/')) continue;
        if (!assets.has(src)) missing.push(`${p.file} → ${src}`);
      }
    }
    expect(missing, `missing images:\n${missing.join('\n')}`).toEqual([]);
  });

  /**
   * Added after a real miss: renaming a screenshot left `og:image` pointing at a
   * file that no longer existed, and the img-only check above could not see it
   * because the reference lives in a <meta> tag and a <link>.
   */
  it('every image referenced from <head> was emitted too', () => {
    const missing: string[] = [];
    for (const p of pages) {
      const d = parseHTML(p.html).document;
      const refs = [
        ...[...d.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')].map(
          (m) => m.getAttribute('content') ?? '',
        ),
        ...[...d.querySelectorAll('link[rel="icon"]')].map((l) => l.getAttribute('href') ?? ''),
      ];
      for (const ref of refs) {
        // og:image is absolute; reduce it to the path the build emitted.
        const path = ref.startsWith('http') ? new URL(ref).pathname : ref;
        if (!path.startsWith('/')) continue;
        if (!assets.has(path)) missing.push(`${p.file} → ${ref}`);
      }
    }
    expect(missing, `missing head assets:\n${missing.join('\n')}`).toEqual([]);
  });

  it('ships no screenshot that nothing references', () => {
    const referenced = new Set<string>();
    for (const p of pages) {
      const d = parseHTML(p.html).document;
      for (const img of d.querySelectorAll('img[src]')) {
        referenced.add(img.getAttribute('src') ?? '');
      }
      for (const m of d.querySelectorAll('meta[property="og:image"]')) {
        const c = m.getAttribute('content') ?? '';
        referenced.add(c.startsWith('http') ? new URL(c).pathname : c);
      }
    }
    const orphans = [...assets].filter((a) => a.startsWith('/shots/') && !referenced.has(a));
    expect(orphans, `unused screenshots shipped:\n${orphans.join('\n')}`).toEqual([]);
  });
});

describe('the shipped HTML carries nothing it should not', () => {
  it('leaves no TODO or FIXME in the output', () => {
    for (const p of pages) {
      expect(p.html, `${p.file}`).not.toMatch(/\bTODO\b|\bFIXME\b/);
    }
  });

  it('leaves no console statements in the shipped scripts', () => {
    for (const f of walk(DIST).filter((f) => f.endsWith('.js'))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/console\.(log|warn|error|debug)/);
    }
  });

  it('has no lorem-ipsum or placeholder body copy', () => {
    for (const p of pages) {
      expect(p.html.toLowerCase(), `${p.file}`).not.toContain('lorem ipsum');
    }
  });

  it('keeps the beta endpoint an obvious placeholder until the owner sets one', () => {
    // If this ever fails, a real endpoint was configured — update the test then.
    const home = pages.find((p) => p.route === '/');
    expect(home?.html).toContain('YOUR_FORM_ID');
  });
});
