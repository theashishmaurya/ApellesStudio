# Timeline lanes: replacing `@xzdarcy/react-timeline-editor` (D-437 build plan)

Status: **plan, 2026-11-01. Built so far: S0, S1, S2, S3a, S3b, S4, S5, S6 — `TimelinePane` renders the lanes and our playhead since S4; the library package and its selectors are gone (S5, S6). See each step's "Built" note.** Decision: D-437 (`docs/08-decisions.md`).
Evidence: `docs/notes/timeline-drag-perf.md` (B-347), the live harness runs under
`scratch/ui-harness/runs/` (run 4: `2026-10-31T21-00-23-799Z`). Builds on D-432 P2/P3
(`docs/notes/ui-redesign.md` §6b, §6c) and the harness (`docs/notes/ui-harness.md`).

What this note is: the inventory of everything the library still does, the target design
of Apelles' own lane renderer, the selector map that keeps the 55 harness scenarios
passing, the perf targets and how each is measured, and a commit-by-commit step plan sized
for Sonnet builders. It covers the timeline **edit area only**. P5 (layout around the
timeline, toolbar row) and P4 (Inspector) run in parallel and are not touched.

## 0. Where the time goes now (run 4) and what that changes in this plan

Run 4 (dev bundle, Apelles in front, 3-clip fixture), after F1–F4:

| measure | run 3 | run 4 |
|---|---|---|
| preview p50 / p95 (our JS per move) | 0–4 ms | 0 / 1 ms |
| `commitRenderedMs` (release, React) | 60–101 ms | **14–18 ms** (F4's identity) |
| `commitPaintedMs` | — | **48–58 ms** |
| move-phase p95 / worst / dropped | — | 30–43 / 38–92 ms / 12–22 % |

Two conclusions shape the plan:

1. **During a move, our JS is ~1 ms, yet frames are 30–43 ms at p95 on 3 clips.** That
   cost is the browser's per-frame style, layout, paint and composite (plus whatever else
   runs on the main thread), not React. The dev bundle does not explain it: no React render
   happens during a move, so StrictMode and React's dev Performance Tracks do nothing
   there. **Expect most of it to ship.** The lane design therefore has paint isolation as a
   first-class requirement (§2.9), and the first step measures paint before anything is
   rebuilt (step S0).
2. **`commitPaintedMs` does not measure paint yet.** `perfMeasureAfterPaint`
   (`packages/editor/src/editPerf.ts:43-46`) measures from the commit mark to the next
   `requestAnimationFrame` callback. rAF callbacks run at the *start* of a rendering update,
   before that frame's style, layout and paint. So the 34–40 ms gap between "rendered" and
   "painted" is: the wait to the next frame boundary (0–16.7 ms) + main-thread work queued
   between the commit and that frame (passive effects; `Waveform`/`Filmstrip` effects
   re-requesting peaks/tiles because widths changed; store subscribers such as the history
   push and the debounced persist; the viewer reacting to the new timeline) + a previous
   rendering update that was still running. It does **not** include the paint of the
   committed DOM. S0 fixes the metric (rAF, then a `MessageChannel` task, which runs after
   that frame has rendered) and adds `commit-effects` and `commit-frame` marks so the gap is
   split into parts.

