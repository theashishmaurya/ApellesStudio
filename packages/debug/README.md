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
  `if (import.meta.env.APELLES_DEBUG_TOOLS !== 'true') return;` — the define
  (`app/perfMarks.mjs`, B-358) is `'true'` for `vite dev` and `tauri build --debug`
  (`TAURI_ENV_DEBUG=true`, exactly when Rust has `debug_assertions`) and `'false'`
  in a release build, so the branch is constant-folded away there.
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
| `debug_get_ui_state` | active tab, Sources panel, Edit Inspector (open + which of its tabs), the Edit tab's `editor.layout` (D-432 P5: browser shown, browser / Inspector width, timeline height), selection/playhead, every dialog the DOM currently has open, and `motion.customProxies` — each Motion custom layer's live-player proxy: component, props, status, viewers, frames/folder or error (B-282), and `crashedPanels` — every panel showing its "This panel crashed" fallback: panel, message, stack, component stack, time, count (B-292) |
| `debug_set_active_tab` | `{tab: 'edit'\|'motion'\|'colorist'}` (or a 1-based index) |
| `debug_set_sources_panel` | `{open: bool}` — the shell's docked Sources column (Motion / Colorist; the Edit tab lays out its own browser since D-432 P5) |
| `debug_set_library_mode` | `{mode: 'sources'\|'titles'\|'effects'\|'subtitles'\|'recut'\|'music'\|'clipper'\|'index'}` — which library the Edit tab's browser shows (its tab bar), and shows the browser so it is visible; an unknown mode is refused with the accepted list |
| `debug_set_editor_inspector` | `{open: bool}` — the Edit tab's Inspector column |
| `debug_set_editor_layout` | D-432 P5 — `{browserOpen?, browserWidth?, inspectorWidth?, timelineHeight?}` (CSS px; `timelineHeight: null` = the default 42 % share), at least one — the Edit tab's splits, through `useEditLayoutStore.setLayout`, the action a released split calls; clamped to each split's bounds and persisted like a drag; wrong types refused by name |
| `debug_set_inspector_tab` | `{tab: 'video'\|'audio'\|'speed'\|'info'}` — that Inspector's own tab (D-246; four since v0.3.0); only one is on screen at a time, so set it before screenshotting or dumping the panel |
| `debug_set_inspector_section` | v0.3.0 — `{id, open: bool}` — open or collapse one Inspector section (`transform`, `compositing`, `crop`, … `INSPECTOR_SECTION_IDS`), through `setInspectorSectionOpen`, the action the section header's click calls; remembered and persisted like a click. An unknown id is refused with the list |
| `debug_set_popover_open` | `{id, open: bool}` — any registered Edit-tab popover/dialog (D-252, `@apelles/editor`'s `panelRegistry.ts`): `caption-panel`, `canvas-settings`, `export-dialog` today. One op for every popover rather than a bespoke one per popover — see D-252 for why. |
| `debug_dom_tree` | `{selector?, maxDepth?, maxNodes?, styles?, includeHidden?, text?}` → bounded JSON of the real DOM: hierarchy, semantic attributes, `getBoundingClientRect()`, chosen computed styles |
| `debug_frame_timing` | `{limit?, reset?}` → the preview's real rAF/paint intervals (see `@apelles/editor`'s `previewTiming.ts`) |
| `debug_perf_entries` | B-347 — `{prefix?, clear?, waitIdleMs?, traceReleaseMs?}` → the app's own `performance` marks (`apelles:edit:*`, `perfEntries.ts`), optionally after waiting for on-time frames. `traceReleaseMs` (B-374, D-437 S11) arms `releaseTrace.ts`: for that long after each edit commit it records forced layouts (with their caller), timer / rAF / message / observer callbacks, listeners added after arming and main-thread gaps as `apelles:trace:<kind>\|<label>` measures, read back with `prefix: 'apelles:trace:'` |
| `debug_pointer` | D-434 — real pointer input: `{action: move\|down\|up\|click\|doubleClick\|drag\|wheel\|pinch, target, to?, path?, button?, modifiers?, steps?, durationMs?, holdMs?, deltaX?, deltaY?, scale?, mode?, measure?, watch?, settleMs?}`. A target is CSS `{x, y}`, a `{byX, byY}` offset from the previous point, or an element by `selector` / `testid` / `nodeId` plus `at: {fx, fy, dx, dy}`. Replies with what was really under each point, what the page received (`observed`: counts, `isTrusted`, targets), and optionally `perf` and per-frame `watch` rects + cursor (`src/input/`) |
| `debug_key` | D-434 — real key presses: `{keys?: ["meta+KeyZ"], text?, phase?: press\|down\|up, holdMs?, gapMs?, mode?, measure?, watch?, settleMs?}` (DOM `code` names — what the keymap matches on) |

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

## Real input (D-434)

`src/input/` is the UI harness's instrument. `plan.ts` turns a gesture into a timed list of
primitive events (pure, unit-tested); `geometry.ts` resolves targets against the live DOM
and reports what is really under each point; `observe.ts` records what the page received;
`perf.ts` samples frames (and watched rects / the cursor) while the gesture runs; `stats.ts`
is the shared percentile/dropped-frame arithmetic (also used by `packages/ui-harness`).
Two dispatchers play the same plan: **native** (`dispatchNative.ts` → the debug-only Tauri
command `chroma_debug_inject_input`, which delivers real `NSEvent`s into the WKWebView —
trusted events, no macOS permission) and **synthetic** (`dispatchSynthetic.ts`, in-page DOM
events, `isTrusted` false — jsdom and non-macOS only). `mode: "auto"` picks native inside
the app and says so in the reply. This is the one place the package synthesises input: the
state setters above still call store actions, for the reason given there. How the harness
uses it: `docs/notes/ui-harness.md`.

## Boundary

- **Depends on** `@apelles/shell` (the tab/Sources store), `@apelles/editor`
  (the Inspector flag, the preview timing buffers) and `@apelles/motion` (the
  custom-layer proxy store, `customProxyStore.ts`) — one way only, so this
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
by name rather than silently accepted. `src/input/*.test.ts` cover the gesture planner,
target resolution and the perf arithmetic, and `inputOps.timeline.dom.test.tsx` drives the
real `TimelinePane` through `debug_pointer` / `debug_key` (synthetic mode) and checks the
app's own state moved. The other ops are verified live
against a running app; the loop and its results are recorded in
`docs/notes/debug-tooling.md`.

`npm run test --workspace @apelles/debug`, or `npm test` from the repo root.
