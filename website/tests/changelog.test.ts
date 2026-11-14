/**
 * changelog.test.ts — /changelog/ publishes exactly the releases the repo has,
 * and publishes them from the users' notes (D-459).
 *
 * The same shape as mcp-data.test.ts: the repo is the ground truth and the page
 * is re-checked against it, so the site cannot say something about a release
 * that `docs/releases/` does not. It reads that directory itself rather than a
 * hand-written list, which is the point — write `docs/releases/v0.4.0.md` and
 * this test demands the page carry it.
 *
 * It runs against `dist/`, like build-output.test.ts, rather than rendering the
 * page through the Container API the way render.test.ts does its components:
 * the page's content comes from a content collection, and the Container API has
 * no content layer to read it from (`getCollection` returns nothing there). So
 * this needs `astro build` first — `npm run verify` does that in order — and
 * says so plainly rather than silently passing on nothing.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHTML } from 'linkedom';

import {
  RELEASES_DIR,
  REPO,
  newestFirst,
  parseVersion,
  releaseDate,
  releaseUrl,
} from '../src/data/releases.ts';

const DIST = fileURLToPath(new URL('../dist', import.meta.url));

/** Every version note on disk — the ground truth the page is checked against. */
const NOTES = readdirSync(RELEASES_DIR)
  .filter((f) => f.endsWith('.md'))
  .map((f) => f.replace(/\.md$/, ''))
  .filter((id) => parseVersion(id) !== null);

const anchor = (version: string) => version.replace(/\./g, '-');

let html = '';
let doc: ReturnType<typeof parseHTML>['document'];
let home = '';

beforeAll(() => {
  const page = join(DIST, 'changelog/index.html');
  if (!existsSync(page)) {
    throw new Error(
      '/changelog/ is missing from dist/ — run `npm run build` before the tests (or `npm run verify`)',
    );
  }
  html = readFileSync(page, 'utf8');
  doc = parseHTML(html).document;
  home = readFileSync(join(DIST, 'index.html'), 'utf8');
});

const section = (version: string) => doc.querySelector(`#${anchor(version)}`);

