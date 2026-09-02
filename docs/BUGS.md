# BUGS

Real defects only — in our code or the engine. Not setup/housekeeping. Move to GitHub
Issues once public.

```
## B-NNN — title
status: open | fixed | wontfix   ·   severity: blocker | high | medium | low   ·   area: …
repro / expected / actual / cause / fix
```

## Known engine constraints (design around these — not bugs)

Refreshed 2026-09-02 (docs-reconciliation pass) — three items previously listed here are
solved and removed:
- ~~Render entry points are Tauri-coupled~~ — fixed by **D-014** (`render_core` extraction,
  done 2026-09-01); the grade path is callable headless (export, the eval harness).
- ~~Masks are static per image — no keyframe/tracking model~~ — SAM 2 video tracking shipped
  (**D-018**) and mask keyframes shipped (**D-034**, done 2026-09-02).
- ~~Depth Anything is wired for stills only; per-frame video flickers~~ — a real temporal
  depth track shipped (**D-036**, Video Depth Anything-vits, done 2026-09-02); the
  single-frame ONNX bake is still used for stills and pre-track, by design, not as a gap.

Still real:
- `process_and_get_dynamic_image` bypasses the GPU and returns the source unprocessed if
  `w|h > max_texture_dimension_2d` — watch at 8K.

## Open

## B-010 — `ExportPanel` (`Panel.Export`) is reachable and appears usable while a video clip is loaded, but silently attempts a still-image export against the video's own path
status: open · severity: low (a working, prominent alternative — `ExportDialog`, D-049 — now exists; this is dead-end UX, not data loss) · area: `app/src/components/panel/right/ExportPanel.tsx`, `app/src-tauri/src/export_processing.rs`
- **repro:** open a video clip in the Colorist tab, click the "Export" icon
  in the panel switcher (`Panel.Export`), pick any format, click Export.
- **expected:** either the panel is unavailable for video content, or it
  exports something sensible from the clip (a frame, or the graded video).
