/**
 * website/src/md/release-notes.ts — the rehype pass the release notes need
 * before they can share one page (D-459).
 *
 * What it is: a small rehype plugin, registered in `astro.config.mjs`, that
 * makes a document written to stand alone behave as a section of a larger one.
 * The notes in `docs/releases/` are authored as the whole body of a GitHub
 * release, so each starts its own outline at `##`. `/changelog/` puts the page
 * title in `<h1>` and each version in `<h2>`, so every heading inside a note
 * moves down one level, and the ids Astro generated for them are prefixed with
 * the version so two releases that both have a "Download" section do not emit
 * the same `id` twice on one page.
 * What it does NOT do: touch the words. No rewriting, no truncation, no
 * stripping — the page shows what the release says.
 *
 * It is written against hast directly rather than pulling in `unist-util-visit`
 * for a nine-line walk (CLAUDE.md's "a 20-line pure function has no business
 * pulling in a dependency").
 */

/** The hast subset this plugin touches. Element children may also be text/raw nodes. */
interface Node {
  type: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: Node[];
}

const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5'] as const;

/**
 * `…/docs/releases/v0.3.0.md` → `v0-3-0`, the prefix heading ids get namespaced
 * with — and `undefined` for any other file, which is how the plugin knows to
 * leave it alone. It is registered globally (Astro's markdown config is not
 * per-collection), so it must only act on a release note.
 */
function prefixFor(path: string | undefined): string | undefined {
  const stem = /docs[/\\]releases[/\\](v\d+\.\d+\.\d+)\.md$/.exec(path ?? '')?.[1];
  return stem?.replace(/\./g, '-');
}

/**
 * Shift every heading down one level and namespace its id.
 *
 * Astro runs its own `rehypeHeadingIds` pass before user rehype plugins, so the
 * `id` properties this rewrites are already in place by the time it runs.
 */
export function rehypeReleaseNotes() {
  return (tree: Node, file: { path?: string; history?: string[] }) => {
    const prefix = prefixFor(file.path ?? file.history?.[0]);
    if (prefix === undefined) return;

    const walk = (node: Node) => {
      const level = HEADINGS.indexOf(node.tagName as (typeof HEADINGS)[number]);
      if (node.type === 'element' && level !== -1) {
        node.tagName = HEADINGS[level + 1];
        const id = node.properties?.id;
        if (typeof id === 'string') {
          node.properties = { ...node.properties, id: `${prefix}-${id}` };
        }
      }
      for (const child of node.children ?? []) walk(child);
    };

    walk(tree);
  };
}
