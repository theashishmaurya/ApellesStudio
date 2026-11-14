/**
 * website/src/content.config.ts — the site's content collections (D-459).
 *
 * What it is: one collection, `releases`, loaded with Astro's own `glob()`
 * loader straight out of `docs/releases/` at the repo root — the files that are
 * already written for users and already used verbatim as the GitHub Release
 * body (`.github/workflows/release.yml` passes each one to `gh release create
 * --notes-file`). `/changelog/` renders them, so a new `docs/releases/vX.Y.Z.md`
 * appears on the site with no code change and the site cannot drift from what
 * the release itself says.
 * What it does NOT do: read `docs/CHANGELOG.md`. That is the internal
 * engineering log — `D-NNN`/`B-NNN` shorthand, worktrees, parity harnesses —
 * and publishing it would leak internal vocabulary at a reader who wants to
 * know what changed in the app. See D-459.
 *
 * `pattern` is `v*.md`, so `docs/releases/README.md` (the release checklist, not
 * a release note) is never picked up. `generateId` keeps the file's own stem as
 * the entry id — the loader's default would slugify `v0.2.0` and lose the dots
 * the version numbers are made of.
 */
import { defineCollection, z } from 'astro:content';
import { glob } from 'astro/loaders';

export const collections = {
  releases: defineCollection({
    loader: glob({
      base: '../docs/releases',
      pattern: 'v*.md',
      generateId: ({ entry }) => entry.replace(/\.md$/, ''),
    }),
    // The notes carry no frontmatter — they are shipped verbatim as a GitHub
    // release body, which would print it — so there is nothing to validate.
    // Everything structural (version, date, tag URL) is derived in
    // `src/data/releases.ts` instead.
    schema: z.object({}).strict(),
  }),
};
