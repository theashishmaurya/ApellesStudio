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
 * What it does NOT cover: parts the timeline LIBRARY renders itself
 *   (`@xzdarcy/react-timeline-editor` — the ruler, the playhead, a clip's two
 *   edge-trim handles). Those elements are not ours to put attributes on; the
 *   harness addresses them by the library's own class names in
 *   `TIMELINE_LIBRARY_SELECTORS` below, and a test pins those names against
 *   the installed library so an upgrade that renames one fails loudly.
 *
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
  /** One track's row in the edit area (`TrackDropZone` — pointer-transparent,
   *  so it is a geometry target: "the lane of track N"). */
  trackLane: 'timeline-track-lane',
  /** One track's header in the left column, and its buttons. */
  trackHeader: 'timeline-track-header',
  trackLock: 'timeline-track-lock',
  trackSyncLock: 'timeline-track-sync-lock',
  trackHide: 'timeline-track-hide',
  trackMute: 'timeline-track-mute',
  trackBeats: 'timeline-track-beats',
  trackRemove: 'timeline-track-remove',
  /** The divider between the track-header column and the edit area. */
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
  /** One trim-palette tool button; the tool id is in `data-chroma-trim-tool`. */
  trimTool: 'timeline-trim-tool',
  /** One marker flag; its id is in `data-chroma-marker`. */
  marker: 'timeline-marker',
  /** One transition badge on a cut. */
  transition: 'timeline-transition',
  /** Overlays. */
  marquee: 'timeline-marquee',
  gapSelection: 'timeline-gap-selection',
  dragGhost: 'timeline-drag-ghost',
} as const;

export type TimelineTestId = (typeof TIMELINE_TEST_IDS)[keyof typeof TIMELINE_TEST_IDS];

/** The library-rendered parts, by the library's own class names (pinned by
 *  `timelineTestIds.test.ts` against the installed package's stylesheet). */
export const TIMELINE_LIBRARY_SELECTORS = {
  /** The ruler — a click seeks, a drag scrubs. */
  ruler: '.timeline-editor-time-area',
  /** The playhead line, and the grab handle at its top. */
  playhead: '.timeline-editor-cursor',
  playheadHandle: '.timeline-editor-cursor-top',
  /** The wrapper the library draws around each clip. */
  action: '.timeline-editor-action',
  /** A clip's left / right edge-trim zone (interact.js resize). */
  trimLeft: '.timeline-editor-action-left-stretch',
  trimRight: '.timeline-editor-action-right-stretch',
  /** The library's own scroll container (its native scrollbars live here). */
  scroller: '.timeline-editor-edit-area',
} as const;

/** The view readout on the edit area (D-434) — the zoom and scroll that live
 *  in `TimelinePane`'s own React state rather than a store, plus the layout
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
} as const;
