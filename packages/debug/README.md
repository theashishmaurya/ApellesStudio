# @apelles/debug

**Internal debug tooling for the running app** (D-219) — the `debug_*`
control-server op registry. It lets an agent (or a developer at an HTTP
client) *drive* real UI state and *inspect* the real webview, so a UI change
can actually be verified instead of guessed at.

Scope/tracker for the whole initiative: `docs/notes/debug-tooling.md`.
Its sibling half, the native screenshot + pixel probe, is D-210 and lives in
Rust (`app/src-tauri/src/chroma/debug_capture.rs`) — see "Boundary" below.

## Debug-only, always — the hard invariant

Nothing in this package may reach a production build (CLAUDE.md's standing
rule). The gate is **compile-time, not a runtime flag**:

- `useDebugControl()`'s whole effect body is behind
  `if (!import.meta.env.DEV) return;` — Vite substitutes the literal `false`
  in a production build, so the branch is constant-folded away.
- The registry itself is reached through a **dynamic `import('./debugOps')`
  inside that branch**, so Rollup drops `debugOps.ts` (and, transitively,
  `domTree.ts` and `uiState.ts`) from the output entirely rather than merely
  leaving them unreachable.
- `src/index.ts` exports exactly one value — the hook — so nothing else here
  is in the app's static import graph in the first place.

This is the frontend counterpart of `#[cfg(debug_assertions)]` on the Rust
commands (B-100 fixed the Rust half, which had been shipping ungated).
It is **verified, not assumed**: `docs/notes/debug-tooling.md` records the
`vite build` + bundle-grep that proves no `debug_` op name survives.

## Ops

All are namespaced `debug_` and answered here, over the same
`chroma://request` / `chroma://response/<id>` event pair every other registry
uses (Colorist's `useChromaControl`, Motion's, the Edit tab's). Reached over
MCP as tools of the same name.

| op | what it does |
| --- | --- |
| `debug_get_ui_state` | active tab, Sources panel, Edit Inspector (open + which of its tabs), selection/playhead, and every dialog the DOM currently has open |
| `debug_set_active_tab` | `{tab: 'edit'\|'motion'\|'colorist'}` (or a 1-based index) |
| `debug_set_sources_panel` | `{open: bool}` — the shell's docked Sources column |
| `debug_set_editor_inspector` | `{open: bool}` — the Edit tab's Inspector column |
| `debug_set_inspector_tab` | `{tab: 'video'\|'audio'}` — that Inspector's own Video/Audio tab (D-246); only one is on screen at a time, so set it before screenshotting or dumping the panel |
| `debug_set_popover_open` | `{id, open: bool}` — any registered Edit-tab popover/dialog (D-252, `@apelles/editor`'s `panelRegistry.ts`): `caption-panel`, `canvas-settings`, `export-dialog` today. One op for every popover rather than a bespoke one per popover — see D-252 for why. |
| `debug_dom_tree` | `{selector?, maxDepth?, maxNodes?, styles?, includeHidden?, text?}` → bounded JSON of the real DOM: hierarchy, semantic attributes, `getBoundingClientRect()`, chosen computed styles |
| `debug_frame_timing` | `{limit?, reset?}` → the preview's real rAF/paint intervals (see `@apelles/editor`'s `previewTiming.ts`) |

**Every write calls the same store action the human's own control calls** —
`useShellStore.setActiveTab` is literally what the tab button's `onClick`
invokes; `useEditorTimelineStore.setInspectorOpen` is what the Inspector
toggle invokes; `useEditorTimelineStore.setPanelOpen` is what every
registered popover's own trigger invokes via `usePanelOpen` (D-252). Nothing
here synthesises a click, a keypress or a pointer event. That is the design
decision, not an implementation detail: a simulated click proves the
simulation works, a store action proves the app works (D-219).

`debug_dom_tree` coordinates are **CSS pixels** (`getBoundingClientRect()`);
`debug_screenshot` pixels are **device pixels**. Multiply by the screenshot's
`scaleFactor` (or the DOM result's `viewport.devicePixelRatio`) to cross
between them.

## Boundary

- **Depends on** `@apelles/shell` (the tab/Sources store) and `@apelles/editor`
  (the Inspector flag, the preview timing buffers) — one way only, so this
  package sits *above* the tab packages and below the app.
- **Does not** import the app (`app/src`). That is why the Colorist tab's own
  panel/visibility/settings state (`app/src/store/useUIStore.ts`, inside the
  vendored RapidRAW fork) is **not** exposed here: reaching up into the app
  layer would invert D-039's dependency direction. Tracked as the remaining
  piece-2 gap in `docs/notes/debug-tooling.md`.
- **Does not** own the screenshot or the pixel probe. Those are D-210 native
  ops answered inside `control.rs` (`native_op`), deliberately never round
  tripping through the frontend — the most valuable moment to photograph the
  UI is when the frontend is too wedged to answer. They share the `debug_`
  prefix but not this code path.
- **Does not** edit a timeline, a grade or a manifest. An op that changes the
  user's work belongs in its own tab's registry.

## Testing

`src/domTree.test.ts` and `src/uiState.test.ts` (vitest, jsdom) cover the
serialiser's bounds, attribute/style selection, dialog detection and argument
validation — the parts that have correct answers. `src/debugOps.popover.dom
.test.tsx` goes one level further for `debug_set_popover_open`: it mounts the
real `CaptionPanel` and proves the op actually opens/closes its real popover
(no synthesised click), and that an unknown id or a missing `open` is refused
by name rather than silently accepted. The other ops are verified live
against a running app; the loop and its results are recorded in
`docs/notes/debug-tooling.md`.

`npm run test --workspace @apelles/debug`, or `npm test` from the repo root.
