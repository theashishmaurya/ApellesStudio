# CHANGELOG

One or two lines per session. Detail lives in the decision it references.

## [Unreleased]

- **2026-09-09** — **D-263: the Edit tab's left library becomes a real activity
  bar — rail on the far left, its buttons switching the DOCKED column** — the
  owner, live, with screenshots: *"as we open this and we have text, other
  things like effects, it should be opening in this panel only as we switch —
  and this panel should be to the left of the open panel, not the other way
  around."* Both halves were real. The rail's Title/Effects/Subtitles buttons
  opened floating popovers (D-248, whose "a drag out of a popover keeps it
  open" reasoning stops applying once nothing is a popover — Sources has dragged
  media out of this very column with a plain `draggable` div since D-046), and
  the rail rendered to the RIGHT of the column it switches, which no reordering
  inside `EditorTab.tsx` could fix: Sources is shell-level (D-046/D-116) and the
  rail is tab-local (D-248). Solved with the pattern this repo already had for
  exactly that — D-251's per-tab injected node: `ShellTab` gains `libraryRail`
  and `libraryPanel`, `Root.tsx` supplies both, and `Shell.tsx` still imports
  nothing from `@chroma/editor`. The rail is now four buttons (Sources / Titles
  / Effects / Subtitles) with VS Code activity-bar semantics (switch, and
  collapse when the shown library is clicked again), built from VS Code's and
  Final Cut Pro's own docs (`scratch/activity-bar-reference/`). The caption
  style library docked too (`CaptionPanel` → `CaptionLibrary`), so D-252's
  `caption-panel` popover id retires. MCP parity checked, not assumed: every
  capability here already has its `editor_*` tool and none of them care what is
  on screen; `debug_get_ui_state` reports the new `libraryMode` so a screenshot
  of the column can still be read. 11 new real-DOM tests (7 in `@chroma/editor`,
  4 in `@chroma/shell`, the latter mounting the REAL rail + panel to pin
  "rail before column" in document order); 1596/1596 editor, 32/32 debug, 7/7
  shell green, `tsc` clean. Lands on top of D-262, whose B-129 new-track fix
  rewrote the very `addAtPlayhead` this pass moved — merged in verbatim, one
  copy, and its own DOM tests now drive the rail plus the docked panel. Found
  and written up, not fixed: **B-131**, `add_clip` has no occupancy check
  (GUI repro closed by D-262; the MCP one is open).

- **2026-09-09** — **D-261: the smart trims get a real tool palette — five icons
  in the timeline toolbar, Alt kept underneath** — the owner, live: *"for roll
  slip etc, instead of alt lets have icons for all of them :) much better."*
  Ripple/roll/slip/slide were reachable only by holding Alt and aiming at the
  right part of a clip (D-235), with every explanatory affordance appearing only
  once the key was already down (D-250) — a discoverability defect three passes
  deep. There is now a Select/Ripple/Roll/Slip/Slide icon group in
  `TimelinePane`'s toolbar (`TrimToolbar.tsx`), taken from a fresh scrape of
  Adobe's own Premiere Tools-panel help into `scratch/premiere-tools-reference/`
  — Adobe's tool set, its filled-active-chip convention, its icon-only +
  tooltip labelling, and its V/B/N/Y/U shortcuts. A chosen tool decides alone,
  ignoring position and modifiers, so a drag is deterministic; Select is a real
  default tool (Adobe's own), not an off state. The Alt heuristic is **kept**
  and strictly layered — it acts only while Select is active — so the two rules
  can never fight over one drag. MCP parity checked, not assumed: all five
  behaviours are already directly nameable per call, so this is correctly
  GUI-only. 15 new unit + 14 new real-DOM tests; the central pair proves the
  icon path and the Alt path commit the identical timeline, and D-235/D-250's
  68 tests pass unchanged.

- **2026-09-09** — **B-129 + B-130 fixed (D-262): "Add Title" now makes its own
  video track, and a title's on-canvas box is its real ink** — both live-reported
  by the owner from one screenshot and both confirmed against their real project
  first. B-129: the track-kind rule existed only in `TimelinePane`'s drop handler,
  so every other caller walked past it — a title had landed on an AUDIO track, and
  another in a gap between two shots on the footage track, where it renders over
  black. The rule moved into the op (`checkAddClip`, shaped like the existing
  `checkTransition`/`checkEditIn`), and `add_clip` gained `onNewVideoTrack` —
  a new video track at index 0, placed in ONE op so one Undo removes both. The GUI
  button and `editor_add_text_clip`/`editor_add_adjustment_clip` both default to
  it; `track` is optional now, deleting the three-call add-track/move-track dance
  the old docstring taught. B-130: `clip_geometry` reported a title's footprint as
  the whole frame — inherited from D-211's "the layer buffer is composition-sized",
  never actually decided — so a 12%-tall title got a full-frame selection box and
  swallowed every canvas click meant for the footage beneath it. It now reports the
  measured ink box, from the same glyph walk that rasterises the text
  (`text_layer_ink_fraction`); no frontend change was needed. 1564 tests in
  `@chroma/editor` (+6), 4 new Rust tests, `tsc` clean, `fmt`/`clippy` clean.

- **2026-09-09** — **D-258: Motion's first representational primitives — a Claude
  chat UI and a phone frame, deliberately decoupled** — the catalog goes from 8
  primitives to 10. `claudechat` draws the real Claude mobile app screen (header,
  user bubbles, serif assistant prose, tool chips, task/document cards, input bar,
  sunburst welcome), built from colours and structure sampled out of the owner's
  own reference screenshot rather than recalled. `deviceframe` is the phone chrome
  on its own, with a genuinely transparent glass cutout, so it frames anything —
  the two compose by agreeing on a rect (`lib/device.ts`) instead of one containing
  the other, per the owner's "separate, not attached". Multiple conversations
  animate over one scene through the EXISTING `active` step schedule, not a new
  mechanism; `registry.ts`'s `resolveActive` was redefined as a wrapper over the
  new `resolveActiveStep` so there is one implementation. Both primitives reach
  `motion_list_primitives`/`motion_add_layer` with no new MCP tool (asserted by a
  test, not assumed). Verified with real `remotion still` renders at three states
  against the reference — which caught a line-wrap over-estimate and a collapsed
  `\n` — plus a byte-identical determinism re-render. 561 tests in `@chroma/motion`
  (37 new), 2155 across all workspaces, `tsc` clean.

- **2026-09-09** — **B-061 + B-062 fixed — Motion Inspector camera-time
  label and a schema validation gap** — B-061: the camera-keyframe `at`
  field was labelled "At (frame)" while the manifest stores seconds;
  relabelled `'At (s)'` on both `CAM2D_KEY_FIELDS` and `CAM3D_KEY_FIELDS`
  (`packages/motion/src/propCatalog.ts`), paired with a new `FieldSpec.step`
  (`step: 0.1`) so a keyboard/scrub nudge no longer jumps a whole second.
  B-062: an `ease` curve's `x1`/`x2` had no validation against
  `Easing.bezier`'s own hard `[0,1]` requirement, so a hand-edited
  out-of-range value parsed fine and only crashed at render time;
  `schema.ts`'s `easeCurve` now `.refine()`s that at PARSE time (`y1`/`y2`
  stay unconstrained — `design.ease.anticipate`'s own legitimate overshoot).
  Both already fully diagnosed with a proposed fix in `docs/BUGS.md`; applied
  verbatim. New tests: `propCatalog.test.ts` (4 tests), a new `B-062` block
  in `schema.test.ts` (6 tests).

- **2026-09-09** — **B-060 fixed — ambient drift now scales with the real
  render fps, not a fixed 30 token** — both ambient-drift implementations
  (`draw.ts`'s `ambientDrift`, `Camera.tsx`'s inline camera drift) divided
  frame-by-`design.fps` (a fixed authoring-default token, `30`) instead of
  the composition's REAL fps, so the same manifest drifted at a visibly
  different perceived speed at 60fps vs 24fps than at the default 30fps.
  `ambientDrift` now takes `fps` as a parameter (the same shape as its
  neighbour `pop(frame, fps, delay)`); `Camera.tsx`'s inline expression
  became an exported, unit-tested `cameraDrift(frame, fps)` reading
  `useVideoConfig().fps`. Own commit (changes rendered pixels for any
  non-30fps manifest) with a before/after: at the same 1-second wall-clock
  instant, the old formula gave `cameraDrift`'s 24fps-render and 60fps-render
  DIFFERENT values (`{dx:1.385,dy:2.670}` vs `{dx:2.796,dy:1.648}`); the
  fixed function gives both the SAME value (`{dx:1.694,dy:2.543}`). New test:
  `ambientDrift.test.ts` (7 tests) — 536 total in `@chroma/motion`, `tsc`
  clean on both packages.

- **2026-09-09** — **D-259: Motion can finally delete and duplicate — human and
  agent halves in one commit.** `manifestEdit.ts` gains `deleteLayer`/
  `deleteScene`/`duplicateLayer`/`duplicateScene`; `LayerList.tsx` gains
  hover-revealed duplicate+delete actions on every layer AND scene row; the MCP
  surface goes **32 → 36 `motion_*` tools**. Until now nothing anywhere could
  remove a layer or a scene once added (roadmap item 6, "the top Motion gap").
  Two real findings: the existing `resolveSelections` re-resolve is **not**
  enough for a delete (it cannot see that a scene delete renumbers every later
  scene), so all four ops return the selection to install next; and only the
  SCENE delete confirms — a two-step arm-then-confirm on the button, no dialog —
  because it cascades into contained content, the same line Premiere draws.
  Deleting the last scene is refused (`scenes.min(1)`). Also corrected a stale
  roadmap item: Motion undo/redo has been live since D-155. 560 tests green
  (+41), `py_compile` clean, 36 Python names diffed identical to the 36 op keys.

- **2026-09-09** — **D-260: re-rendering a Motion scene now refreshes the Edit
  clips already placed from it** — previously a rendered file was frozen at
  render time and a placed clip kept showing it forever, with a manual re-import
  and `editor_swap_clip_media` as the only way out. Not a live embedded renderer
  (D-243's rejection of Remotion-inside-Edit stands, and the owner chose the
  lighter option explicitly): the render now writes beside its destination and
  finishes with an atomic `rename`, so nothing — the preview's live `ffmpeg`
  decoder, an export mid-read — can ever see half a video; the one thing in this
  workspace that a replaced file does *not* invalidate on its own, a live decode
  pipe, is dropped by path. Provenance is a new optional `MediaItem
  .motion_scene_id`, so the pool item (not N copies on N clips) records which
  scene made the file. A new `chroma_media_refresh` reconciles the pool with disk
  and a new `refresh_media` timeline op re-reads length and rate into every clip
  — a **no-op** when the re-render is the same length, which is the common case.
  Both interfaces: an "N in Edit" badge on the Motion scene row, and a new
  Motion tool, `motion_get_edit_links` — landing on top of D-259's delete/
  duplicate batch, the 37th `motion_*` tool overall. Proved by a frame-diff
  through the real preview compositor (red → blue with no re-import) **plus a
  negative control** that shows the same sequence leaving the clip red
  without the one call this adds. Fixes **B-127** (B-056's defect, still
  unfixed in `filmstrip.rs`'s keyframe cache) and **B-128** (a replaced
  source kept its old probe and thumbnail forever — and `Root.tsx`'s comment
  claimed the opposite).

- **2026-09-09** — **D-255: the marketing website shipped, out of sequence** —
  a new top-level `website/` (Astro, its own project, deliberately outside the
  npm workspace), reversing the standing "build the website LAST, right before
  launch" decision at the owner's explicit instruction. Its palette and type are
  a verbatim transcription of the app's own Dark theme and Poppins face, with the
  shipped `MARKER_COLORS` swatches as the only chromatic signals — and a test
  reads both real app files and fails on any drift. The hero is a working
  miniature of the Edit tab (a real draggable playhead scrubbing real
  screenshots, plus D-253's own 8px-per-step drag-to-scrub numeric fields driving
  the preview) rather than a parallax scroll. Every MCP figure is counted from
  `mcp/server.py` — 115 definitions, 9 debug-only, **106 shipped** — by a test
  that also asserts every tool name printed is real, which caught one invented
  name during the build and found `mcp/README.md`'s own heading stale (94/8/48
  vs. the real 115/9/60; corrected here). Missing things are stated on the page,
  not hidden: no Motion or Colorist screenshots exist, there is no demo video,
  and the Motion tab's 0 MCP tools is printed beside the other counts. The beta
  form is fully built against a marked placeholder endpoint and refuses to post
  until a real one is set (`website/BETA_SIGNUP_SETUP.md`). 141 tests green,
  `astro check` and `astro build` clean.

