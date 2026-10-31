/**
 * timelineTestIds.ts — the stable `data-testid` names on the Edit tab's
 * timeline (D-434).
 *
 * What it is: the one list of names the timeline's real interactive parts
 *   carry as `data-testid`, so a UI test — the DOM-tier suites here, and the
 *   live-app UI harness (`packages/ui-harness`) — finds an element by what it
 *   IS rather than by a Tailwind class or a guessed pixel. Each component
 *   writes `data-testid={TIMELINE_TEST_IDS.x}`; the harness imports the same
 *   constants, so a rename is one edit and cannot drift between the two.
 *
 * Naming: `timeline-<part>`, kebab-case, one name per KIND of part. A part
 *   that repeats (a clip, a track header, a marker flag) carries the same
 *   test id on every instance and its identity in the existing `data-chroma-*`
 *   attributes — `data-chroma-clip-id` + `data-chroma-track` on a clip,
 *   `data-chroma-track` on a header or lane, `data-chroma-marker` on a flag —
 *   so a query reads `[data-testid="timeline-clip"][data-chroma-clip-id="…"]`.
 *   Encoding the id INTO the test id was considered and rejected: "every
 *   clip" would then need a prefix match that also catches the clip's own
 *   handles.
 *
 * The library-era class names (D-437 S4): until D-437 S4 the edit area, the
 *   playhead and each clip's wrapper were rendered by
 *   `@xzdarcy/react-timeline-editor`, and the harness addressed them by the
 *   library's own class names (`TIMELINE_LIBRARY_SELECTORS`). S4 switched the
 *   pane to Apelles' own lanes (`lanes/`), which carry real test ids (`trackRow`,
 *   `clipSlot`, `scroller`, `playhead`, `playheadHead`, `playheadBand`) AND, as a
 *   transitional alias, the old class names (`TIMELINE_LIBRARY_ALIAS_CLASSES`),
 *   so every harness scenario and DOM suite runs unchanged across the switch.
 *   The aliases are selectors only: no stylesheet may style them
 *   (`timelineOverrides.test.ts`). D-437 S6 moves the harness to the test ids
 *   and deletes both objects.

 * Test ids are inert in production (an attribute nothing in the app reads),
 *   which is why they are not compile-gated the way the debug tooling is.
 */