describe('the release notes on disk are what gets published', () => {
  it('finds a plausible set of version notes to publish', () => {
    expect(NOTES.length).toBeGreaterThanOrEqual(2);
  });

  it('gives every one of them its own section, and invents none', () => {
    const published = [...doc.querySelectorAll('section.rel')].map((s) => s.getAttribute('id'));
    expect(published.slice().sort()).toEqual(NOTES.map(anchor).slice().sort());
  });

  it('does not publish docs/releases/README.md — it is the checklist, not a release', () => {
    const readme = readFileSync(join(RELEASES_DIR, 'README.md'), 'utf8');
    // A heading unique to the checklist, which no release note contains.
    expect(readme).toContain('Before tagging');
    expect(html).not.toContain('Before tagging');
  });

  it('publishes the notes verbatim, not a retyped summary', () => {
    for (const version of NOTES) {
      const notes = readFileSync(join(RELEASES_DIR, `${version}.md`), 'utf8');
      const text = (section(version)?.textContent ?? '').replace(/\s+/g, ' ');
      // Every `## Heading` of the notes, and the first sentence of the body,
      // have to be on the page. Markdown emphasis is stripped from the
      // comparison — it becomes markup, not text.
      const headings = [...notes.matchAll(/^##+\s+(.+)$/gm)].map((m) => m[1].replace(/\*/g, ''));
      expect(headings.length, `${version} has no sections`).toBeGreaterThan(2);
      for (const heading of headings) {
        expect(text, `${version} is missing its "${heading}" section`).toContain(heading);
      }
      const opening = notes.split('\n')[0].replace(/\*/g, '').slice(0, 60);
      expect(text, `${version} does not open with its own first line`).toContain(opening);
    }
  });

  it('never publishes the internal engineering log’s shorthand', () => {
    // docs/CHANGELOG.md is written in D-NNN / B-NNN references; the release
    // notes are not, and this page must stay on the users' side of that line.
    expect(html).not.toMatch(/\b[DB]-\d{3}\b/);
  });
});

describe('newest first, with a real version and date on each', () => {
  const shownVersions = () =>
    [...doc.querySelectorAll('section.rel')].map(
      (s) => `v${(s.querySelector('h2')?.textContent ?? '').trim()}`,
    );

  it('orders the sections by version, descending', () => {
    expect(shownVersions()).toEqual(NOTES.slice().sort(newestFirst));
    expect(shownVersions().length).toBe(NOTES.length);
  });

  it('heads each release with its version number and nothing else', () => {
    for (const heading of shownVersions()) {
      expect(parseVersion(heading), `"${heading}" is not a version`).not.toBeNull();
    }
  });

  it('dates each release with a machine-readable date that resolves', () => {
    for (const version of shownVersions()) {
      const time = section(version)?.querySelector('time');
      const iso = time?.getAttribute('datetime') ?? '';
      expect(iso, `${version} has no datetime`).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(iso, `${version}'s date is not the one derived from the repo`).toBe(
        releaseDate(version).toISOString().slice(0, 10),
      );
      // A real date, not an epoch default and not in the future.
      const when = new Date(iso).getTime();
      expect(when).toBeGreaterThan(Date.parse('2026-01-01'));
      expect(when).toBeLessThanOrEqual(Date.now());
      // And a human one next to it, not just the attribute.
      expect((time?.textContent ?? '').trim().length).toBeGreaterThan(8);
    }
  });

  it('is in the same order in its index as on the page', () => {
    const toc = [...doc.querySelectorAll('.toc a[href^="#"]')].map((a) => a.getAttribute('href'));
    expect(toc).toEqual(NOTES.slice().sort(newestFirst).map((v) => `#${anchor(v)}`));
  });
});

describe('every release links to its own GitHub release', () => {
  it('uses the real tag URL for each version', () => {
    for (const version of NOTES) {
      const hrefs = [...(section(version)?.querySelectorAll('a[href]') ?? [])].map((a) =>
        a.getAttribute('href'),
      );
      expect(hrefs, `${version} does not link its GitHub release`).toContain(releaseUrl(version));
    }
  });

  it('builds those URLs well-formed, against the real repository', () => {
    for (const version of NOTES) {
      expect(releaseUrl(version)).toBe(
        `https://github.com/theashishmaurya/ApellesStudio/releases/tag/${version}`,
      );
      expect(releaseUrl(version)).toMatch(/\/releases\/tag\/v\d+\.\d+\.\d+$/);
    }
    // No GitHub link the PAGE builds — as opposed to one a release note's own
    // prose carries, which can legitimately point anywhere, e.g. v0.3.0's
    // RapidRAW attribution — goes anywhere but this repository.
    for (const a of doc.querySelectorAll('.relhd a[href], .toc a[href^="http"]')) {
      const href = a.getAttribute('href') ?? '';
      expect(href.startsWith(`${REPO}/`), href).toBe(true);
      expect(() => new URL(href)).not.toThrow();
    }
  });

  it('points at the downloads and the install guide as well', () => {
    expect(html).toContain(`${REPO}/releases"`);
    expect(doc.querySelector('a[href="/install/"]')).not.toBeNull();
  });
});

describe('the page is reachable and reads like the rest of the site', () => {
  it('is linked from both the nav and the footer', () => {
    const d = parseHTML(home).document;
    expect(d.querySelector('header a[href="/changelog/"]'), 'the nav does not link it').not.toBeNull();
    expect(d.querySelector('footer a[href="/changelog/"]'), 'the footer does not link it').not.toBeNull();
  });

  it('carries exactly one h1 and one section heading per release', () => {
    expect(doc.querySelectorAll('h1').length).toBe(1);
    expect(doc.querySelectorAll('section.rel > .relhd > h2').length).toBe(NOTES.length);
  });

  it('gives every heading inside a release a unique id, namespaced by version', () => {
    const ids = [...doc.querySelectorAll('.body [id]')].map((n) => n.getAttribute('id') ?? '');
    // Both current notes have a "Download" and a "Known limits" section, so an
    // un-namespaced id here would be a duplicate on the page.
    expect(ids.length).toBeGreaterThan(5);
    expect(new Set(ids).size, `duplicate ids: ${ids.join(', ')}`).toBe(ids.length);
    for (const id of ids) expect(id, `${id} is not namespaced`).toMatch(/^v\d+-\d+-\d+-/);
  });

  it('starts the notes’ own headings below the per-release h2 they sit under', () => {
    for (const body of doc.querySelectorAll('.body')) {
      expect(body.querySelectorAll('h1, h2').length, 'a note heading outranks its release').toBe(0);
      expect(body.querySelectorAll('h3').length).toBeGreaterThan(0);
    }
  });

  it('spends no signature colour — this page asks for nothing (D-283)', () => {
    expect(doc.querySelectorAll('.signature').length).toBe(0);
  });
});