- **2026-09-09** — **D-256: a Colorist grade now actually renders on the Edit
  timeline** — previously it had literally no effect on the same clip in Edit,
  in the preview or the export. Carried across as a **baked 33³ 3D LUT**: an
  identity lattice run through the Colorist's own wgpu pipeline once per grade
  change (memoised on the grade file's mtime), then applied by the Edit CPU
  compositor and by ffmpeg's `lut3d` — so the grade keeps exactly one
  implementation (the shader) and preview/export agree by construction, which
  `chroma_types::adjustment`'s header had called structurally unreachable.
  Measured equal, not approximately: `[227,227,227]` from both engines on the
  same graded clip. Carries the **global** grade only; masks / Colorist crop /
  relight are inherently outside a 3D LUT and are dropped with a warning shown
  in the Export dialog and by the new `editor_get_grade_status` MCP tool, never
  silently. New `chroma_types::Lut3d` (L0, pure) + `chroma::grade_lut`; D-022's
  `.cube` bake refactored to share the one baker. Investigation correction
  worth knowing: the Edit↔grade link is **`Clip::id`** (D-070), not the
  `shot_id` it looks like.

- **2026-09-09** — **D-257: the Motion tab gets its real MCP surface — 32
  `motion_*` tools, closing `mcp-tool-coverage.md`'s "Gap: Motion tab — 0
  tools"** — the last tab an agent could not drive at all, despite a fully
  shipped visual builder. 18 tools wrap ops that already existed on the bridge
  (D-167→D-170) and were never exposed; **14 are new ops**, because eight
  shipped GUI gestures had nothing to wrap (add a scene, reorder layers,
  scale/rotation/opacity, retime a camera key, ease one key, edit a card,
  multi-select edits, read the selection). Split the op registry out of
  `useMotionControl`'s `useEffect` into a pure `motionOps.ts`/`createMotionOps`
  factory so it could be tested at all — 78 new tests, each mutating one
  asserting the op produces the IDENTICAL manifest the GUI's own
  `manifestEdit.ts` call does; the whole prior surface had zero. Deferred, and
  said so: delete-a-layer/scene (neither the GUI nor `manifestEdit.ts` has one —
  MCP-only would break parity from the other side).

- **2026-09-09** — **B-125: `motion_select` had silently drifted from the GUI
  gesture it mirrors**, always re-seeking to the scene start and throwing away
  the playhead — `onSelect` gained D-173's same-scene check and D-176's
  seek-to-the-layer's-own-start, the hand-copied op received neither. Found by
  D-257's new tests, which are the first this op surface has ever had.

- **2026-09-09** — **D-253: numeric fields lose the native spinner and gain
  drag-to-scrub** — finishes B-113, whose `pr-5` reserve could never have
  worked (WebKit lays the spin button out INSIDE the padding box, so padding
  moves the digits and the arrows together). Every `type="number"` in the app
  now suppresses the widget via `@chroma/ui`'s `Input`, and the field itself is
  dragged horizontally to change its value — Resolve's "virtual slider", 8px
  per declared `step`, Shift ×10 / Cmd ÷10 (Adobe's convention, not Blender's),
  4px click/drag threshold matching the timeline's own. New
  `ScrubbableNumberInput` + shared `useNumberField` hook (reached by
  `@chroma/motion` through a new `@chroma/ui/number-scrub` subpath, since it
  cannot import that barrel); migrated every real numeric field in the Edit and
  Motion Inspectors.

- **2026-09-09** — **B-124: the clip Inspector's Video/Audio tabs looked inert
  because BOTH panels painted at once, stacked** — Base UI's `Tabs.Panel` hides
  a deselected panel by unmounting it, and that unmount waits on a
  `requestAnimationFrame` a non-frontmost window never fires (this repo's own
  `previewTiming.ts` documents that throttling), so the Audio content rendered
  1076px below the fold under a Video panel that never left. Fixed with two CSS
  rules on `TabsContent` in `@chroma/ui` (`[&[inert]]:hidden` — `inert` is
  render-derived, so it is correct with no frame at all — plus
  `[&[hidden]]:hidden`, since a UA `[hidden]` rule loses to any author `display`
  utility). Found in the same pass: `data-selected:` matched nothing (Base UI
  emits `data-active`), so no tab in the app had ever shown a selected state,
  `TimelineSwitcher`'s active-timeline underline included. Proven in real
  Chromium with rAF stubbed dead; jsdom is documented as structurally unable to
  see this one.

- **2026-09-09** — **D-254: the Inspector tab bar now draws Chroma's own
  selected state, and every section seam has a real rule** — the owner's
  "doesn't look like our design system" turned out to be a control with no
  selected state at all (B-124); with that fixed, the bar moves off shadcn's
  pill onto the kit's `line` variant plus the same accent underline
  `Shell.tsx`'s Edit/Motion/Colorist switcher and `TimelineSwitcher` already
  use. All six section seams get a hairline, not just the Crop → Dynamic Zoom
  one that was screenshotted. `app/harness.html` gained a `?mode=inspector`.

- **2026-09-09** — **D-251: Export moved again, out of the Edit tab entirely,
  to `@chroma/shell`'s own chrome bar beside the tab switcher** — the owner's
  live follow-up to D-249. `ShellTab` gained a `headerAction` slot, rendered
  only while that tab is active; `Root.tsx` supplies the Edit tab's real
  `EditorExportDialog` for it, `Shell.tsx` still never imports
  `@chroma/editor`. A considered, narrow reversal of D-118's tab-agnostic
  rule for this one slot (Colorist/Motion have no export action to conflict
  with). New `packages/shell` DOM test suite (first one the package has had)
  proves the real dialog opens from the chrome bar and hides on other tabs.

- **2026-09-08** — **D-252: a generic `debug_set_popover_open(id, open)` debug op**,
  backed by one shared `openPanels` map (`useEditorTimelineStore`) and
  `@chroma/editor`'s new `panelRegistry.ts`, so an agent can open/close any
  registered Edit-tab popover/dialog by name without a working
  Accessibility/Screen-Recording permission to click it — built because the
  coordinating session needed to screenshot `CaptionPanel`'s caption-preset
  popover and hit exactly that wall. Migrated `CaptionPanel`,
  `CanvasSettingsPopover` and `EditorExportDialog` off local `useState` onto
  it; `EditLibraryRail`'s uncontrolled rail popovers and `MarkerStrip`'s
  `editingId`-keyed marker editor are found and deliberately left for a
  follow-on pass (see D-252). New real-DOM test
  (`packages/debug/src/debugOps.popover.dom.test.tsx`) proves the op opens
  the real `CaptionPanel` popover with no synthesised click.
  `@chroma/editor` 1507/1507, `@chroma/debug` 32/32, production `vite build`
  re-verified debug-only (0 occurrences of the new op name in the bundle).

- **2026-09-09** — **B-123 fixed: the whole D-235/D-250 smart trim tool
  (ripple/roll/slip/slide) was inert in the real app.** Reported live by the
  owner — "none of the roll slip etc we built works with alt key" — after both
  features shipped fully green. `TimelinePane` binds three NATIVE listeners to
  its edit-area node in `useEffect(…, [])`: D-235's capture-phase `pointerdown`
  (the tool's entire arm), B-116's ctrl-`wheel` zoom and D-128's
  `ResizeObserver`. That node sits behind two early returns — including the
  `tracks.length === 0` "Empty timeline" placeholder every NEW project starts
  in — so on the app's own startup path it does not exist when the component
  first commits; the effects ran once against `null` and never again, and the
  node then mounted carrying none of them for the rest of the session. With no
  press captured, every armed gesture resolved UNARMED and fell back to a plain
  move/trim, while the badge and cursor (React props, not effect-bound) kept
  correctly announcing "Slip"/"Roll". Every test tier missed it because all of
  them seed a populated timeline BEFORE mounting — the B-092/B-093 pattern
  again. Fixed by giving those effects a real dependency (a `useState` mirror of
  the node) while leaving the ref as the read path; a first attempt that
  replaced the ref outright was reverted after it broke 6 marquee tests and
  bailed the React Compiler. Verified in real Chromium over CDP with real
  trusted input — listener attachment read out of the browser, all four modes
  committing real ops on a timeline that started empty — plus a regression test
  that mounts in the real app's order and provably fails without the fix.
  B-116's ctrl-wheel zoom and D-128's viewport tracking were dead the same way
  and are restored by the same three lines.

- **2026-09-08** — **B-122 fixed: dragging a clip onto a track HEADER crashed
  the whole app, because two different dnd-kit droppables both called
  themselves `type: 'track'`.** Caught in the dev-server log while the owner
  was testing the B-115 drag gesture — `TypeError: undefined is not an object
  (evaluating 'dest.clips')`, unhandled inside a React event handler, taking
  the render tree and the `tauri dev` process down with it. The track HEADER is
  a droppable too (every `useSortable` item is), and it carried `{ type:
  'track', index }` while the row LANE carried `{ type: 'track', track }` — so
  a clip dropped on a header passed the discriminator check and read
  `undefined` as its destination track index. It survived review because the
  payload shapes were asserted with six separate inline `as` casts, each
  individually plausible: a cast is a promise, not a check. Fixed at the root —
  distinct `'track-header'`/`'track-lane'` discriminators, and a new
  `dndTargets.ts` that replaces every cast with a runtime-validating narrowing
  which refuses a header, a stale track index and a malformed payload alike, so
  no caller can be handed an index it must remember to bounds-check. The same
  bug existed in `onDndDragMove` (crashed mid-drag) and, mirrored, in the
  track-reorder branch (silently did nothing). 13 new unit cases, the first
  feeding in the exact payload that crashed the app.

- **2026-09-08** — **The clip Inspector is tabbed: Video and Audio, instead of
  one ~30-control scroll (D-246), and its numeric fields no longer hide their
  own digits under the spinner arrows (B-113).** Both reported live by the
  owner against a real project. The tab split is Resolve's own
  (`scratch/resolve-reference/`, the same scrape D-208/D-223/D-224 were built
  from): Transform, Crop, Dynamic Zoom, Speed, Fade and Keyframes on Video;
  Volume/Pan and the four-band EQ on Audio. Nothing moved but the container —
  same sections, same ops, same gates — and the DOM test asserts exactly that
  (the union of the two tabs is the old section set, with nothing on both). A
  clip type with no audio (a title) gets no Audio tab and no tab bar at all,
  so its Inspector is the column it always was. The tab lives in the store, so
  the human's click and the new `debug_set_inspector_tab` drive one action, not
  two. B-113 was two faults at once: WebKit paints a number input's spinner
  over its right-aligned text with no space reserved (now reserved by
  `@chroma/ui`'s `Input` for EVERY `type="number"`, not per call site), and the
  rows rendered raw dragged floats like `0.052212` into a 40px box — a resting
  field now shows a `step`-derived rounding and the exact value returns on
  focus, so nothing stored or typed changed.

- **2026-09-08** — **Edit tab, from the owner's live pass: a left library rail,
  a Title you can actually drag, a track above the top one, an anchored zoom,
  Export at the top, and a marker you can delete (D-248, D-249; B-114 to
  B-118).** Six defects reported hands-on against the real
  `perf-comparison-reel-v3` project, plus one design call the investigation
  changed: the three boxes sketched on the app's far-left edge were not a
  broken component — nothing rendered there at all — so the rail is a new
  decision, built from Resolve's own "effects library icon at the top left"
  and reusing the Colorist tab's existing icon-rail pattern. It hosts Titles,
  Effects and Subtitles, each a real HTML5 drag source (a second MIME type,
  because only `.types` is readable during `dragover`) routed through the
  media drop's own placement code, so a dragged title snaps, ripples and
  creates a track by exactly the rules a dragged source does. The timeline's
  top became the mirror of its bottom (dropping above the tracks now makes a
  new topmost one, where it used to silently land on the existing top track);
  the zoom gained an anchor it never had (the cursor for a wheel, the playhead
  for the +/- buttons); the marker LIST gained the delete that only ever
  existed behind a double-click on a 9px flag; and the header strip got the
  right-hand padding B-051/D-131 gave its left side two decisions ago. Human +
  AI in the same pass: `editor_add_track` takes an optional `index`.

- **2026-09-08** — **A pass over four things the owner hit editing live:
  B-122, B-120, B-121 and D-250.** *B-122* — "Captions from Transcript" on a
  source with no audio showed the raw `CalledProcessError` argv from the
  sidecar's ffmpeg call; `chroma_transcribe` now refuses up front through the
  same `VideoInfo::has_audio` probe the rest of the app uses, and `ai-media/`
  grew a `UserFacingError` so a predicted failure reaches the UI as its
  sentence instead of its exception class. *B-120* — a real defect behind "idk
  what is this audio waveform but it seems broken": a peaks request that
  overran the end of a file had its envelope **time-stretched** to fill the
  requested window (a tone at source seconds 1–2 drawn at 2–4), which hit every
  source shorter than one 12 s scrub tile; `envelope_over` now buckets only
  what decoded and pads the rest with silence, and the strip says *why* it is
  empty instead of drawing one flat line for silence, loading and no-source
  alike. *B-121* — the D-243 Captions panel was wired and rendering and still
  unfindable, because its button kept the old "Subtitles" label of the file
  picker it replaced. *D-250* — D-235's four trim modes are announced at the
  POINTER now (a mode badge with a gloss, plus a standard-keyword cursor swap)
  where Resolve's own copy says the signal belongs, and every clip's tooltip
  finally says the Alt/Option arm key exists at all.

- **2026-09-08** — **B-111 fixed: the audio session now re-resolves the
  timeline as it plays, so a clip starting later than the playhead when Play
  was pressed actually sounds (D-245).** The old `chroma_audio_play` built its
  source list once, from the frame Play was pressed at, and froze it for the
  whole session — on the owner's own reel, only the continuous music bed at
  frame 0 could ever be heard; the other ten scattered SFX clips never fired
  no matter how long playback ran. `run_session` now calls the same
  resolution again periodically (~every 100ms) as a `Send` closure the app
  hands it — `chroma-media` still never sees a timeline — and opens whichever
  sources are newly active, matched by a new opaque `AudioSourceSpec::clip_id`
  so nothing already playing is ever reopened. A second bug the fix had to
  get right along the way: a source opened mid-session must have its
  fade/duck/level curve evaluated from ITS OWN start time, not the whole
  session's clock, or a late-joining clip's fade could read as already over
  the instant it starts. Verified against real decoded PCM in memory (no live
  device) — deliberately not confirmed on real speakers yet, stated as the
  one open gap rather than skipped quietly.

- **2026-09-08** — **EQ response graph: Resolve's ±24 dB / log-frequency plot,
  draggable per-band points, scroll-wheel Q (D-237, roadmap item 27's last open
  half of D-224).** `EqResponseGraph.tsx` above the Inspector's four EQ band
  blocks — a numbered point per band (horizontal drag = frequency, log-scaled;
  vertical drag = gain, gain-using kinds only) plus the combined response as a
  filled/stroked curve, sampled from the existing `eqResponseDb` (never
  re-derived). Q is scroll-wheel-over-the-point, checked against Logic Pro's
  own Channel EQ convention and debounced to one commit per gesture. No new
  MCP tool — `editor_set_clip_eq` already reports `responseDb`, so the graph is
  a GUI affordance over it (D-214 precedent). 38 new tests (`eqCurve.test.ts`,
  `EqResponseGraph.dom.test.tsx`) plus 3 end-to-end wiring tests added to
  `ClipInspectorPanel.eq.dom.test.tsx`.

- **2026-09-08** — **Auto-captioning from the D-189 transcript (D-238, roadmap
  item 27).** Turns a transcript's timed words into caption cues instead of
  requiring a hand-authored `.srt` — reuses D-229's `import_subtitles` op
  verbatim (no new track kind, no new `Clip` field), with a segment-boundary-
  aware word/duration/pause grouping heuristic as the only new logic
  (`packages/editor/src/captionsFromTranscript.ts`). GUI: a "Captions from
  Transcript" button beside the Subtitles importer, operating on the selected
  clip. MCP: `editor_generate_captions_from_transcript`.

- **2026-09-08** — **The seven edit types on drop (D-239, roadmap item 27).**
  Dragging a Sources item now raises Blackmagic's own edit overlay over the
  preview — Insert / Overwrite / Replace / Fit to Fill / Place on Top / Append
  at End / Ripple Overwrite as seven labelled targets, built from the
  `timeline.jpg` screenshot the roadmap line itself names. All seven are ONE
  atomic `edit_in` `EditOp` (one undo, named for the type), not a client-side
  sequence — the D-129 precedent. The audit found only Append genuinely free
  and Insert nearly so; Overwrite needed real window-clearing, and Fit to Fill
  needed no new retiming concept at all, just a flat D-236 speed ramp at the
  closed-form fitting speed. Replace is deliberately distinct from D-195's
  `swap_media`. The timeline's own positional drop is untouched. MCP:
  `editor_edit_in`, sharing `checkEditIn` with the overlay so a greyed row, a
  tool error and a refused op can never disagree. Fixed a latent track-index
  remap bug in `timelineStore` (a new track at index 0 renumbers everything
  below it) and a real counting bug in `docs/notes/mcp-tool-coverage.md`.

- **2026-09-08** — **Italic/bold caption/title rendering (D-240, roadmap item
  27).** `chroma::text`'s catalogue gained italic/bold-italic faces for every
  family that has them on macOS (sans/condensed/serif/mono) — no new font, the
  same system families D-212 already references. Bold/Italic toggle buttons
  landed in both the Title and Caption Inspectors, plus matching `bold`/
  `italic` params on the four MCP tools that already set `font`; both compose
  the right flat catalogue key through one shared `composeFontStyleKey`, so
  neither `TextLayer` nor `CaptionStyle` grew a new stored field. Export
  parity measured (not assumed): `ab_glyph` vs. real `drawtext` ink widths
  agree within 1.5% for the new faces.

- **2026-09-08** — **Reverse speed, and the live preview's audio finally
  retimes (D-241, D-242 — D-236's two named speed-ramp follow-ups).** A clip, or
  any single run of a ramp, can now play BACKWARDS: a negative percentage in the
  Inspector or a per-run **Reverse** button (both references spell it that way),
  and negatives on `editor_set_clip_speed`. It needed no schema change — a
  reversed run occupies exactly the output its forward twin would, so a sign
  flip never moves a neighbouring clip — but it did need a different filtergraph
  *shape*: `trim`/`reverse`/`concat` per run and `areverse`+`atempo=|s|` for the
  sound, because a negative `setpts` slope is a graph ffmpeg happily runs and
  which reverses nothing. The "backwards preview decode" D-236 flagged as
  blocking turned out not to exist — `decode_pipe` already handles a backward
  step. Separately, the live mixer now retimes its audio through the same ramp
  the picture uses, closing D-236's stated asymmetry: a 2x clip's preview sound
  was 1.9 s adrift from its picture and is now within 50 µs. It varispeeds
  (pitch moves with speed, like tape and like Premiere's default) where the
  export preserves pitch — deliberate, and stated in the MCP tool's own
  docstring. Verified against real decoded pixels and real decoded audio, both
  with negative controls. Also fixed, in passing and never reachable before:
  fade windows are now measured in PLAYBACK order, which a reversed clip needs
  and which is algebraically identical for every forward ramp.

- **2026-09-08** — **A real Captions panel + animated caption presets
  (D-243/D-244, roadmap item 28).** "Subtitles" now opens a panel instead of a
  file picker: a **Styles** library of caption looks, each tile a live
  thumbnail of its own style, that drop onto the timeline in one click, plus an
  **Import** tab carrying D-229's `.srt`/`.vtt` flow verbatim. Captions can now
  ANIMATE per word — highlight, karaoke, kinetic slam and word build — rendered
  identically by the Rust preview and the ffmpeg export, with every knob
  editable in the Inspector because a preset is pure data, not a baked-in look.
  The architecture question the roadmap raised is answered and closed in D-243:
  **native `CaptionStyle` extension, not a Motion manifest**, because the
  Motion engine has no render-to-file path at all and neither Edit renderer is
  a browser. 8 presets shipped, 11 more named individually with their real
  blockers; looks adapted from HyperFrames' catalogue (Apache-2.0, D-244) as
  design only — no third-party code ships here. Verified with 5 real-ffmpeg
  pixel tests that prove the export actually animates.

- **2026-09-08** — **Context-sensitive trim: ripple / roll / slip / slide from
  one gesture (D-235, roadmap item 27).** Hold Alt/Option over the timeline and
  the same drag becomes a different edit depending on where you point — an edge
  that touches a neighbour rolls the cut, a free edge ripples, the upper half of
  a clip slips its source window, the lower half slides it between its
  neighbours (Shift forces a ripple at an edit point). Taken from Blackmagic's
  own smart-trim copy and the four cursors in
  `scratch/resolve-reference/trim.jpg`, cross-checked against Final Cut's and
  Premiere's own help; the toolbar names the mode while armed, since Chroma
  can't swap cursors. Unarmed gestures are untouched — a body drag is still a
  move, an edge drag still the plain gap-leaving trim. The audit behind it found
  `slip` had shipped as an MCP tool with **no** human gesture (D-195), the
  human-AND-AI gap from the AI side; ripple trim is the existing
  `trim_start`/`trim_end` with a `ripple` flag reusing the one ripple-shift
  primitive, and only `roll`/`slide` are new ops. Both edge- and body-drag
  decisions were extracted to pure functions after finding the timeline
  library's interact.js resize does not run under jsdom at all. MCP:
  `editor_roll_edit`, `editor_slide_clip`, and `ripple` on `editor_trim_clip`.
  Harness fixes on the way: `altKey`, real `pageX`/`pageY`, and a
  `getBoundingClientRect` stub so the slip/slide band is a real test.

- **2026-09-08** — **Speed ramps: variable speed over time, previewed and
  exported from one definition (D-236, roadmap item 27).** A clip now carries
  `speed_points` — "from this SOURCE frame onward, play at this speed" — so the
  speed profile is a step function and the time remap is exactly piecewise
  linear. That shape is chosen, not incidental: it is the only one the live
  preview (closed-form Rust), the export's picture (an ffmpeg `setpts`
  expression) and the export's sound can all express, and the sound is what
  decides it — `atempo` takes a number rather than an expression, so a ramped
  clip's audio is per-segment `atrim`/`atempo`/`concat` and a smoothly-varying
  speed would have had no matching audio at all. The pre-existing export-time
  `speedOverrides` is **generalised, not duplicated**: a flat speed is a
  one-segment ramp, resolved through the same function, still compiling the
  byte-identical filtergraph. Both interfaces in the same pass — an Inspector
  **Speed** section (per-run percentage, add a point at the playhead, a Retime
  Curve readout, modelled on Resolve's own Retime Controls read out of
  `scratch/resolve-reference/create.jpg`) and `editor_set_clip_speed`. Because
  this is the B-090/B-094/B-095/B-098/B-103/B-108 risk squared — it animates
  time itself, so a wrong ramp still renders a smooth, plausible, wrong video —
  the parity proof is real decoded pixels: a fixture whose every frame is a
  distinct grey, exported through a `0.5x → 2x → 1.25x` ramp and read back frame
  by frame, agrees with the preview's own resolver on 78 of 84 frames exactly
  and the rest by one, against up to 18 frames out for a deliberately wrong
  ramp. Found and fixed **B-112** on the way: the export divided a sped clip's
  length by its speed but not its fade windows, so the picture faded for
  `speed`× longer than its own sound. Deliberately not built, all named on the
  roadmap: reverse speed, smoothed S-curve transitions, on-clip point dragging,
  frame interpolation, and live-preview audio retiming.

- **2026-09-08** — **Dynamic zoom: drag two boxes in the viewer instead of
  keying by hand (D-234, roadmap item 27).** Arm it from the Inspector and the
  preview shows a green START box and a dashed red END box over the selected
  clip — Resolve's own convention, read off its own Edit-page copy in
  `scratch/resolve-reference/`. Drag either one and the clip's
  `position_x`/`position_y`/`scale` keyframes are written across its whole
  length, plus a Swap button and the four `EASE_PRESETS` eases (renamed from
  `FADE_PRESETS`/`FadeCurve` when this merged alongside D-233, which folded the
  fade-curve vocabulary into one shared `EaseCurve` type — see that merge's own
  reconciliation). The load-bearing
  call is that it **bakes ordinary keyframes** rather than adding a persistent
  dynamic-zoom stage the way Resolve does: no new `Clip` field, no renderer
  change on either side, so preview/export agreement, undo, the Inspector's
  diamonds and the coming curve editor all work on it for free — pinned by a
  test asserting the baked list is byte-identical to the hand-authored
  equivalent. One deliberate divergence, argued in D-234: the boxes are the
  clip's LAYER FOOTPRINT (bigger = more zoomed in), not Resolve's inverse
  framing rect, so "the box" means one thing everywhere in the viewer. A
  non-linear ease is baked as 20 sampled segments because the keyframe model has
  no per-key easing on either side of the wire. Replaces (never interleaves
  with) existing position/scale keys and says so before the drag; every other
  animated property is left alone. `TransformBox` extracted so the single
  transform box and this pair are one component, not two that drift. MCP:
  `editor_set_dynamic_zoom`, running the same math and the same op as the drag.
- **2026-09-08** — **Two owner-reported audio bugs, and the reason neither could
  be seen.** **B-109:** the app's logger has never written a byte — every
  `app.log` on the machine was 0 bytes, across six bundle identifiers and a
  week of builds, because `tauri-plugin-wdio` (registered unconditionally by
  D-104) takes `log::set_boxed_logger` from its plugin `setup`, which Tauri runs
  before this crate's own `.setup()`, so `fern`'s `apply()` always lost the
  race. That silently disabled the entire audio subsystem's only diagnostics,
  including the D-049 rms/peak verification hook. `run()` now claims the global
  slot first with a forwarding `DeferredLogger`, and `setup_logging` drops the
  real `fern` chain in behind it once `app_log_dir()` is resolvable; verified in
  the real app (0 bytes → real `[INFO]`/`[WARN]` lines, several of which the app
  had been reporting into the void). **B-110:** a tape scrub monitored every
  source at unity — `scrubSourceAt` read `Track::gain` only to skip a fully
  muted track and then threw the value away, and never consulted `Clip::volume`
  at all — so a music bed faded to 0.4 was heard ~8 dB hot under the playhead
  versus in playback ("it plays the audio which is not the right one"). The
  resolved source now carries `track.gain × clip.volume` through both scrub
  commands into `run_scrub`'s per-grain `apply_gain`, and `editor_get_waveform`
  reports it so an agent, which cannot hear a hot monitor, gets the number.
  **B-111 filed, open:** "the first play has no audio, stop and play fixes it"
  is *not* a D-232 regression and not a transport-ordering race — both were
  ruled out with real-DOM and live-app evidence (a real click on Play issues one
  `chroma_audio_play` and no scrub; the first play in a fresh process measures
  `rms=0.0883`). It is that `chroma_audio_play` resolves its sources **once**,
  at the frame Play was pressed, and never again: on the owner's own reel that
  is 1 source out of 11 audio clips, so every SFX that starts later is silent
  for the whole session, and a play started in the reel's 40-second audio gap
  opens no device at all. Root cause confirmed and the fix scoped in B-111; not
  built here, because its only honest verification is an audible one and the
  machine had to stay quiet.

- **2026-09-08** — **Tape-style audio scrubbing + the viewer waveform strip
  (D-232, roadmap item 27).** Dragging the playhead — on the timeline cursor or
  the player's position bar — now makes sound: a new `chroma_media::scrub`
  emits a short enveloped grain from wherever the pointer is, ~17×/second, out
  of a decoded window it only re-anchors when you leave it. The load-bearing
  call is that scrub is a **third request on the existing single audio
  transport**, not a parallel engine, so "a scrub stops playback" and "Play
  stops a scrub" fall out of the D-130 ordering protocol with no new invariant
  (and the frontend's request stamp moved to a shared `audioTransport.ts`,
  because two counters feeding one high-water mark is not two orderings).
  Constant-pitch granular scrub, not varispeed — argued, with the reference
  behaviour cited. The waveform half is a full-width strip between the picture
  and the position bar (read off `scratch/resolve-reference/scrubbing.jpg`),
  showing a 4 s window centred on the playhead, fetched in **snapped tiles** so
  a moving playhead does not re-miss D-128's cache on every frame. MCP:
  `editor_set_waveform_view` + `editor_get_waveform`; deliberately **no**
  `editor_scrub` — an agent cannot hear, so it gets the envelope as numbers
  instead (D-232 §5). Verified to real `cpal` output on real media
  (`rms=0.0807 peak=0.3783`); what it *sounds* like still needs a human ear.
  Detail: `docs/notes/audio-fade-duck-crossfade-plan.md` §11. **Found and fixed
  on the way: B-106** — the three live-device playback tests read a
  once-per-second meter after 1.5 s, so they could fail for having nothing to
  read rather than nothing to hear.
- **2026-09-08** — **Timeline curve editor: real bezier ease curves on any keyframed
  property (D-233, roadmap 27).** Keyframe segments were all linear — the biggest
  reason a generated move looks generated. Each segment now carries an optional
  cubic-bezier `ease`, authored by dragging its two control points in a resizable
  lane docked under the timeline (built from Resolve's own `curve.jpg`), by four
  preset buttons, from the Inspector's per-property curve button, or over MCP
  (`editor_set_keyframe_ease` + `editor_set_curve_editor`; 102 → 104 tools). Not a
  new curve concept: D-147's `FadeCurve` became `EaseCurve` in its own
  `chroma_types::ease` module and is now shared by fades and keyframes, one solver
  across both languages. Absent `ease` = linear, so existing projects resolve
  bit-identically and export byte-identically. Preview and export agree exactly at
  every authored key and by a measured 1.4e-3 between them, proven by a real-ffmpeg
  pixel test that was checked to fail when the curve is dropped. Two bugs found on
  the way: **B-108** (open) — the export spins a seam-crossing `rotation` the long
  way round while the preview takes the short arc; **B-107** (fixed here) —
  `chroma::audio`'s tests guarded the process-global open project with a mutex of
  their own instead of the shared `PROJECT_STATE_LOCK`, so they cleared it out from
  under `chroma::edit`'s adjustment-preview tests. Two locks over one global is not
  mutual exclusion; B-105 fixed the same shape one file over.
- **2026-09-08** — **Docs reconciliation, round 2 (D-231).** Docs-only. The product
  docs had drifted on *feature status*, not framing: `01-prd.md` still called Edit a
  single-track MVP and Motion a placeholder tab, `02-scope.md` listed shipped features
  as out-of-scope, and `03-architecture.md` said 3 crates existed (8 do) and 38 MCP
  tools (95 do). All re-derived from the code — tool counts parsed from `mcp/server.py`,
  primitives from the engine's `zod` enum (8, not 7), crate status from
  `crates/*/README.md`. `CLAUDE.md`'s own drift note was itself wrong on both files it
  named and is rewritten to say what is actually still stale. Two real gaps surfaced and
  documented, not fixed: Motion has **0 MCP tools** despite 18 working `motion_*` bridge
  ops (D-167–D-171 never got their Python wrappers), and Edit's media understanding is
  MCP-only with no GUI consumer.
- **2026-09-08** — **Fix B-104: the on-canvas transform box detached from the
  picture and drifted worse the longer playback ran (D-228).** Owner-reported
  on a real macOS screen recording — a genuinely variable-frame-rate source.
  Root cause was not the probe but three decoders each meaning something
  different by "source frame N": the model says *the picture at `N/source_fps`
  seconds*, while `decode_pipe` and the exporter counted **coded** frames after
  a single seek, which on VFR footage walks away from the model without bound
  (measured up to **4.07 s**, ≈180 frames, on the owner's own clip) and resets
  only on a scrub. New `chroma_media::conform` states the invariant once and
  builds the ffmpeg arguments for it (`fps=…:start_time=0:round=up` under
  `-copyts`, `-noaccurate_seek`); the pipe, `decode_frame`, the thumbnail strip
  and `export::spawn_decoder` all go through it. No transcode, no proxy, no
  schema change, no migration — and free on CFR footage (2.51 → 2.50 ms/frame
  measured). Verified against the owner's real file with an `ffprobe`-PTS
  oracle, plus 6 new tests on a synthesized VFR fixture (3 confirmed failing
  pre-fix) and 8 on the argument construction.
- **2026-09-08** — **Subtitles / captions (D-229, roadmap 27).** `.srt`/`.vtt`
  import as a real `TrackKind::Subtitle` track, per-track style with a per-cue
  "use track style" override, an Inspector section with a CPS cue list, sidecar
  `.srt`/`.vtt` export, and 5 `editor_*` MCP tools. A track kind rather than a
  clip variant — deliberately the opposite call from D-211's title, because a
  caption composites over the finished picture whatever its track index and its
  style belongs to the track. **Multi-line cues** (which D-211 had to forbid for
  titles) render identically in the live preview and the export because the line
  layout is ours, not either engine's: one `drawtext` per line at `y_align=font`,
  whose content-independence and `hhea`-derived box were measured against ffmpeg
  7.1 across four faces before being built on. Proven by a real-ffmpeg pixel test
  (the box lands at exactly `line_top − box_padding`; two lines stack exactly one
  `line_step` apart). **TTML is deliberately refused, not half-built** — its
  timings depend on `ttp:timeBase`/`ttp:frameRate`, and a subset parser would
  import real broadcast files with silently wrong times.
- **2026-09-08** — **Fix B-105: a test-suite race over the process-global
  `current_video()`.** `chroma::state`'s thumb-cache test set a current video
  and never restored it; `chroma::relight`'s "no video loaded" test asserts the
  opposite, so whichever ran first decided the result. Latent for as long as
  both existed — D-230's slower, real-ffmpeg preview tests just widened the
  window enough to make it deterministic. Both halves fixed (the mutator takes
  `PROJECT_STATE_LOCK` and restores the baseline; the dependent test asserts its
  own precondition). `cargo test -p RapidRAW --lib` is now 189 passed / 1 failed
  across three runs, that one being the documented pre-existing B-097.
- **2026-09-08** — **Adjustment clips (D-230, roadmap 27).** A clip that
  contributes no picture of its own and instead applies one colour correction
  to every clip composited *beneath* it, for the span it covers. The
  compositing model is the new part: both renderers already paint
  back-to-front, so the canvas in hand when the walk reaches the adjustment
  layer *is* "every layer below it" — the whole scoping rule falls out of the
  existing z-order rather than being implemented. The effect is a
  five-parameter primary correction, **not** the Colorist grade: that blob is
  untyped in Rust (D-020/D-025) and wgpu-shader-only, so the ffmpeg export
  could never have reproduced it — a guaranteed preview/export divergence of
  the B-090/B-095/B-098 class. One shared operator
  (`chroma_types::adjustment`) feeds both engines, compiled to `lutrgb` +
  `colorchannelmixer`; a single folded matrix was tried and rejected (it
  breaches ffmpeg's ±2 coefficient cap at ordinary settings), and `geq`
  measured ~39× slower. Preview vs. export agree to ≤ 1/255, proved by a
  matched pair of real-pixel suites. Toolbar button, on-timeline body and
  Inspector built from `scratch/resolve-reference/adjustments.jpg`;
  `editor_add_adjustment_clip` / `editor_set_adjustment_clip` in the same
  pass. Detail: `docs/notes/adjustment-clips.md`.
- **2026-09-08** — **Fix B-102: total silence during live preview playback.**
  `symphonia` was never built with MP3 decode support (`isomp4`/`aac`/`alac`/
  `aiff` were explicitly enabled; `mp3` — the one common format symphonia keeps
  OUT of its own defaults — was not), so every `.mp3` audio-track clip failed
  to open and the failure was swallowed on a background thread with no error
  surfaced anywhere. Found live against the owner's real project (4 audio
  tracks, all `.mp3`). Added `"mp3"` to symphonia's feature list in both
  `app/src-tauri/Cargo.toml` and `crates/chroma-media/Cargo.toml`; verified
  end-to-end against the real project's own `music.mp3` (real non-silent PCM
  out of the actual `cpal` device, `peak=1.0267`).
- **2026-09-08** — **Per-clip parametric EQ (D-224, roadmap 27).** A clip now
  carries its own multi-band EQ — `Clip::eq_bands`, five real shapes (low/high
  shelf, bell, high/low pass) with frequency/gain/Q per band, and Resolve's own
  four-band strip in a new Inspector "EQ" section, built from its own
  screenshot. The filters are real Audio EQ Cookbook biquads
  (`chroma_types::eq`), applied per channel with state that survives a chunk
  boundary in the live mixer, and compiled to ffmpeg's GENERIC `biquad` filter
  fed the same coefficients in the export — because its own `bass`/`treble`
  measurably do not implement the cookbook's Q (0.25-0.37 dB off, identified
  from their impulse response), so agreement is structural rather than hoped
  for. Applied before the volume/fade/duck gain stages in both engines, an
  order that genuinely matters because a biquad is time-invariant and a fade is
  not. **Static, not keyframeable**, and that is the stated decision rather
  than a gap: ffmpeg's biquad filters parse their parameters once, so an
  animated EQ cannot be rendered at all. `editor_set_clip_eq` returns the
  resulting curve, not just what it stored. Proved by a real frequency response
  measured in BOTH engines against one shared table — a real sine through the
  real mixer, and real ffmpeg output read with `volumedetect`. The response
  CURVE UI is explicitly deferred (roadmap 27), not half-built.
- **2026-09-08** — **Transitions library (D-226 + D-227, roadmap 27).** A
  transition **bridges** an edit point: the two clips stay abutting and never
  overlap, and it reads their handle media instead — D-226 weighs that against
  real clip overlap (Premiere's shape) and records why the bridging model
  composes with this codebase's own resolution/decode/landing machinery while
  the other fights it. Two types: a cross dissolve (both clips visible at once,
  needs handles) and a dip to colour (a generated plate, needs none, so it
  always works) — the pair that proves both mechanisms. Real live-preview
  compositing (a second decode slot per track, `PipeSlot::TrackTransition`),
  real ffmpeg export via `fade=alpha=1` rather than `xfade` (which
  concatenates, a different compiler shape entirely), a drag-onto-the-cut
  palette with an on-track badge and its own popover, and four
  `editor_*_transition` MCP tools. Proved by real decoded pixels on **both**
  engines — a mid-dissolve preview frame measured `[125, 0, 126]` for a
  red↔blue blend against `[255,0,0]`/`[0,0,255]` for a hard cut, and the export
  sampled at 0/25/50/75/100% of the same window. **Found and fixed on the way:
  B-103** — the export compiler had never placed a clip in TIME at all
  (`overlay` pairs inputs by timestamp; only the audio half ever had its
  `adelay`), so every clip at `start_frame > 0` exported its last frame frozen.
  Design detail: `docs/notes/transitions.md`.
- **2026-09-08** — **Per-clip audio: volume + pan (D-223, roadmap 27).** A clip
  now carries its OWN level and stereo position, independent of its track's
  fader — `Clip::volume` (linear, matching `Track::gain`'s unit) and
  `Clip::pan` (constant-power law at a 0 dB centre, `chroma_types::pan`), both
  keyframeable through the machinery D-208/D-220 already built. Composed as
  `track.gain × clip.volume × fade × duck`, then split per channel, identically
  in the live mixer (a third envelope in the same per-sample-frame pass) and in
  the ffmpeg export (a `channelsplit`/`join` fork, the law written as a real
  per-frame expression since ffmpeg's own `pan` filter cannot take one). New
  Inspector "Audio" section + `editor_set_clip_audio`. Proved by real
  per-channel `volumedetect` measurement of real exported files — a whole-file
  measurement cannot tell a pan from an attenuation. One measured divergence
  filed, not papered over: **B-101**, a panned MONO clip exports 3 dB below
  what it plays. Unblocks roadmap 27's per-clip EQ item.
- **2026-09-08** — **Timeline markers (D-222, roadmap 27).** Colour-coded,
  titled flags pinned to a timeline frame, on their own strip between the
  ruler's ticks and track 0 — Resolve's own placement, built from its own
  screenshot. They live on the `Timeline`, not on a `Clip`, so one survives
  the clip beneath it being trimmed, moved or deleted; they are real
  `EditOp`s (`add_marker`/`remove_marker`/`set_marker`), so unlike D-216's
  selection and D-218's preview zoom they persist into `project.json` and
  undo with ⌘Z. Click a flag to jump, double-click to rename/recolour/delete,
  `M` or the toolbar button to add at the playhead, a dropdown to jump
  between them — plus `editor_add_marker`/`_list_markers`/`_set_marker`/
  `_remove_marker` driving the same three ops. Adds `Textarea` to
  `@chroma/ui`.
- **2026-09-08** — **Pre-launch plan extended: Windows port + general Python-
  sidecar hosting** (`docs/notes/pre-launch-plan.md`, items 5-6). Direct
  codebase survey found the Windows gap narrower than expected: the Rust
  compositor (`wgpu`) and most AI features (ONNX Runtime, plus the relight
  sidecar's own already-real `mps`/`cuda`/`cpu` device selection) are already
  cross-platform, with Windows dylib paths and NSIS packaging already wired.
  The real gaps are the `ai-media/` sidecar (`mlx-vlm`/`mlx-whisper`, hard
  Apple-Silicon-only) and `mlx-audiocraft` — named Windows replacements for
  both (`faster-whisper`; the same Qwen3-VL model via `transformers`+
  BitsAndBytes or GGUF). Confirmed: don't cross-compile Windows from this Mac
  (Tauri's own docs call it unreliable) — GitHub Actions `windows-latest` is
  the standard practice. For general (non-GPU) Python-service hosting:
  Railway to start, Google Cloud Run if GPU becomes a near-term need (its GPU
  support went GA in 2026 with sub-5s cold start) — also found Fly.io's own
  GPU offering was deprecated August 1, 2026.
- **2026-09-08** — **Pre-launch plan researched: fal.ai media-gen, a lightweight
  accounts/credits/payment backend, an opt-in cloud GPU fallback for the
  existing local AI sidecars, and the website** (`docs/notes/pre-launch-plan.md`).
  Owner's own sequencing: build these LAST, after the Resolve-parity backlog,
  not now. Nothing built — real provider research only (fal.ai's queue+webhook
  API and pricing; Supabase+Stripe as the concrete backend stack, with real
  Tauri-desktop OAuth precedent; RunPod/Modal/Replicate/Baseten for GPU
  hosting, including a real, specific blocker — `mlx-audiocraft` needs a
  separate CUDA-native build for the cloud path, since Metal has no container
  GPU passthrough). Surfaced the one thing to resolve before starting the
  backend or the cloud sidecar: `D-002`'s own licensing question (AGPL "blocks
  a closed SaaS") was already flagged unresolved and is now directly load-bearing
  for two of these four items.
- **2026-09-08** — **`PropertyRow` extracted to its own file (D-220,
  roadmap 27)** — the reusable Inspector row (label/field/keyframe-diamond/
  nav/reset) several upcoming features (per-clip audio pan/volume, EQ) will
  need, generalised over the param-name type rather than pinned to
  `ClipTransformParam`. Deliberately NOT a cross-tab unification with
  Motion's/Colorist's own Inspector panels — D-103 already settled that
  question. Also added roadmap item 27, the durable Resolve-parity backlog
  (the session tracker artifact isn't a substitute for this).
- **2026-09-08** — **The debug-tooling loop closes: an agent can now open a
  panel, photograph it, and read the DOM behind the pixels (D-219).**
  `docs/notes/debug-tooling.md` pieces 2, 4 and 5 built, piece 3 found already
  complete in D-210 and left alone. Six new MCP tools in a new `@chroma/debug`
  package: `debug_ui_state`, `debug_set_active_tab`, `debug_set_sources_panel`,
  `debug_set_editor_inspector` (each calling the *same* store action the human's
  own button calls — explicit named ops, never a generic backdoor or a
  synthesised click), `debug_dom_tree` (bounded three ways, every bound reports
  itself) and `debug_frame_timing` (the webview-side smoothness measurement
  D-217 needed and could not take). Forced one honest refactor: the Edit
  Inspector's open/closed flag moved out of `EditorTab.tsx`'s `useState` into
  the store, so there is one piece of state under both interfaces.
- **2026-09-08** — **B-100 fixed: the debug screenshot tool had been shipping
  ungated.** Found while reading D-210 as the reference pattern —
  `chroma_debug_screenshot`/`chroma_debug_sample_pixel` had no
  `#[cfg(debug_assertions)]` anywhere, so a release build contained the whole
  webview-capture path, against this project's own "debug tooling is never
  shipped" invariant. Gated properly (module, both commands inside
  `generate_handler!`, `control.rs`'s `native_op`, and the Cmd/Ctrl+Shift+D
  hook), and the gate is now *verified* rather than asserted: a real production
  `vite build` contains zero occurrences of any debug op name.
- **2026-09-08** — **The preview canvas can be zoomed and panned (D-218,
  roadmap 25).** Owner, live: *"i should be able to zoom in the canvas also."*
  A `−  100%  +` cluster shaped exactly like the timeline's own (same icons,
  same step, same ctrl/pinch-wheel split; the readout doubles as reset-to-fit),
  25%–800%, `editor_set_preview_zoom` + `editor_get_state.previewZoom` in the
  same pass. Zoom is a mathematical transform of the `useContentBox` rect, not
  `overflow: auto` scrolling — chosen so the three on-canvas surfaces
  (`TransformOverlay`, `useCanvasClipPick`, `CanvasBoundary`) need no change to
  their coordinate math AND stay provable in jsdom: 46 new tests, including
  click-to-select and both drag gestures proven correct at 200%-and-panned, plus
  a real-Chromium pass with real hit-testing. 100% means fit, not 1:1 — the
  preview is a capped proxy; D-218 says why. **B-099 fixed on the way**: D-217
  had left `app/src/harness-main.tsx` calling `atob` on a string that still
  carried its `data:` prefix, so the real-browser harness threw at module load
  and mounted nothing — that verification tier had been silently dead since.
- **2026-09-08** — **B-098 fixed: `editor_export` now animates keyframed crop
  insets too.** The last of the nine keyframeable transform properties to
  reach the export compiler — all nine now animate identically in the
  preview and the export. Corrected this bug's own original fix guidance
  along the way: it assumed `crop` needed the same `eval=frame` flag `scale`
  does (B-090's trap), but checked empirically instead of assumed, `crop`
  has no `eval` option at all — its `w`/`h`/`x`/`y` are simply always
  evaluated per frame. One new real-ffmpeg pixel test.
- **2026-09-08** — **The Edit-tab preview's real bottleneck, profiled then
  fixed (D-217, roadmap 25).** The standing theory — base64 in
  `chroma_timeline_frame`'s `data:` URL — was measured and is **wrong**:
  0.01 ms of a 42.7 ms frame. 87% of it was decode + composite, and inside
  that, `image::imageops::resize` at 16-19 ms *per layer*, enlarging each layer
  to its whole on-canvas footprint so `overlay` could throw two thirds of it
  away. `blend_layer_sampled` now samples an unrotated, magnified layer
  straight onto the canvas over the visible rect only: **42.7 → 14.0 ms/frame**
  (~23 → ~71 fps) on the owner's own reel, pixel-equivalent within ±1 per
  channel against the path it replaced. The IPC payload went binary
  (`ArrayBuffer` + `Blob` object URL) in the same pass — cheaper on the webview
  side, but recorded as not having been the bottleneck.
- **2026-09-08** — **Text/title clips (roadmap 24c): `TransformOverlay` hides
  the corner (scale) handles for a text clip, keeps the move drag.** The box
  itself needed no special-casing (the backend's `clip_geometry` already
  answers correctly for a text clip's full-frame natural size); the real gap
  was that a corner drag's `commit` writes `scale` through the same
  `set_clip_transform` op a video clip's does, and the frontend store's own
  reducer applies a text clip's write completely unchecked — silently landing
  a `scale` value neither the live preview (`resolve_text_clip_transform`
  pins it to `1.0`) nor `drawtext` (which cannot scale at all) ever reads.
  B-053's exact shape through a different door; closed by hiding the handles
  rather than teaching the reducer to refuse mid-drag. 3 new real-DOM tests.
- **2026-09-08** — **Text/title clips (roadmap 24b): `ClipInspectorPanel`
  hides Scale/Rotation/Width/Height/Crop for a text clip**, leaving Opacity/
  Position X/Position Y — the three fields `resolve_text_clip_transform`
  actually honours (the rest are pinned server-side and `editor_set_clip_
  transform` refuses a non-default write to any of them). A known follow-up
  left open from D-211's own pass (`ClipInspectorPanel.tsx` was owned by two
  concurrent efforts at the time). 3 new real-DOM tests.
- **2026-09-08** — **`editor_set_selection` (roadmap 26, D-216): the Edit tab's
  selection is finally WRITABLE over MCP, not just readable.** Closes the
  read/write asymmetry D-209 hit live — `TransformOverlay`'s on-canvas box and
  handles mount only for a selection of exactly one clip, so until now nothing
  but a human's mouse could reach, drive or verify the entire on-canvas
  transform surface. One op driving the store's existing
  `setSelection`/`setSelectedGap` (the same pair every GUI selection path
  calls), one MCP tool, no new store action, no Rust change. Takes an array
  (so D-107 multi-select is reachable too), each entry addressable by clip
  index or clip id, `[]` to clear, or a `gap` — validated against the live
  timeline, and a gap against the same `gapAt` the GUI's own click uses.
  **Deliberately not undoable**: selection is not part of `Timeline`, so
  D-051's snapshots never carried it and a human's click pushes nothing
  either — see D-216. 17 new real-DOM tests that assert the box and its four
  handles actually mount, not just that the store took the value; 703/703.
  **Verified live end to end** in a second isolated instance with
  `debug_screenshot` (D-210): no box → call the op → box + four handles tight
  around the picture and the real Inspector form → drive a transform and watch
  the picture land inside the box (B-093's own symptom, checked by an agent for
  the first time) → clear → select a gap and watch "Close Gap" appear.
- **2026-09-08** — **B-095 fixed (D-215): `editor_export` now honours `opacity` and `rotation`,
  static and keyframed** — both were completely absent from the ffmpeg
  compiler before this. `geq`'s `alpha_expr` for opacity (`colorchannelmixer`,
  the originally-suggested filter, turns out to flatly reject a time-varying
  expression — confirmed empirically), `rotate=` for rotation (direction and
  canvas-size behavior verified to match the Rust compositor's own
  `imageproc::rotate_about_center` empirically, not assumed). Folding fade
  into the same opacity expression also fixed an adjacent, previously-silent
  gap: a video clip's own fade handle (D-207) only ever reached its embedded
  audio, never the picture. Three new real-ffmpeg pixel tests. Filed B-098
  separately for the one still-open piece of the same shape: crop insets
  remain static-only in export.
- **2026-09-08** — **`editor_move_track` (roadmap 24(e), D-214):** closes the
  "a new track always lands at the bottom of the z-order" gap found right
  after text/title clips shipped — `editor_add_track` only ever appends, so a
  title added to a project that already had footage had no MCP way to get
  above it. Wraps `Timeline::move_track`, the same primitive
  `TimelinePane.tsx`'s drag-to-reorder track headers already used (D-094) —
  a pure MCP-exposure gap, not a missing primitive. Along the way, promoted
  the GUI's local selection-follow math (`trackIndexAfterMove`) to a shared
  `timeline.ts` helper so the new MCP op keeps a human's live clip selection
  correct after an agent-driven reorder, the same way the GUI's own drag
  already does.
- **2026-09-08** — **Text/title clips in the Edit tab** (roadmap 24,
  D-211/D-212/D-213): `Clip::text` as a real clip variant on an ordinary video
  track (so placement/trim/split/keyframes/fades are all the existing ops), an
  `ab_glyph` rasteriser feeding the live compositor, an ffmpeg `drawtext`
  export path spliced into the overlay chain at the clip's own z-order, plus a
  timeline **Title** button, an Inspector Title section and
  `editor_add_text_clip`/`editor_set_text_clip`/`editor_text_fonts`. Both
  engines read the same font file; pixel-measuring the two found (and fixed) a
  real ~11 % size mismatch between `ab_glyph`'s em-based scale and FreeType's
  ascender+descender one, and caught an escaping bug that rendered no text at
  all while exiting 0. Phase 1 is the basic title generator — single-line, no
  scale/rotation/crop — with the deferred list in
  `docs/notes/text-title-clips.md`.

- **2026-09-08** — **Fixed B-096: the Edit tab's preview/timeline split
  wasn't actually resizable**, a fixed `h-[46%]` flex row despite CLAUDE.md's
  own standing rule for exactly this class of pane. Wrapped in a nested
  vertical `ResizablePanelGroup` — the same pattern this file's own
  Inspector column and `MotionTab.tsx`'s equivalent split already use, not a
  new one.

- **2026-09-08** — **Fixed B-093 (D-209): on a keyframed clip the on-canvas
  transform box was drawn from the clip's STATIC transform, so it sat nowhere
  near the picture, and dragging it wrote a value the compositor can never
  show** (owner, live, with screenshots on the real ~50-keyframe
  `perf-comparison-reel-v3.chroma` — "the handles are entirely to the side of
  the visible picture", "i made it small but no clip follows that only the
  box"). Pre-existing since D-136 and invisible until B-085/B-092 made canvas
  click-to-select actually work. The box and D-204's hit rect now read
  `clipKeyframes.ts`'s new `resolveClipBoxTransform` at the clip's own source
  frame — five calls to D-208's existing `paramValueAt`, deliberately **not** a
  second interpolator — and a drag auto-keys **per property**, the same answer
  D-208 gave the Inspector's number fields, through the same helpers. Also
  fixed a `setState`-in-render commit the new DOM drag coverage exposed (a
  StrictMode double-commit is two keyframes, not one idempotent static write).
  **Perf, per the new top-priority rule:** the per-property keyframe reads are
  now indexed once per keyframe-array identity instead of re-sorting the list
  27 times per Inspector render — measured 31.7 µs → 1.2 µs at 50 keys (26.9×).
  That is not what "lagging like hell" is, though: D-209 records the real
  target (every preview frame crosses IPC as a base64 JPEG string, one at a
  time) in roadmap item 25. 23 new tests, 632/632. Live-run in a second
  isolated Tauri instance on the owner's real 50-keyframe project (loads,
  scrubs, no console error or panic; zero React-Compiler bailouts in
  `packages/editor/src` in the real vite build) but **not** verified at the
  pointer tier — and the reason is its own new roadmap item 26: there is no
  `editor_set_selection` op, so nothing but a human's mouse can put a clip into
  the state where the transform box even mounts, which leaves the whole
  on-canvas surface agent-unverifiable. See D-209.

- **2026-09-08** — **(D-210) An agent can now actually see the app.** New
  `chroma_debug_screenshot` / `chroma_debug_sample_pixel` commands make the
  running window's WKWebView photograph *itself*
  (`takeSnapshotWithConfiguration:`), which — unlike `screencapture`,
  `CGWindowListCreateImage` or ScreenCaptureKit — needs no macOS Screen
  Recording permission, the wall that had blocked every live UI verification
  this session. Exposed as MCP `debug_screenshot` (take a shot → `Read` the
  path → look at it) + `debug_sample_pixel`, and to a human as
  Cmd/Ctrl+Shift+D. Verified live against a real running window, not just
  compiled. Notes: `docs/notes/debug-screenshot-tool.md`.

- **2026-09-07** — **Fixed B-092 (D-205): canvas click-to-select was still
  completely dead in the real app after D-204 shipped it** ("still not able to
  select / unselect clips / video by clicking on the canvas... from timeline it
  works"). `useContentBox` took a `RefObject` and could only re-measure when
  its *size* changed — so when the composition size arrived (milliseconds)
  before the container existed (`PreviewPane` renders its surface only once a
  real ffmpeg frame decode returns, hundreds of ms), it stored a 0×0 box
  forever and `useCanvasClipPick` never attached its listener at all. Every
  test and the browser harness answered both commands from synchronous stubs,
  so they never saw that ordering. The hook now takes the ELEMENT, held in
  state via a callback ref. Verified live in a real WKWebView window with real
  clicks: same coordinates select/clear with the fix and do nothing without it.
  Also exposed `selection`/`selectedGap` on `editor_get_state` — selection was
  previously unobservable from outside the webview, which is how this shipped.

- **2026-09-07** — **(D-206) Added a real delete action to the project
  launcher** — a hover-revealed trash button on each project card, confirmed
  via the app's existing `ConfirmModal`, backed by a new
  `chroma_project_delete` Tauri command (`delete_project_at`, validated the
  same way the launcher's own listing already validates a project before
  showing it; refuses to delete whichever project is currently open). The
  card's outer element changed from a `<button>` to a `<div role="button">`
  so the delete button can nest inside it without invalid/unreliable nested-
  button HTML. 3 new Rust tests.

- **2026-09-07** — **On-clip fade handles (D-207), closing D-147's last UI
  gap.** Owner, by screenshot: the fade "rubber band" every reference NLE has.
  Every clip on the timeline — video track and audio track alike, because one
  fade pair drives picture and sound together in this model — now draws its
  `fade_in_frames`/`fade_out_frames` ramps at their real `FadeCurve` shape
  (exactly, not straightened: an SVG cubic *is* a `cubic-bezier`), with a small
  handle at each ramp's top that drags to set the fade live and commits ONE
  `set_clip_fade` op on pointer-up — the same op, undo stack and persist path
  the Inspector's numeric Fade field already used, so the two can't disagree.
  Coexists with the clip-move drag (distinct hit target) and the library's
  full-height edge-trim handles (a 15px-tall grab target at the clip's top
  edge, leaving the lower ~37px of both trim zones alone — Resolve's own
  stacking). Verified pure (22), jsdom with real `PointerEvent`s (10, including
  "the store must not change until pointer-up"), and by real ffmpeg: a
  drag-derived fade exports at −41.2/−21.6/−38.5 dB head/mid/tail against a
  flat −21.1 dB unfaded. Not live-tested in a Tauri instance — see D-207.

- **2026-09-08** — **Per-property keyframes and per-property reset in the Edit
  tab's Inspector (D-208).** Every Transform/Crop row now has its own
  After-Effects-style stopwatch diamond (filled = that one property is
  animated), `<`/`>` nav over that property's own keys, and a `RotateCcw`
  reset to its default — replacing the single whole-clip button that keyframed
  all nine fields as one bang. Writes MERGE into the key at the playhead
  instead of replacing it, editing an animated property keys the new value
  (and the field now shows the interpolated value at the playhead rather than
  a static number the preview isn't using), and "Key all properties" is kept
  as an explicit batch shortcut. **Found and fixed B-094 on the way:** the
  Rust live-preview resolver bracketed keyframes across *all* keys, so a
  property whose key wasn't named in both bracketing entries was *held* rather
  than interpolated — turning exactly the animation this feature authors into
  a step function on screen while the export rendered it correctly. New
  `keyframes::interpolate_param` fixes it; the mask/relight resolver is
  untouched. **Filed B-095, not fixed:** the ffmpeg export compiler ignores
  `opacity` and `rotation` entirely (static values included).

- **2026-09-07** — **Fixed B-088 (D-202): the Edit tab's live preview never
  showed a clip's current position/crop/scale.** Root-caused to an ordering
  race, not the compositor: `chroma_timeline_frame` renders the project's
  *persisted* manifest, but `PreviewPane` refetched on the store's
  *optimistic* `timeline` object — ~400 ms before the debounced
  `chroma_timeline_set` had written anything, and never again after. The
  preview sat one edit behind, permanently, which is why transforms set via
  the Inspector or MCP appeared to do nothing and `TransformOverlay`'s
  handles moved their box over a picture that never moved. Fixed with a
  `savedVersion` clock bumped only when the backend really holds the new
  timeline. The Rust compositor was read end to end against the export
  compiler and is correct — zero Rust changed. New real-DOM regression test
  drives the real `PreviewPane` and asserts the rendered `<img>`.

- **2026-09-07** — **Roadmap item 23, minimal slice:** added `editor_remove_media`
  MCP tool, wrapping the SAME `chroma_media_remove`/`removeMedia` path the
  Sources panel's own delete UI already used — the pool's only
  stuck/wrong-item correction mechanism until a real re-probe/expiry exists
  (still open). Traced (not live-tested — no built Tauri instance in this
  worktree; see roadmap item 23) that a clip already placed on the timeline
  referencing a removed pool item does not break: its `source_path` is an
  independent copy, never re-read from the pool, only its `media_id`
  back-link goes stale — now reported in the tool's `stillReferencedBy`
  field. `docs/notes/mcp-tool-coverage.md` updated.

- **2026-09-07** — **Fixed B-083 (D-203): switching projects left the Edit
  tab on the previous project's timeline.** The composition root told each
  tab only *whether* a project was open — a boolean, and both sides of an
  `open_project`/`new_project` switch are `true`, so the switch was
  invisible to the bridge. Every per-project store now takes the open
  project's **identity** (`selectProjectKey`) as its one input: a changed
  key drops the outgoing project's state and re-runs the store's existing
  open path. The same gap was audited and fixed in two more stores it was
  equally open in — the Motion tab's manifest (a per-project sidecar a save
  would have written into the wrong project) and the media pool that
  `editor_add_clip` resolves against. `npm test --workspaces` green
  (`@chroma/editor` 499/499, `@chroma/motion` 441/441, `@chroma/bridge`
  5/5 — that package gained a test setup for this).

- **2026-09-07** — **Fixed B-085: you can now click a clip's own picture in
  the Edit-tab preview to select it** (D-204). D-136's transform handles were
  reachable only by selecting in the timeline first — nothing in the preview
  listened for a press on the picture at all. New `canvasPick.ts` derives every
  visible layer's on-canvas rect frontend-side (no new backend command needed;
  the note's own open question had assumed otherwise) by mirroring the Rust
  compositor's layer resolution and paint order, and reusing the exact box math
  `TransformOverlay` draws with. The obvious z-ordered hit-layer version is
  wrong and was caught live in a real browser — a full-frame clip's own
  transform box is full-bleed and swallows every press — so the shipped
  `useCanvasClipPick` decides per press in the capture phase instead. Verified
  pure + jsdom + real-Chromium (canvas-only selection, then a real corner drag
  really resizing). `npm test --workspace @chroma/editor` 534/534 (was 495).

- **2026-09-07** — **Fixed B-087** (two components read Zustand state with
  `getState()` during render instead of subscribing, so the UI never updated
  when that state changed — the Colorist "Paste" button stayed disabled after
  copying adjustments, and `App.tsx`'s drag-overlay thumbnail could miss one
  that arrived mid-drag): `EditorView.tsx`'s `copiedAdjustments` and
  `App.tsx`'s `ImageDragOverlayNode` thumbnail now use real store
  subscriptions. Both are vendored-fork files — divergence logged in
  `docs/09-engine-notes.md`.
- **2026-09-07** — **Fixed B-086** (`CanvasBoundary`'s displayed composition
  size went stale after a `set_project_settings` write from anywhere other
  than `CanvasSettingsPopover`'s own "Apply" — e.g. the MCP tool): the Rust
  `chroma_project_set_settings` command now broadcasts a
  `chroma://project-settings-changed` Tauri event on every successful write,
  and `useCompositionSize` listens for it directly instead of depending on
  each caller to hand-bump a refresh token — closes the gap for the MCP tool
  and any future caller, not just this one symptom. Live-verified in the
  `app/harness.html?mode=preview` browser harness.

- **2026-09-07** — **Filed B-091** (`editor_export`'s own MCP response
  intermittently fails outright for a large-but-not-huge payload, instead
  of the graceful size-limit truncation the same size class usually gets —
  the real ffmpeg render always succeeds regardless) and mitigated it on
  this side of the boundary: `editor_export`'s MCP tool now drops the
  compiled `args` (the full `ffmpeg` argv, the actual driver of the
  oversized response) from its return value by default — a caller almost
  always only needs to know whether it succeeded and where the file
  landed, not the literal filtergraph. Also filed roadmap item 24: the
  Edit tab has no text/title clip primitive at all (confirmed by grep) —
  this session's own "AFTER"/"BEFORE" labels were a real `ffmpeg drawtext`
  finishing pass laid on top of Chroma's own correct export, not a Chroma
  feature, disclosed as such.

- **2026-09-07** — **Fixed B-090: `editor_export` silently ignored `scale`
  keyframes — only `position_x`/`position_y` ever animated per-frame.** A
  "zoom" authored via `editor_set_clip_keyframes` compiled to a fixed-size
  overlay panning around, revealing real background wherever the box never
  grew to cover. Found live via a real black band the owner spotted in an
  exported frame, confirmed by pixel-sampling a dense sequence of real
  decoded frames. New `scaleExpr` mirrors `positionExpr`'s own keyframe
  shape exactly, feeding a `scale` ffmpeg filter with `eval=frame`; also
  single-quoted `w=`/`h=` (the same B-075 class of bug — unquoted keyframe
  expressions break ffmpeg's filtergraph parser). New real-ffmpeg pixel
  test proves actual overlay SIZE changes, not just argv shape or "ffmpeg
  didn't error" (how B-090 shipped invisibly under the existing keyframe
  test). `npm test --workspace @chroma/editor` 495/495 (was 494).
- **2026-09-07** — **Fixed B-089: pure-audio media (no video stream at all)
  could never be imported at all.** `video::probe`'s `-select_streams v:0`
  legitimately returns zero streams for a real SFX/music file, but the code
  treated that as a probe FAILURE — permanently `offline: true` for every
  such file, so `editor_add_clip` refused them. Caught live adding real
  downloaded SFX/music to the comparison reel. New `probe_audio_only`
  fallback: real duration/audio facts, a nominal 24fps reference rate for
  frame bookkeeping (mirrors `chroma-timeline`'s own `DEFAULT_FPS`
  convention). `cargo test -p chroma-media` 99/99 (was 98).
- **2026-09-07** — **React Compiler bailout pass (D-201): `@chroma/editor` is now
  bailout-free, and one real bug fell out of it.** All 22 source files in the
  package compile with zero bailouts (`TimelinePane`/`TransformOverlay`'s
  hand-written memoization was fighting the compiler and costing them ALL
  auto-memoization; `PreviewPane`/`Filmstrip`/`useEditorControl`/`SourcesPanel`
  cleared too), pinned by a new `reactCompiler.test.ts` guard. Investigating the
  inventory's "possibly a real bug" flags found **B-087** (two components read
  Zustand state with `getState()` during render, so Colorist's Paste button never
  updates after a copy) — filed, not fixed. `TimelinePane`'s drag gesture was
  audited and is already deferred to pointer-up; no change.
- **2026-09-07** — **Fixed B-082: `new_project`'s auto-placed clips never got
  `source_fps`.** `append_media_clip`'s `..Default::default()` left it `None`
  despite the real probe sitting right above — the one other real `Clip`-
  construction site the B-075/B-077/D-194/B-079 fps-unit work never audited.
  Caught live rebuilding the comparison reel: a 47.6fps clip's timeline block
  rendered at roughly 2x its real length. New regression test (a 25fps fixture,
  deliberately off the 24fps default) covers both immediate and post-reload
  state. `cargo test -p chroma-project` 53/53 (was 52). Also filed (not fixed)
  **B-083**: `open_project`/`new_project` never refresh the Edit tab's own
  timeline store when switching PROJECTS (D-195's multi-TIMELINE-within-one-
  project switching is unaffected) — worked around this session by not
  switching projects mid-build.
- **2026-09-07** — **Fixed B-084: `editor_import_media` never populated
  `useMediaPoolStore.items` for a path already known to the Rust-side
  manifest** (e.g. seeded by `new_project`'s own `media_paths`), leaving
  `editor_add_clip` permanently unable to find it — mirrors `main.tsx`'s own
  established "added came back empty, refresh anyway" fallback. Also filed
  (not fixed) **B-085** (on-canvas clip selection for resize doesn't work,
  timeline-click-first only — owner-reported) and **B-086** (`CanvasBoundary`
  goes stale after a `set_project_settings` write made from outside
  `CanvasSettingsPopover`'s own Apply button, e.g. the MCP tool — display-only,
  self-heals on the next timeline edit).
- **2026-09-07** — **B-081 root-caused and fixed — and it was never an IPC bug
  (D-201).** The `IPC custom protocol failed` burst fires once per Tauri IPC call
  in flight when the page navigates; the navigation was a **Vite full page reload
  of the entire app**, caused by `app/src/main.tsx` holding the `Root` component
  while exporting nothing (an invalidating React Fast Refresh boundary that every
  edit behind a `@chroma/*` barrel propagated to). `Root` moved to its own
  `app/src/Root.tsx`; verified live that editing `timeline.ts`/`timelineStore.ts`/
  the editor barrel now hot-updates instead of reloading the whole app.
- **2026-09-07** — **"Multiple timelines" live-verified working; B-080 filed.**
  Extended the D-142 browser harness to mount `TimelineSwitcher` against a real
  multi-timeline fake backend and drove it with real Chromium pointer events:
  create-via-"+", switch-by-click, and per-timeline persistence/isolation all work
  correctly. Found and filed (not fixed) **B-080**: switching/creating a timeline
  while an edit's 400ms debounced save is still pending silently drops that edit —
  no error, not on disk, not recoverable from memory. Also fixed a harness-only
  usability bug (its debug overlay was eating real clicks on the newly-added tab
  strip).
- **2026-09-07** — **Two new `EditOp`s from the timeline-editing gap analysis
  (D-195): `slip` and `swap_media`, both with new MCP tools.** `slip` moves a
  clip's `source_start` in place without touching `start_frame`/`duration`
  (mirrors `trim_start`/`trim_end`'s clamp/lockstep discipline, `editor_slip_clip`
  MCP tool). `swap_media` repoints a clip at different source media while
  preserving everything else about it — transform, keyframes, fades, `link_group`
  — re-clamping `source_start`/`duration` (never `start_frame`) if the new source
  is shorter, and always re-reading `source_fps` from the NEW source rather than
  keeping the old one (the same fix-class as B-075/B-077/D-194)
  (`editor_swap_clip_media` MCP tool). `@chroma/editor` 377/377 (20 new tests),
  `tsc` clean.
- **2026-09-07** — **Timeline interchange export (D-196): a real, DTD-verified
  FCPXML 1.7 exporter** so a Chroma edit can move to DaVinci Resolve/Final Cut
  Pro. New pure compiler `packages/editor/src/timelineInterchange.ts` (mirrors
  `timelineExport.ts`'s own "same Timeline model, different output format"
  shape) → `editor_export_fcpxml` op → a new narrow `chroma_write_text_file`
  Tauri command → `mcp/server.py`'s `editor_export_fcpxml` tool. Maps clip
  placement/trims, track z-order (as fcpxml lanes), transform/crop/opacity,
  A/V `link_group`, and audio track gain; does NOT export `chroma_keyframes`
  animation, clip fades, or audio ducking — no verified FCPXML syntax for the
  first two without guessing, no static equivalent for the third — every one
  surfaces as a warning rather than a silent drop. Verified against Apple's
  own real FCPXML 1.7 DTD (`__fixtures__/fcpxml-1.7.dtd`) via `xmllint
  --dtdvalid`, not just string-compared. XMEML/Premiere scoped as a precise,
  separate follow-up, not attempted this pass — see D-196 for the full
  field-mapping table and why.

- **2026-09-07** — **`editor_export` mixes real audio (D-197), and the Edit tab
  gets a real Export button/dialog/sequential queue (D-198).** Closes D-183's own
  "video-only, a documented follow-up" gap, found live via the owner's own
  hand-rolled external-ffmpeg workaround for SFX in a real reel. Gain (D-057),
  one-pole ducking (D-149, exact via `exp()`), cubic-bezier fades (D-147, sampled)
  and a video clip's own embedded audio (D-129-aware) now mix down to a real
  output stream, replicating the LIVE mixer's semantics rather than reinventing
  them — deliberately using the B-075/B-077/D-194-CORRECTED fps math for duck
  trigger spans, not B-079's still-open conflation (new code, no reason to carry a
  known bug into it). `TimelinePane.tsx`'s toolbar gets a real Export button
  (`EditorExportDialog.tsx`) with per-clip speed/fit/freeze rows and a real
  sequential queue (`exportQueueStore.ts`), wired through the exact same
  `compileEditorExportArgs`/`runEditorExport` the MCP tool now also calls
  (`editorExport.ts`) — not a parallel implementation. `docs/notes/audio-export-
  mixing.md` / `docs/notes/export-dialog-queue.md` have the full design.
  `npm test --workspace @chroma/editor` 408/408 (was 357), including real
  `ffprobe`/`volumedetect`-verified ffmpeg execution (gain drop, fade ramp, duck
  engage/release, two-source mix all measured, not just argv-matched); the
  dialog/queue live-tested in a real Chromium tab via the D-142 harness.
- **2026-09-07** — **Live-preview canvas boundary + Edit-tab canvas-size popover
  (D-199), and B-079 fixed (D-200).** Root-caused the "live preview shows the AFTER
  clip full-bleed instead of stacked with BEFORE, no visible output frame" report
  (roadmap item 18): the Rust multi-track compositor itself is correct (verified
  with a real two-clip red/blue stacking test through the actual `timeline_frame`
  production path) — the real causes were B-079 (a mixed-native-fps clip's
  `Track::clip_at` could drop it out of the live composite entirely; now fixed,
  same fps-aware shape B-077/D-194 already gave the TS side) and the genuine
  absence of any canvas-boundary/settings surface to notice or diagnose it. Added
  `CanvasBoundary.tsx` (a selection-independent overlay, always shows the real
  output frame) and `CanvasSettingsPopover.tsx` (view/edit `ProjectSettings.width`/
  `height` from the Edit tab, previously reachable only from Colorist's shot-strip
  gear). Drag-to-rearrange (D-136) verified still working alongside the new
  overlay. Extended the D-142 isolated browser harness to mount `PreviewPane`
  (`?mode=preview`) and live-verified all of the above with real `PointerEvent`s in
  a real Chromium tab. Rust: `chroma-timeline` 137/137 (+8), `RapidRAW` 146/146,
  `chroma-project` 52/52, clippy/fmt clean on touched code. `@chroma/editor` 360/360 (+3), `tsc`
  clean both packages. See D-199/D-200 and `docs/notes/preview-canvas-boundary.md`.
- **2026-09-07** — **Independent per-axis clip sizing (D-193): `Clip.box_width`/
  `box_height` + an Inspector Width/Height/ratio-lock control.** The fuller,
  end-to-end fix D-184/B-074 explicitly scoped out — a clip can now be placed into
  an arbitrary, independently-sized box (not just a uniform `scale` of its own
  natural aspect) at every layer: the persisted `Clip` model, the Rust live-preview
  compositor (`composite_layer_onto`'s new `effective_size`), the `timelineExport.ts`
  ffmpeg compiler (`box_height` now takes priority over `fitOverrides`), a real
  Inspector control (Width/Height in px + a lock/unlock toggle, `Scale` kept as a
  separate "reset to uniform" affordance), and `editor_set_clip_transform`'s MCP
  surface. Unlike `scale`, `box_width`/`box_height` are a canvas fraction in BOTH
  engines — zero Rust/TS export-parity gap for the new fields, closing that gap
  rather than inheriting it. Honest remaining gaps, both documented in D-193 and
  `docs/04-roadmap.md` item 18: not wired into the clip-keyframe GUI button yet
  (engine supports it via `editor_set_clip_keyframes` directly), and no visible
  canvas-boundary overlay/project-settings UI exists yet (a separate, related but
  NOT-the-same-root-cause gap, checked explicitly against this work). Rust: 128+33
  tests, clippy clean. `@chroma/editor` 333/333, `tsc` clean. Not live-verified
  against a running app this pass (no instance available in this worktree).
- **2026-09-07** — **`editor_export freeze_overrides` (D-188) + B-077 filed.** Owner's own
  confirmed creative call for the reel — the sped-up AFTER clip finishes while BEFORE keeps
  playing — needed a real capability that didn't exist: holding a clip's last frame for the
  rest of the export instead of it just disappearing. New export-time-only
  `freeze_overrides` (mirrors `speed_overrides`), via ffmpeg's `tpad=stop_mode=clone`, with a
  real ffmpeg-execution test. Also filed **B-077** (not fixed this pass, dispatched
  separately): `endFrame`/the GUI timeline display add a clip's SOURCE-frame `duration`
  directly to its TIMELINE-frame `start_frame` with no fps conversion — wrong displayed
  duration/gaps for any mixed-native-fps clip (does not affect `editor_export`'s actual
  output, which already converts correctly per B-075). `@chroma/editor` 328/328.
- **2026-09-07** — **B-077/D-194: the same B-075 fps-unit bug, everywhere else in the Edit tab.**
  B-075 fixed `editor_export`'s `duration`/`source_start` fps mix-up but only there; the GUI
  itself had the identical bug — a 2113-frame screen recording at 44.13fps showed 00:01:28:00
  (88s) on the transport bar instead of its real 47.86s. Fixed the one real choke point
  (`endFrame`) and threaded the project's `fps` through everything that calls it in
  `timeline.ts`/`TimelinePane.tsx`/`marquee.ts` — gap detection, insertion/ripple math, the trim
  clamps, filmstrip/waveform widths. Also closed a real persistence gap: `Clip.source_fps` didn't
  exist on the Rust struct, so it silently vanished on every `chroma_timeline_set`/`_get` round
  trip (added, additive, no other Rust change needed). Filed (not fixed) B-079: the live Rust
  playback/audio-decode/duck engine has the same conflation on a reachable path — a real
  follow-up, scoped and documented, not silently skipped. `@chroma/editor` 335/335 (+11),
  `chroma-timeline` 129/129 (+1). See D-194 for why "convert at every consumption site" (matching
  B-075) was chosen over normalizing `duration` to timeline-frame units at clip creation.
- **2026-09-07** — **`editor_export` fixed for real content (B-075/B-076, D-187) + real ffmpeg
  regression tests.** The reel's first real export attempt found every render was actually
  broken three ways: an unquoted keyframe expression made ffmpeg reject the filtergraph
  outright for any clip with more than a trivial animation; `duration`/`source_start`/keyframe
  `frame` were divided by the export's fps instead of the CLIP's own native fps (silently wrong
  timing whenever a source's real frame rate differs from the export's — exactly two screen
  recordings at two different rates); and the `color=[base]` backdrop has no duration of its
  own, so nothing ever capped the output — every export before this ran forever until killed by
  hand. Fixed all three (`Clip.source_fps`, quoted `x=`/`y=`, `-t <furthest clip end>`). New
  `timelineExport.ffmpeg.test.ts` actually invokes real ffmpeg and checks real output via
  `ffprobe` — the existing suite only ever string-compared generated argv, which is exactly how
  all three shipped invisibly. `@chroma/editor` 324/324.
- **2026-09-07** — **D-183's Edit-tab MCP server committed** (was sitting unit-verified but
  uncommitted since 2026-09-07 morning): `useEditorControl.ts`, `timelineExport.ts` (pure
  ffmpeg-argv compiler), `chroma_run_ffmpeg`, 62-tool `mcp/server.py`. Its first-ever real use
  (building a performance-comparison reel) found and fixed two real bugs same-session: **B-069**
  (a Rules-of-Hooks violation in `TimelinePane.tsx` that crashed the ENTIRE `editor_*`
  control-server bridge, not just the one panel — two conditional early-`return`s sat between
  hook calls) and **B-074/D-184** (`editor_export`'s `scale` forced every overlay to the output
  canvas's own aspect ratio, making a full-width/half-height stacked layout impossible for any
  canvas size — fixed via ffmpeg's own `-2` auto-height, with the old forced-stretch behavior
  kept available as an explicit opt-in `fitOverrides` value). See `docs/BUGS.md` B-069–B-074 and
  `docs/08-decisions.md` D-184 for the full detail.
- **2026-09-07** — **Media understanding lands in Chroma proper: a second sidecar, 4 new MCP
  tools (D-189, D-190).** Pulled the two capabilities validated in the sibling `videoAgent`
  prototype into Chroma's own architecture — word-level transcript (mlx-whisper large-v3) and
  "what changed on screen, and when" (ffmpeg scene-detect for exact timing + Qwen3-VL-4B to
  describe each before/after frame pair) — as `ai-media/`, a second supervised FastAPI sidecar
  with its own venv and port. The scope doc demanded a real spike before assuming two processes
  were necessary, and it settled the question outright: `ai/requirements.txt` ∪ `{mlx-vlm,
  mlx-whisper}` is a literal pip `ResolutionImpossible` (mlx-vlm needs `transformers>=5.5`, `ai/`
  pins `<5` for ViTMatte). Rather than copy the supervisor for the second process, **D-190**
  generalized `chroma_ai::sidecar` to N sidecars via a `SidecarSpec` + a state registry — `ai/`'s
  behaviour, call sites and tests all unchanged. Then the usual chain, each layer mirroring its
  precedent: `chroma_ai::media_understanding` (the HTTP client, `depth.rs`'s error discipline),
  4 Tauri commands, an `@chroma/editor` store that caches results **by source path**, and
  `editor_get_transcript`/`editor_analyze_video` (+ their two `*_status` polls) in
  `useEditorControl.ts` and `mcp/server.py`. Start-then-poll rather than blocking because
  `chroma::control`'s bridge times out at 20 s and these run for tens of seconds to minutes.
  Live-verified against real footage: an 18 s clip transcribed in 11.9 s with 55 word-level
  timings; a 20 s cut-heavy reel analysed in 37.9 s, 5 candidates → 5 descriptions with correct
  ffmpeg-derived timestamps. 66 MCP tools now, no name collisions; `cargo fmt`/`clippy` clean,
  22 chroma-ai + 325 editor tests pass, zero new `tsc` errors. Settings shows a status card per
  sidecar. `docs/notes/media-understanding-sidecar-scope.md` records what shipped vs. the plan.

- **2026-09-07** — **`editor_get_capabilities`: a static, no-round-trip MCP tool for
  the Edit tab's hard-won constraints (D-191).** The reel session's own first live use
  of D-183's Edit-tab tools kept needing to read Chroma's own source to learn things no
  docstring said. New tool returns a structured dict covering the `scale`/`fit_overrides`
  aspect-ratio model (kept in sync with D-184's actual shipped fix), track paint order,
  per-clip keyframe scoping, export's real video-only v1 scope, and B-069/B-070/B-071/
  B-073's rough edges — answered entirely in-process, no app/project needed at all.
  `editor_import_media`/`editor_set_clip_transform`'s own docstrings gained short
  pointers to it. 63 tools total, verified via a real module import.
- **2026-09-07** — **A Claude Code project skill packages the reel workflow (D-192).**
  `.claude/skills/chroma-comparison-reel/SKILL.md` turns this session's real end-to-end
  procedure — live-test the MCP surface first, avoid the macOS screen-recording filename
  trap, the stacking/PIP compositing recipe (delegated to `editor_get_capabilities`), the
  real `editor_*` tool sequence including `fit_overrides`, the cross-repo `videoAgent`
  SFX/understanding pattern — into a repeatable, checked-in procedure instead of tribal
  chat-transcript knowledge. `.claude/` was not previously tracked in this repo and is not
  gitignored; this is its first use, flagged rather than silently decided.
- **2026-09-06** — **Per-card drag-to-fix for the `layers` primitive, + B-068 (D-182, Phase 3 of 3).**
  `Layers.tsx`'s `LayerItem` gains optional `dx`/`dy` (a pixel offset added to the computed
  position, `0,0` default, byte-for-byte identical render for every existing manifest) and a
  `data-motion-item-index` per card. New `{kind:'layer-item'}` selection lets a card be clicked,
  outlined, and dragged independent of its siblings (`MotionCanvasOverlay.tsx`'s new
  `findLayerItem`/`'move-item'` drag, `manifestEdit.ts`'s `selectedLayerItem`/
  `setLayerItemOffset`/`setLayerItemField`/`resetLayerItemPosition`, a minimal Inspector form).
  Also fixes **B-068**, found live while testing this: D-181's own solo-scene transport bar let a
  click "see through" it to select/drag the canvas underneath, since the existing hit-test
  deliberately walks the whole `elementsFromPoint` stack, not just the topmost element — a new
  `data-motion-transport` marker + an early bail on `e.target` fixes it. Live-verified end-to-end
  against the real project manifest (drag → correct `dx`/`dy` written, siblings untouched, Reset
  works) plus a byte-for-byte render check. `tsc`/`motion-engine`/`app` baselines unchanged,
  `@chroma/motion` 439/439 (+18). Closes the 3-phase scene-separation + per-card-drag initiative
  (D-180 export, D-181 solo preview, D-182 this one).

- **2026-09-06** — **Selecting a scene previews/scrubs it as its own 0:00-start clip
  (D-181, Phase 2 of 3).** `MotionPreview.tsx` gains `activeSceneIndex` — when set, swaps
  Remotion's native transport (no notion of a sub-range) for a small owned one scoped to that
  scene's own window, with a manual loop constraint (`loop`/native `controls` both disabled while
  soloed). `KeyframeTimeline.tsx` filters lanes to the active scene and re-bases its ruler to
  `[0, sceneDurationFrames)` — every write path underneath stays absolute-frame, unchanged; only
  the display/interaction boundary converts. A toolbar "Scene: `<id>` · Whole video" badge is the
  explicit way back to the combined view. No engine/schema changes at all — same key insight as
  D-180. Live-verified: local transport time, continuous in-scene looping across multiple cycles,
  filtered Keyframes panel, and a clean mid-playback revert via the toggle. `tsc` clean,
  `@chroma/motion` 421/421 (+2). Second of 3 planned phases (per-card drag-to-fix for `layers` next).

- **2026-09-06** — **Render exports every scene as its own separate video file, not one
  combined video (D-180, Phase 1 of 3).** `RenderRequest` (`chroma-motion` crate) gains an
  optional absolute-frame `frame_range`, appending Remotion's own `--frames=start-end` — no
  engine/schema changes needed at all, since the CLI already supports rendering a sub-range of an
  existing composition. `chroma_motion_render` defaults per-scene output to
  `<project>/motion/renders/<sceneId>.mp4`. `useMotionManifest.ts`'s `render()` now loops every
  scene sequentially through `sceneStartFrame`/`sceneDurationFrames`; a scene failing stops the
  loop (surfacing which one) rather than silently skipping it. Real end-to-end smoke test against
  the actual project manifest: rendering the `hook` scene's own range produced a 4.05s file, not
  the manifest's combined 15s. `cargo test -p chroma-motion` 7/7 (+2), `tsc` clean, `@chroma/motion`
  419/419 unchanged. First of 3 planned phases (solo scene preview, per-card drag-to-fix next).

- **2026-09-06** — **`+ Add scene` in `LayerList` (D-179).** New `manifestEdit.ts`
  `addScene(manifest, afterSceneIndex?)` appends a minimal, schema-valid scene (a short random id,
  `dur: 4`) either at the end or right after the currently-selected scene, selecting (and seeking
  to) it immediately — `addLayer`'s own established shape. Multi-scene support was already
  complete everywhere else (timeline, player, LayerList grouping); the only real gap was that
  nothing could CREATE one. Live-verified: new scene inserted in the right place, Inspector
  showed its real fields with no second click, total duration and every downstream reader
  updated with zero changes of their own. `tsc` clean, `@chroma/motion` 419/419 (+7).

- **2026-09-06** — **B-067: a destructive duplicate Inspector field, AND the `layers` primitive's
  `active` step-schedule exposed on the Keyframe timeline (D-178).** `propCatalog.ts` had TWO
  competing editors for `layers`/`layerstack`'s `active` key — a correct generic JSON field and a
  destructive `kind:'number'` override that silently overwrote a real `[{at,i}]` schedule the
  moment it was touched. Deleted the destructive one. Separately: that same schedule had NO
  Keyframe-timeline row at all (unlike Camera) — new `'active'` lane kind threaded through
  `keyframeVisibility.ts`/`manifestEdit.ts`/`KeyframeTimeline.tsx`, parallel to (never merged
  with) the existing `transform.keys`-driven `'layer'` lane, so a layer with both kinds of keys
  gets two clearly-labelled adjacent rows. Live-verified both fixes, including a real end-to-end
  drag-to-retime of an `active` key through the actual UI. `tsc` clean, `@chroma/motion` 412/412
  (+24).

- **2026-09-06** — **`LayerList` drag-to-reorder + real per-layer thumbnails (D-177).** New
  `manifestEdit.ts` `reorderLayers(manifest, sceneIndex, kind, fromIndex, toIndex)` — a pure,
  field-preserving array move within one scene's `layers[]` or `scene3d.children[]` (never across
  scenes, never bridging the two arrays), wired into `LayerList.tsx` as a native
  pointerdown/move/up drag (no drag library, matching this package's own standing convention) with
  a live drop-line and undo-wired commit. Also: real live per-row thumbnails via `@remotion/player`'s
  `Thumbnail` component for `matrix`/`layers` (checked empirically — `text`/`emphasis` render
  illegible hairline strokes at this scale and fall back to a static glyph, same as the 3D three's
  existing WebGL-context-ceiling fallback), mount-on-visible via `IntersectionObserver`. Found and
  fixed a real stale-React-state bug in the drag's own drop-target read (fixed with a ref, before
  ever shipping). `@chroma/motion` 367→382 tests, `tsc` clean, `app`'s 64-error baseline unchanged.

- **2026-09-06** — **B-066: the selection outline froze during a move/resize drag; selecting a
  layer now seeks to its own start (D-176).** `recomputeBoxes` only re-measured on a `selections`
  change or a Remotion `frameupdate`/`scalechange` event — never on `onTransientChange` during a
  drag, so the drawn outline stayed at its pre-drag size while the real content visibly
  moved/resized underneath it. Fixed with one `requestAnimationFrame(recomputeBoxes)` per
  pointermove. Also: new `manifestEdit.ts` export `layerVisibleFrameRange` (6 tests) lets
  `onSelect` seek to a layer's own `at` when the current frame falls outside its visible window —
  a `LayerList` click on a not-yet-visible layer now actually shows it, without reintroducing
  B-064's fixed regression. Live-verified in the harness both ways. `tsc` clean, `@chroma/motion`
  373/373 (+6).

- **2026-09-06** — **Keyframe timeline's zoom now matches the Edit tab's own (D-175).** Real
  `lucide-react` `ZoomIn`/`ZoomOut` icons and a percentage readout (was raw text `−`/`+` and
  `70px/s`), plus ctrl+scroll-wheel zoom (a plain native `wheel` listener, matching
  `TimelinePane.tsx`'s own scroll-vs-zoom split exactly). The underlying `pxPerSecond` range
  stays this timeline's own (D-162's call, unchanged) — only the UI/interaction layer matched.
  Live-verified: button and wheel both step 100%→140% with identical precision. `tsc` clean,
  `@chroma/motion` 367/367 unchanged.

- **2026-09-06** — **B-063: clicking a layer on the Motion canvas also toggled playback
  (D-172).** `@remotion/player` silently defaults `clickToPlay` to match `controls`, so enabling
  the transport bar also made every selection click on the canvas start/stop playback — fighting
  `MotionCanvasOverlay`'s own click-to-select. Fixed with an explicit `clickToPlay={false}` on
  `MotionPreview.tsx`'s `<Player>`. Confirmed NOT a shared-component bug — `@chroma/player`
  (the real cross-tab preview component) isn't used by Motion at all; the Edit tab's own preview
  was never susceptible. Live-verified in the harness. `tsc -p app` unchanged at 64.
- **2026-09-06** — **The scene-manifest panel actually collapses now; `</>` moved to sit with
  Save/Render; B-064 fixed (D-173).** D-153's own deferred shape, finally built: `ManifestEditor`
  is now just the textarea, and `showManifest` (`MotionTab.tsx`) gates the WHOLE panel + its
  handle, reclaiming its ~420px when hidden instead of just hiding the JSON inside a
  still-reserved rectangle. Save/Render/dirty/errors moved to a new always-visible toolbar, whose
  `</>` chip gets a red border when a parse error exists and the panel is collapsed. Also:
  **B-064** — a canvas click to select a layer was resetting the playhead to the scene's start on
  every click (predicted and disclosed back at D-158/D-162, now confirmed live). New
  `manifestEdit.ts` export `sceneIndexAtFrame` (5 tests) lets `onSelect` only seek when the
  target is actually in a different scene than what's under the playhead. Live-verified: same-
  scene canvas click preserves the playhead, cross-scene `LayerList` click still jumps. `tsc -p
  app` unchanged at 64, `@chroma/motion` 367/367.
- **2026-09-06** — **B-065: a 2D layer added to a `scene3d` scene rendered nowhere, ever
  (D-174).** `addLayer` only checks whether the INSERTED primitive is 3D-capable, never whether
  the TARGET scene already has a `scene3d` block — so adding an ordinary 2D primitive (e.g.
  `matrix`) via the Catalog to a scene that already has 3D content silently created permanently
  invisible layers: `Video.tsx`'s `OneScene` was a hard `scene.scene3d ? <ThreeD/> : <TwoD/>`
  ternary that never rendered `scene.layers` at all once a scene had `scene3d`, regardless of
  playhead position. Fixed the general way — `<TwoD>` now renders as a 2D overlay ON TOP of
  `<ThreeD>` whenever `scene.layers` actually has entries — rather than blocking the insert, since
  2D graphics over 3D content is a real, useful composition. Byte-for-byte identical renders for
  every existing `scene3d` manifest (none has `layers` at all, confirmed directly); a real smoke
  render with a `matrix` layer added to the sample's `space` scene now shows it composited over
  the particle stream, where before it rendered nothing at any frame.

- **2026-09-06** — **Close D-170's own flagged gap: camera-key `ease` validation (D-171).**
  `motion_set_camera_2d`/`motion_set_camera_3d` (D-168, built before the ease-validation guard
  existed) now run every key's `ease` through the same `validateEaseArg` D-169's
  `motion_set_layer_transform_keys` already uses — malformed shape errors, out-of-range values
  clamp with a warning instead of validating fine and crashing the render later (B-062's exact
  failure mode, still open at the schema level). `tsc -p app` unchanged at 64,
  `@chroma/motion` 362/362.
- **2026-09-06** — **Motion tab MCP surface, Phase 4: navigation, selection, persistence
  (D-170) — closes the whole scoped tool list (18 ops across 4 phases).** Four new `motion_*`
  ops: `select` (set the live selection + seek the player to the scene's start frame, mirrors
  `MotionTab.tsx`'s own `onSelect`), `seek` (absolute `{frame}` or `{scene_index, at}` seconds),
  `save_manifest` (wraps `useMotionManifest().save`), `render` (wraps `useMotionManifest().render`
  — a real `remotion render` subprocess to disk). `useMotionControl` now takes a `refs`
  parameter (`playerRef`/`measureApiRef`/`setSelections`) alongside `m` — no `mRef`-style re-sync
  needed for any of the three (a stable `useRef` object and a stable `useState` setter, unlike
  `m`'s fresh-every-render object). `save`/`render` (`useMotionManifest.ts`) now resolve to a real
  `SaveOutcome`/`RenderOutcome` instead of a bare `boolean`/`void`, so an MCP call gets a
  definitive answer on the promise itself rather than racing a later re-render for `saveError`/
  `renderError` state — every existing GUI side effect unchanged. Found and empirically confirmed
  a real, pre-existing constraint along the way: `control.rs`'s generic 20s bridge timeout applies
  to `motion_render` too (a live render took 33s; the `curl` caller got a 504 at 20.012s while the
  frontend kept rendering to a real, `ffprobe`-confirmed MP4 in the background) — documented as a
  known limitation (poll the deterministic output path), not "fixed" with new polling machinery
  against this task's own explicit instruction not to invent any. Also documents what's still
  open across the WHOLE surface: no Python `mcp/server.py` wrappers for any of the 18 ops yet, no
  `motion_open_project` (still borrows Colorist's `new_project` for test setup), and a real gap
  found while closing out — `set_camera_2d`/`3d` (D-168) never got B-062's ease-validation guard
  Phase 3 added for layer keyframes. Both `motion_render` branches (>20s and <20s) live-verified
  with real rendered files; a real coordinator-instance-killed-by-an-overbroad-`pkill` mistake was
  made and fixed during cleanup, recorded honestly in the decision entry rather than omitted.
  `tsc -p app` unchanged at 64 (diffed identical, not just counted); `packages/motion`'s vitest
  suite unchanged at 362/362.

- **2026-09-06** — **Motion tab MCP surface, Phase 3: layer keyframing (D-169).** Three new
  `motion_*` ops: `set_layer_transform_keys` (replace a layer/scene3d-child's `transform.keys`
  wholesale), `add_layer_keyframe` (upsert one key at a given time — `x`/`y` optional, derived from
  the layer's current on-screen position via `layerDragBase` when omitted), `move_layer_keyframe`
  (retime one existing key, reorders/clamps like a canvas drag). Added a real correctness guard
  along the way: a new `validateEaseArg` helper closes B-062's exact gap (an `ease` 4-tuple that
  can crash `Easing.bezier` if `x1`/`x2` fall outside `[0,1]`) at the MCP boundary, reusing
  `easeCurve.ts`'s own `resolveEaseCurve`/`clampEaseCurve` — a real error for a malformed value, a
  `warning` (never a blocker) for one that got clamped. Considered and deliberately left out:
  `moveKeysByDelta`'s multi-key nudge (D-163) — its own `baseAtSeconds` needs a live drag session
  an MCP call doesn't have; a real scope boundary, not a silent drop. All three ops live-verified
  against a real second running instance with before/after `motion_get_manifest` diffs. `tsc -p
  app` unchanged at 64; `packages/motion`'s own vitest suite unchanged at 362/362.

- **2026-09-06** — **Motion tab MCP surface, Phase 2: the rest of the non-keyframe edit surface
  (D-168).** Nine new `motion_*` ops in `useMotionControl.ts`: `set_layer_field`,
  `set_layer_position`/`size`, `move_layers_by_delta`, `align_layers`/`distribute_layers`,
  `set_scene_field`, `set_camera_2d`/`3d` — all thin adapters over real `manifestEdit.ts`
  functions, live-verified against a real second running instance. Found and fixed a real gap
  along the way: `manifestEdit.ts`'s functions never prefer a selection's stable `id` over its
  `index` themselves (the GUI only gets that "for free" via `MotionTab.tsx`'s own D-158 effect) —
  a one-shot MCP call has no such standing state, so a new `resolveOrError` helper resolves `id`
  before every mutating op, or an `id`-addressed call would have silently degraded to index-only
  addressing. `tsc -p app` unchanged at 64.

- **2026-09-06** — **Motion tab MCP surface, Phase 1: live-verified (D-167).** New
  `packages/motion/src/useMotionControl.ts`, mounted from `MotionTab.tsx`, answers `motion_*` ops
  over the existing D-020 HTTP↔Tauri-event bridge — zero `control.rs`/Rust changes.
  `motion_get_manifest` (read) and `motion_add_layer` (wraps `manifestEdit.addLayer`, committed
  through the real undo-wired `useMotionManifest().commit()`) built and live-verified via `curl`
  against a real running instance: opened a real `.chroma` project over the same bridge
  (`new_project`), confirmed `motion_get_manifest`'s `loadState` going `no-project` → `ready`, then
  a real before/after manifest diff proving `motion_add_layer` actually mutates state (scene
  `hook`'s `layers` array 2 → 3 entries, matching `catalog.ts`'s `defaultLayerFor('text')` shape).
  Also fixed a two-listener race (`useChromaControl` now skips any `motion_*` op so it can't win
  the response slot ahead of Motion's real multi-`await` handler) and found/documented a
  `CHROMA_CONTROL_PORT` gotcha: the control server's port-collision failure is silent, so a second
  Chroma instance for testing needs an explicit distinct `CHROMA_CONTROL_PORT`, verified via
  `lsof`/`ps eww` rather than assumed. `tsc -p app` unchanged at 64, `cargo check --workspace
  --all-targets` clean. Full scoping + tool-list roadmap:
  `docs/notes/motion-mcp-surface-research.md`.

- **2026-09-05** — **Full regression run finds and fixes a real gap (D-166).** `@chroma/editor`'s
  D-142 `jsdom` devDependency was declared in `package.json` but never actually installed on
  `main` — its flagship permanent DOM regression test (`TimelinePane.marquee.dom.test.tsx`) has
  been silently not executing since it merged (`npm test` still exited 0; vitest treats an
  unhandled collection error as a warning, not a failure). Fixed via `npm install` at the repo
  root. `@chroma/editor` now 8/8 files, 294/294 tests, for real. `cargo check --workspace
  --all-targets` clean, `@chroma/motion` 362/362, `@chroma/history` 11/11, `tsc -p app` unchanged
  at 64. No CI exists to catch this class of drift automatically — named as an open gap.

- **2026-09-05** — **A standalone Motion-tab browser harness, and the first live verification of
  the whole D-150–D-164 initiative (D-165).** `app/motion-harness.html` +
  `app/src/motion-harness-main.tsx` — the Motion-tab sibling of D-142's `TimelinePane` harness —
  mounts the real `MotionTab` standalone, seeded with `motion-engine`'s own `sample` manifest
  plus real keyframes/an authored ease. Actually driven live over CDP this session (not just
  built): click-select + canvas drag + undo-commit, the Inspector's separate X/Y/W/H fields, the
  per-row keyframe timeline at the correct positions, drag-a-key retiming, and the bezier curve
  editor rendering a correctly-shaped authored overshoot curve all confirmed working end to end
  in a real browser. Also fixed `packages/motion/src/index.ts`'s stale doc comment (still said
  "no on-canvas manipulation, no timeline UI, no undo/redo" — false since D-155).
- **2026-09-05** — **Motion keyframe timeline, Phase 5b (part 4): a real bezier curve/easing
  editor (D-164) — closes Phase 5b and the whole Motion visual-builder/keyframe-timeline
  initiative (D-150 through D-164).** New `easeCurve.ts` (pure: `curveToPixel`/`pixelToCurve` —
  the real pointer↔value conversion, `x` unconditionally clamped to `[0,1]` since `remotion`'s own
  `Easing.bezier`/`bezier()` THROWS outside that range, confirmed against its real source this
  pass; `curvePath` needs no numerical bezier evaluation at all, an SVG `C` command already draws
  the identical parametric curve; `resolveEaseCurve`/`clampEaseCurve`; `EASE_PRESETS`/
  `DEFAULT_EASE` sourced BY REFERENCE from `design.ease.*`, plus `Linear`/`Ease In` which that
  module doesn't define) and `EaseCurveEditor.tsx` (`EaseFieldControl`: two draggable
  control-point handles with dashed tangent lines, live-commits per pointermove matching
  `color`/`number`'s own established convention, no popover — inline like `color`). New
  `propCatalog.ts` `FieldKind: 'ease'` replaces `kind:'json'` for `CAM2D_KEY_FIELDS`/
  `CAM3D_KEY_FIELDS`/`LAYER_TRANSFORM_KEY_FIELDS`'s own `ease` entries — the only change to those
  three field lists. Unset `ease` shows `design.ease.inOut` muted/dashed with a "Not set — defaults
  to Ease In Out" caption — the literal fallback `interpolateKeys.ts` already renders with, not a
  guess. Found and filed (not fixed, per this pass's own scope) **B-062**: `schema.ts`'s
  `easeCurve` never validated `Easing.bezier`'s own hard `x∈[0,1]` requirement, so a hand-edited
  out-of-range value validates fine and only crashes at render time. No `manifestEdit.ts`/
  `schema.ts` change — `ease` was already fully plumbed, this is a new INPUT WIDGET only. `tsc`
  clean, `app`/`motion-engine` baselines unchanged, `@chroma/motion` 362/362 (was 334, +28, all
  new in `easeCurve.test.ts`).
- **2026-09-05** — **Motion keyframe timeline, Phase 5b (part 3): box-select + nudge multiple keys
  (D-163), on top of Phase 5b part 2 (D-162).** A new `KeySelectionEntry` model
  (`keyframeVisibility.ts` — `{lane, keyIndex}`, local to `KeyframeTimeline.tsx`, no
  same-kind/same-scene restriction, not cleared on every commit) for selecting individual keys,
  distinct from `Selection[]`. A rubber-band drag over empty track space box-selects via
  `keysInMarqueeRect` — pure geometry, no per-marker DOM measurement (only the scrollable content
  div's own rect is read), reusing `canvasGeometry.ts`'s `rectFromPoints`/`rectsIntersect`
  verbatim. Shift-click toggles, mirroring D-158's exact convention. Nudge generalizes D-158's
  `moveLayersByDelta`: `manifestEdit.ts`'s new `moveKeysAt`/`moveKeysByDelta` avoid a real
  correctness trap (N sequential `moveKeyAt` calls on keys sharing one array can retime the wrong
  key once an earlier reorder shifts a later `keyIndex` — fixed by computing every new `at` from
  each key's own remembered base in one pass, then sorting once). Decided: a key-selection may
  span multiple lanes/scenes; each key clamps to its own scene's `[0,dur]` independently (a nudge
  can go non-uniform at a boundary rather than blocking). `tsc` clean, `app`/`motion-engine`
  baselines unchanged, `@chroma/motion` 334/334 (was 292, +42: 15 in `manifestEdit.test.ts`, 21 in
  `keyframeVisibility.test.ts`, 6 `pxDeltaToSeconds` in `timelineZoom.test.ts`).
- **2026-09-05** — **Motion keyframe timeline, Phase 5b (part 2): per-row lanes (D-162), on top
  of Phase 5b part 1 (D-161).** Retires D-160/D-161's flat single-strip `KeyframeStrip.tsx` for a
  real per-row `KeyframeTimeline.tsx`: one row per keyed 2D camera/layer/3D camera
  (`keyframeVisibility.ts`'s new `keyframeLanes`, `LayerList`'s own row order — rows
  appear/disappear as keys are added/removed), `laneKeyMarkers`/`selectionForLane` as the
  per-lane replacements for the old whole-manifest/whole-selection functions, a shared time ruler
  via a REIMPLEMENTED (not imported) copy of `packages/editor/src/ruler.ts`'s tick algorithm
  (`timelineRuler.ts`), a new independent zoom mechanism (`timelineZoom.ts`, bounds chosen fresh
  for this UI, not reused from the Edit tab's D-134 system), a combined vertical+horizontal
  scroll region (sticky row labels + sticky ruler), per-row click-to-select reusing
  `MotionTab.tsx`'s own `onSelect`, and D-161's drag-a-key gesture generalized so any keyed
  layer's keys can be dragged without first selecting that layer. Layout: the timeline moved out
  of `MotionPreview.tsx` into a new full-width sibling panel in `MotionTab.tsx` (nested vertical
  `PanelGroup`), mirroring the Edit tab's own `PreviewPane`/`TimelinePane` stack. `tsc` clean,
  `app`/`motion-engine` baselines unchanged, `@chroma/motion` 292/292 (was 255, +37: 12 in
  `timelineZoom.test.ts`, 15 in `timelineRuler.test.ts`, the rest replacing/extending
  `keyframeVisibility.test.ts`'s old flat-strip coverage).
- **2026-09-05** — **Motion keyframe timeline, Phase 5b (part 1): drag a key along time (D-161),
  on top of Phase 5a (D-160).** New write primitive `manifestEdit.ts`'s `moveKeyAt` (one generic
  core over `layer.transform.keys`/`scene.camera`/`scene.scene3d.camera`) plus three thin
  wrappers. Two edge cases decided + tested: dragging past a neighbor REORDERS the array
  (`interpolateKeys` already re-sorts by `at`, so array position was never meaningful — clamping
  would only be cosmetic); boundary-clamped to `[0, scene.dur]`, the dragged key's own scene.
  `keyframeVisibility.ts` gains `percentToFrame` (the pixel/percent→frame inverse of
  `frameToPercent`) and `KeyMarker.keyIndex`. `KeyframeStrip.tsx` wires the drag through the SAME
  `onTransientChange`/`onCommit` `MotionCanvasOverlay.tsx` already uses; a real problem found and
  solved along the way — re-deriving markers from a live-reordering transient manifest mid-drag
  would silently drop `setPointerCapture` on the dragged button when React remounts it — solved
  with a local `dragPreview` overlay on a STABLE-manifest-derived marker list instead. `tsc`
  clean, `app`/`motion-engine` baselines unchanged, `@chroma/motion` 255/255 (was 224, +31).
- **2026-09-05** — **Motion keyframe timeline, Phase 5a: key visibility (D-160), scoping +
  first slice on top of Phase 0-4 (D-155-159).** New scoping doc,
  `docs/notes/motion-keyframe-timeline-research.md`, re-verifies the visual-builder research
  doc's own Phase 5 ("a real keyframe timeline… a major feature") against the real code: nothing
  in the Edit tab's timeline stack (`@xzdarcy/react-timeline-editor`'s clip-lane model,
  `@dnd-kit/sortable`) transfers as code (spans vs. durationless points); `ruler.ts`'s tick
  algorithm and D-137's gesture-separation discipline transfer as TECHNIQUE only, never an
  import, per the standing `@chroma/motion`/`@chroma/editor` package-boundary rule. Phases the
  rest as 5a (built here) and 5b (drag-a-key, per-row lanes, box-select, a curve editor — still
  a major feature, not attempted). Built this pass: `keyframeVisibility.ts` (pure,
  `layerKeyCount`/`cameraKeyCount`/`scene3dCameraKeyCount`/`cameraKeyMarkers`/
  `selectedLayerKeyMarkers`/`sceneBoundaryFrames`/`frameToPercent`, 25 new tests);
  `LayerList.tsx` per-row key-count badges; a new read-only `KeyframeStrip.tsx` under the
  player (camera + selected-layer key markers across the WHOLE composition, live playhead,
  click/marker-click-to-seek — no manifest mutation, so no undo/commit plumbing needed). One
  real, disclosed deviation: "the player's own scrubber gains markers" isn't buildable as
  literally worded (Remotion's bundled controls have no extension point, checked directly) — a
  separate strip alongside the untouched player gets the same intent instead. `tsc` clean both
  packages (`app`'s 64-error baseline unchanged, `motion-engine` untouched), `@chroma/motion`
  224/224 (was 199).
- **2026-09-05** — **Motion visual builder, Phase 4: per-layer keyframes (D-159), on top of
  Phase 0/1/2/3 (D-155/D-156/D-157/D-158).** `schema.ts`'s `layer.transform` (D-157) gains an
  optional `keys: TransformKey[]` (`{at, x?, y?, scale?, rot?, opacity?, ease?}`, seconds, additive
  DELTA on top of the static field of the same name, uniformly across all five fields) — the
  manifest's second authored spatial animation channel after the camera. `Camera.tsx`'s own inline
  sort/clamp/ease/interpolate logic extracted into one shared `interpolateKeys`
  (`motion-engine/src/lib/`), used by BOTH the camera and the new layer keys (`Video.tsx`'s
  `renderLayers`) — verified byte-for-byte unchanged via `remotion still` before/after the
  extraction. B-059 fixed (`cam2dKey`'s silently-stripped `ease` field, now real and typed) — and a
  SECOND instance of the identical gap found and fixed on `cam3dKey` (that bug's own text guessed
  it was harmless; `Scene3D.tsx`'s `CameraRig` reads `ease` the same way, so it wasn't). Auto-
  keyframe on drag: `MotionCanvasOverlay.tsx`'s move-drag now writes/updates a `transform.keys` row
  at the current playhead frame when a layer's position is already keyed (any key defines `x` or
  `y`), or the native base field exactly as Phase 1 when it isn't — per-PROPERTY (not per-layer:
  keys existing for `opacity` alone doesn't flip position into key mode), scoped to the move gesture
  only (resize is unaffected — `transformKey` has no size field). `InspectorPanel.tsx`'s camera-only
  `CameraKeyList` generalized to `KeyframeList`, now also driving a new per-layer
  `TransformKeysSection` (single-selection only — a documented scope call, keyframe lists don't
  lockstep-edit the way scalar fields do). `tsc` clean both packages (`app`'s 64-error baseline
  unchanged), `@chroma/motion` 199/199 (40 new tests: `interpolateKeys`, B-059 schema retention, the
  new `manifestEdit.ts` functions).
- **2026-09-05** — **Motion visual builder, Phase 3: multiple elements (D-158), on top of
  Phase 0/1/2 (D-155/D-156/D-157).** The owner said "multiple elements" first. `LayerList.tsx`'s
  `Selection` → `Selection[]` (same-kind `layer`, same-scene, or a single entry of any kind —
  enforced by `toggleSelection`). `MotionCanvasOverlay.tsx` gains a FOURTH pointer gesture
  (marquee-select + shift-click-extend, alongside resize/move/click), D-137's "mutually exclusive
  by DOM position" discipline applied explicitly (`[data-motion-resize-handle]` →
  `[data-motion-layer]` → `[data-motion-world]` containment → Remotion's own untouched chrome).
  Drag now moves every selected layer by one shared world delta (`moveLayersByDelta`), one commit
  per gesture. Stable layer identity: an optional, additive `layer.id` (schema.ts) stamped by
  `addLayer`, with `resolveSelection`/`resolveSelections` preferring it over a captured index so a
  live multi-selection survives a reorder/insert/delete — verified inert on render via
  byte-identical `remotion still` output, id present or absent. `InspectorPanel.tsx`'s
  `MultiLayerInspector`: align/distribute (real pure functions,
  `alignSelections`/`distributeSelections`) always shows for 2+ selections; the D-157 Transform
  group always shows in lockstep; the primitive's own fields also show in lockstep when every
  selected layer shares a `use`. Snapping GUIDES explicitly scoped down (open-ended UI work, not
  built — see D-158's own "smallest next step"). A worktree-infra `node_modules` symlink gotcha
  (cross-package types resolving to the MAIN repo's stale copy) found and worked around without
  `npm install` (blocked by this session's permission classifier) — see D-158's own writeup.
  `tsc` clean both packages (`app`'s 64-error baseline unchanged), `@chroma/motion` 159/159
  (37 new tests).
- **2026-09-05** — **Motion visual builder, Phase 2: resize handles, "snap to layer," the layer
  transform wrapper (D-157), on top of Phase 0/1 (D-155/D-156).** Resize: `sizeFields(use)`
  (`propCatalog.ts`) + `layerWorldSize`/`setLayerSize` (`manifestEdit.ts`) for `emphasis.box`,
  `layers.cardW`/`cardH`, `matrix.cell`, `text.maxWidth`, `graph.width`/`height`; 1–3 on-canvas
  handles per primitive, sharing D-156's drag machinery via a discriminated `DragState`. "Snap to
  layer" — the direct fix for the owner's original misplaced-scribble screenshot — an Inspector
  target-picker on an `emphasis` layer that measures the target's real screen rect
  (`MotionPreview.tsx`'s new `measureApiRef`) and writes `box` via a new pure
  `snapEmphasisToRect`. Engine: an optional, additive `layer.transform`
  (`{x,y,scale,rot,opacity,clipWidth,clipHeight}`, absent ⇒ identity — verified byte-identical
  `remotion still` renders at three frames before/after) applied by `Video.tsx`'s `renderLayers`
  on top of a primitive's own positioning — the enabling structural change for Phase 4's
  keyframes. "Crop" implemented honestly as `clipWidth`/`clipHeight` on that same wrapper, NOT
  the Edit tab's four-inset model. `tsc` clean both packages (`app`'s 64-error baseline
  unchanged), `@chroma/motion` 122/122 (30 new tests).
- **2026-09-05** — **Motion visual builder, Phase 1: select + drag a layer on the canvas
  (D-156), on top of four prerequisites (D-155).** The owner's "drag and drop... a visual
  builder for me" ask, first slice. Engine: `data-motion-world`/`data-motion-layer`/
  `data-motion-box` DOM hooks (zero pixel change — verified with byte-identical `remotion still`
  renders before/after, not just reasoning). Tab: a transient-manifest drag preview (no
  JSON round-trip), `@chroma/history` wired in via a new `useMotionManifest.commit` (Inspector
  edits first, drag commits second), and `MotionCanvasOverlay.tsx` — click-to-select via
  `elementsFromPoint`, drag writes world-space `x`/`y` (`text`/`matrix`/`layers`) or
  `box[0]`/`box[1]` (`emphasis`) through a measured screen↔world map (`canvasGeometry.ts`,
  the exact `docs/notes/motion-visual-builder-research.md` §3a technique, 15 new unit tests
  including the doc's own worked camera example), Escape cancels, Shift locks an axis. Out of
  scope, explicitly: resize, rotate, multi-select, keyframes, `scene3d`. `tsc` clean both
  packages, `@chroma/motion` 92/92 (26 new tests).
- **2026-09-05** — **Motion Inspector: position/size tuples get separate X/Y/W/H fields (D-154).**
  Owner: *"we should be able to have all this as x: y: h: w: separate."* `emphasis.box`
  (the exact field behind a misplaced-scribble screenshot), `particleflow.from`/`to`/`center`,
  and `labelbox`/`layerstack`'s `position`/`size` move from one raw-JSON-array field to a new
  `FieldSpec.kind: 'vec'` — separate labeled number inputs per element, sharing one array value.
  Content fields (`Matrix.values`, `Graph.nodes`, …) stay `'json'`, unchanged. On-canvas
  drag/resize sync and the animation timeline are separate, not-yet-built asks (D-152 Phases 0-2
  and 5). `tsc` clean, `@chroma/motion` 66/66 unchanged.
- **2026-09-05** — **The scene manifest collapses behind a `</>` toggle (D-153).**
  Owner: *"as a user i dont need that, you will need only."* Only the raw-JSON
  textarea and its informational status rows (parse OK, render-success line)
  collapse by default; Save/Render and any real save/render error stay visible
  regardless, avoiding the trap D-152's research doc named (those controls live
  in the same panel as the JSON). A live parse error force-expands, since that's
  the one moment hiding the JSON would hide why Save/Render just greyed out.
  `tsc` clean, `@chroma/motion` 66/66 unchanged.
- **2026-09-05** — **The Motion tab's false "No project open" (B-058 / D-150).**
  Owner-reported live; not the D-148 regression the timing suggested —
  `state::set_project` was running fine. The tab mounts at boot like every tab,
  read its manifest right there with no project open, and stored that honest
  backend error as a *fact about the app*; its only escape was a window `focus`
  event, which the in-window launcher never produces. Same structural fault
  B-034/D-112 removed from the Edit tab, and it gets the same fix: a real
  readiness store with one input pushed in from the composition root, no backend
  call at all while the app says no project is open, and a failed read that says
  so instead of lying. 9 new tests (2 confirmed red against the old behaviour);
  `tsc`/`cargo check` state unchanged. Also filed: `closeProject` leaves the Rust
  `ProjectRef` stale — an adjacent hole this pass deliberately did not fix.
- **2026-09-05** — **Motion tab audit + the Catalog (D-151).** Owner: *"map out
  where we lag, have a Catalog Section where all our built catalog is there
  which we can get on our current thing."* The audit
  (`docs/notes/motion-tab-audit.md`, to `timeline-feature-audit.md`'s rigor bar)
  found the tab **could edit everything and create nothing** — `manifestEdit.ts`
  had nine functions, all readers or field-setters, and adding a layer meant
  hand-typing JSON including `use` strings and required props the UI never
  listed. Built the fix: `catalog.ts` (all 8 primitives, exhaustive against the
  engine's own zod enum so a new primitive is a `tsc` error until catalogued,
  plus schema-valid default fragments), `addLayer` in `manifestEdit.ts`
  (immutable, routes 3D primitives into `scene3d.children` and creates that
  container with a valid camera when absent, returns the new `Selection` so the
  Inspector opens on it), and `CatalogPanel.tsx` as a second tab in the sidebar
  pane. Glyphs not live thumbnails, argued in D-151 (three primitives need a
  WebGL context each). 18 → 57 tests, fragments asserted against the real
  `manifestSchema` and mutation-checked; zero new `tsc` errors. Also filed
  **B-059** (camera `ease` is supported by the engine and silently stripped by
  the schema), found by fact-checking a wrong draft claim. Next priority named,
  not built: on-canvas manipulation.
- **2026-09-05** — **Motion visual builder: research pass, no code (D-152).** The owner asked
  for on-canvas drag/size/animate with a human in the loop, pointing at a `scribble` emphasis
  circling the wrong words. Read the engine end to end, and the framing going in turned out to
  be wrong: **this is not D-136 again.** The Motion model is already scene/world space with the
  camera applied at render time, the camera is an invertible 2D similarity, and the reference
  frame is `manifest.width`/`height` declared in the document — so nothing needs migrating. The
  screenshot's real cause is that `emphasis.box` is a hand-authored duplicate of a rectangle
  only the layout engine can know (plus `Emphasis` drawing the ellipse at `w×1.18` / `h×1.5`).
  Recommended technique: **measure the live DOM** (`data-motion-world` +
  `getBoundingClientRect`) instead of reimplementing the camera's math — drift, easing and the
  player's fit-scale all cancel for free. Phased 0–5, with **Phase 5 (a real keyframe timeline)
  named as a major feature**, crop answered "no, and here is why", and 3D excluded. Also filed
  B-060 (drift rate uses the hardcoded `design.fps` token) and B-061 (Inspector labels camera
  `at` in frames; the manifest is seconds), and scoped Part C (collapse the raw JSON behind a
  `</>` chip) for a fast follow-up — the trap being that Save/Render **and the error strip** live
  inside the panel being collapsed. `docs/notes/motion-visual-builder-research.md`.
- **2026-09-05** — **`chroma-project` real extraction (D-148) — Wave 1–3 of the
  crate migration is done.** `chroma/project.rs` L1–1638 (the manifest, every
  schema migration, the media pool + bins, the D-070 unified clip identity and
  grade-file migration) moves verbatim into `crates/chroma-project/`;
  `open_manifest` + the 20 commands stay in `app/src-tauri`, because all 20 take
  `tauri::State<'_, AppState>`. The one piece of real relocation: the timeline
  lifecycle (`ensure_timeline`, `load_and_ensure_timeline`, `resolve_timeline`,
  `resolve_timeline_and_settings`, `build_from_shots`) leaves `chroma/edit.rs`
  for the new crate — project concerns wearing an Edit-tab name — with the
  process global they read (`chroma::state`'s "which project is open") staying
  app-side as a parameter `chroma::edit`'s three-line wrappers supply, so every
  call site is unchanged and the functions are unit-testable for the first time
  (5 new tests). The 59-test suite splits 48 (model → crate) / 11 (command
  surface + process state → stay). `architecture-lock.md`'s dependency table
  corrected twice on contact: **`chroma-project → chroma-media` is real** and was
  missing; the `chroma-grade-model` edge it claimed does not exist.
  `cargo check --workspace --all-targets` clean; `cargo test -p chroma-project`
  52 passed / 1 ignored; `cargo test -p RapidRAW --lib -- chroma::` 126 passed.
  **Next: wave 4** — delete the shims, retarget call sites, fix `03-architecture.md`.
- **2026-09-05** — **Ducking: music under dialogue (D-149)** — the plan doc's §4,
  built on exactly the seam D-147 left it. `Track` gains `duck_from`/`duck_db`/
  `duck_attack_ms`/`duck_release_ms`; the trigger is a pure timeline query (does
  the nominated track have a clip here — `Track::clip_spans_from`, which
  **merges abutting clips** so the duck holds across a cut instead of pumping at
  every one), smoothed by a real one-pole with separate attack/release time
  constants. The smoother is evaluated in **closed form** rather than as a
  per-sample recursion, which makes the envelope identical at 44.1 and 48 kHz
  and `gain_at` a pure function — a unit test runs the discrete recursion
  against it to pin that they are the same filter. It composes with D-147's fade
  by multiplication in one per-sample-frame pass, so `mix_sources` is still
  untouched. Track-header popover (audio tracks only) + `set_track_duck`, the
  third Edit-tab MCP tool, with the real DSP numbers rather than a "strength"
  dial. A track with no `duck_from` gets no envelope at all, so every existing
  project mixes byte-identically. `cargo check --workspace --all-targets` clean;
  chroma-timeline 128, chroma-media 98, `RapidRAW --lib chroma::` 178/178,
  `@chroma/editor` 294; `tsc -p packages/editor` clean, zero new `tsc -p app`
  errors. Not heard in the real app (no Tauri window in this sandbox), and the
  trigger is still the clip layout rather than the signal — RMS sidechain is
  Phase 2, said out loud in the tool text and the UI.

- **2026-09-05** — **`chroma-media` real extraction (D-146)** — the widest slice
  of D-141's plan (§2.2), in its three required ordered commits. (1) `video.rs`
  + `decode_pipe.rs` + `media_cache.rs` move verbatim; two `#[cfg(test)]` hooks
  become a `test-support` feature enabled only from `[dev-dependencies]`, so a
  release build links none of them. (2) `probe_cached` leaves `edit.rs` — it had
  to, or `chroma-media` would depend on the app — and **B-056 is fixed on the
  way**: the in-memory probe cache now revalidates the source file's
  `blake3(path ‖ mtime ‖ len)` identity on every hit instead of being
  insert-only and path-keyed, so a file replaced in place is re-probed rather
  than serving stale facts for the rest of the session. (3) `filmstrip.rs`
  moves whole and `audio.rs` **splits**: the symphonia→rubato→cpal engine, the
  D-130 session protocol and the waveform path are media and moved; the
  timeline resolution inside `chroma_audio_play` is not, and stayed app-side —
  `begin_play` → *(app resolves)* → `start`, preserving the exact ordering the
  D-125 skew compensation depends on. **B-057 fixed** in the same commit: a
  `ChunkLockGuard` whose `Drop` releases the `CHUNK_LOCKS` entry on every path
  out of `load_chunk`, not only the successful one. Both bug fixes carry
  regression tests confirmed to fail against the pre-fix code.
  `cargo check --workspace --all-targets` clean; `cargo test -p chroma-media`
  83 passed; `cargo test -p RapidRAW --lib -- chroma::` 164 passed.
- **2026-09-05** — **Per-clip fades with real cubic-bezier curves (D-147),** plus the
  scoping doc for the whole "practical sound control" ask
  (`docs/notes/audio-fade-duck-crossfade-plan.md`). `Clip` gains
  `fade_in_frames`/`fade_out_frames` + a `FadeCurve` each; a new
  `chroma-types::fade` evaluates them (Newton–Raphson + bisection over the CSS
  `cubic-bezier` model — there was no easing math anywhere in this repo before this).
  One fade drives picture and sound together: the compositor multiplies it into
  `opacity`, the mixer applies it per **sample-frame** before summing sources.
  Landed just after D-146 moved the mixer into `crates/chroma-media` — `FadeEnvelope`
  moved with it (beside `AudioSourceSpec`, the boundary type it extends), the curve
  math moved *down* to L0 `chroma-types` so the L1 mixer and the L2 timeline model can
  share one implementation without an upward dependency (re-exported from
  `chroma-timeline`, so `chroma_timeline::FadeCurve` still resolves), and
  `chroma_audio_play`'s timeline-resolution half stayed app-side per D-146 — it is
  what converts a clip's fade frames to the envelope's seconds. Inspector section + presets, and the first two Edit-tab MCP
  tools (`get_timeline`, `set_clip_fade`) — which also exercise D-140 §6c's "agent
  edits go through `applyOp` so they stay undoable" for the first time rather than
  only stating it. **Crossfade found blocked** on D-104's no-overlap invariant: the
  no-overlap version is a dip-to-silence, not a crossfade, and no curve fixes that —
  the renderer and mixer are already N-source ready, only the model isn't. **Ducking
  scoped, not built** — it reuses the same time-varying-gain primitive, which is why
  the envelope was shaped as one.
- **2026-09-05** — **`chroma-grade-model` real extraction landed (D-143),** per
  D-141's plan §2.4. `save_grade`/`load_grade`/`migrate_v1`/`relativize`/
  `resolve`/`grade_name` + `SCHEMA`/`MATTE_KEYS`/`SaveResult` moved verbatim
  out of `chroma/grade.rs` into the crate — the zero-dependency-edge claim
  held (only `std::path`/`base64`/`serde_json`). The 2 `#[tauri::command]`
  wrappers stay in `app/src-tauri` per D-141's "commands do not move" rule,
  now thin calls into the crate. Corrected a stale `chroma-types` dependency
  edge in `architecture-lock.md`/`crates/README.md` that the real code never
  had.
- **2026-09-05** — **`chroma-gpu` real extraction (D-144).** `render_core::init_gpu_context()`'s
  real body moved verbatim into the new crate; `render_core`'s own version is now a thin
  wrapper. Resolved the one open question D-141's scoping left: `GpuContext` really does
  split into two structs — a headless `chroma-gpu::GpuContext` (device/queue/limits) and
  the unchanged app-side `image_processing::GpuContext` (same three fields plus the
  `display` surface wrapper). `render()` and the grade path stay app-side, gated on the
  later `chroma-grade` effort. `cargo check --workspace` clean; the 6 known call sites
  (`export.rs`/`playback.rs`/`relight.rs`/`gpu_processing.rs`) are unchanged.
- **2026-09-05** — **`chroma-ai` real extraction (D-145).** `sidecar.rs` moves almost
  whole (704 lines — lifecycle supervision, health checks, content hashing, sidecar
  I/O), dropping `spawn_and_supervise`'s confirmed-unused `AppHandle` param on the way.
  `depth.rs`/`mask.rs` split cleanly at the crate boundary: `tracked_depth_map`/
  `tracked_full_mask` stay app-side (they read `chroma::state::current_video()`) but
  as thin wrappers over new crate functions that take the frame as a plain argument —
  `mask_generation.rs`'s call sites need zero changes. `chroma_subject_mask`'s real
  fork-type dependencies stay put, exactly as scoped. `cargo check --workspace` clean.
- **2026-09-05** — **Pacing & audio assistance scoped (D-140), no feature code.**
  Turned D-139's research into a buildable plan:
  `docs/notes/pacing-audio-assistance-plan.md`. Beat detection runs in the `ai/`
  sidecar on librosa (BSD-3, no weights — essentia/madmom excluded on their
  models' non-commercial licences), decoded via ffmpeg, **without** the `_GPU`
  lock and with no `_MODEL_REGISTRY` entry; results cache in a new `media_cache`
  `"beats"` namespace keyed exactly like the waveform peaks, so Phase 1 adds
  **no** field to `Clip`/`Track`/`Timeline` (a `Timeline::markers` model was
  considered and rejected for v1, with reasons). Beat positions become timeline
  guides + snap targets inside the two functions Chroma already owns
  (`computeInsertion`/`resolveClipLanding`); edge-trim snapping is genuinely
  blocked by the timeline library's `dragLine?: boolean` (verified in its
  bundled types) and is named as a gap rather than promised. MCP is designed in,
  not appended: `get_timeline` + `detect_beats` in Phase 1, `inspect_pacing` +
  `snap_clip_to_beat` in Phase 2, `pulse_steadiness` instead of an invented
  `confidence`, and a real answer to the question `mcp-tool-coverage.md` left
  open (a mutating Edit-tab tool goes through `timelineStore.applyOp` so agent
  edits land on the shared undo stack). Phase 0 first: benchmark librosa on the
  owner's own CassetteAI tension beds, which are the worst case for this class
  of tracker — it can invalidate the premise before anything is built.
- **2026-09-05** — **Audio/rhythm/pacing-assistance research pass (D-139), no
  feature built.** Owner asked about beat/emotion/pacing understanding —
  "the things sound engineers do." Researched beat/onset detection
  (librosa/essentia/madmom/aubio + newer transformer trackers — real, mature,
  offline, license gates found on aubio/essentia/madmom), what Premiere/
  CapCut/Descript's beat features actually do (mark or auto-trim, no
  structural understanding), and how real footage-pacing/"emotion" analysis
  is today (shot-length, loudness, motion-intensity are real; "emotional arc"
  understanding is not, and a marketing-blog citation was checked and
  rejected as non-credible). Write-up:
  `docs/notes/pacing-audio-assistance-research.md`. A separate pass scopes
  the actual feature from these findings.
- **2026-09-05** — **The rest of the D-039 crate extraction is scoped from the
  real code (D-141)** — `docs/notes/crate-extraction-plan.md`, the execution map
  a later wave of parallel agents works from. Three findings changed the plan
  rather than filling it in: `#[tauri::command]` functions must stay in
  `app/src-tauri` (read out of `tauri-macros-2.6.3` — the attribute's two
  `#[macro_export]`ed macros land at the *crate root*, the wrapper body needs a
  real `tauri` dep, and any `State<AppState>` command in a crate is a dependency
  cycle); every extraction leaves a `pub use` shim in the same commit, which is
  what keeps `lib.rs`'s handler list off every slice's diff and makes the wave
  genuinely parallel; and `chroma-agent` is rescoped *out* of the wave, because
  `control.rs` has no Tauri-free core and its own doc says the op registry lives
  in the frontend. Order: `chroma-grade-model`/`chroma-ai`/`chroma-gpu` in
  parallel → `chroma-media` (three ordered commits) → `chroma-project` → shim
  sweep. Two real defects found while reading and filed: **B-056**
  (`edit::PROBE_CACHE` never invalidates, shadowing the mtime+size staleness
  contract of the disk cache beneath it) and **B-057** (`filmstrip::CHUNK_LOCKS`
  leaks on the extraction error path). No code changed.
- **2026-09-05** — **A reusable pointer-gesture test harness + a permanent
  real-DOM regression test for marquee-select (D-142).** This repo had built
  the same real-`PointerEvent`-against-a-real-component browser harness from
  scratch five times (D-095/096/098/100/137), always deleted after use, never
  committed. `packages/editor/src/testUtils/pointerHarness.ts` extracts the
  real common pattern (real `PointerEvent` dispatch with rAF waits, real
  `<StrictMode>` mounting, jsdom's missing layout/pointer-capture APIs
  stubbed, a Tauri `invoke` stand-in, an enforced zero-console-errors check)
  as an importable module; `TimelinePane.marquee.dom.test.tsx` uses it to
  mount the REAL `TimelinePane` and re-verify 9 of D-137's own scenarios
  permanently — runs on every `npm test --workspace @chroma/editor` (277
  passing, 9 new). `app/harness.html` + `harness-main.tsx` (the real-Chromium
  tier for what jsdom's fake layout can't check — dnd-kit's own drop-target
  resolution) are promoted from scratch-and-delete to permanent and checked
  in, cross-validated live via `chrome-devtools` MCP tonight.
- **2026-09-05** — **Marquee-select on the Edit timeline (D-137, roadmap item
  12 Phase 2).** Click-drag on empty timeline canvas rubber-bands a selection;
  every clip the rect intersects is selected, shift/cmd/ctrl unions onto the
  existing selection. The deferral's stated reason was dnd-kit coexistence, and
  it is resolved structurally rather than by precedence: `ClipBody` carries
  `data-chroma-clip-drag` and the gesture refuses any `pointerdown` with that
  on its path — the same condition dnd-kit's own `PointerSensor` uses — reusing
  that sensor's `distance: 4` threshold rather than inventing a second one. All
  decision logic is pure and unit-tested (`marquee.ts`, 36 new tests, 258
  total); the gesture was driven with real `PointerEvent`s at the real
  component under `<StrictMode>` in a browser, confirming same-track and
  cross-track clip drag and track reorder all still work and never raise a
  band. That run caught a real bug before it shipped: Escape cancelled the band
  but its terminating click still wiped the pre-existing selection.
- **2026-09-05** — **A manual A/V link/unlink toggle (D-138).** Closes the two
  things D-129 named and deferred: `Timeline::link` (new — links two
  already-independent clips, one video-track/one audio-track, into a group
  indistinguishable from a drop-created one; deliberately narrower than
  Palmier's own group-merging `link`) and `Timeline::unlink` finally exposed
  as real Tauri commands (`chroma_timeline_link_clips`/`_unlink_clip`). Real
  toolbar UI in `TimelinePane.tsx`: a `Link` button next to the existing
  `Unlink`, shown for a two-clip selection and disabled with a reason
  tooltip (`checkLink`, the one precondition check both the button and
  `applyOp` use) when the pair isn't linkable — wrong track kind, already
  linked, a locked track. The existing `avLinkedIds` link highlight needed
  no changes, it already re-derives live from `link_group`. Interaction
  model re-confirmed as `av-linking.md`'s option (b) — permanent link +
  explicit unlink, no Premiere-style toggle — not reopened without cause.
- **2026-09-04** — **`position_x`/`position_y` become normalised composition
  fractions, with a real migration, and the Edit tab gets real on-canvas
  drag/scale handles (D-136, B-043 closed).** Phase 0a's code, left undone by
  D-132: the compositor's canvas is now the project's own composition
  (`ProjectSettings.width`/`height`, or the first clip's probed resolution),
  not the top layer's decoded size, so a PIP overlay no longer moves or
  resizes when you press Play. Existing pixel-valued positions are migrated,
  not silently reinterpreted — `chroma.project`'s schema gained a minor
  (`1.1`), gating a one-time, non-idempotent reinterpretation of old values as
  composition pixels (every clip nobody ever offset migrates to bit-identical
  zeros). A new `chroma_timeline_clip_geometry` command reports a clip's
  source footprint in composition space. Landed alongside it: `TransformOverlay.tsx`,
  Phase 1's real select/drag/corner-scale handles over the Edit-tab preview —
  a DOM overlay (`@chroma/player`'s new `useContentBox`) with live
  overlay-only feedback while dragging and one `set_clip_transform` op on
  release, the same pattern `RelightPuckLayer.tsx`/D-046 already used.
- **2026-09-04** — **"Play and pause restart the audio, just audio": every
  session was starting at 0:00 (D-133, B-052).** Not a D-130 regression, and not
  D-050's by-design fresh-session-per-Play being misread — audio was literally
  decoding from the head of the file on *every* Play, at any playhead, while the
  picture (which seeks through `ffmpeg`) carried on correctly. `open_source` and
  `decode_mono_range` threw away `symphonia`'s seek result, and on the owner's
  own camera original that seek fails every time: `symphonia-format-isomp4`
  seeks every *other* track first with `?`, and that MOV carries an ordinary
  metadata track exactly one 24 fps frame long, so anything past 0.042 s is
  out-of-range for it. Measured, not inferred — `decode_mono_range` at 0 s, 60 s
  and 120 s returned byte-identical samples. Sources now reach their start time
  by trimming on the packets' own timestamps (correct whether the seek succeeds,
  fails, or lands early); the seek is kept only as the fast path and its failure
  is logged instead of swallowed. Catch-up measured at 56 ms to 60 s / 249 ms to
  300 s on that 2.3 GB file. Still not verified by clicking Play in the
  assembled app — the same honest gap D-125/D-130 disclosed.
- **2026-09-04** — **Video export really applies the Colorist's geometry
  (D-135, B-042 closed).** D-127 made a cropped export refuse; this makes it
  work. `grade_frame` now runs `apply_all_transformations` — the same CPU
  pre-pass the live preview and the still export run — and builds its mask
  bitmaps at the transformed size with the real crop offset instead of a
  hardcoded `(0.0, 0.0)`, so export and preview finally agree about where a
  mask sits. The encoder is spawned **lazily, from the first graded frame's
  measured dimensions**, so a crop or a 90° step really changes the encoded
  size and that number can't drift from the pass that produced it. D-019's
  tracked mattes needed no change (their alignment code already un-does
  crop/rotation/flip; its parenthetical is corrected in place). `yuv420p`'s
  even-dimension requirement is now a written rule — round **down** to a
  multiple of 2 for every codec, trimming ≤1 row/column rather than padding
  or resampling — which also closes an odd custom export resolution reaching
  libx264 (D-049). The lens blur and parametric `color`/`luminance` masks,
  dropped by the same omission, work on video export too.
  `unsupported_geometry` is deleted; the only remaining refusal is a crop
  that rounds to zero. Verified with real ffmpeg encodes probed back (a
  100×60 crop lands at 100×60 and matches the source's own cropped frame 0
  pixel-for-pixel, byte-identical across two runs) plus 13 GPU-free pixel
  tests; `chroma::` 231/231, `chroma-timeline` 111/111. No live-window
  verification possible in this sandbox (disclosed in D-135).
- **2026-09-04** — **Player seek/volume sliders were invisible from a
  Tailwind `data-*` variant typo, not a missing token; Sources toggle still
  overlapped "Timeline" because D-126 only fixed legibility (D-131, B-050,
  B-051).** `slider.tsx`'s Track/Indicator used `data-horizontal:`/
  `data-vertical:`, which compiles to a check for a literal `[data-horizontal]`
  attribute Base UI never sets (it stamps `data-orientation="horizontal"`) —
  confirmed by compiling this app's real `styles.css` through
  `@tailwindcss/node`, not guessed. Fixed to `data-[orientation=horizontal]:`/
  `data-[orientation=vertical]:`; also fixed `Player.tsx` passing both sliders
  a bare number instead of a single-element array (was silently rendering 2
  stacked `Thumb`s instead of 1). Separately, `Player.tsx`'s title strip now
  reserves `pl-10` to clear the Sources toggle's real 32px footprint, instead
  of D-126's untouched uniform `px-3`. `packages/editor`/`packages/player`
  `tsc` clean, `packages/editor` vitest 201/201; no live-window verification
  possible in this sandbox (disclosed in D-131).
- **2026-09-04** — **The Edit tab has a real crop, and Phase 0a's unit
  question is answered (D-132, B-053, B-054).** Owner, live: "no UI for
  crop", "no canvas on player to do it". The crop half is built:
  `Clip.crop_left`/`crop_top`/`crop_right`/`crop_bottom` — four normalised
  0–1 insets into the clip's **own source**, so they are correct at every
  preview decode scale by construction rather than needing the
  composition-space fix first — really applied by `composite_layer_onto`
  (crop first, and **in place**: alpha cleared, footprint kept, so the
  picture doesn't re-centre and rotation keeps its pivot), with a real Crop
  section in the Inspector and keyframes for free through the existing D-034
  engine (flat scalars rather than a nested rect precisely so that
  interpolator can reach them). The **on-canvas half is not built** — no
  drag handles, no Resolve-style mode toggle; that is Phase 1 of
  `docs/notes/on-canvas-transform.md` and it needs an overlay substrate that
  doesn't exist yet. Phase 0a's open unit question is now closed
  (**normalised, against `ProjectSettings.width`/`height`**, adopting the
  scoping doc's own recommendation), but its `position_*` migration is
  unwritten and **B-043 stays open**. Found and fixed on the way: **B-053**
  — the preview's single-layer fast path skipped compositing
  unconditionally, so a lone clip's opacity/position/scale/rotation were
  written to disk, read back into the Inspector, and never applied to a
  pixel. Also **B-054**, a test pinned to the owner's live `project.json`
  that had been failing on `main` since they first used A/V linking. Not
  verified in the assembled window — same environment constraint
  D-125/D-127/D-130 each disclosed.
- **2026-09-04** — **The zoom step itself: one storage level for the whole
  fine band, so a level change is a decimation and not a decode (D-134,
  B-049, B-055).** Owner, after D-124/D-128: everything fast now *except*
  clicking zoom. Measured, not assumed — a fine filmstrip chunk costs the
  same to decode at 0.0625s spacing as at 0.5s (8s of the owner's 4K HEVC is
  ~2.15s either way; the real shape is ~0.8s of ffmpeg spawn plus ~0.24s per
  second of source), so D-128's four fine LOD levels were paying full price
  four times for the same seconds — and awaiting a viewport's five chunks
  one at a time while two of three semaphore permits sat idle. Every fine
  level is now decoded once at the finest rung and the rest decimated from
  it (exact, because the ladder is powers of two), a request's chunks load
  concurrently, and a coarse chunk is derived free from cached finer ones.
  **A fine-band zoom sweep over an already-decoded range: 31.3s → 0.001s**;
  the cold first window 9.45s → 7.15s. B-055 found and fixed alongside: a
  window overrunning the source used to lose its whole filmstrip, not just
  the out-of-range tail. Not confirmed in the assembled Tauri window — same
  honest gap as D-124/D-128.
- **2026-09-04** — **Timeline-header overlap fixed, real master mute/volume
  added, real fullscreen wired (D-126).** The Sources/Inspector floating
  toggles (D-118/D-120) now render as elevated chips
  (background+border+shadow) instead of transparent `ghost` buttons, so
  they no longer visually crowd Player's own title strip. `Player.tsx`
  gains a real `muted`/`onMuteToggle`/`volume`/`onVolumeChange` control
  backed by a new lock-free backend primitive, `chroma_audio_set_volume`
  (separate from D-057's persisted per-track `gain` — this is unpersisted
  monitoring volume only). The fullscreen button, previously unwired by any
  caller, now uses the real browser Fullscreen API with `fullscreenchange`
  sync so Esc-driven exits stay in sync. `packages/player` `tsc` confirmed
  clean; `packages/editor`/`packages/shell` `tsc` and interactive
  verification were blocked by genuine concurrent sibling-worktree build
  load and are disclosed as an honest gap in D-126.
- **2026-09-04** — **"The voice loops / overlaps a couple of seconds": the
  audio session was being restarted mid-playback, and D-125 took away the
  ordering that made restarts safe (D-130, B-047, B-048).** Direct follow-up to
  D-125, against a binary rebuilt after it. The repeat is not one session
  playing twice — the prefill and the ring FIFO were read and cleared of that —
  it is **two sessions starting a moment apart from two different playheads**:
  `PreviewPane`'s audio effect was keyed on the `timeline` *object*, which
  `load()` replaces on every window `focus` (i.e. on the click that starts
  playback) and every edit. D-125 then made both audio commands `(async)`,
  which — traced through `tauri-macros` into `tokio::spawn` — removed the
  main-thread FIFO ordering the play/stop protocol depends on, so those
  restarts could land in any order; a stale play winning means audio starts from
  a playhead the picture has already passed. Fixed by keying the effect on
  whether a timeline exists, and by stamping every transport command with a
  monotonic `seq` that Rust uses to drop overtaken requests. Also fixed (B-048,
  pre-existing): a source streamed to the end of its **file** rather than its
  clip's out-point, so a short clip's audio played on underneath the picture
  that had cut away from it. 8 new tests, each confirmed to fail against the
  pre-fix behaviour. Not verified in the assembled window — same gap D-125
  disclosed.

- **2026-09-04** — **Play took 2-3 s and the audio lagged: one decode pipe
  serving N compositor layers, and an audio clock that started late
  (D-125, B-040).** The suspected cause — contention with the filmstrip
  thumbnails — was measured and disproved: with no thumbnail work running
  at all, a single composited preview frame still cost **618-660 ms**, because
  `decode_pipe` kept one global `ffmpeg` process while D-088's compositor
  decodes every visible layer through it, respawning per layer per frame.
  A `PipeSlot`-keyed pool (one per video track, released when a layer goes
  away) takes that to **23-31 ms/frame**, measured back-to-back under
  identical load. Separately, `run_session` started
  the `cpal` stream before opening its sources, so the ring's untimestamped
  head silence left audio permanently **157-635 ms** behind the picture —
  now measured and compensated before the device starts. Also: the heavy
  preview/audio commands moved off Tauri's main thread, `-hwaccel` in the
  decode pipe, and one preview resolution for scrub and play (the split was
  respawning every pipe on each Play toggle). B-041 logged, not fixed: an
  audio-only clip on a real `Audio` track still fails `chroma_audio_play`.

- **2026-09-04** — **"Do we support crop?" answered end to end, and
  on-canvas PIP handles scoped (D-127, B-042, B-043,
  `docs/notes/on-canvas-transform.md`).** Crop is **real in Colorist**
  (routed panel, applied in the preview — including on a video frame — and
  on a still export), **absent in the Edit tab** (no field on `Clip`,
  nothing in the compositor), and was **silently discarded on a video
  export** along with straighten, flips, 90° steps and the lens warp:
  `grade_frame` never ran the CPU geometry pre-pass, and the guard meant
  to catch that was unreachable by construction. Video export now refuses
  up front and names the offending controls (6 unit tests); actually
  honouring the geometry is queued work, not a tweak. Scoping the drag
  handles also turned up **B-043** — the Edit-tab composite's coordinate
  space is preview-resolution-dependent, so a PIP overlay moves *and*
  resizes when you press Play, a hard prerequisite before any handles get
  built. Handles are planned, not built: the preview is a plain `<img>`,
  not a canvas, so they're a DOM overlay writing the same
  `set_clip_transform` op the numeric Inspector already writes.
- **2026-09-04** — **Persistent, disk-backed media caching + windowed LOD
  filmstrips + the full-resolution decode nobody ever saw (D-128,
  B-044/B-045/B-046).** Owner, live: "we are doing actions which can be cached
  again and again... most editors do it already" and "if you are loading 4k
  that might be wrong." Both right, and two different defects. **(1)** Every
  cache in the codebase was a process-local static, so every relaunch re-ran
  every `ffprobe`, re-decoded every filmstrip and re-decoded every waveform —
  now `chroma::media_cache`, a source-keyed (`blake3(path‖mtime‖size)`) disk
  cache under `app_cache_dir()/chroma`, following RapidRAW's own thumbnail
  cache and real NLE precedent (Premiere's `.cfa`/`.pek`, Resolve's
  `CacheClip`). **(2)** Project-open decoded a full 3840×2160 frame per clip,
  ~1.9s each, and discarded every one unseen. **(3)** The filmstrip is now
  windowed level-of-detail extraction over the visible scroll range — the gap
  D-124 named and deferred, and the shape persistence wanted anyway:
  **727px/tile → ≤50px** at default zoom on the owner's 517s 4K clip, and a
  16s window goes **5.41s cold → 0.007s warm-from-disk**, against 9.5s every
  time for the old whole-clip strip. **(4)** The waveform had no cache at all and re-decoded a
  clip's whole audio on every zoom step, on the main thread. Critical-path
  catalogue: `docs/notes/media-cache.md`.
- **2026-09-04** — **Dropping a clip now creates a real, linked audio clip on
  its own track (D-129).** The owner's ask ("in palmier and other anytime i
  drop a clip it… created a linked track in audio"), which needed the exact
  model change `docs/notes/av-linking.md` had flagged as a prerequisite and
  deferred: a video clip's embedded audio is a separate `Clip` now, not just a
  stream D-050 decoded off the video source. `Clip.link_group` (group-based —
  and on a video clip it also means "don't play the embedded stream", which is
  what stops the same audio summing with itself); one atomic `add_clip` places
  both halves, with the audio track found-or-created through the existing
  `add_track` mechanism; `MediaVideoInfo::has_audio` fills the signal gap
  D-097 flagged, backfilled once for existing pool items. Move, trim, split
  and delete propagate across a link group or reject whole (B-033's own
  discipline); `unlink` dissolves the complete group. Reference-checked
  against Premiere, Resolve and Palmier's `manage_clip_links` — including one
  place the references overruled the scoping doc's own recommendation (trims
  propagate). Pre-D-129 clips are unlinked and behave exactly as before, with
  no retroactive migration, deliberately.
- **2026-09-04** — **The filmstrip's real cost: one 105-second decode per
  clip, re-triggered on every zoom step (D-124, B-039).** Round 3 on
  D-119's filmstrip, run empirically after two rounds of reading missed
  it. `extract_thumb_strip_range` decoded every frame of a clip's range
  and threw ~99.5% away — measured 105.5s for the owner's 517s 4K clip —
  while `count` was derived from on-screen width, so a zoom sweep fired
  four more of them and blanked the strip each time. Anything queued
  behind them (a short clip's one-second strip) waited minutes with no
  error and no log line, because nothing logged a *slow* decode. Now
  keyframe-only decode above a measured threshold, `fps=` time-based
  sampling (also fixes VFR sources), thumbnails at 2x the row height
  instead of 150px, and a fetch keyed on clip duration rather than pixel
  width — **105.5s → 9.27s**, and a 59-step zoom sweep went from one
  backend call per bucket to 2 total. Real decodes now log, too.
- **2026-09-04** — **Fixed two `chroma::project` tests red on `main` since
  D-123 (B-038).** Both still asserted the pre-D-123 "empty tracks
  persist" contract; one panicked outright. Found by re-running the clean
  tree to check whether D-124's own failures were pre-existing.
- **2026-09-04** — **Sources panel's opener moved to the corner it actually
  opens into (D-120).** D-116 moved the panel to the left but left its
  toggle stranded in the chrome bar's top-right — now a `top-2 left-2`
  button over the tab content, mirroring the Inspector's own `top-2
  right-2` toggle (D-118) instead of crowding the same corner as it.
- **2026-09-04** — **Capped concurrent filmstrip `ffmpeg` decodes + hardware
  decode (D-121, B-037).** A real live incident: opening a multi-clip
  project spawned 11 simultaneous `ffmpeg` processes, system load past
  200. A `Semaphore(3)` caps concurrency; `-hwaccel videotoolbox` (with a
  real software fallback) cut a single 4K HEVC decode from 393% CPU/~5s to
  38% CPU/~3.3s, measured directly. Also fixed the paired silent-failure
  bug: a missing thumbnail now logs a real error instead of swallowing it.
- **2026-09-04** — **Removed the redundant dashed drag-landing box
  (D-122).** Now that the drag ghost shows real filmstrip content, the
  separate `border-dashed` landing-position box was drawing the same
  information twice — owner: "we have 3 things... let's remove the dot."
- **2026-09-04** — **Auto-decommission an empty track (D-123).** A track
  emptied by `remove` or a cross-track `move` is now pruned automatically
  and the rest renumber — narrowly scoped to only the directly-edited
  track (checked live: neither Premiere nor Resolve auto-removes by
  default, both need an explicit action), with real index-remap coverage
  for `Selection`/`SelectedGap` so nothing points at a stale track index.

- **2026-09-04** — **Real filmstrip thumbnails on Edit-tab timeline clips,
  in the drag preview too (D-119).** Video clips now show their actual
  source content tiled across the clip (`Filmstrip.tsx` +
  `chroma_clip_thumbnails` → `video::extract_thumb_strip_range`, one
  `ffmpeg` decode pass scoped to the clip's real trimmed range, not the
  whole source file), layered under a translucent waveform strip. The
  `DragOverlay` ghost for a clip drag shows the same real content now
  instead of a generic text pill.
- **2026-09-04** — **Auto-create-a-track-on-drop, restored for dnd-kit clip
  moves (D-117, B-036).** D-100's rewrite moved clip repositioning onto
  `@dnd-kit/core` but never carried over "drop past the last track (or
  above the first, or between two) auto-creates one" — `TrackDropZone`
  only ever registered a droppable per existing track, so the drag
  silently cancelled. Now computes the same insertion boundary the
  legacy Sources-panel path already uses, from the dragged clip's own
  live rect instead of a droppable — one shared boundary concept, not
  two to keep in sync.
- **2026-09-04** — **Edit tab's Inspector is now a real full-height panel (D-118).** Extracted `ClipInspectorPanel` out of `TimelinePane.tsx`'s own internal split (where its height was capped at the timeline's 46%-tall row) into a new sibling, `EditorInspectorPanel.tsx`, rendered by `EditorTab.tsx` as a `ResizablePanel` spanning the tab's full height — the same treatment D-116 gave Sources, on the other side. `selection`/`selectedGap` moved from `TimelinePane`'s local state into `useEditorTimelineStore` so both components read one shared selection. Stayed tab-local (a button in the Edit tab's own corner), not a `Shell.tsx` chrome-bar addition — Colorist and Motion each already have their own always-visible right panel, and Sources' shell-level slot is specifically because it's one real shared resource across all three tabs, which the Inspector isn't.
- **2026-09-04** — **Manifest read caching + a drop-target fix (D-114/D-115,
  B-035).** `chroma::edit::resolve_timeline` (the per-preview-frame hot path)
  no longer re-reads and re-parses `project.json` from disk when nothing has
  changed since the last frame — an mtime-validated in-memory cache, measured
  **18.4x faster in the steady state** (682µs/call → 37µs/call, real test,
  not a claim). Separately: fixed a real `dropTargetTrack`/preview
  inconsistency that could let a Sources-panel drop land on a track never
  shown in the preview, and widened the insert-snap radius (16→28px) for a
  more forgiving drop target.
- **2026-09-04** — **Sources panel moved to the left, made a real resizable panel (D-116).** Matches the media-bin-on-left convention every professional NLE reference (including Palmier Pro) uses. Was a fixed 288px `div` on the right — a real, previously-unnoticed violation of the "everything resizable-by-nature must actually be resizable" rule; now a `ResizablePanel` (default 288, min 220, max 480). No tab package needed a change — each one's own properties panel already anchors independently to its own right edge.
- **2026-09-04** — **Cross-track drag preview is now honest (D-113).** Two
  related follow-ups to D-111 on the same live-testing session: the
  full-row drag-over wash is gone, replaced by a precisely-sized/
  positioned placeholder matching the clip's real duration and real
  resolved landing frame (reusing the same `resolveClipLanding` math the
  actual drop applies); sync-linked clips on other tracks now render a
  live shifted ghost during the drag itself, not just a static highlight
  at selection time. Real horizontal row separator lines added too (the
  library draws none itself).
- **2026-09-04** — **"No project open" (5th occurrence): fixed the screen that
  was misreporting all five, not just the fifth cause (B-034/D-112).** The
  common factor across B-004/B-025/B-031/B-032 was never any one of them — it
  was `EditorTab` reporting *any* failed `chroma_timeline_get` as "no project
  is open", while the shell above it showed the tab bar precisely because one
  was. `projectOpen` is now pushed down from the app's own source of truth and
  is the only thing that can produce that message; `load()` gained a monotonic
  token (a stale failure can no longer clobber a fresh success), a timeout for
  lost IPC responses, and a bounded retry ladder replacing D-085's 500ms
  one-shot. Two real faults found underneath: `save_manifest` was a non-atomic
  `fs::write` torn by the app's own per-frame `load_manifest` reader (**25%
  torn reads measured**; now temp-file + rename, 0/2000 against the owner's
  real project), and **D-108's `safeUnlisten` fix never worked** — it caught a
  sync throw where Tauri actually rejects a promise. Occurrence #5's own
  trigger was a concurrent agent HMR-reloading the owner's live app 3s after a
  successful open: a process problem, not a code one.
- **2026-09-04** — Restored the Rust test build on `main`: D-107/D-109's
  `Track::sync_locked` and D-104's `move_clip(…, ripple)` never updated the
  test initializers in `chroma/project.rs` / `chroma/audio.rs` (10 compile
  errors — `cargo test` couldn't run at all).
- **2026-09-04** — **"Hangs so much" audit (D-111): one redundant IPC round-trip
  cut, sync-lock gets real visual language.** Measured, not assumed —
  `applyOp` was already optimistic; the real hang was mostly this session's
  own 4x-oversubscribed system load (a real 87ms write for an 8KB file
  proves it), plus one genuine fix: `_flushSave` no longer refetches after
  every save (`chroma_timeline_set` stores verbatim, so the refetch was
  pure redundant latency). Sync-lock's silent B-033 rejection ("gap select
  does not work") first got a toast, then the owner redirected to real
  visual language instead — reverted the toast cleanly, shipped
  muted-clip-on-locked-track + a secondary "sync-linked to this selection"
  ring (`syncLinkedClipIds`) instead.
- **2026-09-04** — **Cross-track sync-lock reverted from auto-split to
  reject-on-straddle after confirmed real data corruption (B-033/D-109).**
  D-106/D-107's auto-split let repeated real ripple operations keep
  re-splitting an already-split fragment — confirmed on the owner's actual
  `New.chroma` project (a clip id duplicated 3x on one track, another split
  into 4 slivers, total duration growing after closing a gap). Reverted to
  D-104's own proven-safe reject-on-straddle contract, generalized
  cross-track, checked upfront at all three ripple call sites before any
  mutation. New regression tests apply the rejected op 5x in a row and
  prove zero fragmentation. Real feature loss, deliberate: sync-lock now
  blocks a ripple when a straddling clip sits on a synced track — auto-split
  may return as its own separately-scoped, separately-verified follow-up.
  The owner's real project file is confirmed corrupted on disk with no
  clean automated recovery; manual rebuild through the UI is the
  recommended path — underlying media is untouched, only clip-position
  bookkeeping was corrupted.
- **2026-09-04** — **A third, distinct root cause behind "No project open"
  found and fixed (B-032/D-108).** Tauri listener cleanup (`unlisten.then((f)
  => f())`) could throw when Vite's dev-mode HMR reloaded mid-flight,
  corrupting the IPC bridge — Tauri's own console warning names the exact
  scenario. Dev-mode-only (no HMR in production), but frequent enough this
  session (many concurrent forks editing files against one shared dev
  instance) to repeatedly masquerade as the project-open bug already fixed
  twice under different real causes (B-004, B-031). Fixed with a shared
  `safeUnlisten()` helper across all 6 real call sites. Idle-window
  verified (150s+, zero recurrence); honestly flagged as not
  force-reproduced on demand.
- **2026-09-04** — **Multi-select Phase 1 + cross-track ripple/sync-lock,
  built (D-107).** `Selection` is a real array now (shift/cmd-click,
  generalized Remove/Split); `Track.sync_locked` (default on) makes a
  ripple on one track shift every other synced track too, auto-splitting a
  straddling clip rather than blocking the ripple (the owner's call,
  reversing D-106's own first-pass "reject" recommendation) with a real
  ripple-flash so it's never silent. 73/73 Rust + 115/115 TS tests;
  real-window interactive verification not achieved this pass, disclosed
  honestly. Roadmap items 11/12 marked done.

- **2026-09-04** — **Real scoping docs for the audit's top 3 gaps (D-106):
  multi-select, cross-track ripple/sync-lock, A/V linking.** No code —
  three real design docs (`docs/notes/multi-select.md`,
  `cross-track-ripple-sync-lock.md`, `av-linking.md`), each grounded in
  live-checked references (Resolve's Sync Lock, Premiere's Linked
  Selection, Palmier's own `manage_clip_links`/`manage_tracks` tools).
  Multi-select's "just extend the click handler" first read didn't survive
  tracing every real consumer — scoped with a phased plan instead of built
  blind, matching the judgment applied to the other two. Roadmap items
  11-13 updated to point at the docs.

- **2026-09-04** — **Gap select + delete (ripple close), and a real
  timeline-feature research audit (D-105).** Empty track space is now a
  real, selectable thing — click a gap to select it (a dashed overlay
  tracks the exact bounds), Delete/Backspace or a new "Close Gap" toolbar
  button closes it, rippling every later clip on that track earlier by the
  gap's width. The deliberate mirror image of `remove`'s existing Lift
  behavior. `Track::gap_at`/`Timeline::remove_gap` (Rust) mirror
  `gapAt`/`remove_gap` (TS) field-for-field. Verified against the real
  rendered component via a scratch Chrome-driven harness, not just unit
  tests (67/67 Rust, 108/108 TS). Also: `docs/notes/timeline-feature-
  audit.md` — the actual timeline code audited feature-by-feature against
  Premiere Pro's and DaVinci Resolve's own docs plus Palmier Pro's real MCP
  tool surface, with a prioritized recommendation (multi-select, then
  cross-track ripple/sync-lock, then real A/V linking).
- **2026-09-04** — **Unified clip-move placement, reversing D-096: overlap
  is never a reachable outcome of a plain drag (D-104, B-030).** Cross-track
  move used to reuse a clip's own `start_frame` verbatim (ignoring where it
  was actually dropped) and D-096 had made cross-track overlap an explicit
  allowance — together, dragging a clip onto another track could land it
  stacked directly on top of whatever was already there. New
  `resolveClipLanding` wraps `computeInsertion` (the same "where does this
  fit" algorithm a new clip from Sources already gets) for an EXISTING clip
  being moved, used by both the drag path and the "Move to ▾" dropdown.
  `move`/`move_clip` gain `ripple`, mirrored TS/Rust: overlap is now
  rejected for every move, same-track or cross-track, unless `ripple`
  shifts the way clear (same contract `add_clip` already has). A real edge
  case (a clip straddling the landing point) is explicitly rejected rather
  than left silently still-overlapping. `packages/editor` 91→100 tests,
  `chroma-timeline` 60→61, `cargo clippy -p chroma-timeline` clean. The
  `chroma_timeline_move_clip` Tauri command's signature update (a
  zero-caller command) could not be `cargo check`-verified — blocked by an
  unrelated, concurrent-session in-progress `tauri-plugin-wdio` permission
  mismatch, not anything touched here.
- **2026-09-04** — **Real sidecar ownership: content-hash staleness
  detection (D-101, roadmap item 9).** `ai/server.py` now reports a
  `content_sha256` of its own bytes in `/health`; `chroma::sidecar` computes
  the same hash and flags a mismatch (`SidecarStatus.stale`) instead of
  trusting any 200 forever — the actual D-069 gap. Policy: refuse-and-warn
  only, never auto-kill an external process. Re-checked live on the
  existing 10s poll, not just at boot. New "AI Sidecar" status card in
  Settings — `chroma_ai_status`'s first real consumer. Live-verified
  against the session's own genuinely ~6hr-stale sidecar (killed, restarted
  with the new code, watched the supervisor correctly report "no longer
  stale" with no false positive). One incident: a manual `cargo clippy` run
  collided with the dev server's own auto-rebuild watcher and corrupted
  `target/debug` — recovered via the documented `rm -rf target/debug` +
  rebuild.
- **2026-09-04** — **Global Inspector Phase 3: NLE clip properties
  (D-102).** `ClipInspectorPanel.tsx` — a persistent transform + keyframes
  panel for the selected Edit-tab clip, replacing D-090's popover outright
  (removed, not kept alongside — same fields/ops, no benefit to two
  controls). Added to `TimelinePane.tsx` only after the concurrent
  drag-and-drop work (D-100) finished. Backward-compat verified against a
  scratch harness and the owner's own real project file. Drafted as
  D-101, renumbered after the sidecar-ownership pass above claimed it
  first.
- **2026-09-04** — **Global Inspector Phase 4: the shared shell, closing out
  the whole effort (D-103).** New tiny package `@chroma/inspector` — just
  `InspectorEmptyState`/`InspectorSection`, the two pieces Motion's and the
  NLE's Inspector panels had genuinely converged on identically. Not a full
  merge: the two panels' selections/fields/ops stayed different enough that
  forcing one component would mean rewriting working code for no benefit;
  resizable-panel wrapping and `Selection` both stayed package-local for the
  same reason (`Shell.tsx` already keeps every tab mounted, so there was no
  real cross-tab gap to close). Verified live, both panels side by side,
  post-refactor — no regression in either. All 4 phases of the Global
  Inspector now done.
- **2026-09-04** — **Unified clip move onto ONE mechanism; fixed the real
  root cause of D-098's stuck-ghost/blocked-drag cluster (D-100, B-029).**
  A stuck `activeDrag` after an interrupted drag left `TrackDropZone`'s
  `pointer-events-auto` on forever, silently blocking every click/drag on
  that whole track row — that's what "can't drag in the same track"
  actually was, not same-track drag itself breaking. Fixed by making that
  overlay `pointer-events-none` unconditionally (never needed for dnd-kit's
  own rect-based collision detection) and unifying same-track + cross-track
  clip move onto ONE `useDraggable` covering the whole clip (`ClipBody`),
  with the library's native move-drag disabled (`movable: false`, edge-trim
  untouched) — no more two systems racing for one gesture. Also: a real
  dnd-kit-internal-state bug (an interrupted drag left the NEXT real drag
  on the same pointer silently inert; fixed with a genuine synthetic
  `pointercancel` dispatch on window blur, not just local state reset);
  `computeInsertion`/`nearestEdge` now resolve a drop anywhere on an
  existing clip's body (not just a pixel-precise seam), fixing
  ripple-insert between already-touching clips; click-outside-to-deselect;
  selected-clip contrast (a ring, not a background/text-colour swap that
  was using the wrong token). 91/91 tests, `tsc`/`vite build` clean.
- **2026-09-04** — **Track reorder + cross-track clip move moved onto
  `@dnd-kit/core`/`@dnd-kit/sortable` (D-098, B-028).** Native HTML5 drag
  failed live a second time (cross-track clip move, after track reorder)
  despite passing this session's Chromium-only checks — owner greenlit
  implementing the dnd-kit scoping doc's phase 1 plan for real. Same-track
  drag/trim/resize untouched (the timeline library's own native
  mechanism, never what was broken). Two real bugs found and fixed during
  implementation (a React-synthetic-event same-element-handler ordering
  issue; a droppable-registration timing issue); re-checked D-064's
  `dragDropEnabled` fix first and ruled it out. Verified against the real
  component under real `<StrictMode>` with real `PointerEvent` sequences
  (not just the Chromium harness alone this time) — dnd-kit issue #2116's
  StrictMode bug does not reproduce on the installed version. Still not a
  real Tauri/WKWebView window — flagged explicitly, not claimed closed.
  `tsc`/vitest/vite build clean (88/88 tests, 64-error app baseline
  unchanged, one new safe React-Compiler bailout accounted for).
- **2026-09-04** — **Global Inspector Phase 2: a real Motion property panel
  (D-099).** Typed form bound to the layer-list selection across all 8
  primitives, JSON fallback for content-shaped props, a real camera
  keyframe-list editor, a resizable right-hand panel cluster. Reads/writes
  the manifest immutably and degrades gracefully on a stale/unrecognized
  selection — verified against real, already-existing manifests (the
  owner's explicit backward-compat requirement) via a scratch Chrome-driven
  harness, not just unit tests. `packages/motion`'s first test harness
  (18/18). Phase 3 (NLE half) found to be newly unblocked (B3 shipped as
  D-088) but deliberately not started — would need `TimelinePane.tsx`,
  in active use by concurrent dnd-kit work all session.
- **2026-09-04** — **Mid-stack track insert, kind inference, a real
  cross-track clip-move handle, cross-track overlap allowed (D-096,
  B-027).** Continuing D-095's own live-testing session: a track can now
  be inserted at ANY boundary (above the first, between two, or past the
  last), not just past-the-last; an auto-created track infers its kind
  from the adjacent track instead of a hardcoded `'video'` literal
  (verified `DraggedMedia` carries no real audio/video signal to derive
  from directly); the cross-track clip-move handle is now a full-width
  top strip instead of a small corner icon; `move`/`move_clip` now allow
  cross-track overlap (a real composited layer since D-088), same-track
  overlap still rejected. **Caught and fixed a live regression in the same
  pass**: the wider handle made an ordinary same-track drag an easy
  accidental grab of the cross-track mechanism, which used to silently
  no-op on a same-track drop — now handles it as a real reposition
  instead. Also: `docs/notes/dnd-kit-migration.md`, a real scoping doc
  (not implemented) for the owner's `@dnd-kit` steer — MIT, active repo,
  but no npm release since 2024-12 and an open React-19-StrictMode issue
  against the in-progress rewrite, which this app's `<StrictMode>` root is
  actually exposed to. Rust `chroma-timeline` 59/59, `packages/editor`
  88/88, `tsc` + `vite build` clean.
- **2026-09-03** — **Four real gaps in D-094's drag-and-drop, found live
  (D-095, B-026).** Sources-panel drops now snap/ripple-insert between
  existing clips (`computeInsertion`, `timeline.ts` — the one place this
  model intentionally gains ripple behavior) with a live insertion-line/
  new-track-ghost preview; dropping a clip past the last track row auto-
  creates one (the manual "+ 🎞"/"+ 🎵" toolbar buttons are gone); both
  drag handles' hit targets grew + got an explicit `-webkit-user-drag`
  hint for Tauri's WKWebView (D-094's track-reorder logic was verified
  correct via a real Chromium drag against a new isolated-component
  harness, but couldn't be closed-loop-verified on WKWebView itself); the
  Sources-panel drag ghost is now a small name pill instead of the full
  media card. 88/88 tests (+9), `tsc` + `vite build` clean.
- **2026-09-03** — **Real drag-and-drop for the NLE timeline + resizable
  header sidebar (D-094).** `TimelinePane.tsx`: track reorder is now a
  `GripVertical` drag handle per header row (replacing D-090's up/down
  buttons; generalized `move_track` selection-follow math, not just
  adjacent swap); cross-track clip move is a real drag handle on each clip
  (`CHROMA_CLIP_MOVE_MIME`, same drop mechanism as the existing
  Sources-panel drop) — the old "Move to ▾" dropdown stays as a fallback
  since the live drag gesture couldn't be exercised against the native
  window this session. The track-header sidebar is now a real
  `@chroma/ui` `ResizablePanel` (was a fixed `width: 156px`) — the first
  live use of that component, applying the owner's new standing
  "resizable-by-nature panels" `CLAUDE.md` rule. 79/79 tests, `tsc` +
  `vite build` clean.

- **2026-09-03** — **Local-only user-action telemetry infrastructure
  (D-093).** New `trackEvent(event, props?)` in `@chroma/bridge`, reusing
  the existing `frontend_log` Tauri command (`[telemetry]` prefix, JSON
  payload, lands in `app.log` — no network call, no new storage). Wired
  into tab switches, project open/new/close, and relight actions (add/
  delete light, apply preset, bake depth/normals, track depth). NLE track/
  clip actions deliberately deferred — a concurrent fork is reworking
  `TimelinePane.tsx`'s drag-and-drop — tracked as a follow-up in
  `docs/notes/telemetry.md`, which also has the adoption checklist for
  wiring up a new surface.

- **2026-09-03** — **Sidecar memory: real observability + TTL auto-unload
  (D-087).** Diagnosed a reported 5.78 GB sidecar process — not a leak (the
  process itself was already gone; `_free_gpu()`, B-002, is correctly
  called everywhere), but a real gap: loaded models (SAM2/YOLO/ViTMatte/
  Video-Depth-Anything/MoGe-2) were never released. New `GET /memory`
  (RSS + per-model loaded/idle status) and a background TTL sweep that
  auto-unloads anything idle past 5 minutes, safe against the existing
  `_GPU` lock; `POST /unload` for a manual reclaim. Verified live end to
  end (load → idle → auto-unload, watched `/memory` and RSS the whole way).

- **2026-09-03** — **Fixed: Edit tab stuck on "No project open" after a
  real, successful open; opening a project had no loading feedback (D-085,
  B-025).** Project cards now show a real spinner while opening and disable
  during it (closes a confusing "session busy" double-click race); the Edit
  tab's own load now retries once if it lands on a stale error state.
- **2026-09-03** — **Fixed: dragging a clip in the Edit-tab timeline froze
  the UI (D-083, B-024).** Five callback props to the timeline library were
  inline arrow functions (new identity every render); a native drag fires
  `dragover` continuously, so every tick forced a full re-render of every
  clip across every track. `useCallback`-wrapped with real dependency
  arrays; a pre-existing pattern that only became a felt freeze once
  multi-track (D-080) made the cost scale with track count.
- **2026-09-03** — **Global Inspector, Phase 1: Motion tab gets a real
  scene/layer sidebar (D-081).** Wrote a real scoping doc first
  (`docs/notes/global-inspector.md` — a 4-phase build + the complete
  verified prop catalog for all 8 primitives), since unlike the multi-track
  UI this had none. Built the genuinely unblocked prerequisite: a
  `LayerList` sidebar + selection model, wired to seek the preview player to
  whatever scene/layer is selected — real navigation on its own, ahead of
  the actual property panel (Phase 2, next).

- **2026-09-03** — **Multi-track timeline UI (D-080, Phase D of the
  multi-track NLE effort).** The Edit tab now shows a real lane per track —
  custom header sidebar (kind icon, per-kind label, mute toggle, remove),
  add-video/add-audio-track buttons, and a "Move to ▾" dropdown to move a
  clip between tracks (the timeline library has no native drag-between-rows,
  confirmed before assuming otherwise). Confirmed N-track compositing
  actually works past 2 tracks first (was claimed, never tested) before
  building UI on top of it. Opaque compositing only for now — real blend
  modes/opacity (Phase B3) is still unbuilt, a separate later step.

- **2026-09-03** — **Relight shading overhaul (D-078/D-079): real light, not
  a coloured gel.** Falloff was 2D-screen-only and colour was flat additive
  — read as a translucent wash, live-confirmed fixed by switching to a
  screen blend (respects existing highlights/shadows) plus real 3D falloff.
  Then found `distance` was sweeping the lit side of the face instead of
  moving the light nearer/farther (a real face's own depth variation was
  feeding the light's *direction*, not just its brightness) — direction now
  uses a heavily damped copy of the depth delta. That same investigation
  caught a second real bug: a `distance` far from a surface's depth could
  silently zero the light out completely (folded into the same radius-gated
  falloff) — depth-based dimming is now a separate, non-zeroing multiplier.
- **2026-09-03** — **Relight uses one coherent AI geometry pass now, not
  two mismatched ones (D-077 addendum).** "Bake Normals" now also writes
  MoGe-2's own real depth (computed in the same inference call as the
  normal), instead of pairing the normal against a separate
  Depth-Anything-V2 bake — the two are guaranteed geometrically consistent.

- **2026-09-03** — **Relight: real AI surface normals instead of a depth
  finite-difference (D-077).** "Feels like a light blob, that's not light
  that's just color" was accurate — the old normal was a crude heightfield
  trick on the depth map, not real geometry. New "Bake Normals" action runs
  MoGe-2 (MIT-licensed, vendored, verified on MPS) for a real per-pixel
  surface normal; DSINE was evaluated first and rejected (academic-only
  licence). Depth-derived fallback unchanged when no bake exists.
- **2026-09-03** — **Relight `distance` correction (D-076 follow-up):** the
  first fix still failed live because a light's z was partly anchored to
  whatever the depth map showed *behind the puck's own position* — broken
  the moment the puck sat over open background instead of on the subject.
  `distance` is now a true absolute z-coordinate, independent of puck
  placement; default bumped 40 → 85.
- **2026-09-03** — **Relight positional lights actually shade footage now
  (D-076, B-022).** Root cause of "nothing is getting applied at all": there
  was no real z/depth control for a light, only screen-space x/y/radius — a
  light always sat flush on whatever surface it was dropped on, which
  collapses the shading math to ~zero on real (relatively flat) footage.
  Added a real `distance` field end-to-end (UI slider → Rust → GPU uniform →
  shader), defaulting nonzero so a fresh light is lit immediately. New
  GPU-render regression test proves it (renders through the real shader
  against a flat depth map, asserts distance=0 is byte-identical to no
  light at all).
- **2026-09-03** — **Relight panel: Bake Depth fires itself, Track Depth
  moved to a compact bottom "finalize" action (D-073).** No more picking
  between two equal-weight depth buttons — the cheap single-frame bake now
  fires automatically the moment a positional light needs it; the heavy
  whole-clip track (confirmed capable of crashing the AI sidecar) is a
  deliberate, tooltip-explained action at the bottom of the panel.
- **2026-09-03** — **Fixed: dragging a relight light puck also scrubbed the
  video frame (D-074, B-021).** A capture-phase pan handler on an ancestor
  fired before the puck's own drag handler could stop it; the puck now
  marks itself so the ancestor skips it entirely.
- **2026-09-03** — **Edit-tab timeline: plain trackpad scroll now pans,
  only a real pinch/Ctrl+scroll zooms (D-072).** D-051's scroll-wheel zoom
  treated every wheel tick as zoom, so a plain two-finger scroll (a
  different physical gesture from a pinch) couldn't scroll the timeline at
  all. Now gated on `ctrlKey` — the standard convention browsers already
  use to mark a real pinch gesture — everything else falls through to the
  library's own native scrollable container untouched.

- **2026-09-03** — **Colorist wasn't actually live-synced to the Edit tab —
  a real gap D-070 left behind (D-071, B-020).** Owner's immediate retest:
  a clip dragged onto the Edit tab's timeline never showed up in Colorist,
  and a deleted clip lingered there forever as a ghost shot.
  `chroma_timeline_set` never called `open_manifest`, and `syncFromRust`
  (dead code, never called) was the only thing that looked like it should
  have handled this. New `chroma_project_resync_clips`, triggered on
  Colorist tab focus: diffs the active timeline against the decode session,
  decodes new clips, prunes stale ones, but deliberately only re-picks the
  active clip if it was one of the pruned ones — a manual selection in the
  shot strip survives a resync that doesn't affect it, unlike just calling
  `chroma_project_open` again. `cargo test chroma::` 138/138 (+3), `tsc -p
  app` 64/64 unchanged.

- **2026-09-03** — **The real Track Depth root cause: a 2-day-stale AI
  sidecar (D-069, B-018).** D-067's new logging paid off immediately —
  `app.log` showed every click hitting a 404 (`{"detail":"Not Found"}`)
  from the process on `:8765`, which turned out to have been running
  since **Sept 1, 21:19** (`ps -p $(lsof -ti:8765)`), well before
  `/depth_track` existed in `ai/server.py`. `spawn_and_supervise` (D-028)
  only checks for something-already-answering once, at boot, and defers
  forever once found — so every restart tonight deferred to the same
  stale process, invisible to every actual app rebuild. Killed + restarted
  it (`ai/run.sh`), confirmed live via `curl`. Also hardened
  `chroma_depth_track`/`_status` to check HTTP status before parsing a
  response as success (they didn't — this is *why* the 404 silently
  looked like "nothing happened" instead of a real error).

- **2026-09-03** — **Relight diagnosability + visual consistency (D-067/
  D-068).** `chroma_depth_track`/`_status` had zero logging — "clicked
  Track Depth multiple times, nothing happened" couldn't be told apart
  from four very different real causes purely from `app.log`; every real
  exit path now logs. Separately, `RelightPanel.tsx` — flagged by the
  owner as visibly inconsistent with the rest of the app — is rebuilt on
  `@chroma/ui`'s real `Button`/`Slider` instead of the RapidRAW-era plain
  elements its own module doc had admitted using since D-048. Presentation
  only, no interaction-logic changes.

- **2026-09-03** — **Relight keyframe "Clear"/"X" never actually removed
  keyframes (D-066, B-017).** `writeLightParams` spread-merged its result
  onto the stale light (`{ ...l, ...next }`) — a spread can overwrite a
  key, never un-set one, and `clearKeyframes`/`removeKeyframe` signal
  "done" by deleting `chromaKeyframes` from their return value, which the
  merge silently discarded. Now replaces the light outright. Cross-checked
  the shared mechanism (`maskKeyframes.ts`, D-034) against its other real
  caller (`MaskKeyframeBar.tsx`) — not buggy there, this was specific to
  how `RelightPanel.tsx` composed it. Also confirmed a separate same-
  session report ("no light shows when I change color") is by design, not
  a bug — a positional light genuinely no-ops until Track/Bake Depth runs.

- **2026-09-03** — **Colorist fullscreen had no way back out (D-065,
  B-016).** The only exit button lived inside the toolbar, which itself
  hides (`max-h-0 opacity-0`) exactly when fullscreen turns on — the
  control that exits fullscreen was hidden by fullscreen. Added a
  dedicated close button, always rendered, independent of the toolbar and
  of two undeduplicated `handleToggleFullScreen` closures (`App.tsx`/
  `Editor.tsx`, real duplication flagged but not fully consolidated this
  pass — see D-065).

- **2026-09-03** — **Unified clip identity, Edit ↔ Colorist: `ProjectShot`
  retired, `chroma_timeline::Clip` is the single source of truth (D-070).**
  Colorist's shot strip now reads the active Edit-tab timeline's clips
  directly (`Clip.media_id`, new) instead of a separate persisted
  `ProjectShot` list, so a clip dragged onto the Edit tab shows up in
  Colorist immediately — no more "add to grading" as a second step.
  One-time grade-file migration renames `<gradeDir>/<shotId>.grade.json` →
  `<gradeDir>/<clipId>.grade.json`, warning (never dropping) any grade that
  can't be matched to exactly one clip. Colorist's active-clip resolution
  now shares D-056's `resolve_video_clip_at`, not a second copy. Verified
  against a scratch copy of the owner's real project: 3 shots, 0 renamed
  (already-migrated no-op), 2 warned (never dragged onto the Edit tab),
  nothing lost. `cargo test -p chroma-timeline` 37/37, `chroma::` 135/135
  (+10, 1 ignored real-project harness by design). `tsc -p app` 64 errors,
  unchanged baseline.

- **2026-09-03** — **Sources panel delete (single + batch), edge-trim
  cursor, timeline-switcher width fix (D-060/D-061).** New
  `chroma_media_remove(ids: Vec<String>)` — right-click "Remove from
  pool," a hover trash icon per card, and a header "Select" → "Select
  all" / "Delete (N)" bulk path, all wired to the same batch command
  (removes the pool ref + cached thumbnail, never the source file). The
  timeline's resize handles get a real `ew-resize` cursor + hover
  highlight (the library never styled this at all — `timeline-
  overrides.css`, new); the D-058 tab strip stops stretching to fill the
  row (`grow-0`, the shadcn base `flex-1` was never actually cancelled)
  and is capped to half-width. `cargo test chroma::` 126/126 (+1).
- **2026-09-03** — **The real B-012/B-013 fix: Tauri's own
  `dragDropEnabled` was eating drag-and-drop in the actual app (D-064).**
  D-058 fixed the frontend model and verified strongly — in a plain
  Chrome tab, since that's this sandbox's only way to drive real DOM
  events. The owner's live retest in the real Tauri window showed drag
  still completely dead: Tauri v2's window-level native drag capture
  (on by default, never set in `tauri.conf.json`) intercepts HTML5 drag
  events before the page ever sees them — a class of bug no proxy method
  could catch. `dragDropEnabled: false`. Confirmed by the owner dragging
  a real clip in the real window.
- **2026-09-03** — **Motion render now lands in Sources; Edit-tab preview
  gets a real loading state (D-062).** Rendering used to just write a
  file and print its path as plain text — nothing put it anywhere
  usable. `onRendered` (app-composition-root-owned, since `@chroma/
  motion` can't reach `@chroma/bridge`) now imports the result into the
  Sources pool. `PreviewPane`'s "no frame" placeholder — shown
  identically whether a frame was loading or genuinely absent — is now a
  real spinner during a first-load, and the plain text only for a
  genuinely empty timeline.
- **2026-09-03** — **Colorist shot-switch preview had a fully-built
  loading spinner wired to a dead flag (D-063, B-015).** `showSpinner`
  existed, styled and correct, keyed to `useLibraryStore.isViewLoading`
  — a RapidRAW still-image-library flag with exactly one call site,
  unreachable since the D-043 video pivot. The real switch paths
  (`switchToShot`, `_hydrateOpenDto`) never touched it, and
  `_hydrateOpenDto` itself never toggled `busy` either (4 callers each
  separately remembered to wrap it; Sources' "add to grading" didn't).
  `isLoading` now also reads `useSessionStore.busy`; the toggle moved
  inside `_hydrateOpenDto` so every caller gets it for free.

- **2026-09-03** — **Multi-track NLE Phase B1: opaque top-wins video-track
  resolution (D-056).** Real finding: opaque "top wins" compositing needed
  **no new rendering/GPU code** — with no alpha in play, the top-priority
  track's clip fully obscures whatever's below, so this was a track-
  **selection** problem, not a pixel-compositing one (confirms the phase
  brief's hypothesis rather than assuming it). Landed as
  `chroma_timeline::Timeline::resolve_video_clip_at` — pure model logic,
  video tracks walked in `Vec` index order (lower index = higher priority,
  "on top" — matches Palmier Pro's own track convention and every existing
  project's single-track behavior), first track with a clip (not a gap) at
  the position wins, falls through to the next only on a gap. `edit.rs`'s
  `resolve_video_position` (shared by `chroma_timeline_frame` and the audio
  path) is now a thin wrapper around it that probes the winning clip.
  `cargo test -p chroma-timeline` 30/30 (+7 new tests: both-tracks-have-
  content, only-top, only-bottom, neither, top-gap-falls-through, no-video-
  tracks, single-track-behavior-unchanged-regression); `cargo test
  --manifest-path app/src-tauri/Cargo.toml chroma::` 113/113 (+1 real-clip
  integration test exercising the Tauri command path end to end); `tsc
  --noEmit` 64/64, unaffected (no frontend file touched). GUI boot not
  performed this session — port 1420 was already held by the main
  checkout's own dev server — so the regression proof instead rests on the
  real-media integration test hitting the exact `chroma_timeline_frame`
  command plus a test proving the new resolution path is identical to the
  old one for every single-track position (see D-056). Phase B2 (N tracks)
  is now mostly "confirm it generalizes," since the same walk already has no
  hardcoded track count. Phase B3 (real blend modes/opacity, the genuinely
  new GPU work) is next for the compositor. See D-056,
  `docs/notes/multi-track-nle.md`.

- **2026-09-03** — **Multi-track NLE Phase C: real audio mixing (D-057).**
  `chroma::audio`'s `cpal` pipeline now sums N sources instead of playing
  exactly one — the baseline video-embedded audio (unchanged, unity gain)
  plus every genuine `TrackKind::Audio` clip overlapping the play position.
  New `chroma_timeline::Track::gain: f32` (default `1.0`) is per-track
  volume; a new `mix_sources`/`soft_limit` mixer sums active (nonzero-gain)
  sources through a `tanh` soft limiter (chosen over a hard clamp's real
  clipping or a `1/N` pre-scale's needless quietening), bypassing
  summation/limiting entirely with ≤1 active source — which keeps the
  pre-existing single-track case byte-identical and makes "mute via
  `gain: 0.0`" an exact property. Pan scoped out. `chroma-timeline` 25/25,
  `chroma::audio` 29/29 (new deterministic + live-`cpal` 2-track tests),
  `chroma:: ` wide 122/122, `tsc` 64/64 unchanged, real `cargo build`
  boot confirmed (live Tauri UI boot blocked by an unrelated port-1420
  process already running from the main checkout, not this task's to
  kill — see D-057).

- **2026-09-03** — **Timeline UI fixes from real hands-on testing (D-058,
  B-012/B-013).** Drag-from-Sources and edge-trim were both silently broken:
  `packages/editor/src/timeline.ts`'s frontend edit-op mirror (authoritative
  for real saves, since `chroma_timeline_set` stores verbatim) never picked
  up D-054's `Clip.start_frame` — a dropped clip had no real position, and a
  left-edge trim visibly moved the wrong edge. Ported D-054's model into
  `timeline.ts` field-for-field against the Rust ops (`trim_start`/
  `trim_end`'s neighbor clamps, `split`'s right-half position, `add_clip`'s
  append position, a new overlap-rejected `move` op replacing the now-inert
  `reorder`-as-position-change); `TimelinePane.tsx` renders from each clip's
  real `start_frame` instead of re-deriving it from summed durations. **A
  second, independent trim bug found via real live pointer testing** (not
  code reading): the clip-name label's `z-10` had no isolating stacking
  context, so it silently covered the resize handles' hitboxes across the
  library's own DOM, swallowing every edge-trim `pointerdown` before
  `interact.js` ever saw it — `pointer-events-none` on the label, one line,
  fixes it. `TimelineSwitcher` rebuilt as a `@chroma/ui` `Tabs` strip (tabs +
  a `+` tab) replacing the dropdown-plus-button. Timeline ruler: real
  `HH:MM:SS`/`HH:MM:SS:FF` timecode + an adaptive "nice numbers" tick
  interval (`ruler.ts`, new) instead of a hardcoded 1-tick-per-second scale.
  Real op + formatting unit tests (33, `timeline.test.ts`/`ruler.test.ts`);
  drag-and-drop and trim both additionally confirmed against the real
  running app — a real Chrome tab on the plain Vite dev server (Tauri
  mocked), real native drag events and real synthetic pointer events at the
  actual DOM coordinates, real resulting store/JSON state checked — see
  D-058 for the full method and honest caveats.

- **2026-09-03** — **Sources panel fixes: async media commands, real
  thumbnails, real "New Folder" (D-059, B-014).** Owner-reported, hands-on
  bugs D-046's own accessibility-driven verification missed.
  `chroma_media_list`/`_import`/`_move` converted to `async fn` — they were
  plain `fn`, which Tauri runs inline on the main UI thread, stalling the
  native Import file-picker behind them (`chroma_media_import` also moves
  its `ffprobe`/`ffmpeg` work into `spawn_blocking`). Every imported item now
  gets a real cached poster-frame thumbnail (`video::extract_thumb`, reused
  — not a new decode path — to `<video_dir>/.chroma/thumbs/<id>.jpg`).
  `ProjectManifest.folders: Vec<String>` + `chroma_media_create_folder` let a
  new, empty bin persist and list before anything is filed into it, via a
  "New Folder" button + right-click context menus (`@chroma/ui`'s shadcn
  `ContextMenu`, its first real consumer). `cargo test chroma::` 114/114
  (was 112 in this fresh worktree; +2 new tests), `tsc --noEmit` unchanged
  (app 64, bridge 0, editor 1 pre-existing/unrelated, ui 0). See D-059 for
  full verification detail, including an honest note on what the live
  click-to-dialog timing test could and couldn't show.

- **2026-09-03** — **Multi-track NLE Phase A: `Clip.start_frame` + gap-aware
  edit ops + track management (D-054).** `chroma-timeline::Clip` gained an
  explicit, timeline-absolute `start_frame: i64` (not a `Gap` item — see
  D-054's rationale) so clips stop being forced back-to-back.
  `reorder`/`trim_start`/`trim_end`/`split`/`remove` reworked for gaps + a
  no-overlap invariant (`remove`/`reorder`'s behavior changed — flagged in
  D-054). New `Timeline::add_track`/`remove_track`/`move_clip` ops +
  matching `chroma_timeline_add_track`/`_remove_track`/`_move_clip` Tauri
  commands in `edit.rs`. Legacy `project.json` migration
  (`backfill_legacy_positions`) verified against the real
  `~/Movies/Chroma/New.chroma/project.json`. `chroma-timeline` 23/23,
  `cargo test chroma::` 110/110 (was 107; caught and fixed one real
  compile-time bug along the way — a `chroma::audio` test helper built a
  `Clip` literal directly and needed the new field), `tsc --noEmit` 64/64
  unchanged, real boot confirmed the existing single-track Edit tab is
  unaffected. No frontend touched, no compositor/audio work (Phases B/C/D,
  still to come — see `docs/notes/multi-track-nle.md`).

- **2026-09-03** — **Interactive relight follow-ups (D-055)**, all four of
  D-048's deferred small items: a static single-frame depth-bake fallback
  ("Bake Depth", reusing the existing single-frame Depth-Anything-V2 command
  `generate_full_image_depth_map` — parity with D-024's AI-Depth mask, no
  second model); `relight_depth_layer` wired into `export.rs`'s `grade_frame`
  so a positional light survives a real export, not just live preview (+ a
  real GPU pixel-diff test, lit vs. unlit); a "Preset" tab on `RelightPanel`
  (3 starter looks: warm key + cool rim, soft ambient fill, dramatic
  single-source); MCP tool wrapping for the 4 control-server relight ops
  (`mcp/server.py`). Also fixed a pre-existing "D-046" mislabel for
  interactive relight in `docs/04-roadmap.md` and `docs/09-engine-notes.md`
  — the real decision is D-048; D-046 is "Media pool pass 3".
- **2026-09-03** — **`chroma-types` step 2: `Resolution`/`Rational` made real
  (D-053).** Audited `app/src-tauri/src/chroma/*` for real duplicates of the
  D-039-step-1 placeholders. Real find: `width`/`height` field pairs on
  `video::VideoInfo` and its DTOs (`VideoInfoDto`, `ShotDto`,
  `MediaVideoInfo`) — migrated to `chroma_types::Resolution` via
  `#[serde(flatten)]`, a verified zero-JSON-wire-change move (round-trip
  test in `chroma-types`). `Rational` gained a `Display` impl, now used by
  `export.rs`'s ffmpeg fps-arg string in place of a bare `format!`.
  **Deliberately not migrated:** `ChromaError` (no real call site in
  `app/src-tauri` — its Tauri commands correctly use `Result<T, String>`/
  `anyhow`, a different layer's convention); `ProjectSettings`/`ExportOpts`'s
  width/height (independently-optional patch/override fields, not the same
  concept as an atomic `Resolution` — this directly re-examines the task
  brief's own cited example and found it didn't hold up); `ColorSpace`/
  `TimeRange` (no real duplicate exists yet). `cargo build`: clean across
  the workspace. `cargo test -p chroma-types`: 4/4. `cargo test
  --manifest-path app/src-tauri/Cargo.toml chroma::`: 107/107, unchanged
  from the D-051 baseline. `tsc --noEmit` in `app/`: zero TS files touched
  (Rust-only change) → zero new errors; the pre-existing count read 32 in
  this fresh worktree vs. D-051's recorded 64 on `main` (dependency-version
  drift from a clean `npm install` here, not this change — see D-053).
  Booted the real app to confirm no runtime shape drift.

- **2026-09-03** — **Mature Editor timeline UI (D-051): closes the roadmap item.**
  Scoped against `@xzdarcy/react-timeline-editor`'s real API first — edge-drag trim
  and snap-to-clip-edge/playhead turned out to already be fully native (`flexible`/
  `dragLine`, both already set since D-041), zero new code for either. Built: native
  (non-passive) scroll-wheel zoom + toolbar zoom buttons on `TimelinePane.tsx`; a
  Rust-computed waveform (`chroma_audio_waveform`, `chroma::audio`, one-shot
  `symphonia` decode → mono → min/max bucket peaks) drawn as a plain `<canvas>` in
  new `Waveform.tsx`, no new dependency; ripple visual feedback (a clip-id→
  start-frame diff drives a brief `animate-pulse`); a truthful "Video 1" label
  instead of speculative multi-track colour-coding (deferred to a future
  multi-track-authoring feature). `cargo test chroma::` 107/107 (+12), plus 2 more
  real-file-gated waveform tests (real non-flat peaks from the D-050 audio fixture,
  empty `Ok` for the known-silent one). `tsc --noEmit` 64, unchanged baseline, zero
  in touched files. Booted the real app; honest gap noted in D-051 — no Screen
  Recording/Accessibility permission in this sandbox, same as D-050, so the pixel-
  level zoom/waveform/trim/ripple interactions weren't visually confirmed, only
  their backing command surface and the library's own native-support mechanism
  (read directly from its bundled source).

- **2026-09-03** — **Global undo/redo (D-052): shell-level Cmd/Ctrl+Z spanning all 3
  tabs.** New `@chroma/history` package (a generic `{tab, label, undo(), redo(), ts}`
  stack — a new leaf package, not folded into `@chroma/bridge`, see D-052). Colorist's
  existing `useEditorStore` grade history is bridged in unchanged
  (`useColoristHistoryBridge.ts`, reuses the D-032 `restoreEditorHistorySnapshot`
  helper — extracted from `AgentActivityDock.tsx` so both share one implementation).
  The Edit tab's timeline ops get real undo for the first time — `useEditorTimelineStore
  .applyOp` pushes before/after `Timeline` snapshots. `Shell.tsx` owns the only
  Cmd/Ctrl+Z / Cmd/Ctrl+Y (+ Cmd/Ctrl+Shift+Z) listener, pops the shared stack
  regardless of active tab, and **switches to the popped entry's tab** so the effect
  is always visible (the real UX call, reasoning in D-052). Colorist's own local
  Cmd/Ctrl+Z handler removed to avoid double-undo. Deferred: Motion tab (no natural
  edit-history unit), and the Colorist toolbar's Undo/Redo buttons still bypass the
  shared stack (documented, harmless). 16/16 new unit tests (`@chroma/history` +
  `labelForOp`) passing, `tsc --noEmit` 64/64 baseline unchanged, `cargo test
  chroma::` unaffected (no Rust touched).

- **2026-09-03** — **Export dialog, Colorist tab (D-049): a top-right button replaces
  the "buried `ExportPanel` toggle" roadmap item.** New `ExportDialog.tsx`
  (`@chroma/ui` `Dialog`/`Select`, D-042) in `EditorToolbar`'s top-right button group —
  codec, resolution (Project spec / Clip / Custom), frame range (full/custom), a
  `.cube` bake toggle, a native save-dialog output path, and a real progress bar
  polled from `chroma_export_progress`. Backed by the existing `chroma_export_video`/
  `chroma_bake_lut` (D-022) — the only backend change is two new optional params,
  `out_width`/`out_height`, plus a 4-test pure `resolve_export_resolution` helper
  encoding "explicit > D-038 project spec > clip-derived." `Panel.Export`/
  `ExportPanel` (RapidRAW's still-image exporter) stays routed — it's a different
  feature, not a duplicate (see D-049); the pre-existing bug where it's reachable but
  broken against a loaded video is now tracked as **B-010**. `cargo test chroma::`
  87/87 (+4). `tsc --noEmit`: 64 errors, unchanged baseline, zero in touched/new
  files. Booted the real app, opened `~/Movies/Chroma/New.chroma` (a real 4K/50fps
  clip) over the control-server bridge (no screen-recording access in this sandbox),
  and drove the exact same `chroma_export_video`/`chroma_export_progress`/
  `chroma_bake_lut` calls the dialog makes: a 16-frame H.264 export ran to completion
  with real incrementing progress (`done` climbing 1→16, `running` flipping to
  `false`), producing a genuine 3840×2160/50fps/16-frame MP4 (verified via `ffprobe`,
  not just "no error"); a `.cube` bake produced a valid 17³ LUT file with the correct
  "masks dropped" warning for the project's one mask. Not directly observed: the
  dialog's own on-screen rendering/click-through (no screen capture available) —
  covered instead by `tsc` type-checking the wiring and this identical backend path
  proven live.

- **2026-09-03** — **Editor timeline audio playback (D-050), closes the roadmap
  item.** The Edit tab's preview was completely silent (no pipeline at all); now
  Play produces real device audio via a new `chroma::audio` module: `symphonia`
  decode → `rubato` resample → `dasp_sample` bit-depth convert → `cpal` device
  output, reusing the video track's already-embedded audio stream (no separate
  audio `Track` populated this pass — see the D-050 "why not" note). Sync model:
  a persistent audio thread free-running against the device's own clock, started
  from the same playhead frame at the same moment the video `rAF` loop
  re-baselines — not tightly coupled per-frame; the real design tradeoff is
  written up in D-050. `video::VideoInfo` gained `has_audio`/`audio_sample_rate`/
  `audio_channels` (one extra small `ffprobe -select_streams a:0` call, cached).
  `PreviewPane.tsx` fires `chroma_audio_play`/`chroma_audio_stop` at the same
  `playing` transitions that drive the existing video loop. `cargo test
  -p RapidRAW chroma::`: 95/95 passed (was 83; +12: 9 pure-logic + 2 real-file
  end-to-end + 1 extended). `tsc --noEmit` baseline in this worktree: 64
  pre-existing errors, unchanged. Verified end-to-end with real files (not just
  a clean compile): `A001_08302215_C019.MOV` (HEVC+AAC 48kHz/2ch) played through
  the actual `chroma_audio_play`/`_level`/`_stop` commands produced genuinely
  non-silent PCM (`rms=0.0013 peak=0.0080`, logged + read back via
  `chroma_audio_level`) from a real, live `cpal` output stream; this repo's own
  real `New.chroma` project's one shot (`pexels_28808272.mp4`) was confirmed via
  `ffprobe` to have **no audio stream at all**, so its silence is correct, not a
  gap. Booted the real app for real — clean build + launch, no errors.
  **Honest gap:** did not click Play in the actual GUI on an audio-bearing
  project — both `screencapture` and `osascript`/System Events were tried and
  neither had the permission this sandbox needed to observe or drive the
  window — the command-level integration tests above are the substitute
  proof; whoever next drives the UI can cross-check against the `chroma
  audio: rms=… peak=…` log line. Found + logged (not fixed,
  out of scope) a pre-existing, unrelated test-isolation bug while verifying:
  `docs/BUGS.md` B-011.

- **2026-09-02** — **Media pool, pass 3 (D-046): `shots`/`media` unified, closes the
  roadmap item.** `ProjectShot` now references a `MediaItem` by id (`resolve_shot`,
  graceful fallback for a dangling reference) instead of duplicating `sourcePath`/
  `name`; wire DTOs unchanged, so the frontend session store needed no rewrite.
  `find_or_create_media` is the one choke point every shot-constructing path goes
  through; `chroma_project_add_shot` is the new explicit "add to grading" command. A
  docked Sources/Library panel (`app/src/components/chroma/SourcesPanel.tsx`, injected
  into `@chroma/shell` by prop) with import, client-side search, and a bin tree
  (drag-to-move via `chroma_media_move`); `TimelineSwitcher` in `@chroma/editor` for
  D-045's `chroma_timeline_list`/`_create`/`_set_active`; drag-to-track via plain HTML5
  `dataTransfer` (`CHROMA_MEDIA_DRAG_MIME`), scoped to the Edit tab by construction
  (inactive tabs are `display:none`, never a drop target). `cargo test chroma::`
  73/73 (+8). Booted the real app and drove it end-to-end via accessibility scripting
  (no screen-recording access): created a project, imported a clip, added it to
  grading, created + switched timelines, confirmed an empty timeline's drop zone no
  longer crashes (`buildRow` needed its own guard — found live, fixed) and the
  timeline-switcher's `SelectValue` needed a render-children fix to show names instead
  of raw ids (found live, fixed).

- **2026-09-02** — **Interactive relight (D-048): draggable depth-driven light
  pucks, real-time, deterministic.** A new "Relight" grade layer (`RelightLight[]`
  — key/fill/rim/ambient, keyframeable via D-034's mechanism reused verbatim) with
  a ClipDrop-style puck UI (`RelightPuckLayer`, the clone/heal-marker HTML-overlay
  pattern, not the Konva mask-shape tree) and a right-panel (`RelightPanel`:
  Ambient/Light-N tabs, Color/Power/Distance, "Track Depth"). Shading is a new
  `apply_relight` WGSL pass — per-pixel normal from a depth-texture finite
  difference, `max(0,dot(N,L))·falloff(radius)·colour·intensity` — riding the
  *same* mask-texture-array `mask_bitmaps`/`textureLoad` plumbing D-024's
  depth-haze mask already established (one more array layer, no new bind group).
  Covers both live-preview paths for free (`apply_adjustments` + D-031 playback
  share one `process_preview_job`); export/thumbnail/LUT-bake paths untouched
  (ambient still renders there, positional lights are inert — deferred to
  roadmap). Depth source reuses D-036's `chroma_depth_track` job verbatim.
  Control-server ops (`add_relight_light` etc., mirroring `add_mask`) added for
  agent access + verification. `cargo test chroma::relight` 10/10 new (incl. a
  real-GPU determinism test); `cargo clippy`/`fmt` clean on touched files; `tsc`
  unchanged at 64. **Verified against the real running app**: opened the real
  `~/Movies/Chroma/New.chroma` project, added an ambient light over the control
  server, decoded the returned preview — the frame washed a uniform colour tint
  exactly matching the shading math; a positional light with no depth track
  correctly produced zero change. Photoreal diffusion bake (v3, `ai/` sidecar)
  explicitly out of scope, untouched.

- **2026-09-02** — **Docs reconciliation pass** (roadmap "Next" item 7, the `CLAUDE.md`
  hard-rule debt owed since the D-039 pivot). `03-architecture.md` fully rewritten for the
  3-tab world (crate/package tables, per-tab current state, data model, AI sidecar, the
  agent bridge) off `docs/notes/architecture-lock.md` + every `D-039`-onward decision;
  `00-vision.md`/`01-prd.md`/`02-scope.md` corrected from "grading only, not an editor" to
  the real 3-tab product, keeping what was still true (local-first, grade-as-code, the
  colour-science wedge) rather than rewriting wholesale; `02-scope.md` keeps the Colorist
  v1 scope as still-accurate and adds the Edit/Motion tabs' own scope alongside it, and
  fixes its "Anti-scope" section, which had named editing/motion-graphics as explicitly
  out-of-scope ("that's Palmier's job") — exactly backwards post-pivot. `BUGS.md`'s "Known
  engine constraints" list had three stale entries (D-014/D-018+D-034/D-036, all since
  solved) removed, one still-real item (the `max_texture_dimension_2d` 8K bypass) kept.

- **2026-09-02** — **Motion tab MVP (D-047).** `@chroma/motion`'s `MotionTab`
  is real: a `@remotion/player` preview of `@chroma/motion-engine`'s `Video`
  composition, a live-validated JSON manifest editor (`zod`, JSON-in this
  pass — visual editor still open, see `product-direction.md` §9), Save
  (project-scoped sidecar `<project>.chroma/motion/manifest.json`) and
  Render (new `chroma-motion` crate → `npx remotion render`, Rust
  orchestrates the existing Node engine rather than reimplementing it). New
  Tauri commands `chroma_motion_get_manifest`/`_save_manifest`/`_render` in
  `app/src-tauri/src/chroma/motion.rs`. Found + fixed along the way: a
  latent `@react-three/fiber` × polymorphic-`React.ElementType` typing
  collision (`@chroma/ui`'s `Text.tsx`, `app`'s `BottomBar.tsx` — see
  B-008), a react/react-dom version-duplication bug (`motion-engine` pinned
  exact versions npm couldn't hoist, so two React copies would have landed
  in one component tree), and a live runtime crash from a duplicate
  `remotion` package (`@remotion/animation-utils`/`google-fonts`/
  `motion-blur`/`noise`/`transitions`/`shapes` all caret-pinned in
  `motion-engine`, so npm floated them to a newer `4.0.520` patch each
  carrying its own nested `remotion@4.0.520` — Remotion hard-errors on a
  version mismatch at runtime, which is what actually blocked the first
  several boot-verification attempts). Both fixed via a root `package.json`
  `overrides` block (not by touching motion-engine's pins) plus a genuinely
  clean `rm -rf node_modules package-lock.json && npm install` — an
  incremental install on top of the pre-override lockfile did not reliably
  apply a newly-added override. Verified with a real `npm run tauri:dev`
  boot: dev-server stdout and the app log stayed clean for the session, no
  "Multiple versions of Remotion" error, no frontend-ready timeout.
- **2026-09-02** — **Media pool, pass 2 (D-045): bins + multiple named
  timelines.** `MediaItem.folder` (a plain path-string bin, no separate
  entity — Palmier-MCP-folder convention) + `chroma_media_move`.
  `ProjectManifest.timeline: Option<Timeline>` (D-041) → `timelines:
  Vec<Timeline>` + `active_timeline: usize`, migrated losslessly from the old
  singular key on load; `Timeline` gained an `id`; new
  `chroma_timeline_list`/`_create`/`_set_active`, existing `_get`/`_set`/
  `_frame` now target the active timeline (unchanged behaviour for a
  single-timeline project). Model + commands only, still no UI. `cargo test
  chroma::` 65/65 (+7); `chroma-timeline` 10/10 (+1); the real
  `~/Movies/Chroma/New.chroma` project migrates cleanly, checked both via a
  throwaway fixture test and a live app boot.

- **2026-09-02** — **Edit tab stuck on stale "no project open" fixed (B-007);
  tab-default persistence removed.** Opening a project from Colorist never
  told the already-mounted Edit tab to re-check — its timeline store only
  refetches on its own mount and on OS window focus, neither of which fires
  on a same-window tab open. `main.tsx` (composition root) now triggers a
  reload when `useSessionStore`'s project-open signal changes. Also:
  `@chroma/shell`'s active-tab was persisted to localStorage, silently
  overriding the "Edit opens by default" fix the moment anyone clicked another
  tab once — now session-only, every launch starts on Edit.
- **2026-09-02** — **Media pool, pass 1 (D-044).** `ProjectManifest.media:
  Vec<MediaItem>` — additive alongside `shots`, unification deferred to
  pass 2/3. New `chroma_media_import`/`chroma_media_list` Tauri commands
  (probe via the existing `video::probe`, dedup by source path, live offline
  flagging). `useMediaPoolStore` scaffolding in `@chroma/bridge` (no panel UI
  yet). `cargo test chroma::` 58/58 (+4); the real `~/Movies/Chroma/New.chroma`
  project still loads.

- **2026-09-02** — **Colorist black preview fixed for real (B-006).** Root
  cause was never the wgpu render pipeline — a temporary off-screen-texture
  dump proved the render pass, scissor math, and bound frame texture were
  already correct — it was a plain CSS regression: D-039's `@chroma/shell`
  wraps the window in a new root `<div>` with a hardcoded opaque
  `bg-bg-primary`, silently blocking the transparent "hole" the Colorist app
  already punches through itself for the native wgpu surface to show
  through. Fixed by mirroring the app's `isWgpuActive` up into a new
  `wgpuSurfaceActive` flag on `@chroma/shell`'s store, which the shell root
  now reads to drop its own background too. No screen-recording permission
  was available to verify with a literal screenshot; verified instead via
  the texture dump (pre-fix) plus a live `getComputedStyle` read of the
  shell root in the running app (post-fix, shows `rgba(0,0,0,0)` exactly
  when the surface is active) — see B-006 in `BUGS.md` for the full trail.
- **2026-09-02** — **Colorist wgpu-sync stuck-hidden loop fixed (B-005); a
  second, separate black-preview bug found and logged open (B-006).** After
  B-004 fixed the IPC corruption, the Colorist preview was still black —
  traced to a real second bug: the wgpu-position sync effect could get
  permanently stuck sending an off-screen transform after one transient 0×0
  layout read (its retry loop only reschedules on a *changed* outgoing value,
  so a bad read that matches a prior one never gets re-tried). Fixed in
  `Editor.tsx`'s `syncWgpu` — DOM-layout-not-ready now polls continuously
  instead of relying on a dependency-array item that can't see pure layout
  changes. Confirmed via a temporary debug log, removed before commit. The
  render now genuinely fires at the correct on-screen resolution — but the
  panel is still visually black, a distinct, still-open native
  window/GPU-compositing issue, logged as B-006 (not yet root-caused).
- **2026-09-02** — **Entry module double-mount fixed (B-004) — "No project open" /
  blank Colorist preview.** `app/index.html`'s `<script>` still referenced the
  pre-D-039 `main.jsx` (renamed to `main.tsx`); Vite's dev-server extension
  fallback served `main.tsx`'s content under that stale URL *and* something
  separately fetched the correct `/src/main.tsx`, executing the entry twice —
  two `createRoot()` calls on `#root` and a corrupted `@tauri-apps/api/event.js`
  listener map (confirmed via a temporary `import.meta.url` probe: two
  executions → after the one-line fix, exactly one). This is what broke
  `invoke`/`listen` round-trips app-wide, producing the Edit tab's stuck "No
  project open" and Colorist's blank main preview despite successful backend
  WGPU renders. Fixed by pointing `index.html` at `main.tsx`; both symptoms
  re-verified against the real running app. Also: `packages/shell/src/store.ts`
  `DEFAULT_TAB` → `'edit'` (owner request — Edit opens first, not Colorist).
- **2026-09-02** — **`@chroma/player` — shared preview component, Editor tab
  migrated (roadmap "Next" item 1, built).** New package: `<Player>` (viewport +
  title strip + transport bar), fully controlled and presentational — no
  `@tauri-apps/api`, no zustand, no video/decode logic, built on `@chroma/ui`'s
  `Button`/`Slider`. `fmtTimecode` moved here from `@chroma/editor`'s
  `PreviewPane.tsx` (single source of truth). `PreviewPane.tsx` rewritten to use
  it: all frame-fetch (`chroma_timeline_frame`) and rAF play-loop logic stays
  put, only the hand-rolled transport JSX moved to `<Player>`. Colorist + Motion
  adoption is follow-on, not done here.

- **2026-09-02** — **Colorist tab is the grading editor only — RapidRAW's
  DAM/welcome/library/community shell removed (D-043, built).** The "Sources"
  folder-tree panel the owner flagged is gone, along with the whole photo-library
  grid, albums, culling, the welcome/"Continue Session" home screen, and the web
  Community presets page — Colorist now shows only the editor or a
  `ColoristEmptyState` message. ~7800 LOC deleted across 51 files (`docs/09` D-043
  entry has the full list); every RapidRAW branding string fixed to say Chroma,
  including the ones baked into exported files (EXIF `Software` tag, XMP
  `x:xmptk`), across all 13 i18n locales. `cargo test chroma::` 54/54 unchanged,
  `tsc` errors 74 → 64 (baseline files deleted, zero new).
- **2026-09-02** — **`@chroma/ui` → shadcn/ui + Base UI (D-042, built).** Canonical
  shadcn structure by hand (`components.json`, `src/lib/utils.ts`,
  `src/components/ui/*`, `src/index.ts`) — the CLI can't target a workspace library
  package. 18 structural components on Base UI (`@base-ui/react` 1.7.0): button,
  dialog, dropdown-menu, context-menu, tooltip, popover, tabs, select, command,
  resizable, sheet, slider, switch, scroll-area, separator, input, label, sonner.
  The 5 hand-extracted primitives rebuilt: `Button` (superset of the old API —
  `variant="primary"` alias, `className` still wins via tailwind-merge), `Input`
  (`bgClassName` kept), `Switch` → bare shadcn switch + new `LabeledSwitch` composite
  (Base UI restores the knob animation), `CollapsibleSection` on Base UI `Collapsible`,
  `Text` unchanged. Theme: one `@theme` source (`packages/ui/src/styles.css`,
  `@import`ed by `app/src/styles.css`), every shadcn token an alias of an existing
  `--app-*` var; the `--accent` collision resolved by keeping RapidRAW's brand
  `--color-accent` and editing shadcn's hover state to `bg-muted`;
  `--color-destructive` the one pinned value. Migrated: `@chroma/shell` "‹ Projects"
  button, `@chroma/editor` timeline toolbar → `Button` + `Tooltip`. Colorist panels
  untouched (later). `tsc` app = 74 (baseline unchanged), `vite build` green, `cargo
  check` untouched. Deferred: typography unification, Colorist `Dropdown` migration.

- **2026-09-02** — **Project launcher is the app entry screen (D-039 migration
  log).** The app opens on the D-037 launcher with no tab bar — just the chrome
  bar. Opening/creating a project sets `useSessionStore.projectPath` (or
  `projectName` for a loose-clip Untitled), flipping `<Shell>` into the 3-tab
  layout; a "‹ Projects" button in the chrome bar calls a new `closeProject()`
  action (flushes a final save for a dirty named project, then resets all
  session + project state) to return. `<Shell>` gains `projectOpen` / `launcher`
  / `onCloseProject` props — it never imports `ProjectLauncher` (app → shell
  only); `app/src/main.tsx` is now a small `Root` that reads the session store
  and routes. Tab panels stay mounted under the launcher so the Colorist MCP
  control bridge keeps running. Colorist (`<App/>`) drops its `activeView:
  'projects'` branch — `useUIStore` default `'projects'` → `'editor'`, `App.tsx`
  renders `<LibraryView/>` directly as the unrouted albums/culling fallback,
  `useAppNavigation` "back" → `'library'`. No Rust change (`state::ProjectRef` is
  left set on close — harmless; the next open overwrites it and every frontend
  save path guards on `projectPath`). `tsc` 74 baseline unchanged, `vite build`
  green. Follow-ups: reopen-last-project on launch; Untitled close = discard.

- **2026-09-02** — **UI consistency pass (D-039): window chrome in the shell,
  `@chroma/ui` kit, editor icons.** (1) The window title bar moved out of the
  Colorist tab into `@chroma/shell` — new `WindowChrome.tsx` (platform logic
  ported from RapidRAW's `TitleBar`: macOS traffic lights, Win/Linux controls,
  drag region), and `Shell.tsx`'s top bar is now the title bar (left = traffic
  lights + `CHROMA` wordmark, centre = tabs, right = window controls / mac
  spacer, `h-10`). `.macos-window-shell` (14px rounded corners) moved to the
  shell root. `app/src/App.tsx` stops rendering `<TitleBar/>` (import + render
  removed; the file stays unrouted for reference). `@chroma/shell` gains
  `@tauri-apps/api` + `@tauri-apps/plugin-os` + `lucide-react` — it's the app
  chrome now, so Tauri coupling is fine. (2) `@chroma/ui` is a real package:
  `Button`, `Input`, `Text`, `Switch`, `CollapsibleSection` extracted from
  `app/src/components/ui/`, the app-side files now `export { X as default } from
  '@chroma/ui'` re-export shims (all `import X from '../ui/X'` sites unchanged).
  Deps kept to react + clsx + lucide — `Switch` drops `framer-motion` (CSS
  transform transition), `CollapsibleSection` drops `react-i18next` (inlined
  strings); `typography.ts` copied into the package. `Slider` + the app-coupled
  components stay in `app/`. `@source "../../packages/ui/src"` added to
  `styles.css`. (3) `@chroma/editor` transport + toolbar rebuilt with
  `lucide-react` icons (`SkipBack` / `Play`–`Pause` / `SkipForward`, `Scissors`
  split, `Trash2` remove); empty-state action is a `@chroma/ui` `<Button>`.
  `npm install` clean, `tsc` 74 baseline unchanged, `vite build` green,
  `cargo check --no-default-features` unchanged (no Rust touched).

- **2026-09-02** — **Editor tab MVP (D-041)**. The Edit tab is a real, working
  single-video-track timeline of the open project's shots. `chroma-timeline` made
  real: `Timeline::from_shots`, `Track::clip_at` / `Timeline::duration`, and
  reorder / trim-start / trim-end / split / remove ops (each unit-tested, 9/9).
  New Rust bridge `chroma::edit` — `chroma_timeline_get` / `_set` / `_frame`
  commands; the timeline persists **in the `.chroma` project** (`ProjectManifest.timeline`,
  `#[serde(default)]`, schema major unchanged — same additive move as D-038's
  `settings`). The preview is a **standalone lightweight decode→jpeg**
  (`decode_pipe` → `image` q80 → `data:` URL), independent of the Colorist's
  wgpu / grade path. `@chroma/editor` is a real tab now: a
  `@xzdarcy/react-timeline-editor` strip (drag = reorder, edge-drag = trim,
  Split-at-playhead, select + Delete = remove) over a preview pane with a
  wall-clock rAF play loop, backed by `useEditorTimelineStore` (zustand, stays in
  `@chroma/editor` for now). Deferred: multi-track, audio, transitions,
  transcript cut, GPU compositing, grade-in-preview, OTIO export, MCP.
  `cargo build` + `chroma-timeline` 9/9 + `chroma::` 54/54 + `tsc` 74 baseline +
  `vite build` all green.

- **2026-09-02** — **3-tab shell (D-039 migration)**. `@chroma/shell` (react +
  zustand only): `<Shell tabs={registry}>` — an h-9 tab bar (Edit / Motion /
  Colorist) over the active tab, all tabs stay mounted, Cmd/Ctrl+1/2/3, active tab
  persisted to localStorage. `app/src/main.tsx` mounts it with the Colorist tab =
  the whole existing app untouched (root `h-screen` → `h-full`); Edit + Motion are
  placeholder tab components (`@chroma/editor` / `@chroma/motion`). `npm run build`
  (vite prod) green, tsc baseline 74 unchanged. The 3-tab layout is now live.

- **2026-09-02** — **Monorepo workspace skeleton (D-039 + D-040)**. The RapidRAW
  fork was de-submoduled into `app/` (D-040), then the workspace made real (D-039
  migration step 1): root `Cargo.toml [workspace]` (members `app/src-tauri` +
  `crates/*`, `Cargo.lock` moved to root, build profiles hoisted from the member);
  3 pure-leaf **stub** crates — `chroma-types` (`Resolution`/`Rational`/`ChromaError`),
  `chroma-timeline` (OTIO-shaped `Timeline`/`Track`/`Clip`), `chroma-grade-model`
  (`Grade` wrapper, mirrors `grade.json` D-025) — each `cargo check` clean with an
  `it_builds` test; root `package.json` npm workspaces + 6 stub packages
  `@chroma/{tokens,ui,bridge,editor,motion,shell}`; the Remotion motion engine moved
  in from `videoAgent/engine/motion/` as `packages/motion-engine/`
  (`@chroma/motion-engine`); `app` package renamed `rapidraw` → `@chroma/app`.
  Repo-wide `engine/…` → `app/…` path fixes (docs, `mcp/`, `ai/`, `eval/`, CLAUDE.md,
  README, sidecar comment). **No real code moved — the whole workspace builds
  (`cargo build --no-default-features` clean, `RapidRAW` crate + 3 stubs),
  `npm install` hoists, `tsc` baseline unchanged (74), `py_compile` clean.** Run the
  app: `npm run tauri:dev` from the repo root. Migration log in `D-039`
  ("### Migration log"); `crates/README.md` + `packages/README.md` carry the full
  planned lists.

- **2026-09-02** — **Per-project output spec (D-038)**. D-037's reserved,
  unused `settings` field on `project.json` gets a real typed shape:
  `ProjectSettings { width?, height?, fps?, color_space? }`, all optional. A
  multi-shot project now has **one** output spec instead of everything being
  derived from whichever clip is loaded. A fresh project seeds
  width/height/fps by probing the first shot's clip; a project with no settings
  behaves exactly as before (clip-derived, byte-identical exports). Export
  resizes the graded composite (Lanczos3) to the project resolution as the final
  step before the encoder and uses the project fps as the timebase. `color_space`
  (`rec709`/`rec2020`/`dci-p3`/`srgb`) is **stored + surfaced only** — a real
  colour-managed pipeline stays D-004. `chroma.project/1` schema major unchanged
  (additive; legacy `settings: {}` / `{fps:24}` still load). New
  `chroma_project_set_settings(path?, partial)` command (partial merge), a
  "Project settings" modal off the shot-strip gear, `get_state().project.settings`,
  MCP `set_project_settings` — **37 → 38** tools. All new logic in
  `chroma/project.rs` + `export.rs` + new frontend files; `lib.rs` +1 line.
  Verified: `cargo check` clean, `cargo test chroma::` **54/54** (49 + 5),
  `tsc --noEmit` baseline unchanged (74, none in new/touched files),
  `py_compile` + `import server` clean (38 tools). The settings modal + a
  resolution-override export + MCP round-trip are an open manual smoke test.
  Detail: `docs/notes/project-model.md`, `D-038`.

- **2026-09-02** — **Project launcher + `<name>.chroma` project model (D-037)**.
  The home screen was still RapidRAW's inherited Library view — a folder tree,
  photo grid, albums, culling. Replaced with a **project launcher**: a grid of
  saved Chroma projects, each a card with a cached thumbnail + name + relative
  timestamp, click to open. A project is a `<name>.chroma` **directory** (not a
  bundle) — `project.json` (versioned, `chroma.project/1` migration gate, shots
  referenced by **absolute source path** — media is never copied), `thumb.jpg`,
  and `grades/<shotId>.grade.json` (each shot's D-025 grade, inside the project
  so it travels with it). Default folder `~/Movies/Chroma/`, configurable. A
  missing source file → the shot shows **"media offline"** with a **relink**; its
  grade is untouched and reattaches. Completes D-033's deferred session
  persistence — D-033's in-memory `Session` is now the loaded form of a project.
  New `chroma/project.rs` (pure fs+json, like `grade.rs`; 8 tests) +
  `chroma_project_list/open/new/save/relink/current/settings_dir/set_dir`;
  `state.rs` += a `ProjectRef`. Frontend: `ProjectLauncher.tsx`,
  `useProjectAutosave.ts` (debounced save on any grade / shot / active-shot
  change), `useSessionStore` project thunks, one routing conditional in
  `App.tsx`, default `activeView` `'library'` → `'projects'`. **LibraryView /
  albums / culling not deleted** — folder navigation still routes to them, so
  upstream stays cherry-pick-able (D-003). Quick-open preserved: a loose clip via
  the picker or MCP `open(path)` → an in-memory "Untitled" session that still
  seeks / plays / exports / tracks. MCP: `list_projects` / `open_project` /
  `new_project` / `save_project`, `get_state().project` — **33 → 37** tools.
  Verified: `cargo check` clean, `cargo test chroma::` **49/49** (41 + 8),
  `tsc --noEmit` baseline unchanged (74, none in new/touched files),
  `py_compile` + `import server` clean (37 tools). Launcher / New-Project /
  autosave / reopen / relink are an open manual smoke test. Detail:
  `docs/notes/project-model.md`, `D-037`.

- **2026-09-02** — **Per-frame depth track (D-036)**. The depth-haze preset
  (D-024) baked ONE Depth Anything V2 map and reused it for every frame — it
  flickers / goes wrong on a moving camera. Replaced with a real **temporal
  video-depth track**, the same move DaVinci Resolve made: **Video Depth
  Anything — Small** (vits, **Apache-2.0** — vitb/vitl are non-commercial and
  must not be used), whose spatial-temporal head makes the depth stable
  frame-to-frame natively, not via a bolt-on filter. Runs in the `ai/` sidecar
  (new `/depth_track` job mirroring `/track`; VDA's cross-frame attention is
  exactly the "too fragile to ONNX-export" case behind D-009's sidecar
  precedent) — vendored (`ai/vendor/`, not pip-installable), checkpoint
  lazy-downloads (~112 MB), MPS fp32. Per-frame depth PNGs cache to
  `<clip>/.chroma/depth/<key>/` and are read at render time keyed by the current
  source frame via a new `chromaDepthDir` param + **one** hook in
  `mask_generation.rs::generate_ai_depth_bitmap` (mirrors D-019's tracked-matte
  read) — so scrub, playback and export all get per-frame depth for free. The
  Rust DA-V2 ONNX path is unchanged and stays the **static single-frame bake**
  for stills and for `apply_haze` before a track is run; absent `chromaDepthDir`
  → byte-identical to before. UI: a "Track depth over clip" button (mirrors the
  subject-track button). MCP: `depth_track` / `depth_track_status`, `apply_haze`
  gains `tracked` — **31 → 33** tools. Verified: `cargo test chroma::` 41/41
  (37 + 4), `cargo check` clean, `tsc` baseline unchanged (74), `py_compile` +
  `import server` clean. `ai/test_depth_track.py` on Tokyo-Walk: PNGs
  non-degenerate, VDA consec-frame |Δ| 0.0032 vs per-frame DA-V2 0.0050 (1.5×
  steadier). Detail: `docs/notes/depth-track.md`, `D-036`.

- **2026-09-02** — **Agent eval harness (D-035, round-3 tail item)**. New
  top-level `eval/` — a regression + capability test for the grading agent (does
  it *grade by the numbers* and converge on a target, or drift?). A 7-task data
  set (`eval/tasks.json`: neutralise a cast, match a shot to a reference, set
  black/white points, fix an exposure error, **don't over-grade** an
  already-correct frame, grade a masked region only, tame highlight clipping) +
  an **offline** scorer (`eval/score.mjs` — no app, no agent, no network). The
  scorer ports `computeScopes` / `computeGap` / `gapMagnitude` verbatim from
  `app/src/utils/scopes.ts` (`eval/lib/scopes.mjs`, drift-guarded by
  `scopes.check.mjs`) plus an **approximate** primary-grade operator
  (`eval/lib/apply.mjs`) that turns a `grade.json` (D-025) into a scoped result
  frame — so absolute scores are only comparable *within* the harness, and
  engine-fidelity is the `eval/run.md` closed-loop runbook's job. Score =
  normalised inverse residual scope gap to the goal, zeroed by hard-fail gates
  (clipping introduced, mask background moved, `knobEffort` over the cap).
  Committed `eval/baseline.json` = the setup grades left unfixed (mean **0.452**,
  2/7 pass); `eval/results/` (7 hand-authored good grades) score **0.975** (7/7,
  every task up vs baseline); `eval/bad_examples/` score **0.0** with gates
  firing — the scorer ranks good ≫ bad offline. Fixtures (`eval/fixtures/`,
  480×270, `_gen.mjs` to rebuild): a downscaled C019 still + synthesised wedge /
  patch frames. Dependency-free (Node `zlib` PNG codec). **Zero engine changes.**
  MCP: added the missing **adversarial** framing to the shared `SCOPE_DISCIPLINE`
  string, `inspect_color`, and `mcp/README.md` — tool count unchanged (**31**),
  `py_compile` + `import server` clean. Detail: `docs/notes/eval-harness.md`.

- **2026-09-02** — **Mask keyframes (D-034, round-3 item "mask keyframes")**. A
  shape sub-mask (radial / linear / brush) can now be **keyframed** — its
  geometry (centre / radii / rotation / feather, linear endpoints / range, brush
  points) is snapshotted at chosen source frames and **interpolated per frame**
  on scrub, playback and export, so a mask can hand-track a subject SAM can't or
  shouldn't follow (a hand, a product, a light, a reflection, a patch of sky).
  Geometry only — grade adjustments aren't keyframed. New **◆ Keyframe** button +
  a diamond track above the timeline (`components/chroma/MaskKeyframeBar.tsx`);
  the canvas overlay draws the **interpolated** shape at the current frame, and
  dragging the mask writes/updates the keyframe at that frame. Data model:
  `parameters.chromaKeyframes = [{frame, params}]`, round-trips through
  `grade.json` inline. Interpolation: linear scalars, **shortest-arc rotation**
  (350°→10° through 0°), brush points lerp when the stroke shape matches between
  keys else snap to the nearer key; clamp/hold outside the keyed range. Tracked
  (`chromaTrackDir`, D-019) and keyframed are mutually exclusive — tracked wins.
  Rust: new `chroma/keyframes.rs` (pure, 14 unit tests) + **one** hook call in
  `mask_generation.rs::generate_sub_mask_bitmap` (mirrors D-019). Frontend:
  `utils/maskKeyframes.ts` (Rust mirror), `MaskKeyframeBar.tsx`, `ImageCanvas.tsx`
  +~4, `useChromaControl.ts` +4 ops. MCP: `add_mask_keyframe` /
  `list_mask_keyframes` / `clear_mask_keyframe` / `clear_mask_keyframes`
  (27 → 31 tools). No `lib.rs` / Cargo / `AppState` change. `cargo check` clean,
  `cargo test chroma::` 37/37 (+14); `tsc --noEmit` baseline unchanged (74, none
  in a touched file); `py_compile` clean, 31 tools. Export + playback interpolate
  for free (both set `current_video().frame` before the grade). Manual app +
  canvas-drag smoke test open. Deferred: grade-adjustment keyframing (separate
  item), easing handles, a full dope sheet, brush strokes that change point
  count between keys (they snap). Detail: `docs/notes/mask-keyframes.md`.

- **2026-09-02** — **Multi-shot session model + shot strip (D-033, round-3 item 2)**.
  Chroma held one clip; now it holds a **session** — an ordered set of shots from
  one shoot, each with its own grade and its own agent-activity feed. New **shot
  strip** (`components/chroma/ShotStrip.tsx`, bottom bar): thumbnail + filename,
  an accent dot when the shot has a non-neutral grade, click to switch, `+` to
  add clips, `×` to remove, `→` to copy the active grade onto the next shot.
  Switching a shot stashes the live grade under the outgoing clip and restores
  the target's (the per-clip `grade.json` sidecar, D-025, is still the on-disk
  per-shot document). **Lightweight by decision** — no `.chroma` project bundle
  (D-033 weighs it against the project's minimal-fork / cheapest-thing bias).
  Rust: `chroma/state.rs`'s clip global becomes `Session { shots, active }`
  (`current_video()` unchanged — returns the active shot; `set_current_video`
  upserts by path); new `chroma/session.rs` (list / add / set-active / remove /
  thumbnail); `video.rs` +1 thumb helper. Upstream edits: `mod.rs` +2, `lib.rs`
  +5, `BottomBar.tsx` +4. Frontend: new `store/useSessionStore.ts`, `useAgentStore`
  per-shot feed scoping, `useChromaControl.ts` ops + `get_state.session`. MCP:
  `list_shots` / `set_active_shot` / `add_shots` (24 → 27 tools). Single-shot
  behaviour identical (one clip = a session of one shot). `cargo check` clean,
  `cargo test chroma::` 23/23 (+5); `tsc --noEmit` baseline unchanged (74, none
  in a touched file); `py_compile` clean. Deferred: `.chroma/session.json` reopen
  (path list, not a bundle), drag-drop reorder, copy-to-any-shot, per-shot
  `grade.json` auto-load. Manual app + MCP smoke test open. Detail:
  `docs/notes/multi-shot.md`.

- **2026-09-02** — **Agent activity feed + `request_human` (D-032, round-3 item 1)**.
  The GUI now shows every grade change the agent made through the MCP/control
  bridge: a fixed bottom-left "Agent activity" dock, newest-first, each entry a
  summary ("primary: exposure +0.35, temp −8" / "match to reference: 3 iters,
  gap 78→10") + an expandable per-field grade diff + a jump-to-here **Undo**.
  Recorded at the single `chroma://request` chokepoint in `useChromaControl.ts`
  (one entry per op — `debouncedSetHistory.flush()` collapses `match_reference`'s
  internal iterations; `seek`/`open` not logged). New `useAgentStore.ts` slice,
  `utils/agentActivity.ts` (`diffAdjustments` / `summarizeActivity`, pure),
  `components/chroma/AgentActivityDock.tsx` + `AgentRoiHighlight.tsx`. Undo is
  jump-to-here on RapidRAW's history stack (drops newer feed entries; documented
  fallback when the 50-slot stack has evicted the pre-op state). `request_human(
  reason, roi?)` — a new non-blocking op + MCP tool: posts a banner (+ an amber
  ROI rectangle on the canvas if `roi` given, normalized 0..1), the user clicks
  "Resume agent", the agent polls `get_state().pendingHumanRequest`. **No Rust
  change** (rides the generic `POST /op` path). Upstream edits: `App.tsx` +2,
  `ImageCanvas.tsx` +2. MCP 23 → 24 tools. `tsc --noEmit` baseline unchanged (74
  pre-existing unrelated errors, none in a touched file); `py_compile` clean.
  Manual running-app smoke test still open (bridge listener doesn't hot-reload).
  Detail: `docs/notes/agent-activity-feed.md`.

- **2026-09-02** — **Real-time playback ≥30 fps (D-031, round-2 item 5 tail)**.
  Closes the "frontend regrade + IPC per frame" ceiling D-030 named. New
  `app/src-tauri/src/chroma/playback.rs::chroma_play_frame` — one IPC call
  that decodes (scaled, via the D-030 pipe's new `-vf scale` path), swaps the
  base frame, and dispatches a single preview job at ~1280 px playback res,
  replacing per-frame `chroma_seek` + `bumpFrameNonce` + `apply_adjustments`
  (two IPC calls + a React round-trip + a full-4K grade + a ~40 ms CPU
  downscale). `ChromaTimeline.tsx` playback is now a `requestAnimationFrame`
  wall-clock loop (skips missed frames, no `setInterval` drift, no frame-drop
  mutex); pause settles full-res; scrub unchanged. `decode_pipe.rs` gained
  `scale_target` / `open_scaled` / `frame_scaled` / `playback_frame_scaled`
  (D-030's native fns are now `..._scaled(.., None)` wrappers, tests untouched);
  `chroma_seek`'s body extracted to `commands::seek_and_install`. Upstream
  edits: `chroma/mod.rs` +2, `lib.rs` +1. `cargo check --no-default-features`
  clean, `cargo test --no-default-features chroma::` 18/18. Headless timing
  harness (`playback_throughput_c019`) on C019 4K/24p, real WGSL grade via
  `render_core::render`: **27.4 ms/frame → 36.5 fps** at 1280 px (was
  68.8 ms → 14.5 fps at 4K), 19.6 ms → 50.9 fps at 960 px. Manual
  scrub/play/tracked-matte smoke test still open. Detail:
  `docs/notes/playback-30fps.md`.

- **2026-09-02** — **Smooth playback: persistent decode pipe (D-030, round-2 item 5)**.
  New `app/src-tauri/src/chroma/decode_pipe.rs` — one long-lived
  `ffmpeg -ss <(start-0.5)/fps> -i clip -f rawvideo -pix_fmt rgb24 -` per clip
  instead of a fresh spawn + keyframe seek + PNG round-trip per frame. `FramePipe`:
  a forward step is one raw `read_exact`, a ≤48-frame hop discards to target, a
  jump / backward kill+respawns. Process-global, dropped by `set_current_video` on
  a clip change, killed on `Drop`. `chroma_seek` decodes through it and falls back
  to `video::decode_frame` on any error; `load.rs` gained `install_frame` (the
  state-writing tail, so the transport doesn't re-probe). Export's `spawn_decoder`
  now seeks too — `-ss …-1s -copyts` + `select` by absolute timestamp `t` (not
  frame index `n`, which is why it stays tracked-matte-safe, the thing D-022
  avoided) — so a `from > 0` range no longer decodes from frame 0. Upstream edits:
  `chroma/mod.rs` +2 only; no `lib.rs` / Cargo change. `cargo check
  --no-default-features` clean, `cargo test chroma::` 14/14 (new pipe + seeked-
  decoder frame-alignment tests). Measured on C019 (4K/24p): 24 sequential frames
  **0.61 s (~39 fps)** vs **15.3 s (~1.6 fps)**; a mid-clip export frame **0.83 s**
  vs **2.9 s**. Open: the frontend per-frame regrade + IPC is now the fps ceiling.
  Detail: `docs/notes/smooth-playback.md`.

- **2026-09-02** — **Stripped `@clerk/react` (D-029, round-2 item 4)**. Removed the
  community-login dep RapidRAW ships for its hosted account — Chroma has no cloud
  (all AI is the local `ai/` sidecar + in-process ONNX). Gone: the `ClerkProvider`
  + hard-coded dev key in `App.tsx`, the `<TitleBar>` React error, the "loaded with
  development keys" console spam. `useUser`/`useAuth`/`useClerk` → local
  null-returning stubs at the 3 call sites; the Settings sign-in panel → a
  one-line "runs all AI locally" note. Frontend-only, no Rust change.

- **2026-09-01** — **Rust-managed AI sidecar (D-028, round-2 item 3)**. The app
  now starts and supervises the `ai/` FastAPI sidecar itself — no more `cd ai &&
  ./run.sh`. New `chroma/sidecar.rs`: resolves python (`CHROMA_AI_PYTHON` →
  `.venv/bin/python` → `python3` on PATH) + the `ai/` dir (`CHROMA_AI_DIR` →
  `CARGO_MANIFEST_DIR`-relative), spawns `uvicorn`, pipes its logs into
  `app.log` as `[sidecar] …`, polls `/health` (ready-in-Nms), restarts on crash
  with 2→30 s capped backoff (60 s slow-retry after 6 fast failures), and is
  killed on app exit via a `RunEvent::ExitRequested`/`Exit` hook. An already-
  running external sidecar is detected and only monitored, never killed or
  respawned. `CHROMA_AI_NO_SPAWN=1` opts out for manual `ai/run.sh` use.
  `chroma_ai_status` command for a future UI indicator. No new crate — the
  health check is a raw `TcpStream` HTTP GET, not blocking-`reqwest`. Known gap:
  packaged-app path resolution (`CARGO_MANIFEST_DIR` is a dev path) — flagged
  for Phase 4. Detail: `docs/notes/sidecar-lifecycle.md`.

- **2026-09-01** — **Per-mask blur (D-027, round-2 item 2)**. A `blur` field
  (0–100) on every mask's adjustments — defocus the masked region. Shader: renamed
  the dead `_pad_cg1` slot in `MaskAdjustments` → `blur` (Rust + WGSL, zero layout
  change) + a ~20-line loop in `shader.wgsl::main` that blends the masked region
  toward the shader's existing ~40 px `structure_blur` pre-pass, weighted by
  `mask · blur/100`, in linear light before tone-mapping (approach (a) — no new
  texture / pass). Frontend: a mask-only "Blur" slider in `Details.tsx`,
  `INITIAL_MASK_ADJUSTMENTS.blur = 0`, `set_mask_adjust` whitelist (`MASK_ONLY_KNOBS`,
  so `set_primary` still rejects it), a new `add_mask(type, geometry)` op for a
  plain radial/linear container, and `apply_haze` now dials in `blur` too (D-024's
  deferred background defocus — done). MCP `set_mask_adjust` gains a `blur` param.
  Verified on C019: `blur 70` under a radial mask drops masked local contrast
  ~25–35 % with unmasked patches at exactly 0, reversible at `blur 0`, blur present
  in an H.264 export, no wgsl compile error. Detail: `docs/notes/mask-blur.md`.

- **2026-09-01** — **`match_to_reference` — the automated grade-by-the-numbers loop
  (D-026, round-2 item 1)**. `match_reference` op in `useChromaControl.ts` + MCP
  `match_to_reference(reference, strength?, max_iters?, tolerance?)`. Loads a
  reference image (same neutral-preview path as `inspect_color`), measures the
  scope gap, and iterates a **damped** primary correction — exposure /
  temperature / tint / contrast / saturation — re-measuring each step until a
  combined gap magnitude drops below `tolerance` or `max_iters` (default 4) is
  hit. Gap→knob scalars: exposure ← mids-luma + common-mode black/white shift;
  temperature/tint back-derived from the app's WB-picker math; contrast ← spread
  difference; saturation ← raw HSV-sat difference (never a ratio). Machinery:
  near-constant damping (~0.78), per-knob per-step ceilings (contrast/saturation
  tight — they poison the next measurement), **roll-back any non-improving step** +
  halve strength, best-snapshot land, 2-stall / 16 s-budget stop. **Merges into
  `primary`** — a match is a balance; creative/curve/mask work is separate.
  Two-capture averaging on each measure to fight the 512-px-JPEG noise floor
  (D-021). Zero engine-Rust changes. Verified live on the 1080×1920 talking-head
  clip: a warm+bright reference vs a cool+dark subject → combined gap **78.3 → 10.0**
  over 5 iterations, monotone decreasing, `warmCool 12.7 → 56.6` (ref 58.1),
  `white 230 → 251` (ref 253), `sat 0.25 → 0.44` (ref 0.43); re-run is a no-op
  (0 accepted steps); an unrelated reference degrades gracefully (130.6 → 86.0
  then roll-back + stall-stop, all knobs finite + in range). Detail:
  `docs/notes/match-reference.md`.

- **2026-09-01** — **`grade.json` save/load + versioned schema (D-025)** — "the grade is
  code". New `app/src-tauri/src/chroma/grade.rs` (pure JSON+fs, no GPU/store):
  `chroma_save_grade` / `chroma_load_grade`. v1 `grade.json` is a **versioned wrapper**
  around RapidRAW's `adjustments` — `{schema:"chroma.grade/1", shot:{source,width,height,
  fps,frameCount,colorSpace,reference}, adjustments:{…}, notes}` — NOT `docs/06`'s ordered
  `stack` (that's the v2 node graph, D-005; `docs/06` rewritten, `stack` kept under "v2").
  Mask mattes externalized so the JSON stays diff-able: static `maskDataBase64` →
  `<name>.mattes/<subId>.png` + `{"$matte"}`, `chromaTrackDir` → `{"$trackDir"}`
  (referenced, not copied — moving a project needs `.chroma/mattes/` too). Load reverses
  it + a `chroma.grade/<major>` gate (v1 identity migration stub; rejects newer/unknown).
  Frontend `useChromaControl` ops `get_grade` / `save_grade` / `load_grade` (load →
  `setAdjustments(() => normalizeLoadedAdjustments(g.adjustments))` + `bumpFrameNonce`;
  **v1 does not auto-switch clips** — flags a `shot.source` mismatch, applies anyway).
  MCP: 3 tools. Engine edits: `chroma/mod.rs` +2, `lib.rs` +2; `cargo check` +
  `cargo test chroma::grade` (3/3) clean. Verified live against the 1080×1920 talking-head
  clip: `set_primary` + subject mask → `save_grade` → a 25 KB `grade.json` (schema tag,
  `{"$matte"}`/`{"$trackDir"}` refs, a `.mattes/` dir of 1080×1920 grayscale PNGs);
  one-knob change → one-line `git diff`; neutralize → `load_grade` → the grade + 3 masks
  (incl. a tracked one) come back, `inspect_color` deterministic across repeats; tracked
  `$trackDir` resolved to the clip's 527-frame matte folder. Detail: `docs/notes/grade-json.md`.
- **2026-09-01** — **Depth-haze preset (D-024)**. `apply_haze({amount?, protect_subject?})`
  / an "Add depth haze" button / `useAiMasking.handleAddDepthHaze` → a "Depth Haze" mask:
  a full-range `ai-depth` sub-mask **inverted** so the matte value tracks distance, graded
  with negative `dehaze` (adds haze) + `saturation -25` + `blacks +10` + `shadows +8`, all
  × `amount`. Depth is a **static** bake (per-frame / temporal smoothing deferred);
  `chroma_seek` now busts `ai_state.depth_map` so a re-apply on another frame is correct.
  No per-mask blur (no such field — deferred). Verified on the 1080×1920 talking-head clip:
  `inspect_color` blackPoint 17→33, saturation 0.33→0.24; background pixels lift ~10 luma +
  desaturate while the subject face is untouched; `amount` 0.4/1.0/1.6 scales monotonically.
  Also landed: `useChromaControl` **mounted at app level** (was `Editor`-only) + a new
  `open(path)` op/tool. Engine edit: `chroma_seek` +5 lines, `cargo check` clean. Detail:
  `docs/notes/depth-haze.md`.
- **2026-09-01** — **Video export + `.cube` bake (D-022)**. New
  `app/src-tauri/src/chroma/export.rs`: `export_video` (one `ffmpeg -f rawvideo`
  decode pipe → `render_core::render` per frame, one GPU ctx for the run → one `ffmpeg`
  encode pipe; ProRes 422 HQ / H.264) and `bake_primary_lut` (`size³` identity lattice
  through the primary grade only → `.cube`, warns on dropped masked layers). Per-frame
  tracked matte via new `chroma::state::set_current_frame` (D-019). Commands
  `chroma_export_video` (background + `chroma_export_progress`) / `chroma_bake_lut`;
  frontend `export` / `export_progress` bridge ops; MCP `export(kind, path?, from?, to?)`.
  Verified on the 1080×1920 test clip: neutral + `exposure` + tracked-subject exports
  (`ffprobe` + frame spot-checks) and a warm `.cube` that reddens a grey ramp in ffmpeg.
  Detail: `docs/notes/export.md`.
- **2026-09-01** — **Scopes + `inspect_color` (D-021)**. New `app/src/utils/scopes.ts`
  (pure JS, no deps): `computeScopes` (black/white points, luma + per-channel clip %,
  per-zone means, warm-cool + green-magenta cast, 12-bin saturation-weighted hue
  histogram, mean saturation), `renderParade` / `renderVectorscope` PNGs, `computeGap`
  (subject→reference hints that map onto knobs), `samplePoint` / `sampleRegion`.
  Wired into `useChromaControl` as read-only ops `inspect_color(frame?, reference?)` /
  `sample` / `sample_region`; every mutating op response now also carries the compact
  `scopes`. Reference images load via the existing `generate_preview_for_path` command
  — **zero engine Rust change**. `mcp/`: 3 new tools + scope-first discipline ("grade by
  the numbers; cite a scope value or a named region; defer the creative call") in the
  server instructions, the mutating tool docstrings, and `mcp/README.md`. Pure functions
  unit-checked on synthetic ImageData (grey / ramp / warm-cast / orange / clip / gap).
  Detail: `docs/notes/scopes.md`.
- **2026-09-01** — Repo scaffolded. `engine/` submodule = RapidRAW. Docs written (vision,
  PRD, scope, architecture, roadmap, research, grade-format, MCP surface, decisions).
  `CLAUDE.md` rules.
- **2026-09-01** — Engine code-read (`docs/09`). Rust 1.98, `cargo check` passes.
  Findings that shaped decisions: AI is ONNX-in-Rust not Python (**D-009**); `WgpuDisplay`
  is the native video-surface path (**D-006**); render core is Tauri-coupled → extract
  `render_core` (**D-014**). Added D-012 (SAM 1→2), D-013 (relight → v3).
- **2026-09-01** — ffmpeg → 4K Rec709 frame from the C019 test take works. Disk cleaned
  (3.6 → 38 GiB free).
- **2026-09-01** — D-003 decided (standalone hard fork; still keep changes clean for
  upstream cherry-picks), D-012 decided (SAM 2, no fallback).
- **2026-09-01** — App builds + launches (`tauri dev`, 7m18s). Phase 0 done.
  Phase 1 started: `src/chroma/video.rs` — ffmpeg probe + single-frame decode (D-015),
  first engine divergence (all under `src/chroma/`, +1 line in `lib.rs`). Tests pass
  against the real C019 4K take.

## Releases

_(none — pre-v1)_

- **2026-09-01** — Minimal video-open path built: a video loads as frame 0 through the
  existing grade pipeline (`src/chroma/{state,load}.rs` + 3 one-line hooks). Engine on
  branch `chroma`. App rebuilt + running.
- **2026-09-01** — Video transport bar + timeline view (filmstrip → 48-frame thumbnail
  strip when a video is loaded, click/drag to seek). Backend: `chroma_seek`,
  `chroma_video_info`, `chroma_frame_thumbnails` (cached).
- **2026-09-01** — SAM 2 subject mask working (D-012 → Python sidecar, `ai/`,
  `ultralytics` on MPS). Clean silhouette matte on the 4K test frame — the ellipse's
  hands problem is solved. `/segment` supports box + multi-point (+/−) prompts.
- **2026-09-01** — Matte edge refine (**D-016**): SAM 2's 256px decoder staircases at 4K;
  guided-filter finesse (the Resolve approach) failed on the low-contrast test shot; added
  a trimap → **ViTMatte** stage → clean edge. Worklog + before/after in
  `docs/notes/matte-edge-pipeline/`. `transformers` + `opencv-contrib-python` added.
- **2026-09-01** — Subject mask wired into the engine: `src/chroma/mask.rs` —
  `chroma_subject_mask` bridges the current frame → sidecar `/segment` → an `ai-subject`
  mask (RapidRAW's own type, so the grade UI + render are untouched). Box-drag on a loaded
  video now routes to SAM 2 + ViTMatte instead of ONNX SAM. `chroma_ai_health` for a UI
  hint. Engine + frontend both compile; app runs.
- **2026-09-01** — Per-frame subject **tracking**. Sidecar `/track` (background job,
  mattes cached to `<video>/.chroma/mattes/<key>/`), `/refine_track` (upgrade one frame to
  ViTMatte). Engine: `chroma_track_subject`, `chroma_track_status`,
  `chroma_subject_matte_for_frame`, `chroma_refine_tracked_frame`. Frontend: "Track subject
  across clip" + "Finalize matte" buttons + seek swaps the frame's matte. **fast/quality
  modes** — guided-filter edge on the pass, full ViTMatte on the visible frame.
- **2026-09-01** — Tracking rewritten to **SAM 2 memory propagation** (**D-018**):
  `SAM2DynamicInteractivePredictor` (in the installed ultralytics — no new dep), prompt
  once, ~180ms/frame, every frame gets a matte. Gotchas: `conf≈0`, `obj_ids` 0-indexed,
  refine the loose prompt box to a YOLO person box first.
- **2026-09-01** — **B-002 fixed**: sidecar climbed to ~12 GB after repeated Re-track
  (fresh predictor per pass never returned to the MPS pool + concurrent stacking). `_GPU`
  lock serialises model calls; one reused predictor; `_free_gpu()` after every op; `/track`
  cancels a running pass. Plateaus ~1.3 GB now.
- **2026-09-01** — **D-014 done**: `render_core.rs` seam — the render fn takes
  `RenderCaches` (the 2 GPU-cache mutexes) instead of `tauri::State<AppState>`; added
  `init_gpu_context()` (surface-free). GUI render path byte-identical. Unblocks headless
  render + the control/MCP server (next).
- **2026-09-01** — Tracking display reworked (**D-019**): matte is read from disk **at
  render time** (`params.chromaTrackDir` → `tracked_full_mask` → `<dir>/<frame>.png`) in
  `generate_ai_subject_bitmap`, not swapped into `adjustments` per seek. Fixes the
  overlay-regen storm, the frozen timeline, and the frame/matte desync (offset red blob).
  Persists with the project — no re-track on reopen. Also fixed: `ChromaTimeline` root
  capture-phase `stopPropagation` was eating strip clicks. **Mask follows the frame
  perfectly in-app now.**
- **2026-09-01** — **Control server + MCP bridge (D-020) — v1**. `src/chroma/control.rs`
  (`tiny_http`, port 19788, spawned in `.setup()`) ⇄ Tauri events ⇄ new
  `src/hooks/useChromaControl.ts` (mounted in `Editor.tsx`). One shared grade/mask state:
  every MCP op calls the same store action the GUI buttons do (`setAdjustments`, the
  `useAiMasking` handlers, `chroma_seek`) — sliders move, history/undo work, `get_state`
  reflects manual edits. New `mcp/` dir: Python stdio MCP server, 11 tools
  (`get_state, set_primary, set_curve, set_color_grade, seek, list_masks, add_subject_mask,
  track_subject, set_mask_adjust, invert_mask, delete_mask`). Mutating ops return the
  rendered frame (`generate_uncropped_preview`) + histogram + adjustments. Verified end to
  end with `curl` and an MCP client against the C019 take (exposure moves the slider + the
  canvas; subject mask created on the video). Engine edits: `Cargo.toml` +1, `mod.rs` +1,
  `lib.rs` +6. `cargo check` clean.
- **2026-09-01** — Mask refinement decided (**D-023**): use RapidRAW's existing
  Add/Subtract/Intersect composition (works with SAM Subject too), NOT a +/− point
  mechanism. No point UI built. MCP gains `add_subject_mask(mode)`,
  `add_component(mask_id, type, mode)`, `set_submask_mode` — all through the same
  `createSubMask`/`updateSubMask` a slider uses. `ai/` + engine `points` support left
  unused.
- **2026-09-03** — **Full NLE, Phase 1 (D-086): real data model for track
  lock/hide, clip transform, and rearrange.** `chroma_timeline::Track`
  gained `locked`/`hidden`; `Clip` gained `opacity`/`position_x`/
  `position_y`/`scale`/`rotation`/`chroma_keyframes` (reusing the existing
  D-034 keyframe engine, not a new one). New `Timeline::move_track` and
  `resolve_visible_video_layers_at` (the multi-layer generalization of the
  existing single-winner track resolver — the real query the Phase 2
  compositor needs). 58/58 chroma-timeline tests, 143/143 chroma:: tests
  unchanged. Phase 2 (the actual compositor) is next.
- **2026-09-03** — **Full NLE, Phase 2 (D-088): a real video track
  compositor exists now.** `chroma_timeline_frame` alpha-blends every
  visible video layer at a position (not just the top opaque winner) —
  real position/scale/rotation/opacity, keyframeable. CPU-based (real
  arbitrary-angle rotation, real alpha blending), no new dependencies. The
  single-track case is untouched, byte-identical. 7 new pure compositing
  tests, all passing on the first run.
- **2026-09-03** — **Full NLE, Phase 3 (D-089): TypeScript mirror of the
  lock/hide/rearrange/transform data model.** `packages/editor/src/
  timeline.ts` gains `Track.locked`/`hidden`, `Clip`'s transform fields, and
  new ops `set_track_locked`/`set_track_hidden`/`move_track`/
  `set_clip_transform`/`set_clip_keyframes` — `applyOp` mirrors Rust's
  `TrackLocked` refusal exactly (per-clip ops refused on a locked track,
  `move` checks both source and destination, track-list ops stay ungated).
  27 new vitest tests (68/68 across `packages/editor`), `tsc --noEmit`
  clean, `app`'s 64-error baseline unchanged. Phase 4 (UI) is next.
- **2026-09-03** — **Full NLE, Phase 4 (D-090): the UI — the P0 effort is
  done.** `TimelinePane.tsx` gains track header lock/hide toggles, up/down
  rearrange (native row-drag checked, buttons shipped instead — see D-090),
  a clip-transform popover (opacity/position/scale/rotation), and
  keyframing UI reusing `RelightPanel.tsx`'s Diamond-icon pattern via new
  `clipKeyframes.ts`. No new inline props into the timeline library's own
  render path (D-083 discipline held). 11 new tests (79/79 across
  `packages/editor`), `tsc --noEmit` clean both packages, clean app boot.
- **2026-09-03** — **React Compiler enabled (D-091).** `app/vite.config.mjs`
  now runs `babel-plugin-react-compiler` via `@rolldown/plugin-babel` +
  `reactCompilerPreset()` (the real v6 wiring, not the removed inline
  `react({ babel: {...} })` option) across every source package this build
  consumes. Verified via the compiler's own `logger.logEvent` API (bundle-
  grepping for its runtime import/function names is unreliable post-bundle/
  minify — chased that dead end first): 265 `CompileSuccess` events across
  110 unique files, 120 legitimate bailouts (mostly `try/finally`, a
  documented compiler limitation) across 45 files, no build errors. A quiet
  bailout-only `console.warn` logger stays wired in permanently for ongoing
  visibility.
- **2026-09-03** — **`app/bench` UI perf harness revived, retargeted at the
  Edit-tab timeline (D-092).** Its old `scroll`/`open`/`edit` phases
  targeted RapidRAW's library grid/editor sliders, removed by the D-043 DAM
  strip-out — replaced with `pan`/`dragover`/`move` phases against the
  multi-track timeline. `dragover` directly stress-tests the D-083 freeze
  scenario (sustained native `dragover` ticks over the timeline), the most
  relevant probe for whether the new React Compiler (D-091) helps. Also
  added `docs/notes/performance-instrumentation.md`, inventorying every
  other real timing mechanism already in the codebase (Rust
  `Instant::now()`/`log::info!`, sidecar `time.time()` + `GET /memory`).
  Honestly flagged, not faked: no tool this session can drive the native
  Tauri window, so no compiler-on/off numbers were captured — the script's
  ready, running it by hand is the next step.
