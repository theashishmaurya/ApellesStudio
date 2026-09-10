# @apelles/editor

**The Edit tab** (D-039 / D-041; timeline switcher + drag-to-track D-046). A
single-video-track timeline of the open project's shots — scrub + play with a
live preview, reorder / trim / split / remove edits, and add a clip by
dragging a pool item in from the shell's Sources panel.

- `EditorTab` — the tab: preview pane (top) + `TimelineSwitcher` +
  `@xzdarcy/react-timeline-editor` strip (bottom), or an empty state when no
  project is open. The transport (`SkipBack` / `Play`–`Pause` / `SkipForward`)
  uses `lucide-react` icons; the timeline toolbar (`Scissors` split, `Trash2`
  remove) and the empty-state action are `@apelles/ui` `<Button>`s, the toolbar
  buttons wrapped in `@apelles/ui` `<Tooltip>` (D-042).
- `TimelineSwitcher` (D-046) — a `@apelles/ui` `<Select>` of the project's
  timelines (D-045's `chroma_timeline_list`) with the active one checked,
  switching via `chroma_timeline_set_active`, plus inline "+ New" →
  `chroma_timeline_create`. No rename/delete UI (no backing commands).
- `useEditorTimelineStore` — zustand store: `timeline`, `playhead`, `playing`,
  `timelines` (D-046), `openProjectKey` + `setOpenProject()` (B-034/D-112's
  readiness signal, made the open project's *identity* rather than a boolean by
  B-083/D-203 — a changed key is a real project switch and reloads everything),
  `load()`, `applyOp()`, `restoreSnapshot()` (D-051),
  `setPlayhead()`, `loadList()`/`createTimeline()`/`setActiveTimeline()`
  (D-046). Optimistic ops → debounced `chroma_timeline_set` →
  `chroma_timeline_get` refetch. Lives here for now; a `@apelles/bridge`
  extraction is a later task.
- `timeline.ts` — the model mirrored from the `apelles-timeline` Rust crate,
  the pure edit ops (including D-046's `add_clip`, purely client-side — no
  Rust op needed since `chroma_timeline_set` stores whatever is sent
  verbatim), `labelForOp` (D-051), and
  `CHROMA_MEDIA_DRAG_MIME`/`DraggedMedia`/`clipFromDraggedMedia` — the
  drag-to-track contract `TimelinePane`'s drop handler and the Sources
  panel's drag source both implement — plus (D-248)
  `CHROMA_GENERATOR_DRAG_MIME`/`DraggedGenerator`/`clipFromDraggedGenerator`,
  the same contract for a *generated* clip (a title, an adjustment clip)
  dragged out of the docked library panel (D-263).
- `dndTargets.ts` (B-122) — the `@dnd-kit` payload contract: named types for
  every drag source and drop target sharing `TimelinePane`'s one `DndContext`,
  plus the four functions that narrow an untyped `data.current` into something
  safe to use. It exists because two different droppables once shared the
  discriminator `'track'` — the sortable track HEADER (`{ type, index }`) and
  the row LANE (`{ type, track }`) — and six inline `as` casts each promised
  the shape they wanted, so a clip dropped on a header read as a lane drop with
  `track: undefined` and crashed the app. These validate at runtime and fold
  the bounds check in, so a caller cannot receive a track index that does not
  name a real track. No DOM, no React, no store.
- `marquee.ts` (D-137) — marquee-select's pure half: whether a `pointerdown`
  may start a rubber-band at all (`canStartMarquee` /
  `MARQUEE_BLOCKING_SELECTOR`), the activation threshold, the
  clip-box-vs-rect intersection, how the result composes with the existing
  selection, and the pixel↔timeline conversions the overlay paints from. No
  React, no DOM, no `window` — `TimelinePane` owns the wiring. See
  **Marquee-select** below.
- `dragGhost.ts` (B-137/D-279) — which slice of a clip its cursor-follow drag
  ghost shows, and how far into the clip that slice starts. `DragOverlay`
  anchors the ghost at the dragged clip's own rect while the ghost's width is
  capped, so on any clip wider than the cap the ghost used to sit at the clip's
  head, far from the pointer. One pure function of on-screen pixels — no DOM,
  no React, no dnd-kit types; `TimelinePane` feeds it a measured press and uses
  the answer for both the overlay's `Modifier` and the ghost's own
  filmstrip/waveform window.
- `clipFade.ts` (D-205) — the pure half of the timeline's on-clip fade
  handles: a fade duration in the clip's own **source** frames ↔ its on-screen
  width at the current zoom (via `timeline.ts`'s
  `sourceFramesToTimeline`/`timelineFramesToSource`, so a mixed-native-fps clip
  is right — B-077), the handle's drag clamp, and the SVG paths that draw each
  ramp at its real `FadeCurve` shape. It never evaluates a fade's *gain* —
  that is `apelles_types::fade_gain` and its one mirror,
  `timelineExportAudio.ts`'s `fadeGainAt`. `ClipFadeOverlay.tsx` is the
  DOM/pointer wiring around it. See **On-clip fade handles** below.
- `speedRamp.ts` (D-236, roadmap item 27) — the speed ramp's whole model and
  math: `Clip.speed_points` ("from this SOURCE frame onward, play at this
  speed") resolved into concrete constant-speed segments, the clip's retimed
  output length, and **both directions of the time remap** — the inverse
  (`sourceFrameAtOutput`, what the preview decodes with) and the forward
  (`outputAtSourceFrame`, what the exporter's `setpts` expression is built
  from). Also the two ffmpeg compilations that follow from it: the nested
  `if(lt(T,…))` `setpts` body, and the per-segment windows
  `timelineExportAudio.ts` turns into `atrim`/`atempo`/`concat`. An exact
  mirror of Rust's `apelles_timeline::speed_ramp`, and load-bearing in the way
  `eq.ts` is: the two files ARE the preview/export agreement for this feature,
  so they are kept line-for-line comparable and pinned by `speedRamp.test.ts`
  plus a real-decoded-pixel test (`speedRamp.ffmpeg.test.ts`). A flat speed is
  a one-segment ramp — the pre-D-236 export-time `speedOverrides` resolves
  through the same function and still compiles the identical filtergraph.
  `SpeedRampEditor.tsx` is the Inspector section around it.
  **Reverse (D-241)** is a NEGATIVE speed, per run: one `anchor` term (a
  reversed run's output starts at its source END) generalises both maps, and
  `quantizedSourceFrameAtOutput` carries the rounding, which mirrors from
  `floor` to `ceil - 1` when the direction of travel does. It compiles to a
  different filtergraph *shape*, not a different expression — `trim`/`reverse`/
  `concat` per run (`buildReversibleRampSteps` in `timelineExport.ts`) and
  `areverse` + `atempo=|s|` for the sound — because a negative `setpts` slope
  is a graph ffmpeg runs happily and which reverses nothing. Pinned by
  `speedRampReverse.ffmpeg.test.ts`. **Does not** do smoothed S-curve
  transitions or frame interpolation — see D-236's "not built" list, as
  narrowed by D-241.
- `editTypes.ts` + `EditOverlay.tsx` (D-239, roadmap item 27) — **the seven
  edit types on drop**: Insert / Overwrite / Replace / Fit to Fill / Place on
  Top / Append at End / Ripple Overwrite. `editTypes.ts` is pure metadata — the
  seven names, Blackmagic's own one-line description of each, their order (which
  IS the overlay's hit-test geometry), and `editTargetIndexAt`, the pointer→row
  resolution. It deliberately imports **nothing** from `timeline.ts`, which is
  what lets `timeline.ts` import `DropEditType` from it without a cycle.
  `EditOverlay.tsx` is the GUI: a strip of seven labelled targets down the right
  of the preview, raised by a Sources drag, taken from Resolve's own edit
  overlay (`scratch/resolve-reference/timeline.jpg`, the file the roadmap line
  names). The semantics are ONE `edit_in` `EditOp` in `timeline.ts` with the
  rest — one op per edit, so one undo entry, named for the type (the D-129
  precedent: a chained two-op Insert would take two Undos and leave its razor
  cut behind after the first). The precondition check is deliberately in two
  halves, both in `timeline.ts`: `checkEditTarget` answers everything that does
  not need the incoming source (track locked, is there a target under the
  playhead, B-033's straddle guard) and is what the overlay can ask *mid-drag*,
  when the HTML5 payload is still unreadable; `checkEditIn` is that plus the two
  source-length questions, and is what `applyOp` and `editor_edit_in` run — the
  `checkTransition`/`checkLink` shape again. The timeline's own
  positional drop (D-095/D-100) is untouched: two gestures, two questions.
  **Does not** do per-A/V destination-track patching, keyboard shortcuts or the
  toolbar buttons — see D-239's own "not built" list.
- `eq.ts` (D-224, roadmap item 27) — the per-clip parametric EQ's model and
  math: the `EqBand` type `Clip.eq_bands` is a list of, the Resolve-shaped
  four-band strip the Inspector authors (`defaultEqBands`), the stored-value
  clamps, and the Audio EQ Cookbook biquad coefficients + magnitude response
  (`eqBandCoeffs` / `eqResponseDb`). An exact mirror of the Rust
  `apelles_types::eq` — mirrored here for `panGains`' own reason (the export
  compiler is TypeScript and its unit tests must be able to compute what it
  should emit with no app process at all), but load-bearing in a way that one
  is not: `timelineExportAudio.ts`'s `eqFilterChain` ships these very numbers
  to ffmpeg's generic `biquad` filter, so a drift from the Rust would be a real
  preview-vs-render divergence. The two are pinned by one shared response table
  that each side measures through its own engine. `timeline.ts` re-exports the
  type and the helpers, so nothing else has to know which file they came from.
- `eqCurve.ts` + `EqResponseGraph.tsx` (D-237, roadmap item 27) — the response
  graph D-224 deliberately deferred: Resolve's ±24 dB / log-frequency plot,
  with a numbered, draggable point per band and the combined response drawn as
  a filled/stroked line, rendered above the Inspector's four EQ band blocks.
  `eqCurve.ts` is the pure geometry (log-frequency/±24 dB screen mapping, the
  sampled curve, a band's own point, drag-to-patch, the scroll-wheel-to-Q
  mapping) — it computes no response value itself, importing `eqResponseDb`
  from `eq.ts` rather than re-deriving it, the same pure/wiring split
  `curveEditor.ts` + `ClipCurveEditor.tsx` use. `EqResponseGraph.tsx` is the
  component: pointer drag for freq/gain (overlay-draft-then-commit-on-release,
  this package's own established convention), scroll wheel for Q (debounced to
  one commit per gesture). Writes through the same `onEqBandChange` the
  Freq/Gain/Q `PropertyRow`s already do — no new MCP surface, since
  `editor_set_clip_eq` already reports the same `responseDb`.
- `TimelineMarkers.tsx` (D-222, roadmap item 27) — timeline markers: the flag
  strip drawn in the band between the ruler's ticks and track 0 (Resolve's own
  placement), the marker editor popover, the jump-to dropdown and the toolbar's
  add button. `MARKER_STRIP_HEIGHT` is exported from here and is the single
  definition of that band's height — `TimelinePane`'s `RULER_AND_MARGIN_PX`
  derives from it, and `timeline-overrides.css` reads it through the
  `--chroma-marker-strip-height` custom property `TimelinePane` sets. The model
  and ops (`Marker`, `MARKER_COLORS`, `newMarker`, `resolveMarkerColor`,
  `markersOf`, and the `add_marker`/`remove_marker`/`set_marker` `EditOp`s) are
  in `timeline.ts` with everything else; markers are real, persisted, undoable
  document content, unlike the store-only `selection` (D-216) and `previewView`
  (D-218). The strip carries `data-chroma-no-marquee` — `marquee.ts`'s own
  documented escape hatch — so no gesture here can collide with the marquee.
- `TimelineTransitions.tsx` (D-226/D-227, roadmap item 27) — the transitions
  library: the toolbar's browsable palette (a real `@dnd-kit` drag source — a
  third drag kind sharing `TimelinePane`'s one `DndContext` alongside
  `track-header` and `clip`, disambiguated by `data.type` as those two already
  are — see `dndTargets.ts` and B-122 for why that discriminator has to be
  genuinely unique per payload SHAPE, not per conceptual thing), the
  hatched badge drawn on a track across a transition's own window, and the
  popover carrying its type / duration / alignment / dip colour / Remove. The
  model and ops (`Transition`, `transitionWindow`, `transitionHandles`,
  `cutFrames`, `checkTransition`, `newTransition`, and the
  `add_transition`/`set_transition`/`remove_transition` `EditOp`s) are in
  `timeline.ts` with everything else. A transition belongs to the EDIT POINT
  between two clips, not to either of them, which is why its badge is drawn in
  `TimelinePane`'s own overlay layer rather than inside a clip's
  `getActionRender` body. `checkTransition` is the single precondition the drop
  gesture, the popover and the `editor_*_transition` MCP tools all go through —
  the `checkLink` (D-138) shape, so a refusal message can never drift from what
  `applyOp` actually enforces. Design: `docs/notes/transitions.md`.

**Marquee-select (D-137, roadmap item 12 Phase 2).** Click-drag on empty
timeline canvas draws a rubber band; every clip whose bounding box the rect
intersects becomes the selection, with shift/cmd/ctrl (read once, at
`pointerdown`) unioning onto the existing selection instead of replacing it.
**The boundary that matters is with the `@dnd-kit/core` clip drag** (D-098 /
D-100), since both gestures begin with a `pointerdown` in the same edit-area
subtree: they are mutually exclusive **by DOM position**, not by precedence or
ordering. `ClipBody` — the one `useDraggable` node inside the edit area, and so
the only place dnd-kit's `PointerSensor` activator lives there — carries
`data-chroma-clip-drag`, and `canStartMarquee` refuses any press with that
attribute on its propagation path. Nothing relies on handler order or
`stopPropagation`. The rect is held in timeline units (frame + fractional
track row), so a scroll or ctrl-wheel zoom mid-drag moves and rescales the band
with the content it encloses. `marquee.test.ts` covers the intersection math,
the threshold, the modifier composition and the gesture guard.

**On-clip fade handles (D-205).** Every clip on the timeline — video track and
audio track alike, because one fade pair drives picture and sound together in
this model — draws its `fade_in_frames`/`fade_out_frames` as a rubber band
across its own body, at the ramps' real `FadeCurve` shape (an SVG cubic *is* a
`cubic-bezier`, so no solver and no sampling), with a small handle at each
ramp's top that drags to set the fade. **It is a view of the stored field, not
a second state**: a completed drag commits one
`applyOp({kind:'set_clip_fade', …})` — the same op, undo stack and debounced
persist `EditorInspectorPanel.tsx`'s numeric Fade field already used — so the
two views cannot disagree. Live overlay-only feedback during the drag and one
op on pointer-up is the `TransformOverlay`/D-046 convention (`applyOp`
snapshots the whole timeline per call). Against the **third** gesture on a clip
body, the timeline library's own full-height 10px edge-trim handles, the fade
handle is separated by *where in the row* the press lands — a 15px-tall grab
target at the clip's top edge, leaving the lower ~37px of both trim zones
untouched, which is how Resolve stacks the same two affordances. Against the
dnd-kit clip drag it is a distinct hit target that `stopPropagation`s, as
D-094's grip handle was. The drag clamps to the clip's own length; the *model*
still permits a longer-than-clip fade (`set_clip_fade` deliberately does not
clamp), which renders honestly and parks its handle at the far edge.
`clipFade.test.ts` covers the geometry, `TimelinePane.fade.dom.test.tsx` the
gesture and its committed effect, and `timelineExport.ffmpeg.test.ts` proves a
drag-derived fade really exports faded.