export const TIMELINE_TEST_IDS = {
  /** The edit area wrapper. Also carries the view readout below. */
  editArea: 'timeline-edit-area',
  /** One clip body (`ClipBody`) — the dnd-kit drag source. */
  clip: 'timeline-clip',
  /** A clip's fade-in / fade-out corner handle (`ClipFadeOverlay`). */
  clipFadeIn: 'timeline-clip-fade-in',
  clipFadeOut: 'timeline-clip-fade-out',
  /** D-432 P2 — a clip's own edge-trim zones (they replaced the library's
   *  interact.js stretch handles, B-344): ≥ 8 px inside each edge, both sides
   *  of a cut together 16 px. The edge is in `data-chroma-trim-edge`. */
  clipTrimStart: 'timeline-clip-trim-start',
  clipTrimEnd: 'timeline-clip-trim-end',
  /** D-432 P2 — the clip anatomy: the name strip, the filmstrip band, the
   *  video's own waveform band (an audio clip's waveform area is the band). */
  clipStrip: 'timeline-clip-strip',
  clipFilm: 'timeline-clip-film',
  clipBand: 'timeline-clip-band',
  /** D-432 P2 — the strip's keyframes badge, which opens the curve lane. */
  clipKeyframesBadge: 'timeline-clip-keyframes-badge',
  /** One track's row in the edit area (`TrackDropZone` — pointer-transparent,
   *  so it is a geometry target: "the lane of track N"). */
  trackLane: 'timeline-track-lane',
  /** D-437 — the lane renderer's own parts (`lanes/`): one track's lane row
   *  (carries `data-chroma-track`), a clip's positioning slot (also
   *  `data-chroma-clip-slot`; the `timeline-clip` body is inside it), the
   *  native scroller, and the playhead's line, head (in the ruler) and grab
   *  band (under it). Since S4 the pane renders them; they also carry the
   *  library-era class aliases below until S6. */
  trackRow: 'timeline-track-row',
  clipSlot: 'timeline-clip-slot',
  scroller: 'timeline-scroller',
  playhead: 'timeline-playhead',
  playheadHead: 'timeline-playhead-head',
  playheadBand: 'timeline-playhead-band',
  /** One track's header in the left column, and its buttons. */
  trackHeader: 'timeline-track-header',
  trackLock: 'timeline-track-lock',
  trackSyncLock: 'timeline-track-sync-lock',
  trackHide: 'timeline-track-hide',
  trackMute: 'timeline-track-mute',
  trackBeats: 'timeline-track-beats',
  /** D-432 P3 — the track menu's "Delete track" item (it was a red trash on
   *  every row; the menu opens from `trackMenu` or a right-click). */
  trackRemove: 'timeline-track-remove',
  /** D-432 P3 — the header's anatomy: the `V1` / `A1` ID pill, the name (a
   *  double-click opens `trackNameInput`), the ducking popover trigger, the
   *  `DotsThree` menu and its Rename item, and the bottom-edge height zone of
   *  the header (`trackHeightResize`) and of the lane (`laneHeightResize`),
   *  both carrying `data-chroma-track`. A toggle in its non-default state
   *  carries `data-chroma-active`. */
  trackBadge: 'timeline-track-badge',
  trackName: 'timeline-track-name',
  trackNameInput: 'timeline-track-name-input',
  trackDuck: 'timeline-track-duck',
  trackMenu: 'timeline-track-menu',
  trackRename: 'timeline-track-rename',
  trackHeightResize: 'timeline-track-height-resize',
  laneHeightResize: 'timeline-lane-height-resize',
  /** D-432 P3 — the guide line drawn across the lanes while a track height is
   *  dragged. */
  trackHeightGuide: 'timeline-track-height-guide',
  /** The divider between the track-header column and the edit area. Passed as
   *  the handle's `id`, NOT `data-testid`: react-resizable-panels 4.x writes
   *  `data-testid` from its `id`, overwriting any prop (H7). */
  headerResize: 'timeline-header-resize',
  /** The divider above the curve-editor lane (present only while it is open). */
  curveResize: 'timeline-curve-resize',
  /** Toolbar. */
  split: 'timeline-split',
  delete: 'timeline-delete',
  link: 'timeline-link',
  unlink: 'timeline-unlink',
  removeGap: 'timeline-remove-gap',
  zoomIn: 'timeline-zoom-in',
  zoomOut: 'timeline-zoom-out',
  zoomReadout: 'timeline-zoom-readout',
  addMarker: 'timeline-add-marker',
  markerList: 'timeline-marker-list',
  /** D-432 P3 — the view toggles and the Clip Appearance popover
   *  (`TimelineViewControls.tsx`): Snapping (N), Skimming (S), the popover's
   *  trigger and body, its zoom slider and its names / badges switches. The
   *  height and balance buttons carry `data-chroma-clip-height` /
   *  `data-chroma-band-ratio`. */
  snappingToggle: 'timeline-snapping-toggle',
  skimmingToggle: 'timeline-skimming-toggle',
  clipAppearance: 'timeline-clip-appearance',
  clipAppearancePopover: 'timeline-clip-appearance-popover',
  zoomSlider: 'timeline-zoom-slider',
  showClipNames: 'timeline-show-clip-names',
  showClipBadges: 'timeline-show-clip-badges',
  /** One trim-palette tool button; the tool id is in `data-chroma-trim-tool`. */
  trimTool: 'timeline-trim-tool',
  /** One marker flag; its id is in `data-chroma-marker`. D-432 P3: a drag
   *  moves it; the editor popover is `markerEditor`. */
  marker: 'timeline-marker',
  markerEditor: 'timeline-marker-editor',
  /** D-432 P3 — our own time ruler (`TimelineRuler.tsx`; press seeks, drag
   *  scrubs, B-350) and one of its labels. The ruler carries
   *  `data-chroma-tick-seconds` / `data-chroma-tick-split`. */
  ruler: 'timeline-ruler',
  /** D-432 P3 — the skim line (skimming on, pointer over the timeline) and
   *  the viewer's two-up trim overlay (`TwoUpViewer.tsx`, roll / slip / slide
   *  drags only; each half carries `data-chroma-two-up-half`). */
  skimLine: 'timeline-skim-line',
  twoUpViewer: 'timeline-two-up-viewer',
  rulerLabel: 'timeline-ruler-label',
  /** One transition badge on a cut. */
  transition: 'timeline-transition',
  /** Overlays. */
  marquee: 'timeline-marquee',
  gapSelection: 'timeline-gap-selection',
  dragGhost: 'timeline-drag-ghost',
  /** D-432 P2 — the edit-gesture feedback layer (`EditFeedbackLayer`): the
   *  trim bracket(s) (`data-chroma-bracket-side` in/out, `data-chroma-limit`),
   *  the edge-pinned delta readout, the snap guide and the blade cut line. */
  editBracket: 'timeline-edit-bracket',
  editReadout: 'timeline-edit-readout',
  snapGuide: 'timeline-snap-guide',
  bladeLine: 'timeline-blade-line',
} as const;

