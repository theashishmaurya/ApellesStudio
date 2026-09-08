# Internal debug tooling — for agent/dev use, never shipped

Owner, 2026-09-08: build a real set of internal tools that let an agent (a future
Claude Code session) inspect and drive the running Chroma app directly — screenshots,
UI state open/close/select, pixel-level inspection — instead of relying on the owner's
own eyes and manual screenshots every time a UI bug needs verifying. This doc is the
durable tracker for that initiative; individual pieces still get their own `D-NNN`/
bug entries as they land.

**The hard invariant: every tool here is debug-only and MUST be compiled/stripped out
of a production build** — never a runtime flag, never "just don't call it in prod,"
a real compile-time gate (`#[cfg(debug_assertions)]`, a Cargo feature, or equivalent)
so there is no path for one of these to ship. These are for us, not for an end user's
build of Chroma.

**How that gate is actually implemented** (D-219; the Rust half was missing until
then — **B-100**):

- **Rust.** `#[cfg(debug_assertions)]` on `chroma::debug_capture` (the whole module),
  on each command *inside* `tauri::generate_handler!` (the macro parses an outer
  attribute per command and re-emits it on that command's match arm — verified in
  `tauri-macros` 2.6.3's `command/handler.rs`, so the IPC name genuinely does not
  exist in a release build), and on `control.rs`'s `native_op`, which has a
  `None`-returning release twin so its call site reads the same either way.
- **Frontend.** `import.meta.env.DEV` — Vite substitutes the literal `false` in a
  production build — **plus** a dynamic `import()` of the op registry inside that
  branch, so Rollup drops the whole chunk rather than merely leaving it unreachable.
  `@chroma/debug`'s barrel exports exactly one value (the hook) so nothing else is in
  the app's static import graph.
- **Checked, not assumed.** See "Gate verification" at the bottom for the real
  `vite build` + bundle grep.

## Why this exists (the real, repeated problem)

Every agent this session that tried to live-verify a UI fix hit the same wall: this
process has no macOS Screen Recording permission, so `screencapture` fails outright,
and there's no way to see the real running app. The fallbacks used instead (MCP state
polling, blind `cliclick` coordinate guesses, pixel-sampling an EXPORTED file instead
of the live preview) all work but are strictly worse than actually looking at the
screen — and are why a bug like "the on-canvas box doesn't match the picture" took
several rounds of the owner's own screenshots before an agent could even confirm it.

## Pieces

1. **Screenshot capture** — in progress (2026-09-08). A Tauri command using
   WKWebView's own `takeSnapshot` API (an in-process capture the app does of its own
   window content, NOT a system-level screen grab — sidesteps the Screen Recording
   permission wall entirely, doesn't need it) plus an MCP tool wrapping it, so an
   agent can call the tool, get a real PNG path, and `Read` it to actually see current
   state. Status/branch: see `docs/CHANGELOG.md`'s dated entry once it lands.