**Undo/redo (D-051).** Every real (non-no-op) `applyOp` call pushes one
`{tab:'edit', label: labelForOp(op, before), undo, redo}` entry onto
`@apelles/history`'s shared stack — whole-`Timeline` snapshots (`before`/`after`),
not inverse deltas, since every op here already round-trips through a
whole-document `chroma_timeline_set`. `undo()`/`redo()` call
`restoreSnapshot()`, which sets state to the given snapshot, cancels any
pending debounced save, and persists + refetches immediately (no debounce —
undo/redo are discrete actions). Shell-level Cmd/Ctrl+Z / Cmd/Ctrl+Y
(`@apelles/shell`) is the only way this fires; there's no Edit-tab-local
undo keybinding. `src/timeline.test.ts` (vitest) covers `labelForOp`.

Backed by the `apelles-timeline` crate and the `chroma::edit` Tauri commands
(`chroma_timeline_get` / `_set` / `_frame` / `_list` / `_create` /
`_set_active`). The preview is a standalone decode→jpeg (`chroma_timeline_frame`)
— **not** the Colorist's graded wgpu path.

**Two clocks, and which one a backend read follows (B-088 / D-202).**
`chroma_timeline_frame` (and every other backend renderer of this timeline) is
handed no timeline: it composites the project's **persisted** manifest. But
`applyOp` updates `timeline` optimistically and persists it on a 400 ms
debounce, so for that window the in-memory object and the document the backend
renders are two different things. `savedVersion` is the backend's clock —
bumped only when a `chroma_timeline_set` resolves or a `chroma_timeline_get`
lands. **Anything that re-invokes a backend read of the timeline must depend on
`savedVersion`, never on `timeline`'s identity**; doing the latter is B-088,
where the preview fetched a frame ~400 ms before the edit existed backend-side
and then never fetched again. `PreviewPane` is currently the only such
consumer.