**Dev bundle vs real, per phase (until S0's production-bundle run gives real numbers):**
- **Move phase:** dev contributes ≈ 0 (no React work). The 30–43 ms is real.
- **`commitRenderedMs` 14–18 ms:** this includes StrictMode's double render and the dev
  Performance Tracks (~22 % of release time in the 200-clip profile). Production is likely
  **~7–12 ms**. This is an estimate.
- **Rendered → "painted" gap (34–40 ms):** mixed. Passive effects and other tasks are
  partly JS (dev-inflated). The frame-boundary wait is not. The paint of the commit is not
  in this number at all. Unknown until S0 splits it.

A second gap: the `apelles:edit:*` marks are gated on `import.meta.env.DEV`
(`editPerf.ts:25`), so a `tauri build --debug` app (production React) writes none, and the
harness reports `null` exactly where we need production numbers. S0 moves the gate to a
compile-time define that is on in dev and in the debug-tauri build and off in a release
build (still debug-only, per CLAUDE.md).

## 1. Inventory: what the library does today

`TimelinePane.tsx` line numbers are at `main` 63ec5c1.

### 1.1 Rendering and layout

| responsibility | where | notes |
|---|---|---|
| Import + bundled CSS | `TimelinePane.tsx:269-271` | `Timeline as TimelineEditor`, `TimelineState`, `TimelineRow`/`TimelineAction` from `@xzdarcy/timeline-engine`, `react-timeline-editor.css` |
| Rows = tracks, actions = clips | `buildRows` `:583-626`, `editorData` `:1540-1543`, `effects` `:1545` | `row.id = String(trackIndex)`, `rowHeight` per row (P3), `flexible:false`, `movable:false`, `start/end` in seconds |
| Clip content | `getActionRender` `:2301-2419` | renders our `ClipBody` → `ClipBlock`, `ClipFadeOverlay`, the two trim zones. **No memo**: every action of every rendered row re-renders on any `editorData` change |
| Clip wrapper box | library `.timeline-editor-action` | absolutely positioned `left`/`width`/row height; our CSS makes it transparent and `contain: layout size style` (`timeline-overrides.css:16-35`) |
| Row container | library `.timeline-editor-edit-row` | queried by `TimelinePane.clipDrag.dom.test.tsx:156` |
| Content width | library `Yl()` (bundled `index.es.js:6003`) | `scaleCount = max(minScaleCount 20, ceil(maxEnd / scale) + 5)`; width = `startLeft + scaleCount × scaleWidth`. `scale = tickSeconds`, `scaleWidth = tickSeconds × pxPerSec` (`:3384-3385`) |
| `startLeft` 32 px before frame 0 | `START_LEFT_PX` `:515-522`, prop `:4100` | every x↔frame conversion uses it |
| Vertical virtualisation | inlined react-virtualized `Grid` + `AutoSizer` | rows outside the viewport are not mounted. AutoSizer measured 0×0 in a hidden tab, hence `measureEpoch` as the library's `key` (`:1196`, `:4092`, `useViewportWidth.ts`, B-267) |
| Ruler | hidden (`timeline-overrides.css:61-64`): its height still sets where the edit area starts | our `TimelineRuler.tsx` draws over it (P3, B-350). **Stays.** |
| Marker-strip gap | library `.timeline-editor-edit-area { margin-top }`, widened to `MARKER_STRIP_HEIGHT` (`timeline-overrides.css:138-140`, `TimelineMarkers.tsx:81-88`) | `RULER_AND_MARGIN_PX = RULER_HEIGHT_PX + MARKER_STRIP_HEIGHT` (`:514`) |
| Grey action backing, blurry blue cursor | overridden in `timeline-overrides.css` | all of this CSS file except the `[data-chroma-clip-drag]` cursor rule and `[data-chroma-edit-gesture] *` exists only for the library |

### 1.2 Scroll and zoom

| responsibility | where | notes |
|---|---|---|
| The scroll container | library `.timeline-editor-edit-area` (Grid div, `overflow: overlay`) | `TIMELINE_LIBRARY_SELECTORS.scroller` (`timelineTestIds.ts:156`) |
| Scroll position → React | `onScroll={onTimelineScroll}` `:4105`, handler `:2465-2477` | `setScrollTop`/`setScrollLeft` **re-render the whole pane every scroll frame**. Also B-326's "user scrolled during playback" detection |
| Imperative scroll writes | `editorRef.current.setScrollLeft` `:1079` (playback follow, B-326), `:1175` (zoom anchor, B-116) | the library keeps scroll in a `ScrollSync` state and in the Grid; two copies that echo each other caused B-291's update loop (`:1152-1169`, `TimelinePane.zoomScrollLoop.dom.test.tsx`) |
| `scrollRef` mirror | `:896`, `:1186-1188` | read by handlers bound once (dnd, follow) |
| Zoom | `zoomBy` `:3336-3367`, wheel `:1122-1137`, anchor layout effect `:1170-1180` | ctrl/pinch wheel is ours already. The anchor must be applied after the new content width exists (library derives it from `scaleWidth`) |
| Viewport width | `useViewportWidth(editArea)` `:1196` | ResizeObserver on the edit-area wrapper |
| Header column vertical sync | `style={{ top: RULER_AND_MARGIN_PX - scrollTop }}` `:3918-3922` | React state per scroll frame |
| Library auto-scroll during an action drag | `autoScroll` `:4102` | inert: no action is movable or flexible. dnd-kit's own autoscroll scrolls the nearest scrollable ancestor |
| `dragLine` | `:4103` | inert (action-drag alignment lines) |

### 1.3 Playhead

| responsibility | where | notes |
|---|---|---|
| Line + head + grab band | library `.timeline-editor-cursor` / `-cursor-top` (inline SVG) / `-cursor-area` | restyled and cut down by `timeline-overrides.css:42-56, 71-90, 113-119` (B-346, B-349) |
| Position | `editorRef.current.setTime(frame / fps)` `:1056`, `:1066` from a raw store subscription (D-325: the pane must not subscribe to `playhead`) | the library re-renders its cursor component on each `setTime` (its own `useState`) |
| Drag = scrub | `onCursorDragStart/Drag/DragEnd` `:4115-4126` (interact.js on the cursor) | start: `setPlaying(false)`, `setPlayhead`, `beginScrub`. Drag: beat-snapped `setPlayhead` + `updateScrub`. End: `endScrub`. Unmount safety: `useEffect(() => endScrub, [])` `:1088` |
| Edge autoscroll while scrubbing | library `deltaScrollLeft` (with `autoScroll`) | must be reproduced (§2.6) |

### 1.4 Input and gestures that touch library DOM

| responsibility | where | what it reads |
|---|---|---|
| Clip click → selection (plain / Shift range / Cmd toggle) | `onClickAction` `:2431-2463`, prop `:4107` | the library calls it with `{action,row}` from a click on the action wrapper |
| Empty-space click → seek + gap select / clear | edit area `onClick` `:4051-4089` | `closest('.timeline-editor-action')` `:4064` |
| Clip grab rect for the drag ghost (B-137) | capture `pointerdown` `:1332-1360` | `closest('.timeline-editor-action')` `:1341` |
| Hover trim-mode badge | `trimModeAtPointer` `:1375-1405` | `closest('.timeline-editor-action')` `:1378`, then the body inside it |
| Marquee guard | `marquee.ts:84-88` (`MARQUEE_BLOCKING_SELECTORS`) | `.timeline-editor-action`, `-time-area`, `-cursor`, `-cursor-area`, `-edit-row-drag-handle` |
| Edit gesture (P2) | `useEditGesture.ts` | **no library DOM**: finds bodies with `[data-testid="timeline-clip"][data-chroma-clip-id]` (`:130`, `:206`, already tolerates a missing body: "scrolled out of the rendered range"), writes `transform`/`width` on the body and `transform` on `[data-chroma-clip-media]`. Geometry from `EditGestureView` (`:83-109`) |
| dnd-kit clip move | `ClipBody` `useDraggable` `:668-740`, `TrackDropZone` `:786-814`, `DndContext` `:3497`, handlers `:2941-3200` | no library DOM. The draggable node must stay mounted for the whole drag |
| Native HTML5 drop from Sources / library rail | `onDragOver`/`onDrop` on the `ResizablePanelGroup` `:3903-3905`, `xToFrame` `:1937`, `dropTargetTrack` `:1984` | edit-area rect + `scrollLeft`/`scrollTop` state + `RULER_AND_MARGIN_PX` |
| Height drag (P3) | `startTrackHeightDrag` `:2867`, lane zones `:4316-4338` | overlays in edit-area coordinates |
| Skimmer (P3) | `:2690-2740` | edit-area rect + `skimViewRef.scrollLeft` |
| Keyboard focus | dnd-kit `attributes` on `ClipBody` (`role="button"`, `tabIndex=0`) | a focused clip must not be unmounted by culling |

### 1.5 Overlays (already ours, in edit-area coordinates: `x = START_LEFT_PX + sec × pxPerSec − scrollLeft`, `y = RULER_AND_MARGIN_PX + rowTops[i] − scrollTop`)

`TimelineRuler` `:4132`, trim badge `:4172`, gap selection `:4193-4217`,
`TransitionBadges` `:4225` (`TimelineTransitions.tsx:161`, per-badge `left` `:203-221`), row
lines `:4247-4253`, `TimelineDragPreview` `:4273`, marquee `:4302`, `TrackDropZone`s
`:4309`, lane height zones `:4316`, height guide `:4341`, `BeatLane` `:4360`,
`MarkerStrip` `:4370` (drag already writes `translate3d`, `TimelineMarkers.tsx:214-267`),
skim line `:4395`, `EditFeedbackLayer` `:4405` (already `translate3d`,
`EditFeedbackLayer.tsx:73`), `ClipCurveEditor` `:4417` (takes `scrollLeft`). All of these
take `scrollLeft`/`scrollTop` as props, so every scroll frame re-renders them.

### 1.6 Selectors and tests that name the library

- `timelineTestIds.ts:144-157` `TIMELINE_LIBRARY_SELECTORS` (playhead, playheadHandle,
  playheadBand, action, scroller), pinned against the installed CSS by
  `timelineTestIds.test.ts:19-29`.
- Harness: `ui-harness/src/targets.ts:16, 65-72` (`playheadGrab` = `LIB.playheadBand`),
  `scenarios/timeline.ts:82, 86, 657, 662` (`LIB.playhead` watched for `live` x),
  `runner.test.ts:430`.
- DOM suites querying library classes: `TimelinePane.seek` `:134`, `.clipDrag` `:156`,
  `.trim` `:317-490` (`closest('.timeline-editor-action')` ×11), `.trimTools` `:432-460`,
  `.zoomedOut` `:138`, `.clipBlock` `:242`, `.cssOverrides` `:100-118`,
  `.zoomScrollLoop` (B-291: a library-only loop), `.playheadCost` / `.mountCost` (comments
  and budgets premised on the library), `timelineOverrides.test.ts` (text pins on the
  override CSS), `marquee.test.ts:80-115`, `testUtils/pointerHarness.ts:243, 282` (rects
  derived from the library's inline `left`/`width`, which our slot keeps).
- Comments only: `scrubAudio.ts:7`, `clipVisibility.ts:13`, `clipFade.ts:45`,
  `useCanvasClipPick.ts:35`, `ClipFadeOverlay.tsx:55`, `Waveform.tsx:5`, `ruler.ts:9,32`,
  `TimelineMarkers.tsx:84`, `packages/README.md:15`, `packages/editor/README.md:9`.
- `packages/editor/package.json:27` (`@xzdarcy/react-timeline-editor ^1.0.0`; it brings
  `@xzdarcy/timeline-engine`, `interactjs`, `react-virtualized`, `framework-utils`).

### 1.7 Not present (checked)

- **Nested tracks / compound clips:** none. `Timeline.tracks` is a flat array and a track
  holds a flat `clips` array (`timeline.ts`). A track is one lane.
- **Overlapping clips on a track:** not assumed impossible. Track `clips` order is
  bookkeeping, not time (D-054). The culling index sorts by `start_frame` and tolerates
  overlap (§2.4).

## 2. Target design

### 2.1 Component tree and DOM

New directory `packages/editor/src/lanes/` (its own README section in
`packages/editor/README.md`, a header comment per file):

```
TimelinePane (unchanged role: state, handlers, overlays, toolbar)
└─ edit area  [data-testid=timeline-edit-area]  (relative, overflow hidden; view attrs as today)
   ├─ TimelineRuler                      top 0, 24 px              (unchanged)
   ├─ BeatLane, MarkerStrip              top 24, MARKER_STRIP_HEIGHT (unchanged)
   ├─ TimelineLanes                      lanes/TimelineLanes.tsx
   │  └─ scroller [data-testid=timeline-scroller]  absolute, top RULER_AND_MARGIN_PX, l/r/b 0,
   │     │                                          overflow auto (native, both axes)
   │     └─ content  (relative; width = contentWidth, height = max(rowsHeight, viewport))
   │        └─ TrackLane × tracks        lanes/TrackLane.tsx  [data-testid=timeline-track-row]
   │           │   absolute top rowTops[i], height rowHeights[i], width contentWidth,
   │           │   contain: strict; the row's bottom border (replaces the row-line divs)
   │           └─ LaneClip × visible     lanes/LaneClip.tsx  React.memo
   │              └─ slot [data-testid=timeline-clip-slot][data-chroma-clip-slot]
   │                 │  absolute left/width (content px), inset-y 0, contain: layout size style
   │                 └─ ClipBody → ClipBlock, ClipFadeOverlay, trim zones   (unchanged)
   ├─ overlays (gap selection, transitions, drag preview, marquee, drop zones,
   │            height zones + guide, skim line, EditFeedbackLayer)       (unchanged in S4)
   └─ Playhead                           lanes/Playhead.tsx  (pinned, §2.6)
```

The scroller starts at exactly `RULER_AND_MARGIN_PX` in edit-area coordinates, where the
library's edit area started. Every overlay formula, `TIMELINE_VIEW_ATTRS`, the harness's
frame→pixel arithmetic and `rowsTop` therefore stay valid without change. The library's
`margin-top` trick and the hidden time area are gone.

`ClipBody` moves out of `TimelinePane.tsx` into `lanes/ClipBody.tsx` unchanged
(module-scope, `useDraggable`, every `data-*`), so the lane files do not import the pane.
The `getActionRender` body becomes `LaneClip`.

### 2.2 State flow: what re-renders on a release

The rule: **the pane may re-render on a commit, the lanes loop may re-run, but a
`LaneClip` re-renders only when one of its own primitive props or its `clip` object
changed.** F4's `shareUnchanged` already guarantees an untouched clip is `===` across a
commit.

- `TimelinePane` keeps its subscriptions (`timeline`, `selection`, view store). It passes
  to `TimelineLanes`: `tracks`, `fps`, `pxPerSec`, `rowTops`, `rowHeights`, the view
  settings (`bandRatio`, `showClipNames`, `showClipBadges`), `selection`,
  `syncLinkedIds`, `avLinkedIds`, `cutStyleById`, `curveEditor`, `viewportWidth`, the
  quantised scroll window (§2.4) and one stable `actions` object.
- `TimelineLanes` computes the window per track (index lookup, §2.4) and renders a
  `TrackLane` per track. `TrackLane` is not memoised: its loop over the visible clips plus
  k memo comparisons costs microseconds.
- `LaneClip` (`React.memo`, default shallow compare) props are all primitives or stable
  identities: `clip`, `trackIndex`, `clipIndex`, `kind`, `trackHeight`, `leftPx`,
  `widthPx`, `fps`, `pxPerSec`, `bandRatio`, `showName`, `showBadges`, `selected`,
  `avLinked`, `syncLinked`, `locked`, `cut`, `curveParam`, `curveOpen`,
  `visibleStartPx`, `visibleEndPx`, `actions`.
  - `visibleStartPx/EndPx` are **clamped to `[0, widthPx]` and bucketed** in the lane.
    Today they are raw `filmstripScrollLeft − clipLeftPx`, which changes for every clip
    on every 200 px bucket crossing. A fully visible clip then always gets `0`/`widthPx`
    and does not re-render on scroll; only clips straddling an edge do.
  - `actions` = `{ onClipPointerDownCapture(e, track, id), onClipClick(e, track, id),
    onToggleCurve(track, id, param) }`, created once (`useState(() => …)`) and calling the
    latest pane closures through a ref written in an effect (the existing
    `zoomByRef`/`marqueeLatestRef` pattern; no ref access during render, so the React
    Compiler keeps the pane compiled).
- `onClickAction` becomes `actions.onClipClick` with the same body. The click is bound on
  the slot, so it fires before the edit area's empty-space `onClick`, exactly as the
  library's did.

Expected release work at 300 clips: the pane body (compiled), one lanes loop over
≈ visible + overscan clips, and re-rendered `LaneClip`s = the clips the op changed (a trim:
1; a ripple: the visible downstream clips; a move: 1–2), + any whose `selected` flipped.

### 2.3 Scroll and zoom model

- **One native scroller for both axes** (`overflow: auto`). The DOM is the single source
  of the scroll position. There is no `ScrollSync` copy, so B-291's echo loop cannot
  exist.
- **Clips are positioned with `left`/`width` in content pixels**, set at render time and
  constant while scrolling. Native scrolling moves them with no JS (WebKit's threaded
  scrolling). **`transform` is reserved for gestures**: `useEditGesture` writes
  `transform` on the body, so a base-position `transform` on the slot would be a second
  positioning system on the moving node (the D-098/D-100 lesson).
- `contentWidth = START_LEFT_PX + max(20, ceil(endSec / tickSeconds) + 5) × tickSeconds × pxPerSec`:
  the library's formula, kept so "frame just past the last clip" targets (H11) and drops
  past the end behave as today. Pure function in `lanes/laneLayout.ts`.
- **Scroll → React, S4 (parity):** a passive `scroll` listener on the scroller calls the
  existing `onTimelineScroll` logic (B-326 detection, `setScrollLeft`/`setScrollTop`).
  The pane still re-renders per scroll frame, but now every `LaneClip` bails out.
- **Scroll → React, S8 (target):** scroll leaves React state. The scroller's listener
  writes the header column's `transform: translateY` (spec §4.8), the playhead's
  transform, the `data-chroma-scroll-left/-top` attributes and a small store
  (`timelineScroll.ts`: `left`, `top`, and a **bucketed** `windowLeft`). Only the lanes
  (through `windowLeft`) and the scroll-dependent overlays subscribe. Content-space
  overlays (transitions, gap selection, drop zones, height zones, row lines, drag preview)
  move **inside the scroller's content**, so they ride native scroll with zero JS. Pinned
  ones (ruler, marker strip, beat lane, skim line, curve lane) subscribe to the store
  themselves.
- **Imperative scroll writes:** `editorRef.setScrollLeft(x)` → `scroller.scrollLeft = x`
  (playback follow `:1079`, zoom anchor `:1175`). Keep the zoom anchor in a **layout**
  effect keyed on `pxPerSec`. The content width is set in the same commit, so the write is
  not clamped against the old width (B-116), and it lands before paint.
- **Zoom anchoring** is unchanged (`timelineZoom.ts`). A zoom re-renders the visible clips
  (their `leftPx`/`widthPx` change). Culling makes that O(visible), not O(all).
- **Viewport width:** `useViewportWidth(scroller)`. `measureEpoch` and the `key` remount
  go (no AutoSizer). A width of 0 (hidden tab, jsdom) means **no culling** (render every
  clip, today's behaviour), so the hidden-tab path and the DOM suites keep working.

### 2.4 Culling: `lanes/laneWindow.ts`

```ts
/** Per-track index, built once per track OBJECT (WeakMap<Track, LaneIndex>): clip
 *  positions sorted by start_frame, plus a running max of end frames (so overlap is safe). */
export interface LaneIndex {
  order: Int32Array;        // indices into track.clips, by start_frame ascending
  starts: Float64Array;     // start frame per sorted entry
  ends: Float64Array;       // end frame per sorted entry (endFrame(clip, fps))
  maxEndPrefix: Float64Array; // maxEndPrefix[i] = max(ends[0..i]), non-decreasing
}
export function buildLaneIndex(track: Track, fps: number): LaneIndex;   // O(n log n)

/** The half-open range [lo, hi) of sorted entries that can intersect the frame window
 *  [from, to): lo = first i with maxEndPrefix[i] > from, hi = first i with starts[i] >= to.
 *  Callers filter ends[i] > from inside the range (only needed when clips overlap). */
export function visibleRange(ix: LaneIndex, from: number, to: number): { lo: number; hi: number }; // O(log n)

/** The window in frames for a scroll position, with overscan, quantised so a lane
 *  re-renders once per `bucketPx` of scroll rather than per pixel. */
export function laneWindow(v: {
  scrollLeft: number; viewportWidth: number; pxPerSec: number; fps: number;
  startLeftPx: number; overscanPx: number; bucketPx: number;
}): { from: number; to: number } | null;   // null = viewportWidth 0 → no culling
```

- **Complexity:** index build O(n log n) per **changed** track (unchanged tracks keep
  their `Track` object under F4, so the WeakMap hit is free). Per render, O(log n + k) per
  track, where k = clips in the window.
- **Overscan:** one viewport width on each side (minimum 600 px). Bucket: half a viewport.
  The visible area is always inside the window, so a scroll re-renders the lanes at most
  once per half viewport. The overscan also covers clips that a ripple/slide preview pulls
  in from just off screen (§6 R5).
- **Pinned clips (always rendered, wherever they are):** the selection, the active dnd-kit
  drag source (unmounting it mid-drag breaks the drag), the edit gesture's target clip, and
  the clip holding keyboard focus (focus tracked by a `focusin`/`focusout` listener on the
  scroller). Pinned clips outside the window are appended after the range.
- Unit tests: empty track, one clip, window before/after/inside, a clip straddling each
  edge, overlapping clips (a long clip starting before the window), unsorted `clips` arrays,
  pinned outside the window, `viewportWidth` 0, and a 10k-clip property test against a
  brute-force filter.

Vertical culling is not built: at today's track counts (≤ 12), a lane with no visible
clips costs one empty div. If track counts grow, `rowTops` + `scrollTop` gives the same
treatment per lane. It is listed in the roadmap line, not built.

### 2.5 How P2's gesture engine attaches (unchanged)

`useEditGesture` needs only: the edit-area ref (rects, cursor), clip bodies found by
`[data-testid="timeline-clip"][data-chroma-clip-id]`, `[data-chroma-clip-media]` inside
them, `[data-chroma-trim-edge]` zones, and `EditGestureView` geometry. All of these are
kept verbatim. `ClipBody`'s `onPointerDownCapture` comes through `actions`. The
`committedRendered` layout effect (`useEditGesture.ts:528-531`) still runs on the pane's
commit render. A culled-out moving neighbour is skipped by `styledFor` already
(`:206-207`). The only gesture-side changes in this plan are measured paint experiments in
S7 (`will-change` scoping), not behaviour.

### 2.6 Playhead: `lanes/Playhead.tsx`

- Pinned in edit-area coordinates (not inside the scroller): `position: absolute`, from
  the ruler's bottom edge (`RULER_HEIGHT_PX`) to the bottom, like today's override.
- Moved **only by `transform: translate3d(x, 0, 0)`**, `x` rounded to the device pixel,
  `will-change: transform`. It is its own compositing layer, so playback, scrubbing and
  stepping never repaint the lanes. `x = START_LEFT_PX + frame / fps × pxPerSec −
  scrollLeft`.
- Written imperatively through a handle (`setFrame(frame)`, `setScroll(left)`,
  `setScale(pxPerSec, fps)`). It is driven from the existing raw store subscription
  (`:1055-1081`, replacing `setTime`) and from the scroll listener. **No React render per
  frame** (D-325 holds).
- DOM: the line `[data-testid=timeline-playhead][data-chroma-playhead]`, 1 px,
  `--color-playhead`, `pointer-events: none`. The head `[data-testid=timeline-playhead-head]`
  is a Phosphor `CaretDownIcon` (weight `fill`, 12 px), in the ruler, as spec §4.6 asks;
  P2/P3 kept the library's SVG only because the library owned the DOM. The band
  `[data-testid=timeline-playhead-band]` is under the ruler, `MARKER_STRIP_HEIGHT` tall
  and 16 px wide (B-346's grab size). **Only the head and the band take the pointer.**
  B-349's class of bug is gone by construction.
- Drag: `pointerdown` on head/band → `setPointerCapture`. Start: `setPlaying(false)`,
  `setPlayhead(frame)`, `beginScrub(frame)` (as `onCursorDragStart`). Move: frame from
  `clientX` with the same math, `snapFrameToBeat`, `setPlayhead`, `updateScrub`. Up,
  cancel, lost capture and unmount: `endScrub()`. **Edge autoscroll** while scrubbing (the
  library's `deltaScrollLeft`): a rAF loop scrolls the scroller when the pointer is within
  24 px of either edge, at a speed proportional to the overshoot. This is a small pure
  helper with a unit test.
- Accessibility: the head is `role="slider"` with `aria-label="Playhead"`,
  `aria-valuemin=0`, `aria-valuemax=duration`, and `aria-valuetext` = timecode, updated
  imperatively. It is not in the tab order (the frame-step keys already move the playhead
  from anywhere).
- z-order: `--z-timeline-playhead` as today. The band sits under marker flags in hit order
  as today (the flags carry `data-chroma-no-marquee` and stop their own presses).

### 2.7 dnd-kit, selection, marquee, markers, transitions, skimmer

- **dnd-kit moves:** `ClipBody`'s `useDraggable`, `TrackDropZone`s, `DragOverlay`,
  `dragGhostToPointer` and every handler are unchanged. The scroller is a real scrollable
  element, so dnd-kit's autoscroll finds it as it found the Grid. Culling pins the drag
  source.
- **B-137 grab rect** (`:1341`) and **hover trim mode** (`:1378`):
  `closest('[data-chroma-clip-slot]')` replaces `closest('.timeline-editor-action')`. The
  slot is the clip's row box, as the action wrapper was.
- **Selection click:** the slot's `onClick` → `actions.onClipClick` (same body as
  `onClickAction`). Empty-space click: `closest('[data-chroma-clip-slot]')` at `:4064`.
- **Marquee:** `marquee.ts` `MARQUEE_BLOCKING_SELECTORS` becomes
  `[data-chroma-clip-slot]`, `[data-testid="timeline-ruler"]`, `[data-chroma-playhead]`
  (line, head, band) and the existing `[data-chroma-no-marquee]`. The library's row-drag
  handle entry is dropped (it never rendered).
- **Markers, beat lane, ruler, skimmer, curve lane:** unchanged components and positions.
  In S8 they read scroll from the store instead of props.
- **Transitions:** unchanged in S4 (overlay). In S8 they move into the scroller's content
  layer (content coordinates, no `− scrollLeft`), still one badge per cut, still outside
  any clip (D-226's reason).

### 2.8 Keyboard focus and accessibility

Focusable clip bodies keep dnd-kit's `role="button"`/`tabIndex`. Culling pins the
focused clip. The scroller gets `tabIndex={-1}`: it does not steal Tab, and a click on
empty space gives focus to the edit area as today. The lanes container is a `group`
labelled "Timeline tracks", and each `TrackLane` is labelled with its track label
(`trackLabels`). The library exposed no ARIA at all. Off-screen clips are not in the
accessibility tree, the same trade every virtualised list makes. The marker list and the
Edit Index stay the non-visual way to reach every point.

### 2.9 Paint isolation (the run-4 finding)

Goal: during a gesture, the frame cost is the moving clips' composite, not a repaint of
the lanes. On a commit, only the changed clips repaint.

1. **`TrackLane`: `contain: strict`** (size, layout, paint, style; its size is explicit).
   Paint invalidation inside one lane never reaches another lane or the scroller.
2. **Slot: `contain: layout size style`, not `paint`.** A head trim translates the body
   outside its slot, so paint containment would clip it (the reason F2 avoided `paint` on
   the library wrapper). The body keeps its own `contain: layout paint style`.
3. **The moving clips get their own layers, only during the gesture.** At the claim, the
   gesture adds `will-change: transform` to the target body and (ripple/slide) the moved
   neighbours. Culling bounds this to the visible ones. It removes the property after the
   commit has painted, not at the commit, so the release does not also pay for layer
   teardown on the frame it repaints. F3 removed `translate3d` to avoid layers created
   mid-drag. This promotes once, at the press, which trades a one-time layer cost at press
   for no per-frame repaint. **A/B-measured in S7**, with layer borders/repaint counters
   (S0b) as the evidence. Kept only if the move-phase p95 drops without the press frame
   growing past budget.
4. **The media layer (`[data-chroma-clip-media]`: filmstrip + waveform) is drawn once and
   moved, never redrawn during a drag.** During a trim, it keeps its width from the press
   (absolutely positioned, `width` frozen), so a width change on the body only re-clips it.
   It gets `will-change: transform` for the gesture's duration. No layer is promoted if its
   visible width exceeds 2 viewports (memory cap).
5. **Waveform at commit:** today `buckets = round(width / 2)` (`Waveform.tsx:115`), so any
   width change re-requests peaks over IPC, and assigning `canvas.width` clears the bitmap.
   The trimmed clip goes blank until the new peaks arrive and redraws again then. Quantise
   the bucket count (power-of-two steps of the source span's density) so a trim re-uses
   cached peaks and draws synchronously. Skip the `canvas.width` assignment when the size
   is unchanged. Keep the old bitmap until new peaks land.
6. **Filmstrip at commit:** verify that tiles are keyed by source time and density and are
   not re-requested by a trim. Give the `<img>` tiles explicit `width`/`height` and
   `decoding="async"` (`Filmstrip.tsx:259`).
7. **Pinned feedback on its own layers:** the playhead (§2.6), skim line, snap guide,
   brackets and readout (already `translate3d`) carry `will-change: transform`, so moving
   them repaints nothing under them.
8. **Scrolling is composited:** with content-space overlays inside the scroller (S8), a
   scroll repaints only newly exposed tiles. Today every overlay is re-laid-out by React
   per scroll frame.
9. **Row lines** become the lane's own bottom border (one fewer absolutely positioned div
   per track repositioned per scroll frame).

## 3. Test-id / harness compatibility map

| old selector (library) | new selector (ours) | who uses it | when it changes |
|---|---|---|---|
| `.timeline-editor-cursor` (`LIB.playhead`) | `[data-testid="timeline-playhead"]` | `scenarios/timeline.ts:82,86,657,662` (watch `x`, `live minDistinct`) | S4: `LIB.playhead` value repointed; S6: scenarios use `ID.playhead`. Its rect `x` moves with the transform, so `live` checks work |
| `.timeline-editor-cursor-top` (`LIB.playheadHandle`) | `[data-testid="timeline-playhead-head"]` | none in scenarios | S4 / S6 |
| `.timeline-editor-cursor-area` (`LIB.playheadBand`) | `[data-testid="timeline-playhead-band"]` | `targets.ts:72` `playheadGrab()`, `runner.test.ts:430` | S4 repoint; S6 `ID.playheadBand` |
| `.timeline-editor-action` (`LIB.action`) | `[data-testid="timeline-clip-slot"]` (also `[data-chroma-clip-slot]`) | pane `:1341,1378,4064`, `marquee.ts:84`, DOM suites | S4 |
| `.timeline-editor-edit-area` (`LIB.scroller`) | `[data-testid="timeline-scroller"]` | `marquee.test.ts`, docs | S4 |
| `.timeline-editor-edit-row` | `[data-testid="timeline-track-row"][data-chroma-track]` | `TimelinePane.clipDrag.dom.test.tsx:156` | S4 |
| `.timeline-editor-time-area` | (gone; `[data-testid="timeline-ruler"]` is the ruler) | `marquee.ts:85` | S4 |
| `.timeline-editor-action-{left,right}-stretch` | (gone since P2; `timeline-clip-trim-start/-end`) | assertions of absence in `.clipBlock:242` | S5 deletes the assertion |
| every `TIMELINE_TEST_IDS` entry | **unchanged** (`timeline-clip`, `-trim-*`, `-track-lane`, `-edit-area`, …) | all 55 scenarios | — |
| `TIMELINE_VIEW_ATTRS` on the edit area | **unchanged** names and meaning (`rowsTop` stays `RULER_AND_MARGIN_PX`) | `ScenarioRunner` frame targets, `visibility.ts` (H11) | S8 writes the scroll attrs imperatively |

(Done in S6, see below.) `TIMELINE_LIBRARY_SELECTORS` survived S4 only as an alias of the new selectors, so the
harness kept compiling unchanged across the switch. S6 deleted it, moved its uses to
`TIMELINE_TEST_IDS` (`playhead`, `playheadHead`, `playheadBand`, `clipSlot`, `scroller`,
`trackRow`), replaces `timelineTestIds.test.ts`'s library-CSS pin with a render test that
every id is present on a real `TimelinePane` (extends `TimelinePane.testIds.dom.test.tsx`),
and updates `ui-harness.md`'s selector section. Acceptance for S4–S6: the full harness run
(`npm run harness --workspace @apelles/ui-harness`, native mode) passes at least the same
51 of 55 as run 4. Run 4's 4 failures are J/K/L shuttle, I/O marks, edit-point navigation
(features not built yet) and `ripple-delete-shortcut` (`c` stayed at frame 180, an open
defect outside the lane renderer). None of the four touches lane rendering.

## 4. Perf targets and how each is verified

All numbers on a **production web bundle** (`tauri build --debug`, see S0), Apelles
frontmost, harness perf method (no rect watch on measured steps, ≥ 1.5 s gestures,
idle wait). Fixtures: 3 clips (`buildFixture`), and **300 clips on 8 tracks** (S0 adds
`buildBigFixture(clips, tracks)` + a `perf-300` scenario set: trim, ripple, slide, move,
zoom ×3, scroll H/V, playback).

| target | budget | how it is measured |
|---|---|---|
| Release, React | `commitRenderedMs` ≤ 10 ms at 300 clips | `apelles:edit:commit-rendered` via `debug_perf_entries` (S0 makes it exist in the debug-tauri build) |
| Release, to pixels | corrected `commitPaintedMs` (rAF + MessageChannel) **< 30 ms** at 300 clips; release frame (`phases.release` max) ≤ 33 ms | S0's corrected mark + `debug_pointer` `perf.phases.release` |
| Release, what re-rendered | `LaneClip` renders on a trim = 1 (+ selection flips); on a ripple ≤ visible downstream | a DOM-tier test with a render counter on `LaneClip` (deterministic, CI) + `apelles:lanes:clip-renders` count mark (dev/debug only) |
| Move frames | p95 ≤ 16.7 ms, worst ≤ 33 ms, dropped ≤ 5 %, at 3 and 300 clips, every edit tool + dnd move | `debug_pointer` `perf.phases.move`; preview p95 ≤ 2 ms from `apelles:edit:preview` |
| Paint per move frame | repaint counters on non-moving clips do not increase during a gesture; moving clips are composited layers | S0b layer borders + repaint counters, screenshot at mid-gesture (evidence in the report) and a `sample` profile bucket split (paint vs layer flush vs JS), as in `timeline-drag-perf.md` |
| Zoom | one zoom step's commit ≤ 16.7 ms with ≤ 60 clips on screen, ≤ 33 ms with all 300 on screen (fully zoomed out) | new `apelles:timeline:zoom` → `zoom-rendered` marks around `setPxPerSec` → layout effect; `zoom-trackpad-pinch` / `zoom-ctrl-wheel-anchored` measured at 300 |
| Scroll | p95 ≤ 16.7 ms at 12 tracks × 300 clips; after S8, React commits during a scroll = lane bucket crossings only (≈ 2 per viewport scrolled) | `scroll-horizontal-wheel` / `scroll-vertical-wheel` measured at 300 + a commit counter (`debug_frame_timing` + React commit marks) |
| Mount / DOM size | `[data-testid=timeline-clip]` count ≤ visible + 2 × overscan + pinned; opening the 300-clip timeline ≤ 100 ms to first paint | DOM count assertion in a perf scenario; `TimelinePane.mountCost.dom.test.tsx` rewritten for the lanes |
| Playback | no lane repaint during playback (only the playhead layer moves); `playback-frame-rate` stays green | S0b repaint counters during play; existing scenario |

Every target is recorded before (library, S0 baseline) and after (S9) in this note's
"Results" section (to be added by S0 and S9), with the run directory.

## 5. Step plan

Each step is one commit (or a short series on one concern). It builds, passes
`tsc` (zero new errors), the editor and harness unit suites, `reactCompiler.test.ts`, and
lands its own docs. **Sizes:** S ≈ < 300 lines, M ≈ 300–800, L ≈ > 800 or cross-cutting.
Builders work in worktrees and rebase on `main` before each commit. P5 is editing the
toolbar/layout part of `TimelinePane.tsx` (`:3500-3895`), so this plan keeps its pane
diffs to the edit-area block (`:3896-4434`) and the handler sites listed in §1, and
moves new code to `lanes/`.

| # | step | size | depends on | parallel with | model |
|---|---|---|---|---|---|
| S0a | Perf marks that mean what they say | S–M | — | S0b, S1, S3b | Sonnet |
| S0b | WebKit layer-debug toggle (debug-only native op + MCP tool) | M | — | S0a, S1, S3b | Sonnet |
| S0c | 300-clip fixture + `perf-300` scenarios + **baseline run** (library, dev and production bundle) | M | S0a (S0b for evidence) | S1, S3b | Sonnet |
| S1 | `laneWindow.ts` + `laneLayout.ts` (pure) + tests | S | — | S0*, S3b | Sonnet |
| S2 | `ClipBody` → `lanes/ClipBody.tsx` (move only, no behaviour change) | S | — | S1, S3b | Sonnet |
| S3a | `TimelineLanes` / `TrackLane` / `LaneClip` + the `actions` pattern, standalone with their own DOM tests (not yet wired) | M | S1, S2 | S3b | Sonnet |
| S3b | `Playhead.tsx` + edge-autoscroll helper, standalone, with DOM tests | M | — | S1, S2, S3a | Sonnet |
| S4 | **The switch**: the pane renders `TimelineLanes` + `Playhead`, its own scroller, alias selectors, DOM suites ported | L | S3a, S3b | — (touches the pane) | **Opus** |
| S5 | Delete the library: package, `buildRows`, `editorRef`, `measureEpoch` key, the dead override CSS, the library-only tests | M | S4 | S6 | Sonnet |
| S6 | Harness map: `TIMELINE_LIBRARY_SELECTORS` → `TIMELINE_TEST_IDS`, test-id render pin, `ui-harness.md`; full live run | S–M | S4 | S5 | Sonnet |
| S7 | Paint isolation (§2.9 items 3–7), each item A/B-measured | M | S4, S0b | S8 | Sonnet (measure), Opus if the A/B is ambiguous |
| S8 | Scroll out of React: `timelineScroll.ts`, header transform, content-space overlays, imperative view attrs | L | S4 | S7 (different files except the pane: sequence the pane hunks) | Opus |
| S9 | Verification run at 3 + 300 clips, production bundle; Results section; D-437 status; roadmap tick | S | S5–S8 | — | Sonnet |

### S0a — perf marks that mean what they say

**Done 2026-11-01.** The gate is `import.meta.env.APELLES_PERF_MARKS` (not a bare global, so
an unconfigured vitest run gets no marks instead of a ReferenceError), defined by
`app/perfMarks.mjs` from Tauri's own `TAURI_ENV_DEBUG` (`"true"` for `tauri build --debug` and
`tauri dev`, `"false"` for release) instead of the plan's `APELLES_PERF_MARKS=1` env switch, which
survives only as an override for a plain `vite build`. The name table is plain string literals
(a template literal was not dropped by the bundler and left `apelles:edit:` in the release
bundle). The helpers stay as inert branches behind a constant-false guard. Side fix: the Vite
config's `minify`/`sourcemap` tested `TAURI_ENV_DEBUG` for truthiness, which `"false"` satisfies,
so release builds were never minified; fixed in the same file. Tests: `editPerf.test.ts`,
`editPerf.bundle.test.ts` (bundles `editPerf.ts` both ways), `app/perfMarks.test.mjs`,
harness `method.test.ts`/`runner.test.ts`. Verified with a real `vite build` of the app:
`TAURI_ENV_DEBUG=false` has no `apelles:edit:`, `=true` has it.
- `editPerf.ts`: gate on a Vite `define` (`__APELLES_PERF_MARKS__`) instead of
  `import.meta.env.DEV`. Set it true for `vite dev` and when `APELLES_PERF_MARKS=1` (the
  debug-tauri build recipe in `ui-harness.md`). A release build defines it false, so the
  helpers are dead code that Vite removes. Debug-only per CLAUDE.md.
- `perfMeasureAfterPaint`: rAF → `MessageChannel` post → measure (runs after that frame
  has rendered). Keep the old one as `commit-frame` (rAF start). Add `commit-effects`,
  measured from a passive `useEffect` in `useEditGesture` keyed like `committedRendered`.
- Harness: attach `commitFrameMs`, `commitEffectsMs`, `commitPaintedMs` to measured steps.
  Report "painted − frame" as the paint+composite estimate.
- Acceptance: a unit test that the after-paint measure runs after a posted task; harness
  `runner.test.ts` shows the new fields; a release `vite build` bundle contains no
  `apelles:edit:` string (a grep in a test or in the build check).

### S0b — WebKit layer debug toggle

**Done 2026-11-01 (code, tests and parity; the live screenshot is pending).** The op is
`debug_set_webkit_layer_debug {borders?, repaintCounters?, window?}` (MCP: `repaint_counters`),
tool count 266 -> 267 (debug) / 250 -> 251 (release). The SPI was verified before use: the Xcode
SDK exports the C twins and a runtime probe finds all four `WKPreferences` selectors with BOOL
encodings (details in `debug-tooling.md`). All four are checked with `respondsToSelector:`
before any call. **Deviations from the plan:** (1) `debug_get_ui_state` does not report the
flags: they are native webview state the frontend cannot read, so the op reports `before`/`after`
itself and a call with no flag is a read; (2) the live screenshot with borders on, and the answer
to "does `debug_screenshot` include the overlays", need a running debug build and were not
produced in this pass (the running dev app is off limits to the builder agent and the disk was
short of a second debug build). Whoever runs S0c step 3 records both here.
- Native op `debug_set_webkit_layer_debug {borders?, repaint_counters?}` in
  `app/src-tauri` behind `#[cfg(debug_assertions)]`. It calls the `WKPreferences` SPI
  `_setCompositingBordersVisible:` / `_setCompositingRepaintCountersVisible:` through
  `objc2` on the webview's configuration. Check `respondsToSelector:` first and return an
  error naming the missing selector, never a silent no-op. Verify the selectors against
  the installed SDK's `WKPreferencesPrivate.h` before building. It is SPI, which is
  acceptable only because it is compiled out of release.
- MCP tool in both servers + parity corpus (count +1, release count unchanged).
  `debug_get_ui_state` reports the flags.
- Check whether `debug_screenshot` (WKWebView snapshot) includes the borders. If it does
  not, document that the window-capture path must be used.
- Acceptance: unit test of the argument parsing; a live screenshot with borders on, saved
  under `scratch/` and cited in this note.

### S0c — big fixture + baseline

**Done 2026-11-01 (fixture, scenarios and recipe); the baseline run is NOT done.** See
`docs/notes/ui-harness.md` "Baseline recipe" for the exact commands (dev bundle; production
bundle via `tauri build --debug` with its own identifier and control port, because the
single-instance plugin would otherwise hand a second launch over to the dev app). The plan's
`buildBigFixture({clips, tracks})` is `bigFixtureSpec` (exported under both names); the linked
A/V pairs' audio halves count towards the 300. The "Baseline" section below stays empty until a
run fills it.

#### Baseline

_Not run yet. Fill in from `scratch/perf-baseline/dev` and `scratch/perf-baseline/prod`: commit
rendered / effects / frame / painted, move p95 / worst, zoom, scroll, a `sample` split of a release
and a ripple move phase, and the answer to section 0's question (how much of the 30-43 ms move p95
is paint)._
- `buildBigFixture({ clips: 300, tracks: 8 })` in `packages/ui-harness` (mixed lengths,
  linked A/V on two tracks, 4 markers, 2 transitions) and the `perf-300` scenario set.
  Scenarios assert little; they measure.
- Run on today's library build, dev bundle and production bundle. Record the results in a
  "Baseline" section of this note: commit rendered / frame / effects / painted, move
  p95/worst, zoom, scroll, and a `sample` split of a release and of a ripple move phase
  (paint vs layer flush vs JS). Answer §0's open question (how much of the 30–43 ms move
  p95 is paint) with numbers.
- Acceptance: the run directory exists and is cited. No production code changes.

### S1 — `laneWindow.ts`, `laneLayout.ts`
- §2.4 API. `laneLayout.ts`: `contentWidth`, `clipLeftPx`, `clipWidthPx` (via `endFrame`),
  `frameAtContentX`, and the clamped, bucketed `visibleSlice(clipLeftPx, widthPx, windowPx)`.
- Acceptance: the tests listed in §2.4, plus `contentWidth` against the library's formula
  for 6 cases (no clips, < 20 ticks, long timeline, each zoom extreme). Coverage of every
  branch.
- **Built (2026-11-01).** `lanes/laneLayout.ts`, `lanes/laneWindow.ts`,
  `lanes/laneWindow.test.ts` (26 tests: empty/one/unsorted/tied clips, window before/after/
  inside/straddling, a long clip hiding under short ones, pinned ids beyond the window, `viewportWidth`
  0, zoom extremes, `contentWidth` vs the library formula for 6 cases, `visibleSlice`, a 10k-clip
  property test against a brute-force filter, a 400-clip timing guard at < 1 ms per window call; measured
  well under that). Deviations: the API grew three helpers the plan implied but did not name:
  `laneWindowParams(viewportWidth)` (overscan = max(viewport, 600 px), bucket = half viewport),
  `windowScrollLeft(scrollLeft, viewportWidth)` (what the pane passes down so a scroll inside a bucket is
  not a prop change) and `windowClipIndices(track, window, fps, pinnedIds)` (range + overlap filter +
  pinned ids, returned in array order so stacking and keys do not depend on the window).
  `visibleSlice(clipLeft, widthPx, viewStart, viewEnd, bucketPx)` takes the viewport in content px
  (the plan's `windowPx`) and an explicit bucket (200 px, `SLICE_BUCKET_PX`, the old filmstrip bucket).
  `TRIM_ZONE_PX` / `TRIM_ZONE_MAX_FRACTION` live in `laneLayout.ts`; the pane's copies are deleted by S4.

### S2 — move `ClipBody`
- Pure move to `lanes/ClipBody.tsx` with its doc comment. `TimelinePane` imports it.
- Acceptance: every existing editor test green, no diff in rendered DOM (snapshot of one
  clip before/after in a throwaway assertion, not committed).
- **Built (2026-11-01).** `ClipBody` moved verbatim (plus `export` and a header comment) to
  `lanes/ClipBody.tsx`. `TimelinePane.tsx`: one import line added (`import { ClipBody } from
  './lanes/ClipBody'`), the 100-line function deleted, and the now-unused `ReactNode`, `useDraggable`,
  `TRIM_ARM_HINT` imports removed. No behaviour change.

### S3a — lanes components (not wired)
- `TimelineLanes`, `TrackLane`, `LaneClip` per §2.1–2.2, with the pinned set, the clamped
  visible slice and `contain` values from §2.9.1–2.
- `reactCompiler.test.ts` reads only `src/` top level (`readdir(SRC_DIR)`). Extend it to
  `src/lanes/` in this step, so the new files are held to zero bailouts.
- DOM tests (`lanes/TimelineLanes.dom.test.tsx`): renders one slot per clip in the
  window; culls outside it; renders all when `viewportWidth` is 0; pins
  selection/drag/focus; a render counter shows that replacing one clip object re-renders
  one `LaneClip`; a selection change re-renders only the clips whose flag flipped; slot
  `left`/`width` match `laneLayout`; every `data-testid`/`data-chroma-*` from §3 present.
- Acceptance: those tests + compiler test green. No pane change.
- **Built (2026-11-01).** `lanes/TimelineLanes.tsx` (`memo`), `TrackLane.tsx`, `LaneClip.tsx`
  (`memo`), `useLaneActions.ts`, `lanes/README.md`; `reactCompiler.test.ts` now covers `src/` and
  `src/lanes/` (zero bailouts). `lanes/TimelineLanes.dom.test.tsx`: 23 tests. Render counts (counted at
  the `memo` boundary of `LaneClip`, because the React Compiler memoises an unchanged child element and a
  stubbed child would undercount): identical props re-render 0 clips; replacing one clip object re-renders
  exactly that one; a selection change re-renders exactly the clip whose flag flipped (2 on moving it); a
  scroll inside the window bucket re-renders 0 (and not even `TimelineLanes`, since `windowLeft` is
  unchanged); crossing a bucket re-renders the newcomers and the clips that leave the viewport (their
  visible slice parks at an edge once) but not a clip that stays fully visible; a zoom re-renders each
  visible clip once; a change on one track leaves the other track alone. Deviations: (1) `TimelineLanes`
  takes `windowLeft` (scroll already floored to the bucket by `windowScrollLeft`) instead of a raw
  `scrollLeft`, which is what makes "a scroll inside the threshold re-renders nothing" true at the
  component boundary; (2) it also takes `scrollerRef` and `onScroll`, which S4 needs; (3) `useLaneActions`
  is the `actions` pattern as a hook (ref written in a layout effect); (4) six ids were added to
  `TIMELINE_TEST_IDS` (`trackRow`, `clipSlot`, `scroller`, `playhead`, `playheadHead`, `playheadBand`),
  earlier than S4, because the components need them; (5) the clip slot is `top 0` with an explicit
  `height` rather than `inset-y 0`, so the lane's 1 px bottom border does not shrink the clip's row box.
  Not covered (needs layout): real scroll behaviour, which S4's Chromium/live checks own.

### S3b — playhead (not wired)
- `Playhead.tsx` per §2.6, with handle, head and band, scrub callbacks, edge autoscroll
  (`playheadAutoscroll.ts`, pure).
- DOM tests: `setFrame`/`setScroll` write only `transform` (no React render: a render
  counter), the line is `pointer-events: none` and the head/band are not, the drag calls
  begin/update/end in order with snapping, `pointercancel`/lost capture/unmount end the
  scrub, autoscroll speed curve.
- Acceptance: tests + compiler test green.
- **Built (2026-11-01).** `lanes/Playhead.tsx`, `lanes/playheadAutoscroll.ts`,
  `lanes/Playhead.dom.test.tsx` (19 tests) and `lanes/playheadAutoscroll.test.ts` (5). Position is
  `transform: translate3d` only, `x` rounded to the device pixel, `will-change: transform`, written through
  a handle (`setFrame`, `setScroll`); a `Profiler` shows 0 extra commits for 200 `setFrame` calls. The
  line, the root and the (positioned) container are `pointer-events: none` (inline style, so the test can
  read it); the head and band are `auto`. A scrub uses pointer capture; start/scrub/end fire in order with
  snapping, only on a frame change; `pointercancel`, lost capture and unmount each end it exactly once; a
  second press or another pointer while one is active is ignored; edge autoscroll scrolls the scroller by
  `edgeScrollSpeed` per animation frame and reports the new frames, and stops on release. Deviation:
  `fps`/`pxPerSec`/`startLeftPx` arrive as **props** (re-placed in a layout effect, one render per zoom
  step) rather than a `setScale` handle method; the frame and scroll, which change per frame, are the
  handle. The head and band are children of the line, so the one transform moves all three.

### S4 — the switch (Opus)
- Pane: replace `<TimelineEditor>` (`:4091-4128`) with `<TimelineLanes>` + `<Playhead>`.
  `editorRef.setTime` → playhead handle; `setScrollLeft` → `scroller.scrollLeft`; passive
  scroll listener → `onTimelineScroll` logic; `onClickAction` → `actions.onClipClick`; the
  three `.timeline-editor-action` reads → `[data-chroma-clip-slot]`;
  `MARQUEE_BLOCKING_SELECTORS` per §2.7; row-line divs → lane borders.
  `TIMELINE_LIBRARY_SELECTORS` values repointed (§3). New ids added to
  `TIMELINE_TEST_IDS`.
- Port the DOM suites that query library classes (§1.6) to the new selectors.
  `zoomScrollLoop`'s B-291 loop no longer exists; replace that suite with "a zoom writes
  `scroller.scrollLeft` once, in the zoom's commit".
- The library stays installed (imports removed) so S5 is a pure deletion.
- Acceptance: all editor DOM suites green under StrictMode (the suites mount with it);
  `TimelinePane.clipBlock.dom.test.tsx`'s P2 gesture cases (trim/head-trim/ripple/roll/
  slip/slide, Esc, style drop at commit, render budget) pass **without edits to their
  assertions**; Chromium check in `app/harness.html` (screenshots in `scratch/`); a live
  harness run passes the 51 that run 4 passed. Docs: `ui-redesign.md` §6c "the playhead
  still the library's" line updated; this note's status.
- **Built (2026-11-01).** `TimelinePane.tsx` renders `<TimelineLanes>` + `<Playhead>` where
  `<TimelineEditor>` was. The library's JS and CSS imports are gone (it stays in `package.json`
  for S5), and with them `buildRows`/`EFFECT_ID`/`effects`/`editorData`, `getActionRender`,
  `editorRef`, `s2f`, `libScaleWidth`, the pane's `TRIM_ZONE_*` copies, the D-128 filmstrip bucket
  (the lanes' `visibleSlice` does it), the `measureEpoch` key (the hidden-tab case is "width 0 = no
  culling" now), the `--chroma-ruler-height`/`--chroma-marker-strip-height` custom properties and
  the row-line divs (the lanes' bottom border). Wiring: `setTime` → `playheadRef.setFrame` (same raw
  store subscription, D-325); `setScrollLeft` → `scroller.scrollLeft =` (playback follow, B-326, and
  the zoom anchor's layout effect, which now also calls `playheadRef.setScroll` in the same commit);
  the scroller's `scroll` event → `onTimelineScroll` (B-326 detection, `setScrollLeft/Top`,
  `playheadRef.setScroll`); `onClickAction` → `onClipClick(e, track, id)` behind `useLaneActions`;
  the three `.timeline-editor-action` reads → `[data-chroma-clip-slot]`; `MARQUEE_BLOCKING_SELECTOR`
  per §2.7; the playhead's scrub → `setPlaying(false)`/`setPlayhead`/`beginScrub`,
  `setPlayhead`/`updateScrub`, `endScrub`. `pinnedClipIds` = the dnd-kit drag source (a memoised
  `Set`). P2's `useEditGesture` (and S0's `commit-*` perf marks, which fire from its
  `committedRendered`/`committedEffects` on the pane's commit), the overlays, P3's headers/heights/
  ruler/markers/skimmer/two-up, P5's `toolbarCenter`, F1–F4 and B-349's head-only grab are untouched.
  `timeline-overrides.css` keeps only the B-351 and edit-gesture cursor rules.
  **Tests:** editor 2961 green (2952 before; +6 `TimelinePane.laneRenders.dom.test.tsx`, marquee
  tests rewritten for the new selector, the override-CSS pins rewritten), ui-harness 80, tsc
  baselines unchanged (editor 3, app 65), `reactCompiler.test.ts` zero bailouts (pane + `lanes/`).
  Every P2 gesture case in `TimelinePane.clipBlock.dom.test.tsx` passes with no assertion edits.
  **Render counts at the pane level** (`TimelinePane.laneRenders.dom.test.tsx`, real store, real
  ops, counted at `LaneClip`'s `memo` boundary): an unrelated pane render re-renders 0 clips; a plain
  trim re-renders the trimmed clip, plus the next clip only when its cut mark changed (it no longer
  abuts); a trim with no abutting neighbour re-renders exactly 1; a ripple trim re-renders the
  trimmed and shifted clips and nothing on the non-sync-locked track; a selection re-renders the
  selected clip plus the clips that turn sync-linked; a move re-renders the moved clip only. A
  playhead tick costs **0** pane commits now (was 1 per tick: the library's cursor re-render;
  `TimelinePane.playheadCost.dom.test.tsx` tightened to 0).
  **Ported suites:** `clipDrag` (the scroller test id instead of the library's grid),
  `seek` (same), `playheadCost` (0 commits + the line's transform moved), `zoomScrollLoop`
  (rewritten as planned: one `scrollLeft` write per zoom change, never from a passive effect,
  against the new content width; the B-291 loop has no second copy to loop with), `marquee.test.ts`,
  `timelineOverrides.test.ts`. The rest (`trim`, `trimTools`, `zoomedOut`, `clipBlock`,
  `cssOverrides`, …) run unchanged through the aliases below.
  **Visual check:** headless Chromium on `app/harness.html?mode=edit` (dev server on a private
  port), same state before (library) and after: `scratch/d437-s4/{before,after}-{1-initial,
  2-selected,3-zoomed-scrolled}.png` (main checkout's `scratch/`). Clip boxes, rows, ruler, selection
  and playhead x are pixel-identical at scroll 0; after a ×3 zoom and a 400 px scroll, clips, ruler
  labels and playhead agree (the library build ignored the scripted scroll, so shot 3 has no
  library twin). Intended differences: the head is the Phosphor caret in the ruler (§2.6) instead of
  the library's pentagon in the marker band. One unplanned difference to confirm with the owner:
  the library painted faint per-tick vertical grid lines through the lanes (its row background);
  the lanes draw none (no spec asks for them; Final Cut has none).
  **Deviations:** (1) **Class aliases instead of only repointing `TIMELINE_LIBRARY_SELECTORS`.** The
  new elements also carry the library's class names (`TIMELINE_LIBRARY_ALIAS_CLASSES` in
  `timelineTestIds.ts`, the one definition; `TIMELINE_LIBRARY_SELECTORS` is derived from it), so the
  harness and its unit tests need no change at all across the switch and the DOM suites querying
  `.timeline-editor-*` keep working. Because the aliases would otherwise pick up the library-era
  override rules (`.timeline-editor-cursor-top { transform }` would move the head,
  `.timeline-editor-edit-area { margin-top }` would shift the scroller), those rules were deleted in
  S4 rather than S5, and `timelineOverrides.test.ts` now pins that no rule styles an alias. S6 deletes
  the aliases with the selectors. (2) `useViewportWidth` still observes the **edit area**, not the
  scroller: every other consumer (ruler, beat lane, follower, gesture) reads the edit area's width,
  and with overlay scrollbars the two are equal; `epoch` is now unused (S5 drops it). (3) **The edit
  gesture's target is not pinned** separately: it is on screen at the press, the window keeps a
  viewport of overscan, and `styledFor` already tolerates a missing body; pinning it would need a
  pane render at the claim. Only a > 1-viewport scroll during a trim could unmount it (preview drops,
  the commit is unaffected). (4) The playhead's `onScrubStart` gets the snapped frame (the library
  passed the raw one).
  **Check live with the harness (S4's remaining gate):** the full run (`npm run harness --workspace
  @apelles/ui-harness`) against the 51/55 of run 4; WKWebView scrollbars on the scroller (R12: overlay
  vs. classic, and whether a classic bar shrinks the lanes' viewport); the playhead head/band grab and
  scrub autoscroll; dnd-kit autoscroll finding the new scroller during a clip drag; header column
  vertical sync while scrolling; a hidden-tab start (B-267) now that there is no remount.

### S5 — delete the library
- Remove `@xzdarcy/react-timeline-editor` from `packages/editor/package.json` and the lock
  file (check that `interactjs` and `react-virtualized` leave the lock). Remove the CSS
  import, `buildRows`/`EFFECT_ID`/`effects`/`TimelineState`, the `measureEpoch` key (keep
  `useViewportWidth`'s `width`; drop `epoch` if nothing else uses it, else keep with an
  updated doc). Delete `timeline-overrides.css` rules that styled library classes (keep
  the cursor and `[data-chroma-edit-gesture] *` rules; move them to a renamed
  `timeline.css` if the file name no longer fits). Update `timelineOverrides.test.ts`,
  `cssOverrides` suite, comments listed in §1.6, `packages/README.md:15`,
  `packages/editor/README.md:9`, the module doc of `TimelinePane.tsx`.
- Acceptance: `grep -rn "timeline-editor-\|react-timeline-editor\|interactjs"
  packages app/src` returns only historical docs; `npm ls interactjs` empty; bundle size
  delta recorded; all tests green.

- **Built (2026-11-01).** The package, `interactjs` and `react-virtualized` (and 12 transitive packages, 15 in all) left `packages/editor/package.json` and `package-lock.json` (`npm ls` finds none; `grep` over `packages/` and `app/src` finds no import). `timeline-overrides.css` is now `timeline.css` (the B-351 and edit-gesture cursor rules), `useViewportWidth` returns the width only (`epoch` and its remount purpose are gone), and `TimelinePane`'s module doc and the stale comments that named library classes were updated; the lineage comments ("replaces the library") stay on purpose. `app/bench/replay.js` and its README now find clips by `timeline-clip-slot`. `timelineTestIds.test.ts` lost its library-stylesheet pin (it needed the package). Bundle size: no delta to record, the S4 switch had already dropped the import, so the production bundle had tree-shaken the library out; the saving is install size (about 7 MB). The library-only tests were already ported in S4. `buildRows`/`editorRef`/`measureEpoch` were removed in S4.

### S6 — harness map
- §3's last paragraph. Full live harness run, report cited.
- Acceptance: `runner.test.ts` updated; 51/55 live (or better).
- **Built (2026-11-01).** `TIMELINE_LIBRARY_SELECTORS` and `TIMELINE_LIBRARY_ALIAS_CLASSES` are deleted; the lane parts carry only their test ids; `targets.ts` aims at `timeline-playhead-band` and exports `playheadLine()` for the scrub `live` watches; the DOM suites query `[data-testid="timeline-clip-slot"]` etc. `TimelinePane.testIds.dom.test.tsx` now pins that a real render has the scroller, a track row holding a clip slot, and the playhead with its head and band. Live run: pending (the owner runs the harness).
- **The first live perf-300 run on the lanes and what it found** (B-357; reproduced in headless Chromium on `app/harness.html?mode=edit` with a CDP driver, since the running app was off limits): the two transition-blocked trims were a fixture defect AND a real UX bug (a badge over a cut blocked its trim zones: fixed with a hit-test hole, `editPointHoleClip`); `perf-300-scroll-horizontal` was a real bug (the aim point fell on a lane's height-resize overlay, which swallowed the wheel; the ruler too: the pane now forwards it to the scroller); `perf-300-roll` is attributed to the pane's scroll state outliving the scroller (the ruler offset and misplaced brackets in the failure screenshot; fixed by adopting the scroller's position on mount; not reproducible in Chromium, so unproven). Ripple would have been refused next (B-033: dense timeline), so that scenario now sync-unlocks the other tracks.

### S7 — paint isolation (measured)
- §2.9 items 3–7, **one sub-commit per item**, each with the harness at 3 and 300 clips
  before and after, plus S0b's repaint counters as evidence. An item that does not improve
  its target is reverted, not kept. Items 3–4 touch `useEditGesture.ts` (the claim and
  `committedRendered`) and `ClipBlock`; 5–6 `Waveform.tsx`/`Filmstrip.tsx`.
- Acceptance per item: its measured delta in the Results section; existing gesture DOM
  tests green; a DOM test pins the `will-change` lifecycle (added at claim, removed after
  the commit painted, never left behind on Esc/refusal).

### S8 — scroll out of React (Opus)
- §2.3 target. Overlays that become content-space are moved inside the scroller's content.
  The rest subscribe to `timelineScroll.ts`. `scrollRef`, `followGeomRef` and the drop math
  read the store.
- Acceptance: a DOM test that a scroll event causes **zero** `TimelinePane` renders and
  lane renders only on bucket crossings; harness scroll scenarios green at 300 clips;
  view attributes still correct (`scroll-horizontal-wheel` reads them).

### S9 — verification
- Production-bundle run of §4's table at 3 and 300 clips. Results section in this note.
  D-437 status line ("built"). `docs/04-roadmap.md` tick. B-347 updated. CHANGELOG.

## 6. Risks and how each is handled

| # | risk | handling |
|---|---|---|
| R1 | **React Compiler.** One bailout un-memoises the whole pane (D-201), and the `actions` latest-ref pattern is exactly where "Cannot access refs during render" comes from | refs are read only inside event handlers and written in effects (the pane's existing `zoomByRef` pattern); `reactCompiler.test.ts` extended to `lanes/` in S3a; `LaneClip` uses explicit `React.memo` (the compiler does not memoise per item of a `.map`) |
| R2 | **StrictMode** double render/effects (dev, and the DOM suites) | index building is pure (WeakMap cache, no side effects in render); the playhead's store subscription and scroll listener are effect-registered with cleanup; tests mount under StrictMode as today |
| R3 | **Header/lanes vertical sync** drifts or lags a frame | S4 keeps today's state-driven `top`; S8 writes the header column's `translateY` in the same scroll listener that is the only scroll writer, so both move in the same frame. `scroll-vertical-wheel` checks it |
| R4 | **Culling unmounts something in use** (dnd source, gesture target, focused clip, the Inspector's selected clip) | pinned set (§2.4); a DOM test per pin; `styledFor` already skips absent bodies |
| R5 | **Ripple/slide preview pulls an off-screen clip into view** and it is not mounted until release | overscan = one viewport each side covers deltas up to a viewport; beyond that the clip appears at release (it is correct, just late). Documented; revisit only if the harness or the owner sees it |
| R6 | **Very long timelines** (multi-hour, high zoom) → content width beyond WebKit's layer/coordinate limits (~2^24 px), and huge composited layers | content width is plain layout (no layer) except during S7's promotion, which is capped (§2.9.4); `contain: strict` lanes are not promoted. At `MAX_PX_PER_SEC` a 3-hour timeline is checked in S9; if it exceeds the limit, the plan is to clamp `MAX_PX_PER_SEC` by duration (a one-line change in `timelineView.ts`), not to virtualise coordinates |
| R7 | **Accessibility** regressions (focus loss, clips missing from the AX tree) | §2.8: pinned focus, labelled groups, slider semantics on the playhead; off-screen clips leave the AX tree like any virtualised list |
| R8 | **Parallel P5/P4 merges** on `TimelinePane.tsx` | new code lives in `lanes/`; pane hunks confined to the edit-area block and the listed handler sites; S4 and S8 are sequenced, never parallel; rebase before each commit |
| R9 | **Harness drift** (a scenario relying on a library side effect, e.g. the library's ruler click) | S4 keeps alias selectors so the harness is unchanged across the switch; the live run in S4 is the gate |
| R10 | **jsdom has no layout**: culling and scroll tests could pass vacuously | `viewportWidth` 0 ⇒ no culling keeps the old suites meaningful; lane tests stub `clientWidth`/`scrollLeft` (the existing `pointerHarness` helpers) and assert culled counts explicitly |
| R11 | **`will-change` costs** (layer memory, a slower press frame) | S7 is A/B-measured per item and reverted if it does not pay; capped by visible width; removed after paint |
| R12 | **Scrollbar appearance/behaviour change** (`overflow: overlay` → `auto`) | WKWebView on macOS draws overlay scrollbars for `auto` with the system setting; Chromium harness may show classic bars, so check both in S4's visual pass |
| R13 | **The ~35 ms "painted" gap is not in the timeline at all** (viewer re-render, IPC) | S0a's split metric and S0c's `sample` split find out before S7 spends effort; if it is the viewer, that is a separate B-NNN for the viewer, not lane work |

## 7. Not in this plan

- CSS-variable zoom (positions as `calc(var(--px-per-frame) × start)`, so a pinch is one
  style write and React settles afterwards). It is promising for "zoom at 300 visible
  clips". Revisit only if S9 misses the zoom target.
- Vertical (per-track) culling (§2.4).
- One transform per track "downstream group" for ripple (F3's second half). Culling
  already bounds the moved clips to the visible ones; revisit only if S7's ripple numbers
  miss.