2. **UI state open/close/select debug actions** — **DONE (D-219, 2026-09-08).**
   Deterministic, non-pixel-coordinate ways to drive the UI, through the same store
   actions a human's click goes through: `debug_set_active_tab` (Edit/Motion/
   Colorist), `debug_set_sources_panel`, `debug_set_editor_inspector`,
   `debug_set_inspector_tab` (D-246 — the clip Inspector's own Video/Audio tab;
   only one renders at a time, so a screenshot of the panel is a screenshot of
   one of them), plus the read
   half `debug_ui_state` (every flag above, the Edit selection/playhead, and the
   dialogs the DOM actually has open). Explicit named ops per real UI state — **not**
   a generic "set any field" backdoor and **not** a synthesised click; D-219 has the
   full reasoning and the one refactor it forced (the Edit Inspector's flag lifted
   out of `EditorTab.tsx`'s `useState` into `useEditorTimelineStore`, so one piece of
   state sits under both the human's button and the op).
   **Extended (D-252, 2026-09-08): `debug_set_popover_open({id, open})`** — one
   generic op for any registered Edit-tab popover/dialog, backed by
   `useEditorTimelineStore`'s `openPanels: Record<string, boolean>` map and
   `@chroma/editor`'s `panelRegistry.ts` (`PANEL_IDS`, `parsePanelId`,
   `usePanelOpen`). Landed because a repo sweep found the D-219 bespoke-field
   shape (one store field + one op + one snapshot line per popover) does not
   scale: `CaptionPanel`'s caption-preset-library popover (the case that
   forced this — needed screenshotting for the owner with no working
   Accessibility/Screen-Recording access to the native window),
   `CanvasSettingsPopover` and `EditorExportDialog` all had the identical
   local-`useState`-gated-open problem, with a fourth uncontrolled one
   (`EditLibraryRail`'s rail popovers) and a fifth keyed one (`MarkerStrip`'s
   marker editor, `editingId: string | null`) also found and deliberately
   left for later — see D-252 and `panelRegistry.ts`'s own module doc for
   why. `debug_get_ui_state`'s `editor` section now also reports
   `openPanels` (the live map) and `panelIds` (`PANEL_IDS`, the reference
   list of what can appear there).
   Registered today: `caption-panel`, `canvas-settings`, `export-dialog`. Add
   a new one by adding its id to `PANEL_IDS` and swapping its component's
   `useState(false)` for `usePanelOpen(id)` — no new op, no new store field.
   **Remaining gap, deliberately:** the **Colorist tab's** own panel/visibility/
   settings state (`app/src/store/useUIStore.ts` — `setPanel`, `uiVisibility`,
   `isSettingsOpen`). It lives in the vendored fork, i.e. the *app* layer, and
   `@chroma/debug` is a package; reaching up would invert D-039's dependency
   direction. Closing it properly means either moving that UI state into a package or
   having the app register its own named ops into the registry — a real design call,
   not a line of code, so it is stated here rather than half-done. Also still open:
   `EditLibraryRail`'s uncontrolled rail popovers and `MarkerStrip`'s
   `editingId`-keyed marker editor (see D-252).
3. **Pixel/color inspection** — **DONE, in D-210** (it shipped alongside the
   screenshot tool, not after it). `debug_sample_pixel(path, x, y)` reads the exact
   RGBA + hex out of **any** saved PNG, including one written long before the app's
   current state, and refuses an out-of-bounds coordinate with the real image size.
   Re-checked against this piece's own wording during D-219 and found already
   complete — nothing was rebuilt. The one thing worth knowing when using it with
   piece 4: its coordinates are **device** pixels, `debug_dom_tree`'s rects are
   **CSS** pixels, so multiply by the screenshot's `scaleFactor`.