**Drag-to-track (D-046).** `TimelinePane` accepts a plain HTML5
`dataTransfer` drop carrying `CHROMA_MEDIA_DRAG_MIME` JSON (from the shell's
Sources panel, `app/src/components/chroma/SourcesPanel.tsx` — not a package
this one depends on) and turns it into an `add_clip` op. Plain browser DnD
rather than a shared `DndContext`/store, because the Sources panel is docked
at the shell level and D-039's layer direction forbids the shell depending on
a tab package to share one. This also scopes the drop to "only while the Edit
tab is active" for free — an inactive tab's content is `hidden`
(`display:none`), which is never a valid drop target. `TimelinePane` also
handles a *track-less* timeline (`tracks: []`, what `chroma_timeline_create`
makes) with its own empty-state drop zone; the first drop creates the video
track.

Two things changed here in the same pass as the owner's live Edit-tab review:

- **A generated clip is a drag source too (D-248, fixing B-117; docked by
  D-263).** The Edit tab's left library is an activity bar in the VS Code /
  Final Cut sense (`scratch/activity-bar-reference/`): `EditLibraryRail.tsx` is
  the leftmost column — four icon buttons, Sources / Titles / Effects /
  Subtitles — and `EditLibraryPanel.tsx` is what the DOCKED column beside it
  shows for the three this package owns (the fourth, Sources, is the shell's
  shared media pool). Both are mounted by the composition root into
  `@apelles/shell`'s per-tab `libraryRail`/`libraryPanel` slots (D-251's
  injection pattern), never by `EditorTab` — the rail has to sit to the LEFT of
  a column `Shell` owns, and `Shell` must not import this package. Each library
  entry carries a draggable Title/Adjustment clip that puts
  `CHROMA_GENERATOR_DRAG_MIME` on the `dataTransfer`; `TimelinePane`'s existing
  `onDragOver`/`onDrop` recognise it alongside the media MIME and route it
  through the SAME `placeDroppedClip` the Sources drop uses, so a dragged title
  snaps, ripples and creates a track by exactly the media path's rules. Every
  entry is also still a click-to-add-at-the-playhead button (Final Cut keeps
  both gestures too). Which library is showing is `libraryMode` in the store;
  whether the column is open at all is the shell's own `sourcesPanelOpen`,
  which the rail drives through props rather than importing. The transitions
  palette stays in the timeline toolbar — its target is a *cut*, resolved
  through that pane's own `DndContext` (D-226).
