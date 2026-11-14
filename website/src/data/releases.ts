/**
 * website/src/data/releases.ts — everything about a release that its notes file
 * does not say (D-459).
 *
 * What it is: the version, the date and the GitHub release URL for each entry
 * of the `releases` content collection (`src/content.config.ts`). The body comes
 * from the notes file itself; this module derives the three facts around it, so
 * `/changelog/` has nothing hand-typed in it and a new
 * `docs/releases/vX.Y.Z.md` needs no code change.
 * What it does NOT do: hold any release copy. Not a word of what a release says
 * is written here — if it is not in `docs/releases/`, the site does not say it.
 *
 * The date is the one fact a notes file genuinely cannot carry: the workflow
 * passes the file verbatim to `gh release create --notes-file`, so frontmatter
 * would print in the release body. It is read from git instead, the way
 * `src/seo/sitemap.ts` already reads each page's `lastmod`: the date of the
 * commit the `vX.Y.Z` tag points at — the commit the release was built from —
 * and, in a checkout without tags, the last commit that touched the notes file.
 * Both are real; neither is invented.
 */
import { execFileSync } from 'node:child_process';
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** `docs/releases/` at the repo root — the same directory the collection loads. */
export const RELEASES_DIR = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../../../docs/releases',
);

/** The repository the releases are published from. */
export const REPO = 'https://github.com/theashishmaurya/ApellesStudio';

/** The GitHub release a version's notes were published as. */
export function releaseUrl(version: string): string {
  return `${REPO}/releases/tag/${version}`;
}

/** A collection entry id (`v0.3.0`) → `[0, 3, 0]`, or null if it is not a version. */
export function parseVersion(id: string): [number, number, number] | null {
  const m = /^v(\d+)\.(\d+)\.(\d+)$/.exec(id);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** Newest first: a descending comparator over `vX.Y.Z` ids. */
export function newestFirst(a: string, b: string): number {
  const [pa, pb] = [parseVersion(a), parseVersion(b)];
  if (!pa || !pb) return 0;
  for (let i = 0; i < 3; i++) if (pa[i] !== pb[i]) return pb[i] - pa[i];
  return 0;
}

function git(args: string[]): string {
  try {
    return execFileSync('git', args, { cwd: RELEASES_DIR, encoding: 'utf8' }).trim();
  } catch {
    return '';
  }
}

/**
 * When a version was released: the date of the commit its `vX.Y.Z` tag points
 * at, falling back to the last commit that touched its notes file, and finally
 * to that file's mtime so a build from an export with no git history still
 * prints a real date.
 */
export function releaseDate(version: string): Date {
  const file = join(RELEASES_DIR, `${version}.md`);
  const stamp =
    git(['log', '-1', '--format=%cI', `${version}`]) ||
    git(['log', '-1', '--format=%cI', '--', file]);
  return stamp ? new Date(stamp) : statSync(file).mtime;
}

/** The date as the page prints it: "10 November 2026". */
export function formatDate(date: Date): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(date);
}