4. **DOM tree capture** — **DONE (D-219, 2026-09-08).** `debug_dom_tree
   {selector?, maxDepth?, maxNodes?, styles?, includeHidden?, text?}` returns the
   real hierarchy under a selector: tag/id/classes, the semantic attributes
   (`data-*`, `aria-*`, `role`, …), each element's `getBoundingClientRect()`, and a
   chosen set of computed styles.
   **Tauri has no eval-with-result** — `WebviewWindow::eval()` returns `Result<()>`
   in 2.11 (checked, not assumed), so the choice was "a custom event bridge around an
   untyped JS string" vs. "an ordinary frontend op." It is a frontend op
   (`@chroma/debug`'s `domTree.ts`), which is what D-020 already prescribes and which
   makes the serialiser real TypeScript with a jsdom unit suite.
   **Bounded three ways** (selector root, `maxDepth` 12, `maxNodes` 300/ceiling 5000,
   plus per-node class/text caps) and **every bound reports itself** —
   `childrenTruncated: "depth"|"nodes"|"invisible"` on the node, `truncated` on the
   result — so a clipped dump can never be mistaken for a complete one. A `0×0`
   element is flagged `zeroArea` but is **never** pruned: a zero-size parent whose
   children still render is exactly the bug this is for.
   Stable query hooks exist on the two big panels: `[data-chroma-panel=
   "editor-inspector"]`, `[data-chroma-panel="sources"]`.

5. **Preview frame-timing readout** — **DONE (D-219, 2026-09-08)** (found needed by
   D-217). `debug_frame_timing {limit?, reset?}` reports the real frame-to-frame
   intervals on **two independent channels**: `paint` (frames actually put on screen)
   and `raf` (how often the play loop got to run at all), each with
   min/median/p95/max/fps and a `hitches` count (intervals over *twice the median* —
   a fixed ms threshold would call every interval a hitch on a 24 fps timeline).
   D-217 fixed the preview's dominant per-frame cost (42.7 → 14.0 ms) and could
   measure that precisely in Rust, but **could not measure the thing the owner
   actually reported** — perceived playback smoothness. Two blockers were found
   trying, both still true and both sidestepped by measuring in-app: a second app
   instance needs the `identifier` overridden (`tauri-plugin-single-instance`), and a
   **background** window's `requestAnimationFrame` is throttled to a stop. That
   second one is now *diagnosable* rather than merely fatal — a dead `raf` channel
   next to a healthy `paint` one is the signature of a throttled window, so the
   readout tells you you are measuring the wrong thing instead of quietly reporting
   0 fps.
   Measure properly: `debug_frame_timing(reset=True)` → `editor_set_playing(True)` →
   wait → `editor_set_playing(False)` → read. Without the reset, scrub frames are
   mixed in with playback.

## Two different levels — don't conflate them

- **Component level** (a single component in isolation, e.g. `PreviewPane`/
  `TimelinePane`): mostly ALREADY SOLVED, before this initiative — the D-142
  browser harness (`app/harness.html?mode=preview` etc.) is a real Chromium tab,
  reachable via `chrome-devtools`/`claude-in-chrome` MCP tools INCLUDING their own
  screenshot action, with none of the Screen Recording permission problem (it's a
  normal browser tab, not the native window). Several agents this session already
  used it for real hit-testing/pointer-gesture verification. Prefer extending this
  harness (a new `?mode=` if one doesn't exist yet for what needs isolating) over
  building a new mechanism, for anything that can be exercised there.
- **Whole-app level** (the real, native, WKWebView-backed Tauri window, actually
  opening a project/tab/panel and interacting with it as a user would): this is the
  actual gap items 1–4 above exist to close — no existing tool reaches this level.
  "Work as a user — open things, edit things, take a screenshot to validate" (owner,
  2026-09-08) means items 1 (screenshot) and 2 (open/close/select) together, as one
  real loop: drive a real state change through the same store actions/Tauri commands
  a human's click would, then screenshot to confirm what actually rendered — not two
  independent tools used separately.

## The loop, concretely (this is what all five pieces are FOR)

```
debug_ui_state()                             # what's open right now
debug_set_active_tab("edit")                 # → useShellStore.setActiveTab
debug_set_editor_inspector(open=True)        # → useEditorTimelineStore.setInspectorOpen
debug_set_inspector_tab("audio")             # → useEditorTimelineStore.setInspectorTab
debug_set_popover_open("caption-panel", True)  # → useEditorTimelineStore.setPanelOpen
debug_screenshot()                           # → a real PNG path; Read it, look at it
debug_dom_tree('[data-chroma-panel="editor-inspector"]', max_depth=3)
                                             # → its REAL rect + computed styles
debug_sample_pixel(shot_path, x, y)          # ← rect.x * scaleFactor, inside the panel
```

Coordinate spaces: `debug_dom_tree` rects are **CSS** pixels, `debug_screenshot` /
`debug_sample_pixel` are **device** pixels. Multiply by the screenshot's `scaleFactor`
(the same number as the DOM result's `viewport.devicePixelRatio`) to cross over. Getting
this wrong reads as a wrong colour rather than as an error, so it is worth checking the
two numbers against each other once per session.

### That loop, actually run (2026-09-08, D-219's own verification)

A real `tauri dev` instance from an isolated worktree (`CHROMA_CONTROL_PORT=19791`,
vite on 1421), a real project, a real 4K clip on the timeline. Numbers, not claims:

- `debug_ui_state` on a fresh boot: `activeTab: "edit"`, `projectOpen: false`,
  `timelineStatus: "idle"`, `openDialogs: []`. After opening a project:
  `projectOpen: true`, `timelineStatus: "ready"`.
- `debug_set_editor_inspector(open=False)` → `{inspectorOpen: false}`, and
  `debug_dom_tree('[data-chroma-panel="editor-inspector"]')` then returned
  `root: null` — the panel is genuinely **unmounted**, not merely hidden.
- `debug_set_editor_inspector(open=True)` → the same query returned a real node:
  rect `x 960, y 40, 320 × 680` CSS px in a `1280 × 720` viewport,
  `background-color: rgb(28, 28, 28)`, `width: "320px"` — which independently
  confirms D-118's `INSPECTOR_DEFAULT_WIDTH = 320`.
- `debug_screenshot` → `2560 × 1440`, `scaleFactor 2.0`. Read and looked at: the
  Inspector really is the right-hand column, "Select a clip to edit its properties."
- **DOM and pixels agree**: `debug_sample_pixel` at device `(2000, 600)` — i.e. CSS
  `(1000, 300)`, inside that rect — read `#1c1c1c` = `rgb(28, 28, 28)`, exactly the
  computed `background-color` the DOM reported. 50 CSS px to the left, outside the
  panel, read `#0e0e0e`. That is the whole point of the initiative in two numbers.
- `debug_set_sources_panel(open=True)` → a second screenshot shows the Sources column
  really opened; `debug_dom_tree` puts it at `x 0, 288 × 680` (matching
  `SOURCES_PANEL_DEFAULT_WIDTH = 288`).
- Bounds, live: `maxNodes: 12` returned exactly 12 nodes with
  `childrenTruncated: "nodes"`; `maxDepth: 0` returned 1 node with
  `childrenTruncated: "depth"`; a Tailwind button reported `classesTruncated: true`.
  An inactive tab panel came back `invisible: true`, `zeroArea: true`,
  `display: "none"`, `childrenTruncated: "invisible"` — which is also why a full-body
  dump is only ~375 nodes rather than thousands.
- Refusals, live: `tab: "edti"` → *unknown tab "edti" — expected one of edit, motion,
  colorist*; `tab: 9` → *tab index 9 is out of range — 1..3 (…)*; a missing `open` →
  *'open' is required (true or false)*; `selector: "<<<"` → *invalid selector: '<<<' is
  not a valid selector.* (distinct from a no-match, which is `root: null`);
  `limit: 0` → *'limit' must be a positive integer*.
- Routing: `debug_nonesuch` → *unknown debug op: debug_nonesuch* while `nonesuch` →
  *unknown op: nonesuch*, so the `debug_` prefix really is claimed by the new registry
  and the Colorist catch-all really does still answer everything else. No response-slot
  race.
- **`debug_frame_timing`, and the throttling blocker it was built for.** Reset, then
  `editor_set_playing(true)` for ~6 s, then read: **`raf.samples: 0`, `paint.samples:
  0`** — the play loop never ticked once, because the instance was not frontmost.
  That is D-217's blocker (2) reproduced exactly, and it is now *diagnosable in one
  call* instead of looking like a frozen playhead of unknown cause. Scrubbing needs no
  rAF, and the paint channel does record on that path: seven `editor_set_playhead`
  calls produced `paint.samples: 2`, one 90 ms interval, `fps 11.11` — two, not seven,
  because `fetchFrame` coalesces while a request is in flight (D-125/D-201), so the
  readout is correctly counting frames that *reached the screen* rather than requests
  made.
- **Not live-exercised:** the positive `openDialogs` case. Nothing in the op surface
  opens a modal today, so live only ever showed `[]` (correct for the state). The
  detection itself is unit-tested in jsdom, including the `display:none` rejection.
  Also not exercised: a real pointer drag — same standing limit as D-216's own note
  (no Screen Recording / Accessibility permission, and a `decorations: false` window
  exposes no Accessibility target).

## Running a second instance (for an agent, alongside the owner's own app)

Recorded because two separate agents have now had to rediscover it. No committed file
changes are needed:

```
npx vite --port 1421 --strictPort            # in app/, its own dev server
CHROMA_CONTROL_PORT=19791 npx tauri dev --no-watch --config \
  '{"build":{"beforeDevCommand":"","devUrl":"http://localhost:1421"},
    "identifier":"io.chroma.debugtools.worktree"}'
```

The `identifier` override is what `tauri-plugin-single-instance` keys on — without it
the second launch just focuses the first app's window and exits. `--no-watch` stops the
dev watcher from rebuilding under the running instance. A worktree also needs its own
`node_modules` (`npm install` in the worktree), or Node resolution walks up and serves
the *shared* checkout's `@chroma/*` — see D-216's own note about that exact trap.

**Then always kill it by PID**, never by process name: `pkill RapidRAW` or
`pkill node` will take the owner's app and dev server down with it, which has
already happened once (2026-09-07).

## Gate verification — the numbers, not the claim

Re-run these whenever a debug tool is added; a gate that is asserted rather than
checked is how B-100 happened in the first place.

- **Frontend.** `npm run build --workspace app`, then grep `app/dist/` for every debug
  op name. Run 2026-09-08 on D-219's tree: `debug_get_ui_state`, `debug_set_active_tab`,
  `debug_set_sources_panel`, `debug_set_editor_inspector`, `debug_dom_tree`,
  `debug_frame_timing`, `debug_screenshot`, `debug_sample_pixel`,
  `chroma_debug_screenshot`, `chroma_debug_sample_pixel`, plus the internal symbols
  `serializeDomTree`, `describeOpenDialogs`, `previewTimingReport`,
  `recordPreviewTiming` — **0 occurrences each**, and no separate `debugOps` chunk was
  emitted (one `index-*.js`). The control-server op `editor_set_selection` was grepped
  in the same pass as a control and found **1** occurrence, so the grep was reading a
  real bundle.
  Re-run 2026-09-08 for D-246's new op: `debug_set_inspector_tab` — **0** occurrences,
  as are `debug_get_ui_state` and `debug_set_active_tab` on the same build. Its own
  store action `setInspectorTab` is present (**1**), and must be: that is the function
  the human's tab button calls, exactly as `setInspectorOpen` (**2**) is. The op name
  being absent while the action it calls is present is precisely the shape this gate is
  supposed to have.
  Re-run again 2026-09-08 for D-252's new op: `debug_set_popover_open` — **0**
  occurrences. Its own store action `setPanelOpen` — the function `usePanelOpen`
  calls, which is what `CaptionPanel`'s/`CanvasSettingsPopover`'s/
  `EditorExportDialog`'s own triggers now call instead of a local `useState`
  setter — is present (**2**), the same absent-op/present-action shape as
  every check above. Still one `index-*.js` chunk, no separate `debugOps` or
  `panelRegistry` chunk.
- **Rust.** `cargo check -p RapidRAW --release --lib` compiles clean with the whole
  `debug_capture` module and both commands cfg'd out (release turns `debug_assertions`
  off), which also proves nothing outside the gate still references them.

## Status

Pieces 1–5 are all built as of 2026-09-08 (D-210 for 1 and 3; D-219 for 2, 4, 5; B-100
for the gate; D-252 extending piece 2 with `debug_set_popover_open`). Stated remaining
gaps: the **Colorist tab's** own panel/visibility/settings state, `EditLibraryRail`'s
uncontrolled rail popovers, and `MarkerStrip`'s `editingId`-keyed marker editor — see
piece 2 above for why each is a real design call rather than a missing line of code.

Check `docs/CHANGELOG.md` (search "debug" or the date) for what has actually landed —
this file is the scope/tracker, not a live status board.