- **Above the top track is a real insertion boundary (B-115).**
  `trackInsertBoundary` used to refuse every `y < 0`, so "drop it above your
  video tracks" — the reference gesture for a title or an adjustment clip —
  quietly landed on the existing top track (native drop) or cancelled
  (dnd-kit clip drag). The top is now the mirror of the bottom: both outer
  boundaries are unconditional, the inner ones still need the band. The
  dnd-kit path additionally requires the gesture's real pointer to be inside
  the edit area, so "dropped somewhere else entirely" still cancels.

- **Every numeric Inspector field is dragged, not spun (B-113 / D-253).**
  `PropertyRow.tsx` and every other numeric field here render `@apelles/ui`'s
  `ScrubbableNumberInput`: no native spin buttons anywhere (WebKit painted them
  over the digits, and B-113's `pr-5` reserve could never have cleared them —
  the widget is laid out inside the padding box), and horizontal drag on the
  field in their place — 8px per declared `step`, Shift ×10, Cmd ÷10, 4px
  before a press counts as a drag rather than a click. `numericField.ts` is now
  only the Inspector row's *geometry* (`NUM_FIELD`, the fit budget); the
  display-rounding helpers it used to own are `@apelles/ui`'s, next to the
  component that needs them. The gesture's behavioural tests live in this
  package (`ScrubbableNumberInput.dom.test.tsx`) because `@apelles/ui` has no
  test tier and this one owns the real-`PointerEvent` harness.

**Deferred** (later tracked steps): multi-track, audio, transitions, transcript
cut, GPU compositing, grade-in-preview, OTIO export, MCP, timeline
rename/delete. See `docs/notes/editor-mvp.md`.