- **actual:** `selectedImage.path` for a loaded video shot is the clip's own
  file path (`useSessionStore`'s `applyLoaded` — no still/video branch), so
  `ExportPanel`'s `numImages`/`canExport` read as if a real image were
  selected. Clicking Export calls `Invokes.ExportImages` →
  `export_processing.rs`'s `export_images_impl`, which `image::open()`s the
  path as a still — this will error (or, worst case, silently mis-handle a
  path `image` happens to partially parse) on a video container.
- **cause:** `ExportPanel` is RapidRAW's unmodified still-image exporter; it
  was never taught about `useChromaStore.videoInfo`/video-ness, because
  nothing in the Colorist pivot (D-039/D-043) ever routed a real video
  export through it — that gap is exactly what D-049's `ExportDialog`
  fills, via the correct backend (`chroma_export_video`).
- **fix (not done — out of scope for D-049):** gate `Panel.Export`'s
  availability/rendering on `!videoInfo?.isVideo` (simplest), or teach
  `export_images_impl` to route a video path to the real video-export path
  instead of `image::open()`. D-049 deliberately left `ExportPanel` fully
  routed rather than partially unrouting it — see that decision for why.

## Fixed

## B-009 — duplicate `remotion` packages crash the app at runtime with "Multiple versions of Remotion detected"
status: fixed (2026-09-02) · severity: blocker (crashed frontend mount entirely, not just the Motion tab) · area: root `package.json` `overrides`, `packages/motion-engine/package.json`'s caret-pinned `@remotion/*` deps
- **repro:** boot the app (`npm run tauri:dev`) with `packages/motion-engine`'s
  `@remotion/animation-utils`, `@remotion/google-fonts`, `@remotion/motion-blur`,
  `@remotion/noise`, and `@remotion/transitions` (+ its own `@remotion/shapes`
  dependency) pinned with a caret range (`^4.0.519`) while every other
  `@remotion/*`/`remotion` dependency in the workspace is pinned exactly
  (`4.0.519`).
- **expected:** the app boots; the Motion tab (which imports
  `@remotion/google-fonts` via `Video.tsx`'s top-level `loadFont()` call —
  evaluated at module-load time, unconditionally, regardless of which tab
  is visually active, since `@chroma/shell` keeps every tab mounted) loads
  without error.
- **actual:** the whole frontend fails to mount. Vite's client logs an
  unhandled error — `TypeError: 🚨 Multiple versions of Remotion detected:
  4.0.520 and 4.0.519` — thrown by Remotion's own runtime version-check
  (`checkMultipleRemotionVersions`), and the Rust side times out waiting
  for `frontend_ready`, logging "Frontend failed to report ready within
  timeout. Forcing window visibility" and showing a blank window.
- **cause:** a caret range lets npm resolve to the newest *published*
  matching version at install time, not the version every other package in
  the tree is pinned to. `4.0.520` was published after `4.0.519`, so npm
  resolved the five caret-pinned `@remotion/*` packages (each an exact
  dependency on `remotion@4.0.520`, matching their own package version) to
  a nested `4.0.520` install, while the rest of the tree correctly deduped
  to the exactly-pinned `4.0.519`. Remotion's runtime hard-errors the
  instant two `remotion` module instances load in the same page — by
  design, since mixed-version Remotion internals aren't guaranteed
  compatible.
- **fix:** a root `package.json` `overrides` block pins `remotion` and all
  five caret-pinned `@remotion/*` packages to the exact `4.0.519` used
  everywhere else. **A newly-added/changed `overrides` key did not reliably
  take effect via an incremental `npm install`, even after `rm -rf
  node_modules`** — the existing `package-lock.json`'s already-resolved
  entries for those packages kept getting replayed. Only a genuinely fresh
  resolution — `rm -rf node_modules package-lock.json && npm install` —
  produced a lockfile with exactly one `remotion` install (root, `4.0.519`,
  confirmed via `find . -path "*/node_modules/remotion/package.json"`).
- **verification:** a real `npm run tauri:dev` boot, twice, with the dev
  server stdout and the app's own log file both staying clean for the
  whole session — no "Multiple versions of Remotion" error, no
  frontend-ready timeout — versus every prior boot attempt this session
  hitting the error within seconds of the frontend starting to evaluate.

## B-008 — `@react-three/fiber`'s global JSX augmentation breaks any `React.ElementType`-typed component sharing its `tsc` program
status: fixed (2026-09-02) · severity: medium · area: `packages/ui/src/Text.tsx`, `app/src/components/panel/BottomBar.tsx`
- **repro:** in a `tsc` program that includes any file importing
  `@react-three/fiber` (e.g. `@chroma/motion-engine`'s `Scene3D.tsx`/
  `ParticleFlow.tsx`, first pulled into `app`'s program by wiring the
  Motion tab, D-046) alongside a component that renders a
  `React.ElementType`-typed prop via JSX (`<Component {...props}>` where
  `Component`'s static type is `React.ElementType`, not a concrete tag).
- **expected:** unrelated files type-check independently of what else is in
  the program.
- **actual:** the unrelated component fails to type-check —
  `error TS2745: This JSX tag's 'children' prop expects type 'never'…` and
  similar `never`-typed prop errors — even though nothing about that
  component changed.
- **cause:** `@react-three/fiber` augments the **global** `JSX.IntrinsicElements`
  interface (that's how `<mesh>`, `<group>`, etc. type-check anywhere) — a
  program-wide effect, not scoped to files that import r3f. Once present,
  `React.ElementType` (`keyof JSX.IntrinsicElements | ComponentType<any>`)
  is a much larger union that now includes r3f's custom intrinsics, whose
  prop shapes don't share a compatible `children` type with DOM elements.
  TS computing the intersection of props across that whole union for a
  dynamic `<Component>` JSX call collapses `children` (and other props) to
  `never`. Two pre-existing components used this "dynamic tag via a
  `React.ElementType` prop, rendered with JSX" pattern and both broke the
  moment r3f entered the same program for the first time: `@chroma/ui`'s
  `Text.tsx` (`as` prop) and `app`'s `BottomBar.tsx`'s `PanelToggleButton`
  (`Icon` prop).
- **fix:** `React.createElement(Component, props, children)` /
  `createElement(Icon, { size: 18 })` in place of JSX for that one call in
  each file — behaviorally identical (JSX desugars to the same call at
  runtime; this changes nothing about what renders), but `createElement`'s
  generic signature doesn't distribute over `JSX.IntrinsicElements` the same
  way JSX's own type-checking does, so it type-checks correctly whether or
  not r3f's augmentation is present.
- **verification:** a strict `tsc --noEmit` diff of `app/` before vs. after
  the full Motion tab change (file list, not just count) came back
  byte-identical (64 errors either side) — used specifically to catch every
  instance of this pattern application-wide, not just the ones exercised by
  manually clicking through the UI. Any *other* `React.ElementType`-via-JSX
  component elsewhere in the codebase would show up the same way if r3f's
  augmentation reaches its program later.

## B-007 — Edit tab stuck on stale "no project open" after opening a project in Colorist
status: fixed (2026-09-02) · severity: medium · area: app/src/main.tsx, @chroma/shell tab persistence
- **repro:** open the app, open/create a project in the Colorist tab, switch to the Edit tab
  in the same window (no alt-tab away and back).
- **expected:** Edit shows the real timeline for the project that was just opened.
- **actual:** Edit kept showing "No project open" until either the user hit its "Retry"
  button, or the OS window happened to lose and regain focus (alt-tab) — a real fix
  eventually arrived, just not from opening the project itself. Owner correctly diagnosed
  this live as a "state mounted at the Colorist level, not global" question before the fix
  was found.
- **cause:** `@chroma/editor`'s `EditorTab` only calls its timeline store's `load()` on its
  own mount and on the browser `window`'s `focus` event (see its `useEffect`s) — neither
  fires when a project opens from the Colorist tab, since all 3 tabs stay mounted under
  `@chroma/shell` (D-039) and switching tabs is not a window focus event.
- **fix:** `app/src/main.tsx` (the composition root — the one place that legitimately knows
  about both `useSessionStore`'s real "project is open" signal and `@chroma/editor`'s
  timeline store, without either package importing the other) now calls
  `useEditorTimelineStore.getState().load()` in a `useEffect` keyed on the same
  `projectOpen` boolean that already drives the shell's launcher-vs-tabs routing.
- **also fixed alongside (same root cause family):** `@chroma/shell`'s `activeTab` was
  persisted to `localStorage`, which meant the owner's explicit "Edit opens by default, not
  Colorist" request (2026-09-02, `D-039`/earlier `B-004` commit) only held on a machine that
  had never clicked another tab — every real session immediately overrode it back to
  whatever tab was last open, reading as if the default fix never landed. `activeTab` is now
  session-only (`packages/shell/src/store.ts`); every launch starts on `DEFAULT_TAB` ('edit').

## B-006 — Colorist main preview stays black even once the wgpu transform is positioned correctly
status: fixed (2026-09-02) · severity: high · area: `@chroma/shell` root background (`packages/shell/src/Shell.tsx`) — not gpu_processing.rs
- **repro:** open a project with a video shot in the Colorist tab; the shot-strip thumbnail
  renders fine, the main preview viewport never shows anything (solid dark/black).
- **expected:** the main preview shows the decoded, graded frame — the native wgpu surface,
  drawn directly onto the window behind a transparent hole in the webview at the preview
  panel's on-screen position (see `update_wgpu_transform`, `WgpuDisplay::render`).
- **actual (pre-fix):** `apply_adjustments` logs confirmed a real WGPU render fired at the
  *correct* output resolution and the *correct* on-screen position — the panel was still
  visually black regardless.
- **cause:** the render pipeline itself was never the problem. D-039's `@chroma/shell`
  wraps the whole window in a new root `<div>` (`Shell.tsx`) that carried a hardcoded,
  unconditional `bg-bg-primary` (opaque). The Colorist app's own root (`App.tsx`) already
  punches a transparent "hole" through itself (`isWgpuActive ? 'bg-transparent' :
  'bg-bg-primary'`) so the OS-transparent window (and the wgpu surface drawn directly onto
  it) shows through — but that hole only reveals whatever sits *behind* it in the DOM, which
  after D-039 is the shell's own new, permanently-opaque background, not the real
  transparent window. Before D-039 the Colorist app's root *was* the window's content root,
  so there was no opaque ancestor in the way and the trick worked. The shell's own opaque
  background silently defeated it once introduced — a plain CSS stacking regression, not an
  NSView/CALayer ordering issue and not a scissor/DPI bug.
- **how this was actually isolated (not by reasoning alone):** with no screen-recording
  permission available in the session that found this (`screencapture` failed with
  "could not create image from display" from every invoking path tried), two proxies stood
  in for a real screenshot: (1) a temporary debug hook in `WgpuDisplay::render` re-ran the
  *exact same* clear/scissor/bind-group/draw call into an off-screen `COPY_SRC` texture
  (the swapchain texture itself doesn't support `COPY_SRC`) and dumped it to PNG — this
  showed the real graded frame, correctly positioned, proving the render pass, scissor math,
  and bound texture were all already correct, and pointing the remaining search at
  compositing/visibility rather than rendering; (2) after the fix, a live
  `getComputedStyle` read of the shell root in the running app confirmed its
  `background-color` actually flips to `rgba(0, 0, 0, 0)` exactly when the Colorist wgpu
  surface is active. Both were run against the real app with the real
  `~/Movies/Chroma/New.chroma` project open. A final from-cold-boot re-check hit an
  unrelated environment wedge (WebKit's `markLayersVolatile`/process-suspension throttling
  the webview after this session's own repeated hard `kill -9` cycles on the dev app — see
  `sample`/`log show` trace from that session; confirmed unrelated to this fix since
  `gpu_processing.rs` and `lib.rs` carry zero diff from before the investigation started)
  and was not retried further; the two proxies above are the verification this fix rests on,
  not a literal on-screen screenshot.
- **fix:** `packages/shell/src/store.ts` — add a session-only (not persisted)
  `wgpuSurfaceActive` flag to `useShellStore`. `app/src/App.tsx` mirrors its own
  `isWgpuActive` into that flag via a `useEffect` (app → shell is the correct dependency
  direction here; shell still never imports the Colorist app). `Shell.tsx`'s root class now
  reads it: `wgpuSurfaceActive ? 'bg-transparent' : 'bg-bg-primary'`, restoring the same
  "no opaque ancestor between the window and the app's own hole" invariant D-039 broke. The
  tab bar and the project-launcher overlay both paint their own explicit backgrounds so they
  stay opaque regardless.
- **not this bug, ruled out during investigation:** `WgpuDisplay::render`'s scissor/clip
  math and `self.config` sizing — a live debug log during investigation showed
  `config` tracking the real window size correctly (the existing `on_window_event`
  `Resized` handler does keep it in sync) and the scissor bounds landing well inside it with
  `will_draw=true` every time; the off-screen dump then confirmed the draw itself was
  correct. Not a DPI/physical-vs-logical-pixel mismatch either — both sides already agree on
  physical pixels.

## B-005 — Colorist wgpu-position sync loop permanently stuck hidden after one transient 0×0 layout read
status: fixed (2026-09-02) · severity: high · area: app/src/components/panel/Editor.tsx (syncWgpu)
- **repro:** open a project / switch tabs so the preview container's `getBoundingClientRect()`
  briefly reads `0×0` during a layout transition (e.g. a tab switch) at the same moment
  `hasRenderedFirstFrame` flips true.
- **expected:** once the container actually lays out to a real size, the native wgpu frame
  is positioned there and becomes visible.
- **actual:** the frame stayed hidden (positioned at `x:-999999,y:-999999`) forever, even
  after the container had a real, valid size — required an unrelated dependency-array change
  (e.g. toggling a setting) to ever recover, or never recovered at all.
- **cause:** `syncWgpu`'s `requestAnimationFrame` self-scheduling loop only reschedules itself
  when the outgoing "hidden transform" string changes (a dedup guard against redundant
  `invoke()` calls). A transient `0×0` read produces one specific hidden-transform string;
  once sent, the loop stops rescheduling — nothing re-measures the container after that,
  since real DOM layout changes aren't part of the effect's dependency array (only React
  state is). Confirmed via a temporary debug log: `hasRenderedFirstFrame: true` but
  `rectW: 0, rectH: 0` at the exact moment the loop went silent.
- **fix:** split the single hidden-condition check into `notLaidOutYet` (a DOM-measurement
  state, not covered by any dependency array — must keep polling every frame until it
  resolves) vs. `notReadyToRender` (real React-state conditions, correctly covered by the
  existing dependency-array effect). `notLaidOutYet` now unconditionally calls
  `scheduleSync()` even when the outgoing transform was deduped, so measurement keeps
  polling until the container genuinely has a size — without spamming `invoke()`, which
  stays deduped as before.

## B-004 — entry module double-executes on every cold boot → corrupted Tauri IPC → "No project open" in Edit, blank Colorist preview
status: fixed (2026-09-02) · severity: blocker · area: app/index.html, frontend↔backend IPC
- **repro:** fresh `npm run tauri:dev` (verified across independent cold boots, port + processes killed first). Within ~2s of "Logger initialized successfully": `ReactDOMClient.createRoot() on a container that has already been passed to createRoot()`, then a burst of `[TAURI] Couldn't find callback id N` warnings and `Unhandled promise rejection TypeError: undefined is not an object (evaluating 'listeners[eventId].handlerId')` in `@tauri-apps/api/event.js`'s `_unlisten`, repeated several times.
- **expected:** Edit tab shows a real timeline once a project with shots is open in Colorist; Colorist's main preview viewport shows the current frame (not just the shot-strip thumbnail).
- **actual:** Edit tab stuck on "No project open" even with a project open and a shot visible in Colorist's shot strip; Colorist's own main preview viewport blank, though its shot-strip thumbnail rendered fine and the Rust backend logged successful `[apply_adjustments] … native WGPU display updated` renders. After the corruption, no further `invoke`/`listen` round-trip reached React for the rest of the session.
- **cause:** `app/index.html`'s entry `<script>` still pointed at `/src/main.jsx`, a file that hasn't existed since the D-039 TS rename (`main.tsx` is the real entry) — a dead reference `git log` shows predates `main.tsx`. Confirmed via a temporary `import.meta.url` probe at the top of `main.tsx`: on cold boot the module body runs **twice**, once for each of two distinct URLs — `http://localhost:1420/src/main.jsx` (the browser's literal fetch of the stale `<script src>`, which Vite's dev-server extension-probing fallback resolves to `main.tsx`'s real source and serves under the wrong module id) and `http://localhost:1420/src/main.tsx` (a second, genuinely separate fetch/execution of the same file under its correct canonical URL). Two independent top-level module executions call `createRoot()` on the same `#root` DOM node and independently wire up `useTauriListeners`' `listen()` calls (including `wgpu-frame-ready`, which the Colorist preview depends on) against the same shared `@tauri-apps/api/event.js` singleton, racing on `listen`/`unlisten` bookkeeping and corrupting the callback-id map — after which further `invoke`/`listen` resolutions silently stop reaching React. `chroma_timeline_get`'s real error text (`"no project open — open one in the Colorist tab"`) matches exactly what Edit tab's empty-state renders, confirming the open-project `invoke` was one of the calls that never resolved correctly.
- **fix:** `app/index.html` — `<script type="module" src="/src/main.jsx">` → `/src/main.tsx`. Re-verified with the same `import.meta.url` probe on a fresh cold boot: the module executes exactly once, no `createRoot` warning, no `unlisten` TypeError, for the whole session. Re-verified the two user symptoms directly (via `osascript`/System Events driving the real app window, since WKWebView exposes real accessibility): opened the existing `~/Movies/Chroma/New.chroma` project (a genuine saved `.chroma` project, not an Untitled/loose-clip session) — Edit tab's "No project open" state was replaced by a real Timeline pane, and Colorist's main preview `<img>` (726×516, positioned as the main viewport, distinct from the 49-thumbnail shot strip) rendered, with matching `[apply_adjustments] … WGPU display updated` log lines tied to the same action.
- **note:** unrelated to this bug — that one test project's `project.json` already had a *persisted-empty* `timeline` field (0 clips despite 1 shot) predating this session, most likely written during an earlier session while this same corruption was active. `chroma_timeline_get` returns a project's persisted timeline as-is once one exists (by design, D-041) rather than rebuilding, so that project's Edit timeline still shows 0 duration until its `timeline` field is cleared or a shot is re-added — a stale-data artifact of the bug's *effects*, not a remaining defect in the fix.

## B-002 — AI sidecar climbs to ~12 GB after repeated "Re-track"
status: fixed (2026-09-01) · severity: high · area: ai/server.py
- **repro:** load a video, track a subject, hit "Re-track subject across clip" several times (or scrub a lot during a track).
- **expected:** sidecar RSS bounded — one predictor + models ≈ 1–1.5 GB.
- **actual:** ~12 GB (mostly compressed under memory pressure; `ps` RSS showed ~330 MB resident, Activity Monitor "Memory" 12 GB). Machine hit 20 GB swap.
- **cause:** each `/track` built a *fresh* `SAM2DynamicInteractivePredictor` (~1 GB into the MPS pool, which never returns to the OS); track + on-seek `/refine_track` + ViTMatte warm-up ran concurrently, stacking their MPS working sets. The propagation loop itself is flat (verified — `memory_bank` stays at 1).
- **fix:** `_GPU` lock serialises every model call (per-frame in the track loop so refine interleaves); `_get_video_predictor` reuses one instance with per-track state reset; `_free_gpu()` (`empty_cache` + `gc`) after every `/segment`, `/refine_track`, and track pass; `/track` cancels any still-running track. Measured after: plateaus ~1.3 GB across repeated tracks, refines pull it back toward ~800 MB (577 MB after an hour of heavy testing).

## B-003 — tracking seek: render storm, frozen timeline, offset overlay
status: fixed (2026-09-01) · severity: high · area: engine + frontend
- **repro:** track a subject, click/scrub the timeline.
- **actual:** timeline playhead frozen; canvas re-rendering continuously (`apply_adjustments` ~30×/s); red overlay a person-shaped blob offset from the actual subject.
- **cause:** (1) `useAiMasking` (with the per-seek matte-swap effect) is mounted in 3 components → 3× work per seek, and it fired on every intermediate drag frame — each a `setAdjustments` + full re-render. (2) frame vs matte desync: `frameNonce` bumps faster than `setAdjustments` settles → frame-N matte on frame-M image. (3) `ChromaTimeline` root `onPointerDownCapture={e=>e.stopPropagation()}` ate the strip's own `onPointerDown` — clicks did nothing.
- **fix:** **D-019** — matte read from disk at render time (`generate_ai_subject_bitmap` → `tracked_full_mask`), no per-seek `setAdjustments`; a seek just bumps `frameNonce`. Root capture-phase `stopPropagation` moved onto the strip handler.