export type TimelineTestId = (typeof TIMELINE_TEST_IDS)[keyof typeof TIMELINE_TEST_IDS];

/** D-437 S4 — the class names `@xzdarcy/react-timeline-editor` gave these parts,
 *  now written by Apelles' own lanes onto the elements that replaced them, so a
 *  selector written against the library keeps matching (see the module doc).
 *  One definition: the lane components read their alias from here, and
 *  `TIMELINE_LIBRARY_SELECTORS` is derived from it. Inert: no stylesheet styles
 *  them. Deleted by D-437 S6 together with the selectors below. */
export const TIMELINE_LIBRARY_ALIAS_CLASSES = {
  /** On the playhead line (`TIMELINE_TEST_IDS.playhead`). */
  playhead: 'timeline-editor-cursor',
  /** On the playhead's head, in the ruler (`TIMELINE_TEST_IDS.playheadHead`). */
  playheadHandle: 'timeline-editor-cursor-top',
  /** On the playhead's grab band under the ruler (`TIMELINE_TEST_IDS.playheadBand`):
   *  with the head, the only part of the playhead that takes the pointer (B-346, B-349). */
  playheadBand: 'timeline-editor-cursor-area',
  /** On each clip's positioning slot (`TIMELINE_TEST_IDS.clipSlot`). */
  action: 'timeline-editor-action',
  /** On the native scroller (`TIMELINE_TEST_IDS.scroller`). */
  scroller: 'timeline-editor-edit-area',
  /** On each track's lane row (`TIMELINE_TEST_IDS.trackRow`). */
  row: 'timeline-editor-edit-row',
} as const;

/** The library-era selectors (`.` + `TIMELINE_LIBRARY_ALIAS_CLASSES`), kept so the UI
 *  harness compiles and runs unchanged across D-437 S4. Each still names a class the
 *  installed library styles (pinned by `timelineTestIds.test.ts` until S5 removes the
 *  package); S6 moves the harness to `TIMELINE_TEST_IDS` and deletes this. */
export const TIMELINE_LIBRARY_SELECTORS = {
  /** The playhead line, and the grab handle at its top. */
  playhead: `.${TIMELINE_LIBRARY_ALIAS_CLASSES.playhead}`,
  playheadHandle: `.${TIMELINE_LIBRARY_ALIAS_CLASSES.playheadHandle}`,
  /** The playhead's head band under the ruler: the only part of it that takes the pointer (B-346, B-349). */
  playheadBand: `.${TIMELINE_LIBRARY_ALIAS_CLASSES.playheadBand}`,
  /** Each clip's positioning slot (the library's "action" wrapper). */
  action: `.${TIMELINE_LIBRARY_ALIAS_CLASSES.action}`,
  /** The timeline's scroll container (its native scrollbars live here). */
  scroller: `.${TIMELINE_LIBRARY_ALIAS_CLASSES.scroller}`,
} as const;

/** The view readout on the edit area (D-434) — the zoom and scroll that live
 *  in `useTimelineViewStore` (zoom) and `TimelinePane`'s own React state (scroll), plus the layout
 *  constants that turn a frame into a pixel, written as data attributes so a
 *  test can assert on them — and aim at "frame 90 on track 1" — without
 *  reaching into a component. Read with `Number(el.getAttribute(...))`.
 *
 *  A frame's x in viewport px is
 *  `areaRect.left + startLeft + (frame / fps) * pxPerSec - scrollLeft`, and a
 *  track row's top is `areaRect.top + rowsTop + track * rowHeight - scrollTop`
 *  — the same arithmetic `TimelinePane` positions every overlay with. */
export const TIMELINE_VIEW_ATTRS = {
  pxPerSec: 'data-chroma-px-per-sec',
  scrollLeft: 'data-chroma-scroll-left',
  scrollTop: 'data-chroma-scroll-top',
  fps: 'data-chroma-fps',
  startLeft: 'data-chroma-start-left',
  rowHeight: 'data-chroma-row-height',
  rowsTop: 'data-chroma-rows-top',
  /** D-432 P3 — every row's top below `rowsTop`, comma-separated, one entry
   *  past the last row (tracks have their own heights; `rowHeight` is the
   *  view's default). */
  rowTops: 'data-chroma-row-tops',
} as const;
