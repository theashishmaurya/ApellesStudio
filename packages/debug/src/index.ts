/**
 * @chroma/debug — internal debug tooling for the running app (D-219).
 *
 * The `debug_*` control-server op registry: drive real UI state through the
 * same store actions a human's click uses, dump a bounded slice of the real
 * DOM, and read the Edit-tab preview's actual frame timing. Paired with the
 * D-210 native `debug_screenshot`/`debug_sample_pixel` ops (answered in Rust,
 * not here) this is what lets an agent open something, look at it, and check
 * it — without a human in the loop.
 *
 * **Debug-only, always** (CLAUDE.md's standing rule; scope/tracker in
 * `docs/notes/debug-tooling.md`). `useDebugControl` is deliberately the only
 * VALUE this barrel exports: it reaches the registry through a dynamic
 * `import()` inside an `import.meta.env.DEV` branch, so a production build
 * drops every op body along with `debugOps.ts`, `domTree.ts` and
 * `uiState.ts`. Re-exporting those modules' functions here would put them
 * back in the app's static import graph for no gain — nothing outside this
 * package calls them, and the tests import them by path. Types are exported
 * freely (they erase). See `README.md` for this package's boundary.
 */

export { useDebugControl } from './useDebugControl';
export type { DomTreeOptions, DomTreeResult, DomNodeInfo, OpenDialogInfo } from './domTree';
export type { Parsed } from './uiState';
