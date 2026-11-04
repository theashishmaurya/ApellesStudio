/**
 * @apelles/editor — the timeline strip (D-041; drag-to-track D-046 pass 3;
 * mature-timeline-UI pass D-051; position-model + ruler fixes D-058;
 * multi-track UI D-080; own lanes D-437 S4).
 *
 * **D-437 S4 — read this first.** The edit area no longer renders
 * `@xzdarcy/react-timeline-editor`. It renders Apelles' own lanes
 * (`lanes/TimelineLanes.tsx`: one native scroller, a `TrackLane` per track, a
 * memoised `LaneClip` per clip in the scroll window) and playhead
 * (`lanes/Playhead.tsx`, transform-only, driven through a handle). This pane
 * keeps its role: state, handlers, overlays, the toolbar. The notes below that
 * describe the library ("action", `buildRows`, `getActionRender`, its
 * `ScrollSync`, its CSS) are the history of decisions that still hold for the
 * behaviour; where they name a library mechanism, read: lane slot
 * (`[data-chroma-clip-slot]`) for its action wrapper, `laneActions.onClipClick`
 * for `onClickAction`, the scroller's `scroll` event for its `onScroll`, a
 * `scroller.scrollLeft` write for `setScrollLeft`, `playheadRef.setFrame` for
 * `setTime`. D-437 S5 rewrites these notes when it deletes the package. Plan:
 * `docs/notes/timeline-lanes.md`.
 *
 * Scroll (D-437 S8): the scroll position is NOT React state. A per-pane store
 * (`lanes/timelineScroll.ts`) mirrors the native scroller; a scroll renders
 * this pane zero times. Handlers read it at event time, `applyScrollSinks`
 * writes the header column's `translateY`, the playhead and the view
 * attributes, the lanes and the pinned strips (ruler, beat lane, markers,
 * curve lane) subscribe for themselves, and the row/frame overlays
 * (transitions, gap highlight, drag ghosts, marquee, drop and height zones)
 * are rendered inside the scroller's content so they scroll natively. Where
 * the notes below say "`scrollLeft` state", read: the scroll store.
 *
 * `@xzdarcy/react-timeline-editor` with one row PER TRACK (D-080 — was one
 * fixed row, the video track, before this pass). Each clip is an "action".
 * Drag the body → `move` (same-track only, see below); drag an edge →
 * `trim_start` / `trim_end` (or, held with Alt/Option, the context-sensitive
 * ripple/roll/slip/slide of D-235 — see its own note below); "Split at
 * playhead" → `split`; select + Delete
 * / × → `remove`; drop a Sources-panel pool item onto a lane → `add_clip`
 * on that lane's track. Every edit goes through the store (`applyOp` →
 * debounced `chroma_timeline_set` → `chroma_timeline_get` refetch). Time in
 * the editor is seconds (frame / fps).
 *
 * D-058: every clip's on-screen position is read from its own `start_frame`
 * (`timeline.ts`'s `Clip.start_frame`, mirroring `apelles-timeline`'s D-054
 * field) — not re-derived from summed preceding durations, which is what
 * this file did before this pass and is the actual root cause of "drag from
 * Sources doesn't work" / "edge-trim doesn't work" (see D-058 in
 * `docs/08-decisions.md` for the full bug writeup). A gap can now genuinely
 * appear on screen (after a left-edge trim, or a remove) — that's real,
 * matches what's on disk, and is exactly what a normal NLE's non-ripple trim
 * looks like, not a glitch.
 *
 * D-080 (multi-track UI, Phase D of `docs/notes/multi-track-nle.md`) — what
 * changed and why, since this is the biggest structural change to this file
 * since D-058:
 *   - **One `TimelineRow` per track**, not a single hardcoded video row —
 *     `buildRows` (was `buildRow`) walks every `timeline.tracks` entry.
 *     `row.id` is the track's own index as a string (`"0"`, `"1"`, …), the
 *     one stable way to map a library row back to `timeline.tracks[i]`
 *     inside `getActionRender`/the click/drag callbacks, which the library
 *     always hands back the *row* for.
 *   - **Track headers are NOT a library feature** — checked its bundled
 *     types before building this (`EditData`/`TimelineEditor` in
 *     `interface/timeline.d.ts` has no `getRowHeaderRender` or similar,
 *     only `getActionRender`/`getScaleRender` for action/ruler content).
 *     So the header column is a fully custom sidebar to the LEFT of the
 *     library's own scrollable edit area, one block per
 *     track, kept in vertical sync with the library's own scroll via its
 *     `onScroll` prop (`OnScrollParams.scrollTop`, from `react-virtualized`
 *     — the library's own scroll mechanism) applied as a CSS transform.
 *   - **No native cross-row (cross-track) drag** — checked before building
 *     D-080: `onActionMoveEnd`'s `row` param is always the action's
 *     *starting* row, and there is no drop-target-row concept anywhere in
 *     the library's own action-drag path. D-080 shipped a "Move to ▾"
 *     toolbar dropdown instead (kept below as a fallback affordance — see
 *     D-094). **D-094 adds the real drag gesture**: each clip's rendered
 *     content (`getActionRender`) gets a small `DotsSixVertical` handle at its
 *     top-left, inset past the 10px left-edge resize zone so it doesn't
 *     shadow `flexible`'s resize hit-testing (same B-013 concern the label
 *     overlay already had to solve). That handle is plain HTML5
 *     `draggable`, carrying `{ track, id }` as `CHROMA_CLIP_MOVE_MIME` JSON
 *     (`timeline.ts`) — the exact same drag/drop mechanism this file
 *     already used for Sources-panel → timeline drops, just a second MIME
 *     type the shared `onDragOver`/`onDrop` on the edit area now also
 *     recognizes. Its `onMouseDown`/`onPointerDown` call `stopPropagation`
 *     so the press never reaches the library's own interact.js listener
 *     bound to the action wrapper (which would otherwise also try to start
 *     its native same-track move-drag from the same physical mousedown) —
 *     the two drag systems never both engage from one gesture because the
 *     handle is a distinct hit-target from the rest of the clip body, not
 *     because either system defers to the other. A drop lands via the same
 *     `dropTargetTrack` row-from-`clientY` math the Sources-panel path
 *     already uses; a same-track drop of the clip-move payload is a no-op
 *     here (the library's own drag already owns same-row repositioning).
 *     **D-098 superseded this native-HTML5 mechanism** (and D-097's own
 *     track-reorder equivalent) with real `@dnd-kit/core`/`@dnd-kit/
 *     sortable` drags — native HTML5 `draggable` was reported live as
 *     unreliable on Tauri's macOS WKWebView twice, despite passing this
 *     session's own Chromium-based harness checks each time. See D-098 in
 *     `docs/08-decisions.md`, and `ClipMoveHandle`/`SortableTrackHeader`/
 *     `TrackDropZone` (module scope, below) for the current mechanism. The
 *     "distinct hit-target, not either-defers-to-the-other" coexistence
 *     principle above is unchanged — only the drag API underneath it is.
 *     **B-122 — every `@dnd-kit` payload in this file is now named and
 *     narrowed by `dndTargets.ts`, not asserted inline.** `SortableTrackHeader`
 *     is a DROPPABLE as well as a draggable (every `useSortable` item is), and
 *     it and `TrackDropZone` both used to answer to `type: 'track'` with
 *     differently-shaped payloads — so a clip dropped on a track header read as
 *     a lane drop with `track: undefined` and crashed the app inside
 *     `resolveClipLanding`. The discriminators are `'track-header'` and
 *     `'track-lane'` now, and `asClipDrag`/`asTrackHeaderDrag`/`laneDropTrack`/
 *     `headerDropIndex` validate at runtime — including that a track index
 *     names a track that actually exists — so no handler here can be handed an
 *     index it must remember to bounds-check.
 *   - **Dropping a Sources-panel clip targets whichever lane the cursor is
 *     over** (D-046 pass 3's plain-HTML5-drag mechanism, now row-aware) —
 *     `dropTargetTrack` converts `e.clientY` into a row index using the
 *     layout constants (`RULER_AND_MARGIN_PX`: the ruler plus the marker
 *     strip) plus the tracked
 *     `scrollTop`, clamped to a real track index. Falls back to the first
 *     video track if the drop lands above/below every row (e.g. on the
 *     ruler itself) — same default this file always had.
 *   - **Selection is now `{ track, id }`, not a bare action id** — with only
 *     one track before this pass, an action id alone was unambiguous;
 *     `Split`/`Remove`/the new `Move to ▾` all need to know *which track's*
 *     clip list a selected id lives in now.
 *   - **`Split` now requires a selection** (was: split whatever's on "the"
 *     video track under the playhead, regardless of selection — there was
 *     only ever one track to mean). With N tracks, "split at playhead"
 *     needs to know which track's clip to split; the natural, standard-NLE
 *     reading is "the selected one." A behavioural refinement, not a
 *     regression — flagged in D-080's own decision writeup.
 *   - **Track headers: kind icon, a running per-kind number ("Video 1",
 *     "Audio 1", "Video 2", …), a mute toggle for audio tracks** (writes
 *     `Track.gain` — D-057's existing field the real audio mixer already
 *     reads, `0` muted / `1` unmuted — "muted" has no separate boolean to
 *     drift out of sync with), **and a remove-track button**. "Lock" /
 *     "solo" are real standard-NLE affordances but have no backing model
 *     field anywhere yet (`apelles_timeline::Track` has no `locked`/`solo`)
 *     — not built this pass rather than faked with only-frontend state that
 *     `chroma_timeline_set`'s verbatim-storage contract wouldn't actually
 *     persist.
 *
 * D-051 (mature timeline UI) additions, scoped against what
 * `@xzdarcy/react-timeline-editor` v1.0.0 already does natively — see that
 * decision for the full library-vs-custom breakdown:
 *   - **Edge-trim was native** (`flexible: true`, interact.js) until D-432
 *     P2 replaced it with the clip's own edge zones and `useEditGesture.ts`
 *     (B-344: the library's snap accumulator lost pointer travel; B-345: it
 *     could not preview a ripple or a roll). Snapping for edits is now
 *     `editGesture.ts`'s `snapFrame`.
 *   - **Scroll-wheel zoom is custom** (the library has no wheel handling at
 *     all) — a non-passive native `wheel` listener on the edit-area wrapper
 *     rescales `pxPerSec`; the toolbar's zoom in/out buttons drive the same
 *     state for a discoverable, non-mouse-wheel-only affordance.
 *   - **The waveform is custom** (`Waveform.tsx`, Rust-computed peaks) —
 *     the library renders only the plain `getActionRender` content per
 *     action, nothing audio-aware.
 *   - **The filmstrip needs the scroll viewport, not just the clip** (D-128).
 *     `Filmstrip.tsx` fetches picture tiles only for the source range a clip
 *     is actually showing, at a density matching the current zoom, so this
 *     pane passes each clip its visible sub-range in px. `scrollLeft` is
 *     bucketed to `FILMSTRIP_SCROLL_BUCKET_PX` first — `getActionRender`
 *     rebuilds every clip's DOM when its inputs change, and feeding it a raw
 *     per-pixel scroll position would run that on every scroll frame.
 *   - **Ripple visual feedback is custom**: a small effect diffs each
 *     clip id's timeline start frame across every track's clips changes and
 *     briefly `animate-pulse`s whichever ids shifted — a trim/remove/move
 *     that shifts a clip is visibly, not just numerically, felt. (D-058: a
 *     trim/remove no longer *ripples* downstream clips by construction —
 *     see the position-model note above — so this now mostly fires for a
 *     `move`; kept as-is since a future ripple-mode trim would want it too.)
 *
 * D-137 (marquee-select, roadmap item 12 Phase 2) — a SECOND pointer gesture
 * on this surface, which is the whole reason it warrants a note here rather
 * than just a comment at its own code. A click-drag on empty edit-area canvas
 * rubber-bands a selection; the pure half (what may start one, the activation
 * threshold, the intersection, the modifier composition, the overlay
 * geometry) is `marquee.ts`, unit-tested. **It cannot collide with the clip
 * drag above, structurally**: dnd-kit's `PointerSensor` activator is an
 * `onPointerDown` prop `useDraggable` puts on `ClipBody` and — inside this
 * edit area — nowhere else, so `ClipBody` carries `data-chroma-clip-drag` and
 * `canStartMarquee` refuses any press with that attribute on its propagation
 * path. The two gestures are separated by DOM position, not by ordering,
 * precedence or `stopPropagation` — see D-137 §1 and the block comment at the
 * gesture's own code below for why that distinction is the entire point,
 * given D-094–D-100.
 *
 * D-207 (on-clip fade handles) — a THIRD pointer gesture on this surface, and
 * the reason it is noted here alongside D-137's: each clip's rendered content
 * now carries a `ClipFadeOverlay` drawing its `fade_in_frames`/
 * `fade_out_frames` rubber band, with a small handle at each ramp's top that
 * drags to set the fade live and commits ONE `set_clip_fade` op on pointer-up
 * (the same op, undo stack and persist path the Inspector's numeric Fade field
 * already used — the two are views of one field, never two states). It cannot
 * collide with the clip drag or the marquee, structurally, for the same reason
 * they cannot collide with each other: the handle is a distinct hit target
 * inside `ClipBody` that `stopPropagation`s the press, and every press in that
 * subtree already carries `data-chroma-clip-drag`, which `canStartMarquee`
 * refuses. Against the library's own full-height 10px edge-trim handles it is
 * separated by WHERE IN THE ROW the press lands (a 15px-tall grab target at
 * the clip's top edge; the lower ~37px of both trim zones are untouched) —
 * see `ClipFadeOverlay.tsx`'s own doc for the full coexistence story, and
 * `clipFade.ts` for the pure geometry, which is where all of the math lives.
 *
 * D-222 (timeline markers) — a FOURTH interactive surface on this pane, and
 * the first that lives in the ruler band rather than over the tracks:
 * `MarkerStrip` (`TimelineMarkers.tsx`) draws one coloured flag per
 * `Timeline.markers` entry in the gap between the library's 32px ruler and
 * track row 0 (the lanes leave `MARKER_STRIP_HEIGHT` of room for it)
 * for the purpose — so `RULER_AND_MARGIN_PX` is now derived from that
 * constant instead of being the library's own fixed 42. It cannot collide
 * with the marquee (D-137), the clip drag (D-098) or the fade handles
 * (D-207): the strip carries `data-chroma-no-marquee`, the escape hatch
 * `marquee.ts` already documents, and its flags are distinct hit targets that
 * stop their own presses — the same "separated by DOM position" principle,
 * not by ordering or precedence. Everything else in the strip is
 * `pointer-events-none`, so an ordinary press in that band still reaches the
 * library beneath it.
 *
 * D-235 (context-sensitive trim, roadmap item 27) — a FIFTH gesture family, and
 * the only one that adds no new pointer listener at all. Holding Alt/Option
 * ARMS the smart trim tool; while armed, the two drags this pane already has
 * mean something else, chosen by where the pointer is: an edge that touches a
 * neighbour ROLLS that edit point, a free edge RIPPLES, the upper half of a
 * clip's body SLIPS its source window, the lower half SLIDES it between its
 * neighbours (Shift forces ripple at an edit point). Unarmed, both drags are
 * exactly what they were — `move` (D-100) and the plain gap-leaving trim
 * (D-058) — so this is additive, not a re-mapping.
 *
 * D-432 P2: the press is resolved once (`resolveTrimMode`, `trimMode.ts`,
 * pure and unit-tested) in the clip body's capture phase by
 * `useEditGesture.ts`, which claims every non-move edit before dnd-kit's move
 * can start and previews the real op live; the marquee, fade handles and
 * marker flags are separate hit targets it stands aside for.
 *
 * D-261 — that trim tool now has a real, visible PALETTE, and it is the primary
 * way in: a Select/Ripple/Roll/Slip/Slide icon group in this toolbar
 * (`TrimToolbar.tsx`), from Adobe's own Premiere Tools panel
 * (`scratch/premiere-tools-reference/`). The owner's own words after living
 * with the Alt-only version: *"for roll slip etc, instead of alt lets have
 * icons for all of them :) much better."* The gesture plumbing here is
 * unchanged — the active tool is simply captured onto `trimPressRef` alongside
 * the modifiers, and `resolveTrimMode` consults it first. The Alt heuristic is
 * kept and strictly layered under it (Alt acts only while Select is active), so
 * the two rules can never both claim one drag.
 *
 * D-248 (the left library rail) — this pane's native-HTML5 drop now accepts a
 * SECOND payload: `CHROMA_GENERATOR_DRAG_MIME`, a title or an adjustment clip
 * dragged out of `EditLibraryRail.tsx`. It is not a second drop path — both
 * payloads go through one `placeDroppedClip`, so a dragged generator snaps to
 * an edge, ripples and creates a track by exactly the rules a dragged Sources
 * item does. It is a second MIME TYPE rather than a field inside the media one
 * because `dataTransfer.getData` is unreadable during `dragover` (see
 * `onDragOver`'s own note), so the type name is all a live preview can branch
 * on. The Title and Adjust buttons that used to sit in this toolbar moved to
 * that rail with the feature; what is left here acts on the timeline you
 * already have. The transitions palette (D-226) deliberately stays, because
 * its target is a cut resolved through this pane's own `DndContext`.
 *
 * B-116 (anchored zoom) — every zoom, from the ctrl/pinch wheel or the
 * toolbar's +/-, goes through one `zoomBy(factor, anchorClientX)`: it records
 * the frame under the anchor before `pxPerSec` changes and an effect puts that
 * frame back at the same viewport x afterwards (it must be an effect — the
 * library derives its scrollable width from `scaleWidth`, so a scroll issued
 * before the re-render is clamped against the old width). The arithmetic is
 * `timelineZoom.ts`, pure and unit-tested. A wheel anchors on the cursor; a
 * button, which has none, anchors on the playhead (viewport centre if the
 * playhead is off screen).
 *
 * D-058 (ruler): tick labels are real timecode (D-432 P3: `ruler.ts`'s
 * `formatRulerLabel`, `0:05` / `1:02:10`, frames only at frame-level zoom)
 * via `getScaleRender`, the minor-tick density follows the zoom
 * (`rulerSplitCount`), and the labeled-tick interval
 * (`scale`, seconds) is recomputed from `pxPerSec` on every zoom change via
 * `niceTickIntervalSeconds` — the library's own `scale` prop is a single
 * fixed value with no adaptive-density concept of its own (checked in its
 * bundled source before writing this).
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type UIEvent,
} from 'react';
import './timeline.css';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
  type Modifier,
} from '@dnd-kit/core';
import { SortableContext, verticalListSortingStrategy } from '@dnd-kit/sortable';
import {
  ArrowsLeftRightIcon,
  ArrowsInLineHorizontalIcon,
  // D-138 — the A/V-link action's own icon. Deliberately `Link`, not
  // `LinkSimpleHorizontal`: that one is the track header's sync-lock-ON icon
  // (`TrackHeader.tsx`), and sync-lock and an A/V link are different
  // relationships (see `avLinkedIds`), so they must not share an icon.
  LinkIcon,
  TrashIcon,
  // D-128 — the A/V-unlink action. Deliberately `LinkBreak`, not the header's
  // `LinkSimpleHorizontalBreak` sync-lock toggle, for the same reason.
  LinkBreakIcon,
  SplitHorizontalIcon,
  MagnifyingGlassPlusIcon,
  MagnifyingGlassMinusIcon,
} from '@phosphor-icons/react';
import { snapSpan, snapTo } from '@apelles/beats';
import { beatFramesOf } from './beatGrid';
import { followScrollLeft, seekFollowScrollLeft } from './playbackFollow';
import { setBeatGrid, snapCutsToBeats } from './beatOps';
import { BeatLane } from './TimelineBeats';
import { useTimelineBeats } from './useTimelineBeats';
import {
  Button,
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Separator,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@apelles/ui';
import { useShortcut } from '@apelles/keymap';

import { useEditorTimelineStore, type Selection } from './timelineStore';
import { animatedParams } from './clipKeyframes';
import { ClipCurveEditor } from './ClipCurveEditor';
import {
  AddMarkerButton,
  MarkerStrip,
  MARKER_STRIP_HEIGHT,
} from './TimelineMarkers';
import { TimelineRange } from './TimelineRange';
import { rippleDeleteClips } from './rippleDeleteSelection';
import {
  TransitionBadges,
  TransitionsPaletteButton,
  TRANSITION_SNAP_PX,
  defaultTransitionFrames,
  nearestCut,
  type TransitionDragData,
  type TransitionPatch,
} from './TimelineTransitions';
import { beginScrub, endScrub, isScrubbing, updateScrub } from './scrubAudio';
// D-437 S4 — Apelles' own lane renderer and playhead (they replaced the library's).
import { TimelineLanes } from './lanes/TimelineLanes';
import { Playhead, type PlayheadHandle } from './lanes/Playhead';
import { useLaneActions } from './lanes/useLaneActions';
import { createTimelineScrollStore, setTimelineScroll, WithScrollLeft, type TimelineScrollState } from './lanes/timelineScroll';
// D-432 P2 — the clip block's anatomy (the drag ghost), the edit gestures and their feedback layer.
import { ClipBlock, CLIP_KIND_CLASSES } from './ClipBlock';
import { clipKindOf, cutStyleAt, CLIP_VERTICAL_INSET_PX } from './clipAnatomy';
import { EditFeedbackLayer, type EditFeedbackHandle } from './EditFeedbackLayer';
import { snapTargets } from './editGesture';
import { useEditGesture } from './useEditGesture';
import { TIMELINE_TEST_IDS, TIMELINE_VIEW_ATTRS } from './timelineTestIds';
import {
  niceTickIntervalSeconds,
  DEFAULT_PX_PER_SEC,
  RULER_HEIGHT_PX,
} from './ruler';
// D-434 / H2 — the zoom lives in a store so MCP can set and read it.
import { clampPxPerSec, perTimelineView, useTimelineViewStore } from './timelineView';
// B-116 — anchored zoom: keep whatever is under the cursor (wheel) or the
// playhead (buttons) under it across a zoom step.
import {
  buttonZoomAnchorX,
  createZoomCoalescer,
  frameAtViewportX,
  gestureZoomFactor,
  pinchZoomFactor,
  scrollLeftForAnchor,
  type WebKitGestureEvent,
} from './timelineZoom';
// B-145 — the one place a dnd-kit drag's displacement is derived. NOT
// `event.delta`, which is corrupted by this pane's own scroll container — see
// that module's doc for the full mechanism.
import { dragDelta, type DragDelta, type ScrollOffset } from './dragDelta';
// B-160 — the live drag-preview overlays, and the state that drives them, live
// in their own component so a drag tick does not re-render this whole pane.
import { TimelineDragPreview, type TimelineDragPreviewHandle } from './TimelineDragPreview';
// B-122 — the one place the `@dnd-kit` payload shapes are named, and the
// validating narrowings that replaced this file's six inline `as` casts.
import {
  asClipDrag,
  asTrackHeaderDrag,
  headerDropIndex,
  laneDropTrack,
  type ClipDragData,
  type TrackHeaderDragData,
  type TrackLaneDropData,
} from './dndTargets';
import {
  CHROMA_GENERATOR_DRAG_MIME,
  CHROMA_MEDIA_DRAG_MIME,
  GENERATOR_LABELS,
  clipFromDraggedGenerator,
  DEFAULT_DUCK_ATTACK_MS,
  DEFAULT_DUCK_RELEASE_MS,
  DEFAULT_SYNC_LOCKED,
  DEFAULT_TRACK_GAIN,
  checkLink,
  checkRemoveGap,
  checkTransition,
  computeInsertion,
  cutFrames,
  endFrame,
  gapAt,
  newTransition,
  linkedClipIds,
  linkedClipsFromDraggedMedia,
  markersOf,
  newMarker,
  resolveClipLanding,
  sourceFramesToTimeline,
  syncLinkedClipIds,
  timelineFps,
  trackIndexAfterMove,
  videoTrackIndex,
  type Clip,
  type DraggedGenerator,
  type DraggedMedia,
  type LinkCheck,
  type LinkTarget,
  type NewClipFields,
  type Timeline,
  type Track,
} from './timeline';
import {
  edgeIsEditPoint,
  resolveTrimMode,
  trimModeCursor,
  trimModeHint,
  trimModeLabel,
  type TrimMode,
  type TrimTool,
  type TrimZone,
} from './trimMode';
import { TrimToolbar } from './TrimToolbar';
import { dragGhostWindow } from './dragGhost';
import {
  canStartMarquee,
  clipsInMarquee,
  composeMarqueeSelection,
  marqueeActivated,
  marqueeAnchorFromPoint,
  marqueeContentBox,
  marqueeRect,
  type MarqueeAnchor,
  type MarqueeRect,
  type MarqueeGeometry,
} from './marquee';
import { useViewportWidth } from './useViewportWidth';
import { trackBadges, trackLabels } from './trackOps';
import { TrackHeader, trackDragId } from './TrackHeader';
import { ClipAppearanceButton, SnapSkimToggles, TimelineZoomSlider } from './TimelineViewControls';
import { TimelineBeatControl } from './TimelineBeatControl';
import { TimelineEmptyState, TimelineNoClipsHint } from './EditEmptyStates';
import { TimelineRuler } from './TimelineRuler';
import { usePreviewPeekStore } from './previewPeek';
// D-432 P3 — per-track height.
import {
  clampTrackHeight,
  DEFAULT_TRACK_HEIGHT,
  trackAtY,
  trackBoundaryNear,
  trackHeights,
  trackTops,
} from './trackHeight';

/** how many pixels a labeled ruler tick should target, at any zoom (D-058
 *  item 4 — `niceTickIntervalSeconds`'s target, see `ruler.ts`). */
const TICK_TARGET_PX = 70;
// Zoom bounds (px per second) now live in `ruler.ts` and are imported above
// (D-124/D-128) — `Filmstrip.tsx` derives its requested tile spacing from the
// current zoom, and the backend's level-of-detail ladder is sized to bracket
// exactly the range these bounds allow, so one definition beats two that can
// drift (see `ruler.ts`'s own note). Owner, 2026-09-04: the floor was 16
// (18%), too tight to see a whole multi-minute project at once; it is 1 so a
// long timeline can actually be zoomed out to fit the visible width.
const ZOOM_STEP = 1.2;
/** B-357 — px a `DOM_DELTA_LINE` wheel notch scrolls (a browser's own wheel line height). */
const WHEEL_LINE_PX = 16;
/** D-432 §4.3 — a clip that an edit shifted gets ONE opacity flash this long
 *  (ms), from `RIPPLE_FLASH_OPACITY` back to 1. No looping `animate-pulse`. */
const RIPPLE_FLASH_MS = 160;
const RIPPLE_FLASH_OPACITY = 0.55;
/** D-250 — how far below-right of the pointer the armed trim-mode badge sits.
 *  Clear of a standard macOS cursor's own ~16px glyph, so the badge never
 *  covers the thing it is annotating. */
const TRIM_BADGE_OFFSET_PX = 16;
/** Track header sidebar default width (D-080; widened D-090 for the lock/
 *  hide/rearrange row) — now the `ResizablePanel`'s `defaultSize` (D-094:
 *  the sidebar became genuinely resizable, per the owner's standing
 *  "resizable-by-nature panels" rule in `CLAUDE.md`), not a fixed `width`. */
const HEADER_WIDTH = 136;
const HEADER_MIN_WIDTH = 100;
const HEADER_MAX_WIDTH = 280;
/** D-432 P3 — the lane-side height-drag band, px, straddling the line between
 *  two rows (the header's own zone is `TRACK_HEIGHT_ZONE_PX`, all inside its
 *  row). Narrower than the header's so it takes at most a pixel of a clip. */
const LANE_HEIGHT_ZONE_PX = 4;
/** The ruler bar (`ruler.ts`'s `RULER_HEIGHT_PX`) + the marker strip under it
 *  (D-222, `MARKER_STRIP_HEIGHT`), i.e. exactly where row 0 starts on screen:
 *  the lanes' scroller starts here (D-437 S4, `TimelineLanes`'s `topPx`), and
 *  `dropTargetTrack` (D-080) and every absolutely-positioned overlay in this
 *  file use it to convert a `clientY` into a track index (and back). */
const RULER_AND_MARGIN_PX = RULER_HEIGHT_PX + MARKER_STRIP_HEIGHT;
/** px before frame 0 in the lanes' content (D-095; the library's `startLeft`,
 *  kept at the same 32 px by D-437 S4): every frame↔x conversion in this file,
 *  the lanes and the playhead use it. */
const START_LEFT_PX = 32;
/** B-326 — scroll events this soon after the follower's own write are its echo. */
const FOLLOW_ECHO_WINDOW_MS = 100;
/** B-359 item 6 — a paused jump does not move the view within this long of
 *  the user's own last scroll of it (a wheel/trackpad pan still in flight). */
const SEEK_FOLLOW_SCROLL_QUIET_MS = 300;

/** D-233 — the curve lane's default and minimum heights, px.
 *
 *  The default is a little over three track rows, which is the smallest lane
 *  in which a full-range ease reads as a curve rather than as a slightly bent
 *  line — below roughly this, a `ease-in-out`'s two shoulders are a couple of
 *  pixels apart and there is nothing to aim a handle at. The minimum keeps the
 *  header strip and a usable plot on screen when the user drags the split
 *  right down; it is a floor on the pane, NOT a fixed size — the whole point
 *  of the resizable split is that a user authoring a delicate ease can give it
 *  half the timeline. */
const CURVE_LANE_HEIGHT = 180;
const CURVE_LANE_MIN_HEIGHT = 96;
/** D-095/D-096 — how close (in px, independent of zoom) a Sources-panel
 *  drop needs to land to an existing clip edge to snap to it for a ripple
 *  insert, and how close to the bottom of the last track row it needs to
 *  land to trigger the "drop past the last row creates a new track"
 *  affordance instead of landing on the last real one. D-100: widened from
 *  10 — a real, if secondary, contributor to "insert between two touching
 *  clips doesn't work": the primary fix is `computeInsertion`'s new whole-
 *  clip-body fallback (this threshold no longer gates whether snapping
 *  works AT ALL), but 10px was still a tight, easy-to-miss target for a
 *  real mouse specifically aiming for the exact seam between two clips. */
// Gap-on-add: 16px is a tight target to hit precisely with a real mouse
// drag, especially once a clip is only a few dozen pixels wide at a
// zoomed-out view - a drop that visually looks "right next to" a clip can
// still miss a 16px window and fall through to a raw, unsnapped position
// far away. Widened for a more forgiving, still-precise-enough target.
const INSERT_SNAP_PX = 28;
/** D-097 — how wide the "insert a new track here" hit-zone is on EACH side
 *  of the boundary line between two existing track rows, in px, independent
 *  of any track's own height. Deliberately a thin band, not half the row:
 *  most of each row still resolves to "drop onto this existing track" (the
 *  pre-D-097 behaviour) — only hovering close to where two rows actually
 *  meet offers the mid-stack insert. ~22% of the default track height on each side
 *  (~44% combined) was picked as the deliberate trade-off between "reliably
 *  offers the affordance without pixel-perfect aim" and "doesn't eat so
 *  much of each row that an ordinary same-track drop near an edge
 *  accidentally triggers it." */
const TRACK_INSERT_BAND_PX = Math.round(DEFAULT_TRACK_HEIGHT * 0.22);

/** id -> timeline start frame for every clip on every track — the snapshot
 *  the ripple-highlight effect diffs against the previous one (D-080:
 *  generalized from one track's clips to all of them, since a `move` can
 *  now shift a clip across tracks and both its old and new positions should
 *  still be able to ripple-flash if this ever grows a ripple-mode trim). */
function startFramesById(tl: Timeline | null): Map<string, number> {
  const m = new Map<string, number>();
  if (!tl) return m;
  for (const track of tl.tracks) {
    for (const c of track.clips) m.set(c.id, c.start_frame);
  }
  return m;
}

/** D-098 — one droppable target per track, overlaid on the edit area at
 *  that track's real on-screen position (same `RULER_AND_MARGIN_PX +
 *  rowTops[index] - scrollTop` math `TimelineDragPreview`'s overlays already
 *  use). **Always mounted** (not conditionally rendered on an active
 *  drag) — a real bug found live, not assumed: mounting these only once
 *  `activeDrag` flips on meant dnd-kit had to register + measure a brand
 *  new droppable in the middle of an already-in-progress drag, and its
 *  collision detection never caught up in time for the very first
 *  gesture (verified live: the `DragOverlay` ghost tracked the pointer
 *  correctly, but `onDragEnd`'s `event.over` never resolved, so the drop
 *  silently didn't move anything). Kept permanently mounted instead —
 *  `useDroppable`'s registration/measurement then happens at real mount
 *  time, long before any drag starts.
 *
 *  D-100 — `pointer-events` is now `none` UNCONDITIONALLY, not toggled by
 *  `active`. This was the real root cause of the live "stuck ghost /
 *  same-track drag completely blocked" report: dnd-kit's own collision
 *  detection (`rectIntersection`, checked in its bundled source) works
 *  purely off MEASURED RECTS, never off native DOM pointer-event hit-
 *  testing — this element never needed `pointer-events-auto` for dnd-kit
 *  to find it as a drop target, that was a wrong assumption when D-098
 *  wrote it. If `activeDrag` ever got stuck `{type:'clip',...}` (an
 *  interrupted drag whose `onDragEnd`/`onDragCancel` never fired — a real,
 *  plausible gap in a desktop app if the pointer effectively leaves the
 *  window), `active` stayed `true` forever, which meant this FULL-ROW,
 *  `z-20` overlay kept `pointer-events-auto` forever too — silently
 *  intercepting every click/drag/resize on that entire track row,
 *  including the clip underneath, which is exactly what "can't drag in
 *  the same track any more" was. Making this permanently inert removes
 *  the whole bug class regardless of why `activeDrag` got stuck, not just
 *  the one trigger that happened to be found.
 *
 *  D-113 — the full-row `isOver` wash is GONE. Owner, live: "when i drag
 *  and drop it shows whole track as white make only the track length and
 *  where it is actually going to go, placeholder kindda." This element's
 *  full-width `useDroppable` hit target is still correct and necessary —
 *  dnd-kit needs a real drop target spanning the whole row to resolve
 *  which track the pointer is over at all — but the row is no longer
 *  PAINTED at that full width; the real visual feedback is
 *  `TimelineDragPreview`'s own precisely-sized/positioned placeholder overlay
 *  (rendered separately, sized to the dragged clip's actual duration,
 *  positioned at its actual resolved landing frame) plus the sync-linked
 *  ghost previews alongside it. This component stays purely a (now
 *  invisible) hit-testing target. */
function TrackDropZone({ track, top, height }: { track: number; top: number; height: number }) {
  const { setNodeRef } = useDroppable({
    id: `track-drop:${track}`,
    // B-122 — `'track-lane'`, not `'track'`: `SortableTrackHeader` is a
    // droppable too (every sortable is) and used to answer to the same name
    // with a differently-shaped payload. Distinct discriminators are what make
    // `event.over?.data.current` safe to narrow on at all — see `dndTargets.ts`.
    data: { type: 'track-lane' as const, track } satisfies TrackLaneDropData,
  });
  return (
    <div
      ref={setNodeRef}
      // B-145 — a stable hook for a test to find this droppable, the same
      // convention `ClipBody`'s own `data-chroma-*` attributes already use.
      // jsdom has no layout, so a DOM-tier test has to supply this element's
      // real geometry itself before dnd-kit can resolve a drop onto it (see
      // `TimelinePane.clipDrag.dom.test.tsx`) — and it cannot do that without
      // being able to find it.
      data-chroma-track-drop-zone={track}
      // D-434 — the lane of track N as a geometry target for the UI harness
      // ("click empty space on track 1"). Pointer-transparent, so a press
      // aimed at it lands on whatever is really there, which is the point.
      data-testid={TIMELINE_TEST_IDS.trackLane}
      data-chroma-track={track}
      className="pointer-events-none absolute left-0 right-0 z-(--z-timeline-overlay)"
      style={{ top, height }}
    />
  );
}


/** D-432 P5 — `toolbarCenter`: what the Edit tab centres in this pane's
 *  toolbar row (the timeline switcher and timecode, spec §4.9). */
export function TimelinePane({
  toolbarCenter,
  emptyAction,
}: {
  toolbarCenter?: ReactNode;
  /** v0.3.0 (§4.13) — the empty timeline's action (the composition root's
   *  Import button), shown under its one-line instruction. */
  emptyAction?: ReactNode;
}) {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  // D-325 — deliberately NOT `useEditorTimelineStore((s) => s.playhead)`. This
  // is the only component in the codebase where that selector's ordinary
  // per-frame re-render cost (D-290's own "eight components subscribe to
  // playhead" finding) is paid by a ~4500-line, Compiler-bailed-out (B-184)
  // component whose render body walks every clip on every track. Measured:
  // `TimelinePane.playheadCost.measure.dom.test.tsx` — 3.75ms/commit at 2
  // clips, 15.0ms/commit at 96, 27.1ms/commit at 200, scaling with clip count
  // because there is nothing in this file that reads a subscribed playhead
  // reactively — see the effect below and the three `getState().playhead`
  // reads at the split/marker/zoom-anchor call sites, none of which need a
  // re-render to do their job, only the value at the moment they run.
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);
  const editingMarkerId = useEditorTimelineStore((s) => s.editingMarkerId);
  const setEditingMarkerId = useEditorTimelineStore((s) => s.setEditingMarkerId);
  // B-326 — a click-to-seek keeps a running transport running (re-baselined).
  const seekPlayhead = useEditorTimelineStore((s) => s.seekPlayhead);
  // D-232 — grabbing the playhead during playback pauses it, the way every
  // reference NLE does and the way the player's own position bar already did.
  // It is also what keeps the ONE audio transport coherent: a scrub claims it,
  // so a play session left nominally running would have lost its sound anyway.
  const setPlaying = useEditorTimelineStore((s) => s.setPlaying);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  /** Multi-select, Phase 1 (D-107, `docs/notes/multi-select.md`) — an array
   *  of the same `{track, id}` shape D-080 always used singularly, not a
   *  bare `Set<string>` of ids: `Clip.id`'s own doc only promises "stable,
   *  survives reorder/trim," never global uniqueness across tracks, so
   *  `{track, id}` pairs remove that ambiguity for free (verified against
   *  the real id-generation call sites, not assumed — `clipFromDraggedMedia`
   *  and `Timeline::split`'s `${id}·${frame}` scheme both produce ids
   *  scoped to their own construction, not guaranteed unique globally).
   *  `[]` is "nothing selected" — the doc's own recommended replacement for
   *  `null`, since every consumer below already treats an empty selection
   *  and a null one identically. */
  const selection = useEditorTimelineStore((s) => s.selection);
  const setSelection = useEditorTimelineStore((s) => s.setSelection);
  const isInSelection = (sel: Selection[], track: number, id: string) =>
    sel.some((s) => s.track === track && s.id === id);
  const toggleInSelection = (sel: Selection[], track: number, id: string): Selection[] =>
    isInSelection(sel, track, id) ? sel.filter((s) => !(s.track === track && s.id === id)) : [...sel, { track, id }];
  /** The many pre-existing single-clip-only consumers below (Inspector,
   *  transform, keyframes, the "Move to" dropdown) intentionally fall back
   *  to their existing empty/disabled state whenever the selection isn't
   *  exactly one clip — `docs/notes/multi-select.md`'s own Phase 1
   *  recommendation, not a real N-clip contract for those this pass
   *  (multi-clip cross-track move and richer Inspector batch-editing are
   *  explicitly scoped to a later Phase 3, once Phase 1 has real usage). */
  const primary = selection.length === 1 ? selection[0] : null;
  /** D-105 — a selected GAP (empty track space, not a clip), mutually
   *  exclusive with `selected`: selecting one clears the other, at the two
   *  real interactive entry points (`onClipClick` for a clip, the edit
   *  area's own empty-space click handler for a gap) — deliberately a
   *  parallel piece of state rather than folding into `Selection` itself,
   *  which would mean touching every one of that type's many existing call
   *  sites (Inspector panel, "Move to" dropdown, Transform, drag handles) for
   *  a feature that only needs two new entry points and one new toolbar/
   *  keyboard action. */
  const selectedGap = useEditorTimelineStore((s) => s.selectedGap);
  const setSelectedGap = useEditorTimelineStore((s) => s.setSelectedGap);
  // D-233 — the curve editor's target lives in the store, not here, because
  // two other surfaces open it: the Inspector's per-property curve button and
  // `editor_set_curve_editor` over MCP.
  const curveEditor = useEditorTimelineStore((s) => s.curveEditor);
  const setCurveEditor = useEditorTimelineStore((s) => s.setCurveEditor);
  const pxPerSec = useTimelineViewStore((s) => s.pxPerSec);
  const setPxPerSec = useTimelineViewStore((s) => s.setPxPerSec);
  /** D-437 S8 — the lanes' scroll position, OUT of React state: a per-pane
   *  store (`lanes/timelineScroll.ts`) mirroring the native scroller. A scroll
   *  renders this pane zero times. Handlers (drops, clicks, drags — D-095's
   *  `xToFrame`, B-145's drag origin) read `scroll.getState()` at the moment
   *  of the event; the header column, the playhead and the view attributes are
   *  written by `applyScrollSinks`; the lanes and the pinned strips subscribe
   *  for themselves; content-space overlays live inside the scroller. */
  const [scroll] = useState(createTimelineScrollStore);
  // B-326 — playback view-follow bookkeeping (see the store subscription).
  const followGeomRef = useRef({ pxPerSec: DEFAULT_PX_PER_SEC, viewportWidth: 0 });
  const followWriteAtRef = useRef(Number.NEGATIVE_INFINITY);
  const userScrolledDuringPlayRef = useRef(false);
  /** B-359 item 6 — when the user last scrolled the lanes themselves (a scroll
   *  event that is not the echo of a follower write); the paused-seek follow
   *  stays out of a pan in flight. */
  const userScrollAtRef = useRef(Number.NEGATIVE_INFINITY);
  /** B-145 — the scroll offset at the moment the current dnd-kit drag began.
   *  `dragDelta` needs it to turn an on-screen displacement into a
   *  content-space one: if the timeline scrolls mid-drag, the clip has moved
   *  through the content by that much more than the pointer moved on screen.
   *  `null` when no drag is in flight. */
  const dragScrollOriginRef = useRef<ScrollOffset | null>(null);

  /** D-437 S4 — the lanes' native scroller (the one place the scroll position
   *  lives) and the playhead's imperative handle. */
  const scrollerRef = useRef<HTMLDivElement | null>(null);
  const playheadRef = useRef<PlayheadHandle>(null);
  /**
   * B-123 — the scrollable edit area. A ref for READING, plus a state mirror
   * whose only job is to be a DEPENDENCY.
   *
   * **The bug.** This node is behind two early returns further down
   * (`!timeline`, and `tracks.length === 0`'s "Empty timeline — drag a clip
   * from Sources" placeholder), so on the real app's own startup path — a
   * freshly created project, which has no tracks at all — it does not exist
   * when this component first commits. Three effects below bind NATIVE
   * listeners to it: D-235's capture-phase `pointerdown` (the smart trim
   * tool's entire arm), B-116's non-passive `wheel` (ctrl-zoom) and D-128's
   * `ResizeObserver`. All three were `useEffect(..., [])` reading
   * `editAreaRef.current`. With an empty dependency array they run exactly
   * once, find `null`, bail — and never run again. The node then mounts, for
   * the rest of the session, carrying none of them.
   *
   * **Why both, and not just one of them.**
   *
   * A ref alone cannot fix it: a ref write does not schedule anything, so
   * there is no moment at which an effect could learn the node had arrived.
   * That is the whole defect.
   *
   * State alone cannot replace the ref either, and this was tried first and
   * reverted after it broke six real tests. Several handlers on this surface
   * (D-137's marquee, the fade drags) are bound ONCE to `window`/`document`
   * and outlive many renders. A ref read inside them is always the current
   * node; a state value captured at bind time is the node as of THAT render —
   * and since `setEditArea` only lands after the first commit, that value is
   * `null` for exactly the renders those listeners are created in. Converting
   * the reads is therefore not a refactor of the same behaviour, it is a
   * different one, and a worse one.
   *
   * So: `editAreaRef` stays the single read path everywhere (unchanged, and
   * always current), and `editArea` exists solely so the three node-bound
   * effects have something real to depend on. `attachEditArea` writes both.
   * A dependency on some boolean mirroring the render condition would work
   * today and rot silently the first time a third early return is added; this
   * cannot, because it depends on the node itself.
   */
  const editAreaRef = useRef<HTMLDivElement | null>(null);
  const [editArea, setEditArea] = useState<HTMLDivElement | null>(null);
  /** D-432 P3 — the header column (a height drag resizes its row) and the
   *  guide line a height drag moves across the lanes. */
  const headerColumnRef = useRef<HTMLDivElement | null>(null);
  const heightGuideRef = useRef<HTMLDivElement | null>(null);
  /** B-350 — whether the current ruler press has become a scrub drag. */
  const rulerScrubRef = useRef(false);
  /** D-432 P3 — the skim line (skimming on), positioned imperatively. */
  const skimLineRef = useRef<HTMLDivElement | null>(null);
  const attachEditArea = useCallback((node: HTMLDivElement | null) => {
    editAreaRef.current = node;
    setEditArea(node);
  }, []);
  const fps = timelineFps(timeline);
  const tracks = timeline?.tracks ?? [];
  const labels = useMemo(() => (timeline ? trackLabels(timeline) : []), [timeline]);
  const badges = useMemo(() => (timeline ? trackBadges(timeline) : []), [timeline]);
  // D-432 P3 — per-track height (a track's own `height`, else the Clip
  // Appearance default) and the view toggles, all from `timelineView.ts`.
  const viewClipHeight = useTimelineViewStore((s) => s.clipHeight);
  const bandRatio = useTimelineViewStore((s) => s.bandRatio);
  const showClipNames = useTimelineViewStore((s) => s.showNames);
  const showClipBadges = useTimelineViewStore((s) => s.showBadges);
  const snapping = useTimelineViewStore((s) => s.snapping);
  const skimming = useTimelineViewStore((s) => s.skimming);
  const rowHeights = useMemo(() => trackHeights(timeline?.tracks ?? [], viewClipHeight), [timeline, viewClipHeight]);
  const rowTops = useMemo(() => trackTops(rowHeights), [rowHeights]);

  /**
   * D-233 — the curve lane's target, resolved from the store's `{track, id,
   * param}` to the actual clip and its INDEX (which `set_clip_keyframes`
   * addresses).
   *
   * `null` — so the lane does not render at all — whenever the target no
   * longer makes sense: the clip was deleted or moved to another track, or
   * the property it named stopped being animated (turning a stopwatch off
   * while its curve is open). Resolving to `null` rather than rendering an
   * empty lane is deliberate: a lane with nothing in it is a panel claiming
   * to be about a clip it cannot find.
   */
  const curveEditorClip = useMemo(() => {
    if (!curveEditor) return null;
    const tr = tracks[curveEditor.track];
    if (!tr) return null;
    const index = tr.clips.findIndex((c) => c.id === curveEditor.id);
    if (index < 0) return null;
    const clip = tr.clips[index];
    if (!animatedParams(clip.chroma_keyframes).includes(curveEditor.param)) return null;
    return { clip, index, track: curveEditor.track, param: curveEditor.param };
  }, [curveEditor, tracks]);

  // Owner, 2026-09-04: "for sync when i select one is should see all the
  // sync selected" — every clip on another sync-locked track that a ripple
  // from the current selection would touch (shift or block), drawn as a
  // secondary highlight by the lanes. Recomputed only when the selection or
  // the timeline actually changes, not on every render.

  const syncLinkedIds = useMemo(
    () => (timeline ? syncLinkedClipIds(timeline, selection) : new Set<string>()),
    [timeline, selection],
  );

  // D-128 — the A/V-link highlight: the other half (or halves) of the
  // selected clip's link group. Deliberately a SEPARATE set and a separate
  // visual from `syncLinkedIds` above: sync-lock means "these tracks ripple
  // together," an A/V link means "these clips ARE one shot" — two different
  // relationships that must not read as the same thing on screen. This is
  // also the only on-screen cue that a clip's edits will carry to another
  // track, which is what makes a linked move/trim/delete legible instead of
  // surprising.
  const avLinkedIds = useMemo(
    () => (timeline ? linkedClipIds(timeline, selection) : new Set<string>()),
    [timeline, selection],
  );

  // keep the playhead line in step with the store playhead (step buttons,
  // the play loop, clicks in the preview transport)
  //
  // D-325 — a direct store subscription, not a reactive `playhead` selector.
  // This effect (and the `getState().playhead` reads at the split/marker/
  // zoom-anchor handlers below) are the ONLY things in this whole file that
  // ever needed the live playhead value, and none of them need a component
  // re-render to get it — an imperative `setFrame` call (D-437 S4: our own
  // `Playhead`'s handle, transform-only) and a few
  // read-at-the-moment-of-the-click handlers both work identically off
  // `useEditorTimelineStore.getState()`. Subscribing to the raw store (this
  // one has no `subscribeWithSelector` middleware, so the listener gets the
  // whole state and filters for itself) instead of selecting `playhead`
  // through the hook is what stops this ~4500-line component from
  // re-rendering on every displayed frame during playback — see the D-325
  // decision doc for the measured cost this removed.
  //
  // B-326 — the same subscription also pages the VIEW during playback, still
  // imperatively (a `scrollLeft` write on the lanes' scroller, no React state): the
  // playhead used to run off the edge of the visible window and the user was
  // left clicking a part of the timeline the playhead was nowhere near.
  // Following pauses once the user scrolls on their own (any scroll event that
  // is not the echo of our own write) and resumes the next time Play starts.
  useEffect(() => {
    playheadRef.current?.setFrame(useEditorTimelineStore.getState().playhead);
    let last = useEditorTimelineStore.getState().playhead;
    let wasPlaying = useEditorTimelineStore.getState().playing;
    return useEditorTimelineStore.subscribe((state) => {
      if (state.playing !== wasPlaying) {
        wasPlaying = state.playing;
        if (wasPlaying) userScrolledDuringPlayRef.current = false;
      }
      if (state.playhead === last) return;
      last = state.playhead;
      playheadRef.current?.setFrame(last);
      const geom = followGeomRef.current;
      const input = {
        frame: last,
        fps,
        pxPerSec: geom.pxPerSec,
        scrollLeft: scroll.getState().left,
        viewportWidth: geom.viewportWidth,
        startLeftPx: START_LEFT_PX,
      };
      let next: number | null;
      if (state.playing) {
        if (userScrolledDuringPlayRef.current) return;
        next = followScrollLeft(input);
      } else {
        // B-359 item 6 — a jump while paused (`editor_set_playhead`, a marker
        // in the Index panel, ↑/↓ to an edit point, a transcript line) that
        // lands outside the view centres it. Not while the user drives the
        // view or the playhead by hand: a scrub (the playhead, the ruler, the
        // viewer's position bar) moves the playhead under the pointer, and a
        // jump in the middle of the user's own scroll would fight it.
        if (isScrubbing() || performance.now() - userScrollAtRef.current < SEEK_FOLLOW_SCROLL_QUIET_MS) return;
        next = seekFollowScrollLeft(input);
      }
      if (next === null) return;
      followWriteAtRef.current = performance.now();
      if (scrollerRef.current) scrollerRef.current.scrollLeft = next;
    });
  }, [fps, scroll]);

  // D-232 — unmounting mid-drag (a tab switch, a project close) still ends the
  // scrub gesture (the ruler's; the playhead's own ends itself on unmount). A drag-end handler cannot fire for a component that is gone,
  // and a scrub that outlived its gesture would hold the audio output device
  // open for the rest of the session. `endScrub` is idempotent, so this costs
  // nothing on an ordinary unmount.
  useEffect(() => endScrub, []);

  /** D-437 S8 — everything outside React that follows the scroll position,
   *  written in one place: the header column's `translateY` (spec §4.8; it
   *  used to be a `top` from React state, R3: written by the same listener as
   *  every other sink, so headers and lanes move in the same frame), the
   *  playhead's transform, and the edit area's view attributes (D-434's
   *  `data-chroma-scroll-left/-top`, which the UI harness reads; React does not
   *  own these two attributes, so a render never resets them). Runs from the
   *  store's listener (any write: a scroll, the zoom anchor) and from the mount
   *  adoption below. Reads refs only, so its identity is stable. */
  const applyScrollSinks = useCallback((pos: TimelineScrollState) => {
    const header = headerColumnRef.current;
    if (header) header.style.transform = pos.top ? `translateY(${-pos.top}px)` : '';
    playheadRef.current?.setScroll(pos.left);
    const area = editAreaRef.current;
    if (area) {
      area.setAttribute(TIMELINE_VIEW_ATTRS.scrollLeft, String(Math.round(pos.left)));
      area.setAttribute(TIMELINE_VIEW_ATTRS.scrollTop, String(Math.round(pos.top)));
    }
  }, []);
  // A LAYOUT effect, declared before the zoom anchor's and the mount
  // adoption's, so the listener exists before either writes the store.
  useLayoutEffect(() => scroll.subscribe(applyScrollSinks), [scroll, applyScrollSinks]);

  // Scroll-wheel zoom (D-051, pan/zoom split D-072) — the library has no
  // wheel handling of its own (checked before writing this), so this is a
  // plain native listener rather than React's `onWheel` (which React
  // attaches passively by default, silently ignoring `preventDefault`,
  // letting the page scroll underneath the zoom).
  //
  // D-051 originally treated *every* wheel tick as zoom, reasoning "the
  // library's own horizontal scrollbar covers pan" — true for a mouse
  // (drag the scrollbar, or shift-scroll), wrong for a trackpad: a plain
  // two-finger scroll and a pinch are two different physical gestures on a
  // trackpad, and this made both do the same thing (zoom), so an owner
  // trying to scroll the timeline on a trackpad couldn't. The fix is the
  // standard web convention, not a new one: a real pinch gesture (trackpad)
  // — and an explicit Ctrl+scroll, the same shortcut most web/canvas apps
  // already use for a mouse — both arrive as a `wheel` event with
  // `ctrlKey: true`, synthesized by the browser itself, regardless of
  // whether a physical Ctrl key is actually held. A plain two-finger
  // scroll arrives with `ctrlKey: false`. So: zoom only on `ctrlKey`;
  // everything else is left alone (no `preventDefault`, nothing handled
  // here) and falls through to the lanes' own scroller (`overflow: auto`,
  // D-437 S4 — real native browser scroll, not something this file has to
  // reimplement), which is
  // exactly what a plain two-finger scroll (or a physical mouse wheel) is
  // supposed to do: pan.
  //
  // B-116 — the zoom is ANCHORED: whatever is under the cursor stays under the
  // cursor. See `zoomBy` below and `timelineZoom.ts` for the arithmetic and
  // the "why". This listener stays mounted for the component's whole life
  // (empty dep array — re-attaching a non-passive native listener on every
  // `pxPerSec` change would be a real cost on the app's highest-update-rate
  // surface), so it reaches the current `zoomBy` through a ref rather than
  // closing over a stale one.
  const zoomByRef = useRef<(factor: number, anchorClientX: number | null) => void>(() => {});
  useEffect(() => {
    const el = editAreaRef.current;
    if (!el) return;
    const zoomCoalescer = createZoomCoalescer((factor, clientX) => zoomByRef.current(factor, clientX));
    // B-387 — the scale the pinch in flight last reported, 0 between gestures.
    // Doubles as "a gesture is live", which the wheel handler needs: a webview
    // that reported BOTH a gesture and a synthesized ctrl-wheel for the same
    // physical pinch would otherwise zoom twice for it.
    let gestureScale = 0;
    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey && gestureScale > 0) {
        // The pinch is already being handled as a gesture; don't count it again.
        e.preventDefault();
        return;
      }
      if (!e.ctrlKey) {
        // B-357 — a plain wheel pans through the lanes' scroller natively, but
        // only when the pointer is over it: the ruler and the lanes' own
        // overlays (the bottom-edge height zones sit between two tracks) are
        // siblings of the scroller, so a two-finger scroll over one of them
        // went nowhere. Forward it.
        const scroller = scrollerRef.current;
        if (!scroller || scroller.contains(e.target as Node)) return;
        e.preventDefault();
        const unit = e.deltaMode === WheelEvent.DOM_DELTA_LINE ? WHEEL_LINE_PX : e.deltaMode === WheelEvent.DOM_DELTA_PAGE ? scroller.clientHeight : 1;
        scroller.scrollBy({ left: e.deltaX * unit, top: e.deltaY * unit });
        return;
      }
      e.preventDefault();
      // B-375 — proportional to the gesture (`pinchZoomFactor`), and
      // D-437 S8 — coalesced to ONE zoom step per animation frame. A trackpad
      // pinch delivers several ctrl-wheel events per frame, and each used to be
      // a full zoom (a store write → a synchronous render of the pane and every
      // visible clip), so one pinch frame paid for 3–6 zoom renders (the
      // 181–247 ms pinch frames measured live at 300 clips). The factors
      // multiply, the latest pointer x is the anchor, and the zoom lands once,
      // in the next frame.
      zoomCoalescer.push(pinchZoomFactor(e.deltaY, e.deltaMode), e.clientX);
    };
    // B-387 — the macOS trackpad pinch, which the wheel handler above never
    // sees. Its comment's premise ("a real pinch ... arrives as a `wheel` event
    // with `ctrlKey: true`, synthesized by the browser itself") is Chromium's
    // and Firefox's convention; this app's webview is WKWebView, and WebKit
    // instead delivers a pinch as its own `gesture*` events, whose `scale` is
    // the cumulative factor since the gesture began. So the standard macOS
    // zoom gesture did nothing at all on the timeline, while =/-, the toolbar
    // buttons, the zoom slider and an explicit Ctrl+wheel all worked.
    // Reference: https://danburzo.ro/dom-gestures/.
    //
    // Through the SAME coalescer and the same anchored `zoomBy` as Ctrl+wheel,
    // so a pinch is not a second zoom implementation: one zoom step per frame,
    // anchored under the fingers, one undo entry.
    const onGestureStart = (e: WebKitGestureEvent) => {
      e.preventDefault(); // else WKWebView magnifies the whole page instead
      gestureScale = Number.isFinite(e.scale) && e.scale > 0 ? e.scale : 1;
    };
    const onGestureChange = (e: WebKitGestureEvent) => {
      e.preventDefault();
      const factor = gestureZoomFactor(e.scale, gestureScale);
      if (factor === null) return;
      gestureScale = e.scale;
      zoomCoalescer.push(factor, e.clientX);
    };
    const onGestureEnd = (e: WebKitGestureEvent) => {
      e.preventDefault();
      gestureScale = 0;
    };
    // `gesture*` is not in the DOM event map, so the handlers are registered
    // through the base `EventListener` type rather than declared globally: this
    // is a WebKit-only event, and widening `HTMLElementEventMap` for the whole
    // app would claim otherwise.
    el.addEventListener('wheel', onWheel, { passive: false });
    el.addEventListener('gesturestart', onGestureStart as EventListener, { passive: false });
    el.addEventListener('gesturechange', onGestureChange as EventListener, { passive: false });
    el.addEventListener('gestureend', onGestureEnd as EventListener, { passive: false });
    return () => {
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('gesturestart', onGestureStart as EventListener);
      el.removeEventListener('gesturechange', onGestureChange as EventListener);
      el.removeEventListener('gestureend', onGestureEnd as EventListener);
      zoomCoalescer.cancel();
    };
    // B-123 — `editArea`, not `[]`: this node mounts LATE on the real app's
    // own startup path (see its declaration), and an empty array bound this
    // listener to nothing at all for the whole session.
  }, [editArea]);

  /** B-116 — the frame + viewport x a zoom in flight has to keep together,
   *  handed from `zoomBy` to the effect below. A ref, not state: it is a
   *  parameter of one gesture, never rendered, and putting it in state would
   *  add a render to every zoom step. */
  const zoomAnchorRef = useRef<{ frame: number; viewportX: number } | null>(null);

  /** B-116 — restore the anchor AFTER the new `pxPerSec` has been laid out.
   *  It has to be an effect rather than a second statement inside `zoomBy`:
   *  the lanes' content width is derived from `pxPerSec`, so a `scrollLeft`
   *  write issued before React has re-rendered with the new zoom would be
   *  clamped against the OLD content width and silently lose the anchor on
   *  every zoom-in.
   *
   *  A LAYOUT effect, so the write lands in the zoom's own commit, before
   *  paint: `TimelineLanes` (a child) has already laid its content out at the
   *  new width, and the playhead (also a child) has already re-placed itself
   *  for the new zoom — at the OLD scroll, which the scroll store's sinks
   *  correct in the same frame. D-437 S4: the scroller is one native element,
   *  the single source of the scroll position, so B-291's two-copy echo loop
   *  (the library's `ScrollSync` state vs. its `Grid`) cannot exist any more;
   *  the write is one assignment. D-437 S8: the store is updated right here
   *  rather than waiting for the browser's `scroll` event, so every reader
   *  (the sinks, the lanes' window, the ruler) has the anchored position in
   *  this same commit; the event's echo is then a no-op. */
  useLayoutEffect(() => {
    const anchor = zoomAnchorRef.current;
    if (!anchor) return;
    zoomAnchorRef.current = null;
    const wanted = scrollLeftForAnchor(anchor.frame, anchor.viewportX, fps, pxPerSec, START_LEFT_PX);
    const scroller = scrollerRef.current;
    if (scroller) scroller.scrollLeft = wanted;
    // What the scroller really took (clamped to its range); jsdom keeps the value as written.
    const next = scroller ? scroller.scrollLeft : wanted;
    setTimelineScroll(scroll, next, scroller ? scroller.scrollTop : scroll.getState().top);
  }, [pxPerSec, fps, scroll]);

  // B-357 — the scroll position outlives the scroller element. The pane renders
  // nothing while no timeline is open (a switch or a project close), which
  // unmounts the lanes' scroller; the next one mounts at 0 and fires no
  // `scroll` event, so the mirror kept the OLD element's position: the ruler,
  // the overlays and every drop/drag conversion read a position the lanes
  // were not at (the harness's `byFrames` targets land hundreds of px off).
  // Adopt the scroller's real position whenever the edit area (its parent)
  // mounts, and write the sinks explicitly: the header column and the edit
  // area are NEW nodes even when the position is unchanged (when the store's
  // own write is a no-op and its listener does not run).
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    setTimelineScroll(scroll, scroller.scrollLeft, scroller.scrollTop);
    applyScrollSinks(scroll.getState());
  }, [editArea, scroll, applyScrollSinks]);

  // B-359 item 6 — the scroll position is per timeline, like the zoom
  // (`timelineView.ts` swaps `pxPerSec` on the switch itself). Leaving a
  // timeline files its scroll offsets under its id (the cleanup runs in the
  // switch's commit, before the browser has clamped the scroller to the new
  // content, so the store still holds the outgoing position); arriving
  // restores the incoming one's, or the start for a timeline not shown yet.
  // A layout effect, declared after the mount adoption, so on a remount the
  // remembered position wins over the fresh scroller's 0; the content is
  // already laid out at the incoming zoom, so the write is not clamped short.
  //
  // B-373 — arriving also ends the paused-seek follow's quiet window. The user's
  // last scroll (`userScrollAtRef`) was a pan of the OUTGOING timeline's view,
  // and this pane outlives the switch (it only renders nothing while no
  // timeline is open), so the mark used to carry over: a jump on the incoming
  // timeline within `SEEK_FOLLOW_SCROLL_QUIET_MS` of a wheel on the old one was
  // dropped, and a dropped follow is never retried (the playhead stayed off
  // screen). The incoming view is placed right here, by us, not by the user.
  const timelineId = timeline?.id ?? null;
  useLayoutEffect(() => {
    if (timelineId === null) return;
    userScrollAtRef.current = Number.NEGATIVE_INFINITY;
    const scroller = scrollerRef.current;
    const saved = perTimelineView(useTimelineViewStore.getState().viewByTimeline, timelineId);
    if (scroller) {
      scroller.scrollLeft = saved.scrollLeft;
      scroller.scrollTop = saved.scrollTop;
    }
    setTimelineScroll(
      scroll,
      scroller ? scroller.scrollLeft : saved.scrollLeft,
      scroller ? scroller.scrollTop : saved.scrollTop,
    );
    return () => {
      const pos = scroll.getState();
      useTimelineViewStore.getState().rememberTimelineScroll(timelineId, { left: pos.left, top: pos.top });
    };
  }, [timelineId, scroll]);


  // D-128 — keep `viewportWidth` honest across window and panel resizes. The
  // edit area's width (the track-header column is a separate panel): the
  // lanes cull to it (D-437; 0 = not measured, e.g. a hidden tab, = no
  // culling, so B-267's hidden-tab start needs no remount any more) and the
  // ruler, beat lane, follower and edit gesture all read it.
  // B-123 — `editArea`, not a ref: this node mounts late; see the `wheel` effect.
  const viewportWidth = useViewportWidth(editArea);

  // B-326 — what the playback follower (the store subscription above) needs
  // that lives in React state: kept in a ref so reading it costs no render.
  useEffect(() => {
    followGeomRef.current = { pxPerSec, viewportWidth };
  }, [pxPerSec, viewportWidth]);

  // D-413 — the beat grid: the grid track's beats on timeline frames, and the
  // one snapping rule the clip drag, the edge trims and the playhead share
  // (nearest beat within the same `INSERT_SNAP_PX` reach as edge snapping).
  const beatView = useTimelineBeats(timeline);
  const beatSnap = useEditorTimelineStore((s) => s.beatSnap);
  const setBeatSnap = useEditorTimelineStore((s) => s.setBeatSnap);
  const beatFrames = useMemo(() => beatFramesOf(beatView.beats), [beatView.beats]);
  const beatSnapReach = Math.max(1, Math.round((INSERT_SNAP_PX / pxPerSec) * fps));
  // D-432 P3 — beats are one of snapping's targets (spec §5), so the toolbar's
  // Snapping toggle (N) turns beat snapping off with everything else; the beat
  // grid's own magnet still chooses whether beats are a target at all.
  const beatSnapOn = snapping && beatSnap && beatFrames.length > 0;
  const snapFrameToBeat = (frame: number): number =>
    beatSnapOn ? snapTo(frame, beatFrames, beatSnapReach).value : frame;
  const snapClipToBeat = (start: number, length: number): number =>
    beatSnapOn ? snapSpan(start, length, beatFrames, beatSnapReach).value : start;
  /** D-432 P3 — the edge-snapping reach of a drop or a clip drag, in frames:
   *  `INSERT_SNAP_PX` at the current zoom, or 0 (land exactly where released)
   *  while the Snapping toggle (N) is off. */
  const insertSnapFrames = snapping ? Math.round((INSERT_SNAP_PX / pxPerSec) * fps) : 0;
  const [snappingCuts, setSnappingCuts] = useState(false);
  /** The last "Snap cuts to beats" outcome, in words, shown beside the tempo
   *  (the answer belongs next to the button that asked, B-080's rule). */
  const [beatNotice, setBeatNotice] = useState<string | null>(null);
  const doSnapCutsToBeats = () => {
    if (!primary || snappingCuts) return;
    setSnappingCuts(true);
    snapCutsToBeats(primary.track, 'beat')
      .then(
        (r) => {
          if ('error' in r) setBeatNotice(r.error);
          else if (r.applied === 0) setBeatNotice('no cut moved: each is on a beat already, or too far from one');
          else setBeatNotice(`snapped ${r.applied} cut${r.applied === 1 ? '' : 's'}`);
        },
        (e: unknown) => setBeatNotice(e instanceof Error ? e.message : String(e)),
      )
      .finally(() => setSnappingCuts(false));
  };

  // --------------------------------------------------------------------- //
  // D-235 — the context-sensitive trim tool (roadmap item 27), and since
  // D-432 P2 every edit drag that is not a plain move. The mode rule lives in
  // `trimMode.ts` (pure, unit-tested); the gesture itself — press, live
  // preview, commit — is `useEditGesture.ts`, which claims the press on a
  // clip's own edge zones (or on its body for slip/slide) before dnd-kit's
  // move can start. Resolved once, at PRESS time: Resolve resolves its own
  // mode from where the pointer is before the click, and a mode that could
  // change halfway through a drag would commit an edit the user did not aim at.
  //
  // `trimArmed` — whether Alt/Option is held RIGHT NOW — only drives the hover
  // affordance (the badge that names the armed mode); no gesture reads it.
  const [trimArmed, setTrimArmed] = useState(false);
  /** B-137 — the horizontal half of the same capture-phase press: how wide the
   *  pressed clip really is on screen, and how far into it the pointer went
   *  down. Stamped by the listener below and promoted to `clipGrab` state once
   *  dnd-kit confirms a drag actually started, so an ordinary click never
   *  re-renders the pane. See `dragGhost.ts` for what the ghost does with it. */
  const clipGrabRef = useRef<{ widthPx: number; offsetPx: number } | null>(null);

  // Declared beside `trimArmed` because disarming has to clear it (see below).
  const [hoverTrimMode, setHoverTrimMode] = useState<TrimMode | null>(null);
  // The clip body last given a direct cursor override — see `onTrimHoverMove`.
  const cursorOverrideElRef = useRef<HTMLElement | null>(null);

  // D-261 — the trim palette's active tool: the primary, visible way to reach
  // the four smart trims, replacing "hold Alt and hope you are at the right
  // height" as the path a user is expected to find. `'select'` is a real tool
  // (Adobe's own default), not an off state — see `trimMode.ts`.
  //
  // Held BOTH as state and as a ref, deliberately. The state renders the
  // toolbar's filled/ghost buttons; the ref is what the capture-phase
  // pointerdown below stamps onto `trimPressRef`, and it exists so that
  // listener does not have to re-bind (and so `useEffect` does not have to
  // carry a dependency) every time the tool changes. `selectTrimTool` is the
  // only writer, so the two can never drift.
  // The tool lives in the timeline view store so `editor_set_tool` drives the same state.
  const trimTool = useTimelineViewStore((s) => s.trimTool);
  const trimToolRef = useRef<TrimTool>(trimTool);
  useEffect(() => {
    trimToolRef.current = trimTool;
  }, [trimTool]);
  // The palette starts on Select each time the pane mounts (as it did when this was local state).
  useEffect(() => () => useTimelineViewStore.getState().setTrimTool('select'), []);
  const selectTrimTool = (tool: TrimTool) => {
    trimToolRef.current = tool;
    useTimelineViewStore.getState().setTrimTool(tool);
  };

  /** Whether ANY non-default trim behaviour is live right now — a tool chosen
   *  in the palette, or Alt held. The hover affordance (badge + cursor) keys
   *  off this rather than off `trimArmed` alone, because a chosen tool is
   *  exactly as much "you are about to do something other than a move" as a
   *  held key is, and Adobe's own panel says the same: "When you select a tool,
   *  the pointer changes shape according to the selection." */
  const trimActive = trimArmed || trimTool !== 'select';

  useEffect(() => {
    // `e.altKey` rather than `e.key === 'Alt'`: the same read works for
    // keydown and keyup, and it stays correct if the key is released while the
    // window is unfocused (the next event carries the real state). Gated to
    // only dispatch on a real change — D-083's per-tick discipline applies to
    // key repeat exactly as it does to pointer moves.
    //
    // D-250 — disarming clears the resolved mode too, not just the arm.
    // Caught by that pass's own test 16, on real DOM: the mode is only ever
    // recomputed by a pointer MOVE, so a stale one survived a keyup, and once
    // the mode drove a `cursor` (rather than only a readout that hid itself
    // with the arm) that left the timeline stuck showing `ew-resize` after the
    // key came up, until the pointer happened to move again.
    // Two change-gated updates rather than one updater with a side effect in
    // it: an updater must stay pure, and React really does call them twice
    // under StrictMode (which this component's own DOM tests mount with).
    const setArmed = (armed: boolean) => {
      setTrimArmed((prev) => (prev === armed ? prev : armed));
      if (!armed) setHoverTrimMode((prev) => (prev === null ? prev : null));
    };
    const onKey = (e: KeyboardEvent) => setArmed(e.altKey);
    const disarm = () => setArmed(false);
    window.addEventListener('keydown', onKey);
    window.addEventListener('keyup', onKey);
    window.addEventListener('blur', disarm);
    return () => {
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('keyup', onKey);
      window.removeEventListener('blur', disarm);
    };
  }, []);

  useEffect(() => {
    const el = editAreaRef.current;
    if (!el) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      // The clip's positioning slot (D-437 S4, `LaneClip`) — the one element
      // whose rect is the clip's real on-screen row box, which is what
      // Resolve's slip-above / slide-below split needs.
      const action = target?.closest('[data-chroma-clip-slot]');
      const rect = action?.getBoundingClientRect();
      // B-137 — the same press, measured horizontally, for the drag ghost.
      // Taken here rather than from dnd-kit's own `active.rect.current.initial`
      // in `onDragStart`: that ref is not yet populated when the drag-start
      // handler runs (established by probe on the real component, not
      // assumed — the ghost simply never moved), whereas the clip's box is
      // readable from the very press that starts the gesture. Same rect the
      // trim tool's own vertical band already uses, so the two cannot disagree
      // about which clip was pressed.
      clipGrabRef.current =
        rect && rect.width > 0
          ? { widthPx: rect.width, offsetPx: Math.max(0, Math.min(rect.width, e.clientX - rect.left)) }
          : null;
    };
    el.addEventListener('pointerdown', onPointerDown, true);
    return () => el.removeEventListener('pointerdown', onPointerDown, true);
    // B-123 — `editArea`, not `[]`: the node mounts after this component's
    // first commit (see `attachEditArea`), and a `[]` effect would never bind.
  }, [editArea]);

  /** D-235 — which mode a press at this pointer position would commit, or
   *  `null` when there is nothing worth announcing. The hover affordance's
   *  whole job, and deliberately built on the SAME `resolveTrimMode` call the
   *  two commit paths use — a hint that could disagree with the op that
   *  actually fires would be worse than no hint.
   *
   *  `null` covers two cases: not over a clip at all, and over one where the
   *  gesture is still just a plain move/trim. D-261 made the second case
   *  reachable — a tool that does not own this zone (Ripple over a clip's
   *  BODY) leaves the drag exactly as it was, and announcing an unnamed mode
   *  there would put an empty badge under the pointer. `trimModeLabel` is the
   *  authority on which modes have something to say, so it is asked rather
   *  than the two unarmed modes being re-listed here. */
  const trimModeAtPointer = (e: PointerEvent): TrimMode | null => {
    if (!timeline) return null;
    const target = e.target instanceof Element ? e.target : null;
    const action = target?.closest('[data-chroma-clip-slot]');
    if (!action) return null;
    const body = action.querySelector<HTMLElement>('[data-chroma-clip-drag]');
    const ti = Number(body?.dataset.chromaTrack);
    const clipId = body?.dataset.chromaClipId;
    if (!clipId || !Number.isInteger(ti)) return null;
    const i = idxOf(ti, clipId);
    if (i < 0) return null;
    const edgeEl = target?.closest<HTMLElement>('[data-chroma-trim-edge]');
    const zone: TrimZone = !edgeEl ? 'body' : edgeEl.dataset.chromaTrimEdge === 'start' ? 'edge-start' : 'edge-end';
    const rect = action.getBoundingClientRect();
    const mode = resolveTrimMode({
      zone,
      // D-261 — the palette's tool, and the arm as it REALLY is. Both had to
      // become real reads here: this used to be called only while Alt was
      // held, so `altKey: true` was a safe constant; now a chosen tool brings
      // the pointer here with no modifier down at all, and hard-coding the arm
      // would make the badge promise a slip/slide the commit path would not
      // perform. Same `resolveTrimMode` call as both commit paths, which is
      // what keeps hint and op from ever disagreeing.
      tool: trimTool,
      altKey: trimArmed,
      shiftKey: e.shiftKey,
      atEditPoint: zone !== 'body' && edgeIsEditPoint(timeline, ti, i, zone === 'edge-start' ? 'start' : 'end'),
      bodyYRatio: rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0,
    });
    return trimModeLabel(mode) === null ? null : mode;
  };

  // D-235 — the hover affordance. Resolve swaps between four custom cursors
  // (`scratch/resolve-reference/trim.jpg` is literally those four glyphs);
  // Apelles names the mode in the toolbar instead, which needs no cursor
  // bitmaps, survives every zoom level, and is legible to a screen reader.
  //
  // A React `onPointerMove` prop on the edit area (see the JSX below), NOT a
  // manually-bound listener in an effect. That was the first shape tried and
  // it was wrong twice over: `trimModeAtPointer` closes over `timeline`, so an
  // honest dependency array re-binds the listener on every render, and a
  // dishonest one silenced with an eslint-disable bails the WHOLE component
  // out of the React Compiler — caught by this package's own
  // `reactCompiler.test.ts` (D-201), which is exactly the regression that test
  // exists to catch. As a plain prop there is no dependency array to get
  // wrong, and no bailout.
  //
  // D-083's per-pointer-move discipline still applies and is still met: the
  // handler returns on a boolean before touching the DOM unless Alt is
  // actually held, and `setHoverTrimMode` is change-gated so a pointer
  // sweeping a clip's body dispatches once, not once per pixel.
  // D-250 — the badge that follows the pointer. Its POSITION is written
  // straight to the node, never through state: this runs on every pointermove
  // of an armed hover, and a `setState` per pixel would re-render a component
  // that renders every clip, every filmstrip and every waveform on the
  // timeline (CLAUDE.md's performance-first rule — a badge that makes the
  // timeline janky is worse than no badge). Only the mode NAME is state, and
  // it is change-gated, so React re-renders once per band crossed.
  const trimBadgeRef = useRef<HTMLDivElement>(null);
  const placeTrimBadge = (e: ReactPointerEvent<HTMLDivElement>) => {
    const badge = trimBadgeRef.current;
    const area = editAreaRef.current;
    if (!badge || !area) return;
    const rect = area.getBoundingClientRect();
    // Below-right of the pointer, the side a cursor's own hotspot leaves free.
    const x = e.clientX - rect.left + TRIM_BADGE_OFFSET_PX;
    const y = e.clientY - rect.top + TRIM_BADGE_OFFSET_PX;
    // Clamped so a badge raised near the pane's right or bottom edge stays
    // readable instead of being clipped away by the area's `overflow-hidden`
    // — but only when the pane can actually be measured. An unmeasurable box
    // (a pane laid out to nothing, and every jsdom test tier) would otherwise
    // clamp every position to the corner, which is worse than not clamping:
    // the badge would stop following the pointer entirely.
    const measurable = rect.width > 0 && rect.height > 0;
    const maxX = rect.width - badge.offsetWidth - TRIM_BADGE_OFFSET_PX;
    const maxY = rect.height - badge.offsetHeight - TRIM_BADGE_OFFSET_PX;
    const left = measurable ? Math.min(x, Math.max(0, maxX)) : x;
    const top = measurable ? Math.min(y, Math.max(0, maxY)) : y;
    badge.style.transform = `translate(${left}px, ${top}px)`;
  };

  const onTrimHoverMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    // D-432 P2 — the edit-point bracket on the hovered edge (any tool), the
    // slip/slide brackets and the Blade cut line: imperative writes to the
    // shared feedback layer, no state.
    editGesture.onHover(e);
    // D-261 — `trimActive`, not `trimArmed`: a tool chosen in the palette gets
    // the same hover affordance a held Alt does. Still an early boolean return
    // before touching the DOM, so D-083's per-pointer-move discipline is
    // unchanged for the default (Select, no Alt) case, which is most of the
    // time the pointer is over this pane.
    if (!trimActive) return;
    const next = trimModeAtPointer(e.nativeEvent);
    setHoverTrimMode((prev) => (prev === next ? prev : next));
    if (next) placeTrimBadge(e);
    // The resolved mode's cursor is also written straight onto the hovered
    // clip's own element, not just the edit area's ancestor style: `ClipBody`
    // carries its own `cursor-grab` class on that same node, and an element's
    // own declared `cursor` always wins over an ancestor's, no matter the
    // ancestor's specificity — so without this, selecting Slip/Slide (which
    // own the clip BODY, not just its edges) never visibly changed the
    // cursor. Direct DOM write, not React state, for the same per-pointer-move
    // performance reason `placeTrimBadge` above is one.
    const target = e.nativeEvent.target instanceof Element ? e.nativeEvent.target : null;
    const hoveredBody = target?.closest<HTMLElement>('[data-chroma-clip-drag]') ?? null;
    if (cursorOverrideElRef.current && cursorOverrideElRef.current !== hoveredBody) {
      cursorOverrideElRef.current.style.cursor = '';
    }
    // D-432 P2 — the Blade tool's crosshair over any clip (spec §5.1).
    if (hoveredBody) hoveredBody.style.cursor = trimTool === 'blade' ? 'crosshair' : next ? trimModeCursor(next) : '';
    cursorOverrideElRef.current = hoveredBody;
  };
  const onTrimHoverLeave = () => {
    editGesture.onHoverLeave();
    setHoverTrimMode((prev) => (prev === null ? prev : null));
    if (cursorOverrideElRef.current) {
      cursorOverrideElRef.current.style.cursor = '';
      cursorOverrideElRef.current = null;
    }
  };

  // Ripple visual feedback (D-051) — diff each clip id's timeline start frame
  // against the previous render; anything that moved (chiefly a `move` now,
  // since D-058 made trim/remove non-rippling by construction — see the
  // module doc) gets ONE 160 ms opacity flash (D-432 §4.3; it was a looping
  // `animate-pulse` box-shadow, repainted every frame). Played with the Web
  // Animations API on the clip bodies themselves, so it costs no React render. A brand new track (nothing to compare against yet) or a clip that
  // simply didn't exist before (add_clip, split's new right-hand clip) is
  // correctly excluded — `prev.get(id)` is `undefined` for those, not "shifted".
  const prevStartsRef = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const starts = startFramesById(timeline);
    const prev = prevStartsRef.current;
    prevStartsRef.current = starts;
    if (!prev) return;
    const shifted = new Set<string>();
    starts.forEach((start, id) => {
      const before = prev.get(id);
      if (before !== undefined && before !== start) {
        shifted.add(id);
      } else if (before === undefined && id.includes('·')) {
        // D-106 — a brand-new split-derived clip (this file's own
        // `${leftId}·${frame}` id convention, both here and in
        // `rippleShiftWithAutoSplit`). Flash it too: sync-lock's real
        // auto-split can create one of these on a track the user isn't even
        // looking at, as a side effect of a ripple elsewhere — never
        // silent, the owner's own explicit mitigation ask. A plain
        // user-initiated `split` flashing its own new right half too is a
        // harmless, honestly-simpler side effect of the same generic rule,
        // not worth a second signalling path just to suppress it there.
        shifted.add(id);
      }
    });
    if (shifted.size === 0) return;
    const area = editAreaRef.current;
    if (!area) return;
    for (const body of area.querySelectorAll<HTMLElement>(`[data-testid="${TIMELINE_TEST_IDS.clip}"]`)) {
      const id = body.dataset.chromaClipId;
      // `animate` is absent under jsdom; the flash is decoration only.
      if (id && shifted.has(id) && typeof body.animate === 'function') {
        body.animate([{ opacity: RIPPLE_FLASH_OPACITY }, { opacity: 1 }], { duration: RIPPLE_FLASH_MS, easing: 'ease-out' });
      }
    }
  }, [timeline]);

  const [dragOver, setDragOver] = useState(false);
  // D-098 — track reorder and cross-track clip move are now real
  // `@dnd-kit/core`/`@dnd-kit/sortable` drags, not native HTML5 `draggable`
  // (see the module doc on `SortableTrackHeader`/`ClipBody` for why —
  // reported live as unreliable on Tauri's WKWebView). `activeDrag` is the
  // one shared `<DndContext>`'s notion of "what's currently being dragged"
  // — drives the `DragOverlay` ghost and whether `TrackDropZone` overlays
  // exist in the DOM at all (only during a clip-type drag).
  const [activeDrag, setActiveDrag] = useState<TrackHeaderDragData | ClipDragData | null>(null);
  /** B-137 — the press that started the current clip drag, measured against
   *  the dragged clip's own on-screen box: how wide it is and how far into it
   *  the pointer went down. `null` for anything that is not a clip drag, and
   *  for a clip drag dnd-kit could not measure (a pane laid out to nothing).
   *  Feeds `dragGhostWindow` — see that module for why the ghost needs it. */
  const [clipGrab, setClipGrab] = useState<{ widthPx: number; offsetPx: number } | null>(null);
  // D-113 — owner, live: "when i drag and drop it shows whole track as
  // white make only the track length and where it is actually going to
  // go, placeholder kindda." The full-row wash `TrackDropZone` used to
  // paint is gone (see that component's own updated doc); this is the
  // real, precisely-sized/positioned replacement — the SAME resolved
  // landing (`resolveClipLanding`) `onDndDragEnd` would actually apply,
  // computed live on every `onDragMove` tick instead of only at drop time.
  // Cleared on drag end/cancel and whenever the active drag isn't a clip
  // drag at all (or isn't currently over a real track).
  /** B-160 / D-304 — the live drag-preview overlay layer, and the ONLY thing
   *  this pane writes on a pointer-move tick. The state that drives it
   *  (`clipDragPreview` + `insertPreview`) used to live here, which meant every
   *  tick of a drag re-rendered this whole component — the ruler, every track,
   *  every clip, every filmstrip and waveform — to move four small overlay
   *  boxes. That is the "drag and drop... is still not smooth and animations
   *  are shakky" report; `TimelineDragPreview.tsx`'s own doc has the
   *  measurements and the B-024 precedent. Writing through an imperative handle
   *  keeps each of those renders inside that small subtree.
   *
   *  Nothing in this file READS the preview — it only ever set it — so a
   *  write-only handle costs no expressiveness here. */
  const dragPreviewRef = useRef<TimelineDragPreviewHandle>(null);

  const dndSensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));

  // D-100 — a safety net, not the primary mechanism: dnd-kit's own sensors
  // already listen at `document` level for the events that normally end a
  // drag (`pointerup`/`pointercancel`, Escape), which is what `onDragEnd`/
  // `onDragCancel` (below) rely on. But a real desktop app can plausibly
  // lose those entirely mid-drag — the pointer effectively "leaves" the
  // window (another app/dialog steals focus while the button is still
  // down) without the webview ever seeing a completing event — and this
  // session's live reports (a stuck ghost overlay, then same-track drag
  // itself becoming unreachable — see `TrackDropZone`'s own doc for the
  // real mechanism that made a stuck `activeDrag` a functional blocker,
  // not just cosmetic) are consistent with exactly that. `window.blur` is
  // a real, working signal for "the app lost focus" regardless of why.
  //
  // Dispatching a real, synthetic `pointercancel` on `document` — not just
  // resetting `activeDrag` directly — matters: verified live (this
  // session's harness) that resetting only our OWN state left dnd-kit's
  // own `AbstractPointerSensor` still internally tracking the interrupted
  // pointer (it registers its own `pointercancel`/`pointermove`/`pointerup`
  // listeners on `document`, read in its bundled source, not guessed) —
  // the very NEXT real drag attempt afterward silently failed to apply,
  // even though our own UI had already reset and looked idle. A real
  // `pointercancel` event goes through dnd-kit's own normal cancel path
  // (it explicitly listens for that event type), which is what actually
  // releases its internal state, not just ours — `setActiveDrag` here is
  // now a defensive fallback in case no drag was active for it to cancel.
  useEffect(() => {
    const onBlur = () => {
      document.dispatchEvent(new PointerEvent('pointercancel', { bubbles: true, cancelable: true }));
      setActiveDrag((prev) => (prev === null ? prev : null));
      setClipGrab((prev) => (prev === null ? prev : null));
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  /** D-226 — why the last drop onto this pane was refused, shown as a
   *  transient toolbar note. A refusal is the NORMAL outcome of a near-miss
   *  drop (a transition can only live on a cut, and a cross dissolve
   *  additionally needs handle media), so it has to say WHY rather than
   *  silently doing nothing — the same reason `checkLink`'s own reason string
   *  drives the Link button's disabled tooltip. Cleared by the next successful
   *  drop or by dismissing it.
   *
   *  D-248 — was `transitionDropError`; renamed when the library rail's
   *  generator drop gained refusals of its own ("a title is picture — drop it
   *  on a video track"). One note rather than one per drag kind: only one drag
   *  can be in flight at a time, and a second identical chip in the same
   *  toolbar would be the same control twice. */
  const [dropError, setDropError] = useState<string | null>(null);

  // D-100 — the equivalent safety net for the OTHER drag system in this
  // file, the native-HTML5 Sources-panel drag (`onDragOver`/`onDrop`
  // below): `onDrop` is the only place `dragOver`/the insert preview reset,
  // and `drop` never fires at all if a native drag ends outside a valid
  // target (dropped somewhere that isn't this component, or cancelled).
  // `dragend`, per spec, ALWAYS fires exactly once on the element that
  // received `dragstart` when a native drag concludes — success, failure,
  // or cancellation — and it bubbles, so a `document`-level listener here
  // catches it regardless of which draggable item started the drag,
  // without needing any cross-component wiring into `SourcesPanel` (a
  // different package under D-039's layer rules) at all.
  useEffect(() => {
    const onGlobalDragEnd = () => {
      setDragOver((prev) => (prev ? false : prev));
      dragPreviewRef.current?.setInsert((prev) => (prev === null ? prev : null));
    };
    document.addEventListener('dragend', onGlobalDragEnd);
    return () => document.removeEventListener('dragend', onGlobalDragEnd);
  }, []);

  // ── Marquee-select (D-137, roadmap item 12 Phase 2) ──────────────────────
  //
  // Click-drag on empty timeline canvas draws a rubber band; every clip whose
  // bounding box it intersects becomes the selection. Every decision this
  // gesture makes is pure and lives in `marquee.ts` (and is unit-tested
  // there); what follows is only the wiring.
  //
  // **How it coexists with the clip drag, since that is the one thing this
  // file has a six-decision history of getting wrong (D-094–D-100).** A
  // marquee and a clip drag both begin with a `pointerdown` inside this edit
  // area, so they are separated by DOM POSITION, not by precedence: dnd-kit's
  // `PointerSensor` activator is an `onPointerDown` prop that `useDraggable`
  // puts on `ClipBody` and nowhere else in this subtree (the other draggable
  // in this file, `SortableTrackHeader`'s grip, is in the track-header
  // `ResizablePanel`, a different subtree entirely). `ClipBody` therefore
  // carries `data-chroma-clip-drag`, and `canStartMarquee` refuses any press
  // whose propagation path contains it. The two gestures are consequently
  // mutually exclusive by construction: a press dnd-kit's sensor can claim is
  // a press this handler provably returns early on, and the reverse. Nothing
  // here relies on which handler runs first, on `stopPropagation`, or on a
  // shared "is a drag already running" flag — the `activeDrag` check below is
  // a redundant belt, not the braces.
  //
  // The activation threshold reuses the `PointerSensor`'s own
  // `activationConstraint: { distance: 4 }` value and distance metric
  // (`MARQUEE_MIN_DRAG_PX`) rather than inventing a second one, so a press
  // that is "a click" for one system can never be "a drag" for the other.
  // Below the threshold the press stays a plain click and falls through to
  // this area's existing clear-selection / select-gap `onClick` (D-100/D-105)
  // untouched; above it, `marqueeClickSuppressedRef` swallows exactly that one
  // click so the marquee's own result isn't immediately cleared by it.
  const [marquee, setMarquee] = useState<MarqueeRect | null>(null);
  /** The in-flight gesture. A ref, not state: it is written from `window`
   *  pointer listeners that must not be re-registered on every mutation, and
   *  nothing renders from it directly (`marquee` above is what paints). */
  const marqueeRef = useRef<{
    pointerId: number;
    /** press point in CLIENT px — the threshold is a physical-distance
     *  question, so it is the one part of this gesture not held in timeline
     *  units. */
    originX: number;
    originY: number;
    anchor: MarqueeAnchor;
    /** read once, at `pointerdown`: a modifier tapped mid-drag must not change
     *  the meaning of a gesture already under way. */
    additive: boolean;
    /** the selection to compose against — snapshotted at press time for the
     *  same reason. */
    base: Selection[];
    active: boolean;
  } | null>(null);
  const marqueeClickSuppressedRef = useRef(false);

  /** Everything the `window`-level pointer listeners need to read at their own
   *  moment rather than at registration time (zoom, scroll and the timeline
   *  all change mid-gesture). One ref, refreshed after every commit, keeps
   *  those listeners registered exactly once for the component's whole life.
   *
   *  Written in an effect, NOT during render — the canonical "latest value"
   *  ref pattern. A render-body assignment worked, but a mutation during
   *  render is a real React anti-pattern (and the React Compiler said so:
   *  `vite build` reported a fresh `Cannot access refs during render` bailout
   *  on this file, which is this repo's own signal to fix the structure rather
   *  than accept the bailout — D-100 made the same call for its own). Safe
   *  timing-wise: the ref is seeded with the first render's values at
   *  `useRef` time and refreshed after every commit, and a pointer event can
   *  only ever be dispatched between frames, i.e. after a commit. */
  const marqueeGeometry: MarqueeGeometry = {
    fps,
    pxPerSec,
    startLeftPx: START_LEFT_PX,
    rowHeight: viewClipHeight,
    rowTops,
  };
  const marqueeLatestRef = useRef<{ geometry: MarqueeGeometry; timeline: Timeline | null }>({
    geometry: marqueeGeometry,
    timeline,
  });
  useEffect(() => {
    marqueeLatestRef.current = { geometry: marqueeGeometry, timeline };
  });

  /** Pointer position → timeline units, against the CURRENT viewport (the
   *  scroll is read from the store at this moment, D-437 S8). */
  const marqueePointTo = useCallback(
    (clientX: number, clientY: number): MarqueeAnchor | null => {
      const rect = editAreaRef.current?.getBoundingClientRect();
      if (!rect) return null;
      const pos = scroll.getState();
      return marqueeAnchorFromPoint(clientX - rect.left, clientY - rect.top, {
        ...marqueeLatestRef.current.geometry,
        scrollLeft: pos.left,
        scrollTop: pos.top,
        rulerPx: RULER_AND_MARGIN_PX,
      });
    },
    [scroll],
  );

  const onEditAreaPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // Only ever suppresses the click belonging to the gesture that set it —
      // reset here so an interrupted gesture can't leak the flag forward.
      marqueeClickSuppressedRef.current = false;
      // Redundant with the target check below (a dnd-kit drag can only be
      // running because its own sensor claimed a press on a `ClipBody`, which
      // `canStartMarquee` already refuses), kept as a cheap invariant.
      if (activeDrag) return;
      if (!canStartMarquee(e.button, e.target as Element | null)) return;
      const anchor = marqueePointTo(e.clientX, e.clientY);
      if (!anchor) return;
      marqueeRef.current = {
        pointerId: e.pointerId,
        originX: e.clientX,
        originY: e.clientY,
        anchor,
        additive: e.shiftKey || e.metaKey || e.ctrlKey,
        base: selection,
        active: false,
      };
    },
    [activeDrag, marqueePointTo, selection],
  );

  // The gesture's own move/up/cancel listeners live on `window`, not on the
  // edit area and not via `setPointerCapture`: a marquee routinely runs past
  // this pane's edges, and pointer capture would RETARGET every subsequent
  // pointer event to the captured element — a real way to interfere with
  // something else's hit-testing, which is precisely the class of bug this
  // file already has enough of. Registered once (every value they read comes
  // from a ref) so React re-renders during the drag never rebind them.
  useEffect(() => {
    /** Abandon an in-flight gesture without committing anything (Escape,
     *  `pointercancel`, the window losing focus).
     *
     *  Cancelling an ACTIVATED marquee also suppresses the click that
     *  terminates it — a real bug found by driving this in a browser, not
     *  reasoned about: Escape correctly dropped the band, but the `pointerup`
     *  that followed still produced a click on the edit area, which ran the
     *  D-100 clear-selection branch and wiped the selection the user had
     *  before they ever started the cancelled gesture. Cancelling must leave
     *  the world exactly as it was found. A gesture that never passed the
     *  threshold sets nothing, so a plain click still clears as it always
     *  has; and the flag is re-cleared at the next `pointerdown`, so it can
     *  never leak into an unrelated later click when no click follows at all
     *  (blur, `pointercancel`). */
    const finish = () => {
      if (marqueeRef.current?.active) marqueeClickSuppressedRef.current = true;
      marqueeRef.current = null;
      setMarquee((prev) => (prev === null ? prev : null));
    };
    const onMove = (e: PointerEvent) => {
      const g = marqueeRef.current;
      if (!g || e.pointerId !== g.pointerId) return;
      if (!g.active) {
        if (!marqueeActivated(e.clientX - g.originX, e.clientY - g.originY)) return;
        g.active = true;
      }
      const cur = marqueePointTo(e.clientX, e.clientY);
      if (cur) setMarquee(marqueeRect(g.anchor, cur));
    };
    const onUp = (e: PointerEvent) => {
      const g = marqueeRef.current;
      if (!g || e.pointerId !== g.pointerId) return;
      marqueeRef.current = null;
      setMarquee(null);
      // Never activated: this was a click, not a drag. Leave the selection
      // alone and let the edit area's own `onClick` do its existing job.
      if (!g.active) return;
      const cur = marqueePointTo(e.clientX, e.clientY);
      if (!cur) return;
      const hits = clipsInMarquee(marqueeLatestRef.current.timeline, marqueeRect(g.anchor, cur));
      setSelection(composeMarqueeSelection(g.base, hits, g.additive));
      // A completed marquee is a real selection action, and a clip selection
      // and a gap selection are mutually exclusive (D-105).
      setSelectedGap(null);
      marqueeClickSuppressedRef.current = true;
    };
    const onCancel = (e: PointerEvent) => {
      const g = marqueeRef.current;
      if (g && e.pointerId !== g.pointerId) return;
      finish();
    };
    // Escape abandons an in-flight marquee without committing — the same
    // cancel affordance `TransformOverlay`'s own drag has (D-136).
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && marqueeRef.current) finish();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('blur', finish);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('blur', finish);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [marqueePointTo, setSelection, setSelectedGap]);

  /** D-097 — the `0..tracksLength` insertion boundary near `y`
   *  (`editAreaRef`-relative, ruler/scroll already subtracted), or `null` if
   *  `y` isn't close to one. Shared by `onDragOver` (preview), `onDrop` (the
   *  real op) and `dndBoundary` (the dnd-kit clip drag) so they can never
   *  disagree about where a drop actually lands.
   *
   *  **The two OUTER boundaries are unconditional; the inner ones are a
   *  band.** Past the last row resolves to `tracksLength` and above the first
   *  row resolves to `0`, in both cases because there is nothing else there to
   *  resolve to — an inner boundary (1..tracksLength-1, between two existing
   *  rows) has two real tracks competing for the same pixels, so it only
   *  counts within `TRACK_INSERT_BAND_PX` of the line where the rows actually
   *  meet (see that constant's own doc).
   *
   *  **B-115** — `y < 0` used to return `null`, so the top was NOT the mirror
   *  of the bottom: the only way to reach boundary 0 was the `TRACK_INSERT_
   *  BAND_PX` (11px) sliver at the very top of track 0's own row, and dragging
   *  anywhere ABOVE the tracks — over the ruler and the marker strip, i.e. the
   *  48px of `RULER_AND_MARGIN_PX` that is exactly "above your video tracks" —
   *  resolved to nothing at all. The two drag paths then failed differently
   *  and both wrongly: the native Sources drop fell through to
   *  `dropTargetTrack`, which clamps into range and so quietly added the clip
   *  to the EXISTING top track, while the dnd-kit clip drag cancelled outright
   *  (`onDndDragEnd` returns when `dndBoundary` is `null`). The owner reported
   *  exactly that, live: "i m trying to drag and drop a clip on over it's not
   *  creating a new timeline on very top."
   *
   *  Dragging above the top track to create a new one there is the reference
   *  gesture, not an invention — Resolve's own titles copy is "drag it into
   *  the timeline ABOVE your video tracks", and adjustment clips are "place it
   *  on a HIGHER video track over your clips"
   *  (`scratch/resolve-reference/resolve-edit-features.json`, `edit-titles` /
   *  `edit-adjustments`). Since track index order IS compositing z-order here
   *  (D-086, lower index = on top), "above" is boundary 0, and it has to be as
   *  reachable as "below" already was. `y`'s negative range is bounded by the
   *  edit area's own top edge (`y` starts at `-RULER_AND_MARGIN_PX + scrollTop`),
   *  so this cannot swallow a drop from outside the pane. */
  const trackInsertBoundary = (y: number, tracksLength: number): number | null => {
    if (tracksLength === 0) return null;
    if (y >= rowTops[tracksLength]) return tracksLength;
    if (y < 0) return 0;
    // D-432 P3 — the boundary lines are the rows' own tops, at any mix of heights.
    return trackBoundaryNear(rowTops, y, TRACK_INSERT_BAND_PX);
  };

  /** D-097 — what kind a track created at insertion boundary `index` should
   *  be. Derived from drop *context*: continue whatever kind cluster the
   *  insertion point is adjacent to — the track directly above the boundary
   *  (or, at the very top, the track directly below it) — rather than a
   *  hardcoded literal (the actual pre-D-097 bug: every auto-created track
   *  was unconditionally `'video'`, regardless of where the drop landed).
   *
   *  D-097 originally flagged that `DraggedMedia`/`MediaItem` carried no
   *  audio-vs-video signal at all, so the kind could not come from the
   *  dragged item "without a real backend model change." **D-128 made that
   *  change** — `MediaItem.video.hasAudio` (and `DraggedMedia.hasAudio`) is
   *  real now. It is deliberately NOT used here, though: it answers "does
   *  this source have sound," not "is this an audio-only item," and a drop
   *  onto a video-track boundary still wants a video track even when the
   *  source has audio (its audio half gets its own track via
   *  `ensureAudioTrackWithRoom`, not this boundary). Drop context remains
   *  the right signal for this specific question. */
  /*  D-229 — a **subtitle** neighbour is deliberately not inferable. This
   *  function answers "what track should a dropped MEDIA item get", and the
   *  answer is never a subtitle track: captions come from a subtitle file or
   *  the Add-caption action, never from dropping footage, and a media clip
   *  placed on a subtitle track would be invisible (the caption resolver only
   *  looks for cues, the video compositor skips the track entirely). So a
   *  subtitle neighbour falls through to the next signal rather than being
   *  continued. Adding the variant to `TrackKind` is what surfaced this —
   *  before it, the function returned `tracks[i].kind` unexamined. */
  const inferNewTrackKind = (index: number): 'video' | 'audio' => {
    const mediaKind = (t: (typeof tracks)[number] | undefined): 'video' | 'audio' | null =>
      t?.kind === 'video' || t?.kind === 'audio' ? t.kind : null;
    if (index > 0) {
      const above = mediaKind(tracks[index - 1]);
      if (above) return above;
    }
    return mediaKind(tracks[index]) ?? 'video';
  };

  /** D-095 — a drop's `clientX` to a timeline frame, mirroring the library's
   *  own `Pt()` left-px→seconds helper exactly (checked against its bundled
   *  source — see `START_LEFT_PX`'s own doc for why this reduces to a plain
   *  `/ pxPerSec` divide rather than needing `scale`/`scaleWidth`). */
  const xToFrame = (e: DragEvent, rect: DOMRect): number => {
    const contentX = e.clientX - rect.left + scroll.getState().left;
    return Math.round(((contentX - START_LEFT_PX) / pxPerSec) * fps);
  };

  /** B-360 — the frame a Sources-panel / generator drop lands at: where the
   *  pointer was released (never before 0), pulled onto the playhead when the
   *  release is within the insertion snap distance and snapping is on — FCP's
   *  "snaps to the playhead" for a drag from the browser. Every drop path
   *  (onto an existing track, or onto a brand-new one) goes through this, so a
   *  drop never silently falls back to frame 0. */
  const dropFrameAt = (e: DragEvent, rect: DOMRect): number => {
    const frame = Math.max(0, xToFrame(e, rect));
    const playhead = useEditorTimelineStore.getState().playhead;
    return insertSnapFrames > 0 && Math.abs(frame - playhead) <= insertSnapFrames ? playhead : frame;
  };

  /** D-095/D-100 — nearest clip edge (start/end of any clip on `track`, or
   *  0) to `frame`, within `INSERT_SNAP_PX` at the current zoom; if nothing
   *  edge-snaps, falls back to whichever half of the clip CURRENTLY UNDER
   *  `frame` is closer (mirrors `computeInsertion`'s own D-100 fallback
   *  exactly — the live preview and the real drop-time decision must never
   *  disagree, or the snap line lies about where the clip will actually
   *  land). `null` only for a drop with nothing nearby at all. */
  const nearestEdge = (track: Track, frame: number): number | null => {
    const snapFrames = insertSnapFrames;
    const edges = new Set<number>([0]);
    for (const c of track.clips) {
      edges.add(c.start_frame);
      edges.add(endFrame(c, fps));
    }
    let best: number | null = null;
    let bestDist = snapFrames + 1;
    edges.forEach((edge) => {
      const d = Math.abs(edge - frame);
      if (d <= snapFrames && d < bestDist) {
        bestDist = d;
        best = edge;
      }
    });
    if (best !== null) return best;
    const covering = track.clips.find((c) => frame >= c.start_frame && frame < endFrame(c, fps));
    if (covering) {
      // B-077 — `covering.duration` is source frames; its real midpoint on
      // THIS timeline needs the same source_fps→timelineFps conversion
      // `endFrame` itself does, not a raw halving of the source-frame count.
      const mid = covering.start_frame + (endFrame(covering, fps) - covering.start_frame) / 2;
      return frame < mid ? covering.start_frame : endFrame(covering, fps);
    }
    return null;
  };

  /** D-080: which track a Sources-panel drop lands on, from the drop
   *  event's `clientY` — see the module doc's "Dropping a Sources-panel
   *  clip" section for the exact layout constants this reads. Falls back to
   *  the first video track (this file's pre-D-080 default) if the pointer
   *  is above/below every row. (D-098: cross-track clip move no longer uses
   *  this — it's a real `@dnd-kit/core` drag now, resolving its own drop
   *  target via `TrackDropZone`'s droppable id, not `clientY` math.) */
  const dropTargetTrack = (e: DragEvent): number => {
    const rect = editAreaRef.current?.getBoundingClientRect();
    if (!rect || tracks.length === 0) return timeline ? videoTrackIndex(timeline) : 0;
    const y = e.clientY - rect.top - RULER_AND_MARGIN_PX + scroll.getState().top;
    // Gap-on-add fix: this used to silently fall back to `videoTrackIndex`
    // for `y < 0`, while `onDragOver`'s own preview showed NOTHING for that
    // same case - a real drop could land on a track the user was never shown
    // a preview for. Now both agree: clamp into range instead of a hidden
    // special case, so whatever track the preview pointed at is always the
    // one the drop actually uses. (B-115: `y < 0` no longer reaches here at
    // all — `onDrop` resolves it to insertion boundary 0, "a new track above
    // the top one", before ever calling this.)
    return Math.max(0, Math.min(tracks.length - 1, trackAtY(rowTops, y)));
  };

  // B-024: `dragover` fires continuously (many times/sec) for the whole
  // duration of a native drag — `setDragOver` is now gated to only actually
  // dispatch when the value would change, instead of unconditionally on
  // every single tick. Real, defensive fix regardless of the deeper cause
  // below (a `setState` call that doesn't change the value still goes
  // through React's update/scheduler machinery on every call).
  //
  // D-094: also recognizes `CHROMA_CLIP_MOVE_MIME` (a clip's own drag
  // handle, for a cross-track move) alongside the pre-existing
  // `CHROMA_MEDIA_DRAG_MIME` (a Sources-panel pool item, for `add_clip`) —
  // both land on this same edit-area drop target, `onDrop` below tells them
  // apart. Per the HTML5 spec, `dataTransfer.getData` is unreadable during
  // `dragover` (only `.types` is) — that's why this only ever branches on
  // `.types.includes(...)`, never reads the payload until `onDrop`.
  //
  // D-098 — no longer branches on `CHROMA_CLIP_MOVE_MIME`: cross-track clip
  // move is a real `@dnd-kit/core` drag now (`ClipMoveHandle`/`onDndDragEnd`
  // below), a completely separate drag system from this native-HTML5
  // `onDragOver`/`onDrop` pair, which now only ever handles a Sources-panel
  // media drag.
  const onDragOver = (e: DragEvent) => {
    // D-248 — a generator drag (a title / an adjustment clip, dragged out of
    // the left library rail) previews IDENTICALLY to a media drag: it lands as
    // an ordinary `add_clip` at a snapped insertion point, or as a new track at
    // an insertion boundary. Only `.types` is readable during `dragover` (the
    // HTML5 constraint this handler's own doc above explains), which is
    // exactly why the generator got its own MIME type rather than a field
    // inside the media payload.
    const isDropDrag =
      e.dataTransfer.types.includes(CHROMA_MEDIA_DRAG_MIME) ||
      e.dataTransfer.types.includes(CHROMA_GENERATOR_DRAG_MIME);
    if (!isDropDrag) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver((prev) => (prev ? prev : true));

    const rect = editAreaRef.current?.getBoundingClientRect();
    if (!rect || tracks.length === 0) {
      dragPreviewRef.current?.setInsert((prev) => (prev === null ? prev : null));
      return;
    }
    const y = e.clientY - rect.top - RULER_AND_MARGIN_PX + scroll.getState().top;
    const boundary = trackInsertBoundary(y, tracks.length);
    if (boundary !== null) {
      dragPreviewRef.current?.setInsert((prev) =>
        prev?.kind === 'new_track' && prev.index === boundary ? prev : { kind: 'new_track', index: boundary },
      );
      return;
    }
    // B-115 — there used to be an `if (y < 0)` clear-the-preview branch here.
    // It is unreachable now: with at least one track (guaranteed above),
    // `trackInsertBoundary` resolves every `y < 0` to boundary 0 and returns
    // in the branch above, so nothing negative ever reaches this point.
    const track = Math.max(0, Math.min(tracks.length - 1, trackAtY(rowTops, y)));
    const edge = nearestEdge(tracks[track], xToFrame(e, rect));
    dragPreviewRef.current?.setInsert((prev) =>
      edge === null
        ? prev === null
          ? prev
          : null
        : prev?.kind === 'edge' && prev.track === track && prev.frame === edge
          ? prev
          : { kind: 'edge', track, frame: edge },
    );
  };
  const onDragLeave = () => {
    setDragOver((prev) => (prev ? false : prev));
    dragPreviewRef.current?.setInsert((prev) => (prev === null ? prev : null));
  };

  /**
   * D-248 — where a dropped clip lands, for BOTH native-HTML5 drop payloads:
   * a Sources-panel media item (D-095/D-096/D-097/D-128) and a library-rail
   * generator. Extracted verbatim out of `onDrop`'s media path when the
   * generator gained the same drop target — one placement algorithm, so a
   * dragged title snaps to an edge, ripples and creates a track by exactly the
   * rules a dragged source already does, and neither can drift from the other.
   *
   * `generator` is the generator's kind, or `null` for a media drop. It is
   * read for one thing only: a title and an adjustment clip are picture, so a
   * new track created for one is a VIDEO track regardless of what it was
   * dropped next to, and a drop onto an audio or subtitle track is refused
   * with a real sentence rather than placing an invisible clip. (D-229 made
   * the same call for the opposite case: a media clip is never inferred onto
   * a subtitle track.)
   */
  const placeDroppedClip = (
    e: DragEvent,
    clip: NewClipFields,
    linkedAudio: NewClipFields | undefined,
    generator: DraggedGenerator['kind'] | null,
  ) => {
    const rect = editAreaRef.current?.getBoundingClientRect();
    const y = rect ? e.clientY - rect.top - RULER_AND_MARGIN_PX + scroll.getState().top : -1;
    const boundary = rect && tracks.length > 0 ? trackInsertBoundary(y, tracks.length) : null;
    if (boundary !== null) {
      // D-096/D-097 — dropped at a real track-insertion boundary: past the
      // last row, above the first, or between two existing ones. `add_track`
      // always appends at the end (`apelles_timeline::Timeline::add_track`),
      // computed from this render's own `tracks.length` since every op
      // below runs synchronously in this one handler, before either the
      // store or this component re-renders — so a brand-new track is
      // reliably at that index the instant it's created.
      const newTrackIdx = tracks.length;
      const kind = generator ? 'video' : inferNewTrackKind(boundary);
      applyOp({ kind: 'add_track', trackKind: kind });
      if (boundary !== newTrackIdx) {
        // D-097 — not a plain append: reposition the just-created track into
        // place with the SAME `move_track` + selection-follow math the
        // track-reorder drag already uses (`trackIndexAfterMove`), not a
        // second version of that logic.
        applyOp({ kind: 'move_track', from: newTrackIdx, to: boundary });
        setSelection((prev) => prev.map((s) => ({ ...s, track: trackIndexAfterMove(s.track, newTrackIdx, boundary) })));
      }
      // B-360 — the new track is empty, so the clip lands exactly where it was
      // dropped (an omitted `startFrame` means "append", which on an empty
      // track is frame 0: every drop below/above the tracks used to land at
      // the very start of the timeline).
      applyOp({ kind: 'add_clip', track: boundary, clip, startFrame: rect ? dropFrameAt(e, rect) : undefined, ripple: false, linkedAudio });
      if (generator) selectDroppedGenerator(boundary, clip.id);
      return;
    }

    const track = dropTargetTrack(e);
    const trackData = tracks[track];
    if (generator && trackData && trackData.kind !== 'video') {
      setDropError(
        `A ${GENERATOR_LABELS[generator].toLowerCase()} is picture — drop it on a video track, or above the top one to make a new video track for it.`,
      );
      return;
    }
    // D-095 — snap to a real insertion point (an open gap, or a ripple
    // between two clips / before the first) when there's a real track/rect
    // to compute one against; `computeInsertion` returning `null` (an
    // ambiguous mid-clip drop far from any edge — see its own doc) falls
    // back to the pre-D-095 plain append, same as no `rect`/track at all.
    const insertion =
      rect && trackData
        ? computeInsertion(trackData, dropFrameAt(e, rect), clip, insertSnapFrames, fps)
        : null;
    if (insertion) {
      applyOp({
        kind: 'add_clip',
        track,
        clip,
        startFrame: insertion.startFrame,
        ripple: insertion.ripple,
        linkedAudio,
      });
    } else {
      applyOp({ kind: 'add_clip', track, clip, linkedAudio });
    }
    if (generator) selectDroppedGenerator(track, clip.id);
  };

  /** D-248 — a dropped title/adjustment clip is selected, so the Inspector's
   *  own Title (D-211) or Correction (D-230) section opens on it ready to type
   *  into — the same thing the click-to-add path has always done. Guarded on
   *  the clip actually being there: a non-ripple `add_clip` into occupied
   *  space is refused by design, and selecting a clip that was never created
   *  would point the Inspector at nothing. */
  const selectDroppedGenerator = (track: number, id: string) => {
    const after = useEditorTimelineStore.getState().timeline;
    if (after?.tracks[track]?.clips.some((c) => c.id === id)) {
      setSelection([{ track, id }]);
    }
  };
  // D-098 — no longer handles a `CHROMA_CLIP_MOVE_MIME` payload: cross-track
  // clip move is `onDndDragEnd` (a real `@dnd-kit/core` drag) now. This
  // handler is Sources-panel media drops only.
  const onDrop = (e: DragEvent) => {
    setDragOver(false);
    dragPreviewRef.current?.setInsert(null);
    // D-248 — a generator (title / adjustment clip) dragged out of the left
    // library rail. Handled first and separately because it has no
    // `DraggedMedia` payload at all: nothing to probe, no linked audio half,
    // and one legal track kind. Everything AFTER the clip is built is the
    // media path's own placement, reached through the shared `placeDroppedClip`
    // below rather than a second copy of it.
    const rawGen = e.dataTransfer.getData(CHROMA_GENERATOR_DRAG_MIME);
    if (rawGen) {
      e.preventDefault();
      let gen: DraggedGenerator;
      try {
        gen = JSON.parse(rawGen);
      } catch {
        return;
      }
      if (gen.kind !== 'title' && gen.kind !== 'adjustment') return;
      const built = clipFromDraggedGenerator(gen, fps);
      if ('error' in built) {
        setDropError(built.error);
        return;
      }
      placeDroppedClip(e, built, undefined, gen.kind);
      return;
    }
    const raw = e.dataTransfer.getData(CHROMA_MEDIA_DRAG_MIME);
    if (!raw) return;
    e.preventDefault();
    let media: DraggedMedia;
    try {
      media = JSON.parse(raw);
    } catch {
      return;
    }
    // D-128 — a dropped source with an audio stream produces TWO clips: the
    // picture, and its own audio as a separate, linked clip (the owner's own
    // ask, and both reference NLEs' default). `audio` is `null` for a silent
    // source, or one whose audio status isn't known yet — that drop behaves
    // exactly as it did before this feature.
    // D-292 — the project's own rate, because a STILL has no length of its own
    // and its synthesized span is measured in seconds (`mediaSourceFacts`).
    const pair = linkedClipsFromDraggedMedia(media, fps);
    if (!pair) return; // unprobed / offline media has no known length — nothing to place
    const { video: clip, audio } = pair;
    placeDroppedClip(e, clip, audio ?? undefined, null);
  };

  const clipsOf = (track: number): Track['clips'] => tracks[track]?.clips ?? [];
  const idxOf = (track: number, actionId: string) => clipsOf(track).findIndex((c) => (c.id || '') === actionId);

  // D-432 P2 — every non-move edit drag (trim, ripple, roll, slip, slide) and
  // the Blade tool's cut; see `useEditGesture.ts`. The view is re-read on
  // every render; nothing in a gesture sets this component's state.
  const feedbackRef = useRef<EditFeedbackHandle>(null);
  const editGesture = useEditGesture(editAreaRef, feedbackRef, trimToolRef, {
    timeline,
    fps,
    pxPerSec,
    scroll: scroll.getState,
    startLeft: START_LEFT_PX,
    rowsTop: RULER_AND_MARGIN_PX,
    rowHeight: viewClipHeight,
    rowTops,
    snapping,
    viewportWidth,
    snapExtras: () => {
      const st = useEditorTimelineStore.getState();
      return [st.playhead, ...markersOf(st.timeline).map((m) => m.frame)];
    },
    applyOp,
    selectClip: (track, id) => {
      setSelectedGap(null);
      setSelection([{ track, id }]);
    },
    currentTimeline: () => useEditorTimelineStore.getState().timeline,
  });

  // B-024 (root cause of the reported freeze during drag-and-drop): these 5
  // props were previously inline arrow functions in the (since D-437 S4
  // removed) library timeline's JSX — a brand new function identity on EVERY render of
  // `TimelinePane`, including every `setDragOver`/`setScrollTop` tick a
  // native drag fires many times a second. `@xzdarcy/react-timeline-editor`
  // renders every visible action across every row through these props; a
  // changed `getActionRender`/`onActionMoveEnd`/etc. identity is exactly the
  // kind of thing a component rendering many items typically uses to decide
  // whether to skip re-rendering a given item — passing a fresh one on every
  // tick defeats that, forcing a full re-render (canvas recreation for every
  // `Waveform`, DOM diffing for every action across every track) on every
  // single dragover tick. This got dramatically worse with D-080: the same
  // inline-function pattern existed before D-080 too (checked via `git show`
  // against the pre-D-080 revision), but re-rendering 1 hardcoded row's
  // worth of actions was cheap enough to never be felt — re-rendering N
  // tracks' worth on every tick is what actually froze the UI.
  //
  // D-201 — that stability now comes from the React Compiler (D-091), not from
  // a hand-written dependency array, and the two are mutually exclusive: the
  // compiler only auto-memoizes a component when it can *preserve* every
  // manual `useMemo`/`useCallback` already in it, and SEVEN of this file's
  // arrays disagreed with the dependencies it inferred — this one and
  // `onClickAction` (`idxOf`/`clipsOf`/`setSelection`/`setSelectedGap`, the
  // component-body arrows their bodies actually call), `onActionResizeEndCb`
  // (`s2f`), `linkCheck` (`idxOf`), and `onDndDragMove`/`onDndDragEnd`
  // (`dndBoundary`, `inferNewTrackKind`, `trackIndexAfterMove`,
  // `setSelection`). ONE disagreement bails the compiler out of the WHOLE
  // component, so `TimelinePane` — the highest-update-frequency surface in the
  // app — was getting zero auto-memoization while still paying for the
  // hand-written kind: precisely the B-024 regression the arrays were added to
  // prevent. Worse, two of the seven were memoizing nothing at all —
  // `onDndDragMove`/`onDndDragEnd` listed `idxOf`/`clipsOf`, plain arrows
  // re-created on every render, so both got a fresh identity every render
  // regardless.
  //
  // All seven are plain functions now, and the compiler memoizes them with
  // dependencies it infers itself — which is also strictly safer than a
  // hand-maintained array. `reactCompiler.test.ts` fails if a future edit
  // reintroduces a bailout in this file, so B-024 cannot come back silently.
  // If you think you need hand-written memoization here, run that test first:
  // a `useMemo`/`useCallback` the compiler cannot preserve is a net LOSS.
  /** D-432 §4.3 — how the cut at each clip's LEFT edge is drawn (none / a
   *  hairline / FCP's dashed through-edit), by clip id. One pass per timeline
   *  change, so the render below is a map lookup per clip. */
  const cutStyleById = useMemo(() => {
    const out = new Map<string, 'none' | 'cut' | 'through'>();
    for (const t of tracks) {
      const endingAt = new Map<number, Clip>();
      for (const c of t.clips) endingAt.set(endFrame(c, fps), c);
      for (const c of t.clips) out.set(c.id, cutStyleAt(c, endingAt.get(c.start_frame) ?? null));
    }
    return out;
  }, [tracks, fps]);

  /** Multi-select, Phase 1 (D-107) — shift-click range-extends within the
   *  clicked clip's own track (ordered by `start_frame`, this model's real
   *  time order — Vec order is bookkeeping only, D-054); cmd/ctrl-click
   *  toggles the clicked clip in/out of the selection; a plain click
   *  replaces the whole selection with just this clip, unchanged from
   *  before. D-437 S4 — called by a click on the clip's lane slot
   *  (`actions.onClipClick`), which fires before the edit area's own
   *  empty-space `onClick`, exactly as the library's `onClickAction` did. */
  /** D-201 — no `useCallback` (see the note above `cutStyleById`). */
  const onClipClick =
    (e: ReactMouseEvent<HTMLElement>, track: number, id: string) => {
      setSelectedGap(null); // D-105 — clicking a clip always supersedes a gap selection
      if (e.shiftKey && selection.length > 0) {
        const anchor = selection[selection.length - 1];
        if (anchor.track === track) {
          const ids = clipsOf(track)
            .slice()
            .sort((a, b) => a.start_frame - b.start_frame)
            .map((c) => c.id);
          const ai = ids.indexOf(anchor.id);
          const ci = ids.indexOf(id);
          if (ai >= 0 && ci >= 0) {
            const [lo, hi] = ai <= ci ? [ai, ci] : [ci, ai];
            setSelection(ids.slice(lo, hi + 1).map((cid) => ({ track, id: cid })));
            return;
          }
        }
        // Different track than the anchor — this model has no cross-track
        // "range" concept (that would need a real 2D grid, out of scope for
        // Phase 1). Fall back to a plain toggle rather than silently
        // ignoring the shift-click.
        setSelection((prev) => toggleInSelection(prev, track, id));
        return;
      }
      if (e.metaKey || e.ctrlKey) {
        setSelection((prev) => toggleInSelection(prev, track, id));
        return;
      }
      setSelection([{ track, id }]);
    };

  /** D-437 S4/S8 — the lanes' scroller's `scroll` event: the one reader of
   *  the native scroll position. Writes the scroll store (its listener moves
   *  the header column, the playhead and the view attributes; the lanes and
   *  the pinned strips re-render themselves if their selected value changed).
   *  Sets no React state here: a scroll renders this pane zero times. */
  const onTimelineScroll = useCallback(
    (e: UIEvent<HTMLDivElement>) => {
      const sl = e.currentTarget.scrollLeft;
      const st = e.currentTarget.scrollTop;
      // B-326 — a horizontal scroll that is not the echo of the playback
      // follower's own write is the user taking the wheel: stop following.
      // B-359 item 6 — and the paused-seek follow keeps out of it for a moment.
      if (sl !== scroll.getState().left && performance.now() - followWriteAtRef.current > FOLLOW_ECHO_WINDOW_MS) {
        userScrollAtRef.current = performance.now();
        if (useEditorTimelineStore.getState().playing) userScrolledDuringPlayRef.current = true;
      }
      setTimelineScroll(scroll, sl, st);
    },
    [scroll],
  );

  // D-080: split now requires a selection — with N tracks, "at the
  // playhead" alone no longer says which track's clip. Standard-NLE
  // reading: split whatever's currently selected, if the playhead actually
  // falls inside it (the existing `atFrame` bounds check inside `applyOp`
  // already no-ops otherwise).
  // Multi-select, Phase 1 (D-107) — "Split every selected clip at the
  // playhead" is a real, commonly-used batch operation in every reference
  // checked (`docs/notes/multi-select.md`), generalizing cleanly since each
  // clip's own split is independent of the others.
  /** D-128 — resolve a clip id against the store's CURRENT timeline, not this
   *  render's captured `tracks`. Batch ops below apply several `EditOp`s in
   *  one synchronous pass, and every one of them can renumber clips (and now,
   *  with A/V links, clips on tracks the op never named — `remove` deletes a
   *  linked clip's whole group, `split` cuts every member). Re-reading between ops is what keeps the second op in a batch
   *  from acting on a stale index; `null` simply means that clip is already
   *  gone (it was some other selected clip's linked half), which is a normal
   *  outcome here, not an error. This replaces the previous
   *  captured-index-descending scheme, which was only ever correct for
   *  same-track index shifts. */
  const locateClip = (id: string): { track: number; clip: number } | null => {
    const tl = useEditorTimelineStore.getState().timeline;
    if (!tl) return null;
    for (let ti = 0; ti < tl.tracks.length; ti++) {
      const ci = tl.tracks[ti].clips.findIndex((c) => c.id === id);
      if (ci >= 0) return { track: ti, clip: ci };
    }
    return null;
  };

  const doSplit = () => {
    for (const s of selection) {
      const at = locateClip(s.id);
      if (at) {
        applyOp({
          kind: 'split',
          track: at.track,
          clip: at.clip,
          atFrame: useEditorTimelineStore.getState().playhead,
        });
      }
    }
  };

  const doRemove = () => {
    for (const s of selection) {
      const at = locateClip(s.id);
      if (at) applyOp({ kind: 'remove', track: at.track, clip: at.clip });
    }
    setSelection([]);
  };

  // D-248 — `doAddTitle` (D-211) and `doAddAdjustment` (D-230) lived here,
  // behind the toolbar's Title and Adjust buttons. Both moved to the left
  // library rail (`EditLibraryRail.tsx`) together with those buttons, because
  // a generated clip is a thing you take OUT OF A LIBRARY — Resolve's own copy
  // for both is "drag it from the effects library into the timeline" — and
  // because there was no drag source for one anywhere in the app (B-117). The
  // rail keeps the identical click-at-the-playhead behaviour these had and
  // adds the drag; both now build their clip with `clipFromDraggedGenerator`,
  // which is also what this pane's own generator drop path uses.

  /** D-222 — drop a marker at the playhead. Not clip-scoped and never
   *  refused: a marker annotates a POSITION in the edit, so there is nothing
   *  to select first and no track lock to respect (see `Timeline.markers`).
   *  `newMarker` owns id generation and the default colour, so this button and
   *  `editor_add_marker` build an identical marker. */
  const doAddMarker = (openEditor: boolean) => {
    const store = useEditorTimelineStore.getState();
    // B-339 — Final Cut ("M on an existing marker opens it") and Resolve ("M
    // again on the same frame opens the marker dialog"): a marker already at
    // the playhead is edited, never duplicated. Option/Alt+M and the toolbar
    // button also open the editor for a NEW marker; plain M does not, so
    // marking during playback is not interrupted.
    const existing = markersOf(store.timeline).find((m) => m.frame === store.playhead);
    if (existing) {
      store.setEditingMarkerId(existing.id);
      return;
    }
    const marker = newMarker(store.playhead);
    // `newMarker` only rejects a caller-supplied colour or a non-finite frame;
    // this call site passes neither, so the guard is a type narrow, not a real
    // branch.
    if ('error' in marker) return;
    applyOp({ kind: 'add_marker', marker });
    if (openEditor) store.setEditingMarkerId(marker.id);
  };

  /** D-128 — break the selected clip's A/V link so its halves can be edited
   *  independently (the L-cut/J-cut workflow: unlink, slip one half). The
   *  same explicit action both reference NLEs expose (Premiere `Clip >
   *  Unlink`, Resolve "Unlink Clips"), and the only way back to D-050's
   *  embedded-audio playback for a video clip. Dissolves the COMPLETE group,
   *  so running it on either half is equivalent. */
  const doUnlink = () => {
    for (const s of selection) {
      const at = locateClip(s.id);
      if (at) applyOp({ kind: 'unlink', track: at.track, clip: at.clip });
    }
  };

  /** Whether anything in the current selection is A/V-linked — gates the
   *  Unlink button, which is meaningless (and a no-op) otherwise. */
  const selectionIsLinked = selection.some(
    (s) => !!timeline?.tracks[s.track]?.clips.find((c) => c.id === s.id)?.link_group,
  );

  /** D-138 — the Link button's own gate: exactly two clips selected, resolved
   *  to real `{track, clip}` locations, run through `checkLink` (the SAME
   *  precondition check `applyOp`'s `link` case uses, see that op's own
   *  doc) — `null` when the selection isn't shaped like a link candidate at
   *  all (not exactly two clips selected), so the button is hidden rather
   *  than shown-and-always-refused for the common case of 0/1/3+ selected.
   *  D-201 — no `useMemo` (see the note above `cutStyleById`): its
   *  `[timeline, selection]` array left out `idxOf`, and the body returns
   *  `null` immediately unless exactly two clips are selected anyway. */
  const linkCheck = ((): { a: LinkTarget; b: LinkTarget; result: LinkCheck } | null => {
    if (!timeline || selection.length !== 2) return null;
    const [sa, sb] = selection;
    const ia = idxOf(sa.track, sa.id);
    const ib = idxOf(sb.track, sb.id);
    if (ia < 0 || ib < 0) return null;
    const a: LinkTarget = { track: sa.track, clip: ia };
    const b: LinkTarget = { track: sb.track, clip: ib };
    return { a, b, result: checkLink(timeline, a, b) };
  })();

  /** D-138 — link the two selected (already-independent) clips into a new
   *  A/V group: Palmier's own `manage_clip_links` `link`, Premiere's `Clip >
   *  Link`, and the manual counterpart to `doUnlink` above. Re-resolves via
   *  `locateClip` (not the memoized `linkCheck` locations) for the same
   *  stale-index reason every other batch-capable action here does, even
   *  though this one is never actually batched. */
  const doLink = () => {
    if (!linkCheck?.result.ok) return;
    const at = locateClip(selection[0].id);
    const bt = locateClip(selection[1].id);
    if (!at || !bt) return;
    applyOp({ kind: 'link', trackA: at.track, clipA: at.clip, trackB: bt.track, clipB: bt.clip });
  };

  /** B-236 — whether the selected gap can actually be closed, from the SAME
   *  `checkRemoveGap` that `applyOp`'s `remove_gap` case and the MCP's
   *  `editor_remove_gap` both run (B-227), so the button, the Delete key and
   *  the agent can never disagree about it. `null` when no gap is selected.
   *
   *  A gap can be perfectly real and selectable yet still not closeable: on a
   *  sync-locked timeline (every track here defaults to sync-locked), closing
   *  it ripples every other sync-locked track, and B-033 refuses that ripple
   *  when some other track has a clip straddling the gap's end. Before this,
   *  the GUI never asked — `doRemoveGap` dispatched, the reducer silently
   *  returned the timeline unchanged, and the selection was cleared anyway,
   *  so the gap looked like it could neither be kept selected nor deleted.
   *
   *  Cost: one pass over every track's clips, only while a gap is selected —
   *  the same O(clips) walk `gapAt` already does for the highlight below. */
  const gapCloseCheck =
    selectedGap && timeline ? checkRemoveGap(timeline, selectedGap.track, selectedGap.frame, fps) : null;

  /** D-105 — the deliberate mirror image of `doRemove`: close a selected
   *  GAP, rippling everything after it earlier, rather than lifting a clip
   *  and leaving the space behind. B-236 — a refused close leaves the gap
   *  selected (the Close Gap button says why), rather than dropping the
   *  selection as if something had happened. */
  const doRemoveGap = () => {
    if (!selectedGap || !gapCloseCheck?.ok) return;
    applyOp({ kind: 'remove_gap', track: selectedGap.track, frame: selectedGap.frame });
    setSelectedGap(null);
  };

  // D-273 — every one of this pane's shortcuts, resolved from the registry.
  //
  // These used to be a `onKeyDown` on the pane's own root div comparing
  // `e.key` to 'm' / 'Delete' / the trim-tool letters, each with its own
  // hand-rolled "no modifier held" and "not in a text field" guard. Two things
  // were wrong with that beyond the literals: the guards were duplicated per
  // branch (and drifted — the Delete branch had neither), and because the
  // handler hung off a `tabIndex={0}` div, NONE of them worked unless the user
  // had clicked the timeline first. Pressing M straight after dragging a clip
  // in from Sources did nothing at all. The dispatcher is window-level and
  // tab-scoped, so they now work whenever the Edit tab is frontmost, and the
  // typing guard lives in exactly one place.
  //
  // `edit.split` is new: the Split button has been in this toolbar since D-093
  // with no key bound to it anywhere.
  useShortcut('edit.add_marker', () => doAddMarker(false));
  useShortcut('edit.add_marker_edit', () => doAddMarker(true));
  useShortcut('edit.split', () => {
    if (selection.length > 0) doSplit();
  });
  useShortcut('edit.delete_selection', () => {
    // D-105 — a selected gap takes the same key as a selected clip; the two
    // are mutually exclusive (see `selectedGap`'s own doc), so at most one
    // branch ever fires.
    if (selection.length > 0) doRemove();
    else if (selectedGap) doRemoveGap();
  });
  // B-348 — Shift+Delete: Premiere's Ripple Delete. The clip comes out AND the
  // hole closes (`ripple_delete_ranges`, per clip); plain Delete lifts and
  // leaves the gap. A selected gap needs no ripple variant (Delete already is one).
  useShortcut('edit.ripple_delete', () => {
    if (selection.length === 0) return;
    if (rippleDeleteClips(selection.map((s) => s.id)) > 0) setSelection([]);
  });
  useShortcut('edit.tool_select', () => selectTrimTool('select'));
  useShortcut('edit.tool_ripple', () => selectTrimTool('ripple'));
  useShortcut('edit.tool_roll', () => selectTrimTool('roll'));
  useShortcut('edit.tool_slip', () => selectTrimTool('slip'));
  useShortcut('edit.tool_slide', () => selectTrimTool('slide'));
  useShortcut('edit.tool_blade', () => selectTrimTool('blade'));
  /**
   * D-432 P3 — skimming (S, off by default; spec §4.6). While it is on, the
   * pointer over the timeline moves a 1 px `skimmer` line and asks the viewer
   * for the frame under it (`previewPeek.ts`); the playhead does not move.
   * Native listeners and a ref, coalesced to one update per animation frame
   * and to frame changes only: a skim renders neither this pane nor the
   * viewer (it fetches through its own latest-wins path). Suspended while a
   * button is held (a drag, a trim) and cleared when the pointer leaves.
   */
  const skimViewRef = useRef({ fps, pxPerSec });
  useEffect(() => {
    skimViewRef.current = { fps, pxPerSec };
  });
  useEffect(() => {
    const el = editArea;
    if (!el || !skimming) return;
    let raf = 0;
    let lastX: number | null = null;
    const hide = () => {
      lastX = null;
      if (raf) cancelAnimationFrame(raf);
      raf = 0;
      if (skimLineRef.current) skimLineRef.current.hidden = true;
      usePreviewPeekStore.getState().setSkimFrame(null);
    };
    const apply = () => {
      raf = 0;
      if (lastX === null) return;
      const v = skimViewRef.current;
      const scrollLeft = scroll.getState().left;
      const x = lastX - el.getBoundingClientRect().left;
      const frame = Math.max(0, Math.round(((x + scrollLeft - START_LEFT_PX) / v.pxPerSec) * v.fps));
      const line = skimLineRef.current;
      if (line) {
        line.hidden = false;
        line.style.transform = `translate3d(${START_LEFT_PX + (frame / v.fps) * v.pxPerSec - scrollLeft}px, 0, 0)`;
      }
      usePreviewPeekStore.getState().setSkimFrame(frame);
    };
    const onMove = (e: PointerEvent) => {
      if (e.buttons !== 0 || el.dataset.chromaEditGesture !== undefined) {
        if (lastX !== null) hide();
        return;
      }
      lastX = e.clientX;
      if (!raf) raf = requestAnimationFrame(apply);
    };
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerleave', hide);
    return () => {
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerleave', hide);
      hide();
    };
  }, [editArea, skimming]);

  // D-432 P3 — Final Cut's N (snapping) and S (skimming): the same store the
  // toolbar's toggles write.
  useShortcut('edit.toggle_snapping', () => {
    const v = useTimelineViewStore.getState();
    v.setView({ snapping: !v.snapping });
  });
  useShortcut('edit.toggle_skimming', () => {
    const v = useTimelineViewStore.getState();
    v.setView({ skimming: !v.skimming });
  });

  // D-080: "Move to another track" — the library has no cross-row drag (see
  // the module doc), so this is a discoverable affordance for the same
  // cross-track move `ClipBody`'s drag handle does. D-104: lands via
  // `resolveClipLanding` (same as the drag path), trying to keep the clip's
  // own current time position but snapping to a real open/ripple slot if
  // that would land on top of something already on `toTrack` — never a
  // silent overlap, never a silent no-op either.
  const doMoveToTrack = (toTrack: number) => {
    // Multi-select, Phase 1 (D-107): multi-clip cross-track move is a real,
    // deliberately deferred Phase 3 (`docs/notes/multi-select.md`) — N
    // landing positions that must be mutually non-overlapping with EACH
    // OTHER, not just with what's already on the track, is a real
    // sequencing problem this pass doesn't take on. `primary` (only set
    // when exactly one clip is selected) keeps this dropdown single-clip
    // only, same as before this pass.
    if (!primary) return;
    const i = idxOf(primary.track, primary.id);
    if (i < 0) return;
    const clip = clipsOf(primary.track)[i];
    const snapFrames = Math.round((INSERT_SNAP_PX / pxPerSec) * fps);
    // B-122 — the third and last `resolveClipLanding` call site, and the only
    // one not fed by a drag. `otherTracks` builds this menu from real indices,
    // so this guard should never fire — but `resolveClipLanding` reads
    // `dest.clips` immediately, and "should never fire" is exactly what was
    // believed about the two drag sites before one of them took the dev server
    // down. Every caller of that function now proves its destination first.
    const dest = tracks[toTrack];
    if (!dest) return;
    const { startFrame, ripple } = resolveClipLanding(dest, clip.id, clip, clip.start_frame, snapFrames, fps);
    applyOp({ kind: 'move', fromTrack: primary.track, toTrack, clip: i, startFrame, ripple });
    setSelection([{ track: toTrack, id: primary.id }]);
  };

  // D-096 — no more explicit "add track" buttons (removed per owner
  // feedback, D-080's toolbar affordance): a track is now created implicitly
  // by dropping a Sources-panel clip past the last real row — see `onDrop`'s
  // "new_track" branch, which calls `applyOp({ kind: 'add_track', ... })`
  // directly rather than through a named wrapper like this one used to be.

  const doRemoveTrack = (track: number) => {
    applyOp({ kind: 'remove_track', track });
    // Multi-select, Phase 1 (D-107): drops every selected clip that was on
    // the removed track. Pre-existing limitation, unchanged from before
    // this pass — like the old single-`selected` code, this doesn't shift
    // the `.track` index of a selected clip on a track AFTER the removed
    // one (removing a track shifts every later track index down by one);
    // out of scope here, matching prior behavior exactly rather than fixing
    // an unrelated gap while generalizing this.
    setSelection((prev) => prev.filter((s) => s.track !== track));
    if (selectedGap?.track === track) setSelectedGap(null); // D-105
  };

  const toggleMute = (track: number) => {
    const t = tracks[track];
    if (!t) return;
    const muted = (t.gain ?? DEFAULT_TRACK_GAIN) <= 0;
    applyOp({ kind: 'set_track_gain', track, gain: muted ? DEFAULT_TRACK_GAIN : 0 }, 'mute-button');
  };

  /** D-149 — patch one track's ducking. Reads the track's CURRENT values for
   *  whatever the patch doesn't name, so changing the attack alone doesn't
   *  reset the amount — `set_track_duck` writes all four fields at once (like
   *  `set_clip_fade` does for its four), so a partial write has to be
   *  completed here rather than in the op. */
  const changeDuck = (
    track: number,
    patch: { duckFrom?: number | null; duckDb?: number; attackMs?: number; releaseMs?: number },
  ) => {
    const t = tracks[track];
    if (!t) return;
    applyOp({
      kind: 'set_track_duck',
      track,
      duckFrom: patch.duckFrom !== undefined ? patch.duckFrom : (t.duck_from ?? null),
      duckDb: patch.duckDb ?? t.duck_db ?? 0,
      duckAttackMs: patch.attackMs ?? t.duck_attack_ms ?? DEFAULT_DUCK_ATTACK_MS,
      duckReleaseMs: patch.releaseMs ?? t.duck_release_ms ?? DEFAULT_DUCK_RELEASE_MS,
    });
  };

  // D-090 — Phase 4 of the P0 full-NLE effort: lock/hide/rearrange, wired to
  // the D-086/D-089 ops. Not gated by the track's own current lock state
  // (mirrors `applyOp`'s own `set_track_locked`/`set_track_hidden`/
  // `move_track` — track-list-level, not routed through the per-clip
  // `TrackLocked` check).
  const toggleLock = (track: number) => {
    const t = tracks[track];
    if (!t) return;
    applyOp({ kind: 'set_track_locked', track, locked: !t.locked });
  };

  const toggleHidden = (track: number) => {
    const t = tracks[track];
    if (!t) return;
    applyOp({ kind: 'set_track_hidden', track, hidden: !t.hidden });
  };

  // D-106 — cross-track ripple sync toggle. Same unconditional-success
  // reasoning as `toggleLock`/`toggleHidden` above.
  const toggleSyncLocked = (track: number) => {
    const t = tracks[track];
    if (!t) return;
    applyOp({ kind: 'set_track_sync_locked', track, syncLocked: !(t.sync_locked ?? DEFAULT_SYNC_LOCKED) });
  };

  /**
   * D-432 P3 — the per-track height drag (§4.8), from a header's bottom edge
   * or a lane's. Imperative, so a drag renders nothing: each move writes the
   * dragged header's `height` (the headers below it reflow) and moves one
   * guide line across the lanes; the release commits ONE `set_track_height`
   * (one undo step, the same op `editor_set_track_height` applies), and that
   * commit's render lays the lanes out at the new height. Esc cancels.
   */
  const startTrackHeightDrag = (e: ReactPointerEvent<HTMLElement>, track: number) => {
    if (e.button !== 0) return;
    const start = rowHeights[track];
    if (start === undefined) return;
    e.preventDefault();
    const originY = e.clientY;
    const header =
      headerColumnRef.current?.querySelector<HTMLElement>(
        `[data-testid="${TIMELINE_TEST_IDS.trackHeader}"][data-chroma-track="${track}"]`,
      ) ?? null;
    const guide = heightGuideRef.current;
    const top = RULER_AND_MARGIN_PX + rowTops[track] - scroll.getState().top;
    let height = start;
    const show = (h: number) => {
      if (header) header.style.height = `${h}px`;
      if (guide) {
        guide.hidden = false;
        guide.style.transform = `translate3d(0, ${top + h}px, 0)`;
      }
    };
    const onMove = (ev: PointerEvent) => {
      height = clampTrackHeight(start + ev.clientY - originY);
      show(height);
    };
    const finish = (commit: boolean) => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onCancel);
      window.removeEventListener('keydown', onKey, true);
      if (guide) guide.hidden = true;
      if (header) header.style.height = `${commit ? height : start}px`;
      if (commit && height !== start) applyOp({ kind: 'set_track_height', track, height });
    };
    const onUp = () => finish(true);
    const onCancel = () => finish(false);
    const onKey = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape') return;
      ev.stopPropagation();
      finish(false);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onCancel);
    window.addEventListener('keydown', onKey, true);
    show(height);
  };

  // D-094 — track reorder is now a real drag handle on each header row
  // (`DotsSixVertical`, plain HTML5 drag/drop — same mechanism as the
  // Sources-panel clip drop, just scoped to the header sidebar's own DOM,
  // entirely separate from the library's action-drag), replacing D-090's
  // up/down buttons. `move_track(from, to)` mirrors `apelles_timeline::
  // Timeline::move_track` exactly (`Vec::remove(from)` then `insert(to,
  // _)`) — a plain button swap only ever needed `from`/`to` adjacent, but a
  // real drag can drop a track anywhere in the list, which shifts every
  // track between `from` and `to` by one, not just the two endpoints. Doing
  // the selection-follow math generically here (rather than the old
  // two-branch swap) keeps it correct for both: an adjacent `to` reduces to
  // exactly the old swap.
  //
  // D-214 promoted this to `timeline.ts`'s own exported `trackIndexAfterMove`
  // so `useEditorControl.ts`'s `editor_move_track` MCP op (the same
  // `move_track` primitive, driven by an agent instead of a drag) does the
  // identical selection-follow rather than re-deriving it — imported above.
  const doMoveTrack = (from: number, to: number) => {
    if (from < 0 || from >= tracks.length || to < 0 || to >= tracks.length || from === to) return;
    applyOp({ kind: 'move_track', from, to });
    setSelection((prev) => prev.map((s) => ({ ...s, track: trackIndexAfterMove(s.track, from, to) })));
  };

  // D-098 — the one shared `<DndContext>`'s handlers, covering both drag
  // kinds this file now hands to `@dnd-kit/core` (track reorder, cross-track
  // clip move — same-track drag/trim/resize stays on the timeline library's
  // own native mechanism, untouched, out of scope for this migration).
  const onDndDragStart = useCallback((event: DragStartEvent) => {
    // B-122 — narrowed by `dndTargets.ts`'s validating helpers rather than an
    // inline `as` cast. A cast is a promise, not a check; six independent
    // promises about one shared `type` namespace is exactly how the header and
    // the lane ended up indistinguishable.
    const clip = asClipDrag(event.active.data.current);
    const header = asTrackHeaderDrag(event.active.data.current);
    // B-145 — the scroll origin is captured for EVERY drag kind, before the
    // early return below: a transitions-palette drag has no ghost of its own
    // but its drop still resolves through `dragPx`, and a drag whose origin
    // was never captured would fall back to `{0,0}` and reintroduce exactly
    // the offset this bug was.
    dragScrollOriginRef.current = { ...scroll.getState() };
    const next = clip ?? header;
    if (!next) return; // a transitions-palette drag — no overlay ghost of its own
    setActiveDrag(next);
    // B-137 — where in the clip the press that started this drag landed, and
    // how wide that clip really is on screen. Measured off the DOM at press
    // (`clipGrabRef`), not recomputed from frames × zoom: the ghost has to line
    // up with the element `DragOverlay` anchors itself to, and a second,
    // independently-derived width is exactly how those two drift apart.
    // Promoted to state only now, once there is a real drag to render a ghost
    // for. See `dragGhost.ts` for what it is used for.
    setClipGrab(clip ? clipGrabRef.current : null);
  }, [scroll]);

  const onDndDragCancel = useCallback(() => {
    setActiveDrag(null);
    setClipGrab(null);
    dragScrollOriginRef.current = null;
    dragPreviewRef.current?.setLanding((prev) => (prev === null ? prev : null));
  }, []);

  /** B-145 — the ONE place a dnd-kit drag's displacement is read in this file.
   *  `event.delta` is not usable here (see `dragDelta.ts` for the mechanism):
   *  this pane's draggables live inside the lanes' own scrolling
   *  grid while its droppables are overlay siblings outside it, so dnd-kit's
   *  scroll adjustment goes wrong by the whole scroll offset the drag started
   *  at. Every consumer — the live landing preview, the committed move, the
   *  new-track drop, the slip/slide body drag and the transition drop — goes
   *  through this, so none of them can drift from the others again. */
  const dragPx = (event: DragMoveEvent | DragEndEvent): DragDelta | null =>
    dragDelta(event.active.rect.current, dragScrollOriginRef.current ?? scroll.getState(), scroll.getState());

  // D-113 — live landing preview, the drag-tick-sensitive twin of
  // `onDndDragEnd`'s own landing computation below (same math, same
  // `resolveClipLanding` call — kept in sync deliberately, not copy-pasted
  // and left to drift: if `onDndDragEnd`'s computation ever changes, this
  // one needs to change with it). Fires on every pointer-move tick during
  // a drag, so the D-083 discipline that already governs every other
  // per-tick handler in this file applies here just as strictly: the
  // `setLanding` call is gated to only actually dispatch when the resolved
  // landing genuinely changed, not on every pixel of movement.
  //
  // D-201 audited this against roadmap item 21.3 ("does the drag re-render
  // through React state every pointer-move frame?") and answered "no, it is
  // change-gated." **B-160 found that answer was wrong in practice**: at any
  // ordinary zoom a few pixels of movement IS a different landing frame, so the
  // gate almost never fires, and the state lived on `TimelinePane` itself —
  // which meant a full re-render of the app's largest component on nearly every
  // tick, measured at ~2 renders per pointer-move with frame intervals p90
  // 24-28ms against a flat 16.7ms idle. The gating is still right and still
  // here; what changed is WHERE the state lives — `TimelineDragPreview` owns it
  // now, so a tick re-renders four overlay boxes instead of the whole pane.
  //
  // The rest of D-201's audit still holds: a marquee writes only local
  // `marquee`, a trim goes through the library's own resize and reaches
  // `applyOp` in `onActionResizeEndCb` — i.e. on resize END — and
  // `TransformOverlay`'s canvas gesture keeps a local `draft`. The ONE and
  // only `applyOp` for a clip drag is in `onDndDragEnd` below, so exactly one
  // undo entry (`useHistoryStore.push`) and one debounced `chroma_timeline_set`
  // are produced per gesture. Do not move a store write into this handler.
  /** D-117 — a dnd-kit clip drag has no `over` at all once the pointer is
   *  past the last `TrackDropZone` (or above the first, or between two) —
   *  `TrackDropZone` only ever mounts one instance per EXISTING track
   *  (`tracks.map` below), so there was never a droppable there to resolve
   *  to. That's the real cause of "i can't drag a clip to create a new
   *  track" — the legacy Sources-panel `onDrop` path has always supported
   *  this (`trackInsertBoundary`), the newer dnd-kit clip-move path
   *  (D-100) never gained the equivalent. Rather than mount MORE
   *  droppables (a real option, rejected: it would mean two different
   *  boundary concepts to keep in sync), this computes the same boundary
   *  `trackInsertBoundary` already defines, from the dragged item's own
   *  live rect (`event.active.rect.current.translated`) instead of a
   *  native `clientY` — dnd-kit doesn't hand you the raw pointer position
   *  directly, but the dragged `ClipBody`'s own translated top edge is an
   *  equally real, live signal of where the pointer is. */
  /*  B-115 — and it now REFUSES unless the gesture's real pointer is inside
   *  the edit area. `dndBoundary` is only consulted when `event.over` is
   *  `null`, which covers two very different situations that the dragged
   *  rect alone cannot tell apart: "above/below/between the track rows, still
   *  over the timeline" (a real insertion) and "dropped somewhere else
   *  entirely — the preview, the Inspector, off the window" (a cancel). That
   *  did not matter while `trackInsertBoundary` refused every `y < 0`, because
   *  a drop outside the pane almost always produced one; now that above-the-
   *  tracks is a legal boundary, the two have to be told apart explicitly.
   *  The pointer is reconstructed the same way the transition drop already
   *  does it — `activatorEvent`'s own position plus the drag's displacement,
   *  which dnd-kit does not expose directly — so there is one notion of "where
   *  did this drag actually end" in this file, not two.
   *
   *  B-145 — that displacement is the SCREEN one (`dragPx`), never the content
   *  one: this is a "is the pointer still over the pane" question, asked in
   *  the same viewport coordinates `getBoundingClientRect` answers in. */
  const dndBoundary = (event: DragMoveEvent | DragEndEvent): number | null => {
    const rect = editAreaRef.current?.getBoundingClientRect();
    const translated = event.active.rect.current.translated;
    const moved = dragPx(event);
    if (!rect || !translated || !moved || tracks.length === 0) return null;
    const activator = event.activatorEvent as PointerEvent | MouseEvent | undefined;
    if (typeof activator?.clientX !== 'number' || typeof activator?.clientY !== 'number') return null;
    const px = activator.clientX + moved.screenX;
    const py = activator.clientY + moved.screenY;
    if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) return null;
    // D-117's own signal for WHICH boundary: the dragged `ClipBody`'s
    // translated top edge, which is what the user actually sees lining up
    // with a row. The pointer above answers "is this drop on the timeline at
    // all"; this answers "which line is it on".
    const y = translated.top - rect.top - RULER_AND_MARGIN_PX + scroll.getState().top;
    return trackInsertBoundary(y, tracks.length);
  };

  /** D-201 — no `useCallback` (see the note above `cutStyleById`): its old
   *  array listed `idxOf`/`clipsOf`, plain arrows re-created on every render,
   *  so it never memoized anything — while still bailing the compiler out of
   *  the whole component. */
  const onDndDragMove =
    (event: DragMoveEvent) => {
      // B-122 — `laneDropTrack` answers "which REAL track is this over" in one
      // step: it refuses a track HEADER (the crash), a malformed payload, and
      // an index naming a track that no longer exists. So `toTrack` below is
      // never an index this component has to remember to bounds-check.
      const data = asClipDrag(event.active.data.current);
      const overTrack = laneDropTrack(event.over?.data.current, tracks.length);
      if (!data) {
        dragPreviewRef.current?.setLanding((prev) => (prev === null ? prev : null));
        dragPreviewRef.current?.setInsert((prev) => (prev === null ? prev : null));
        return;
      }
      if (overTrack === null) {
        // Not over an existing track's lane — check whether this is a real
        // track-insertion boundary (same helper the Sources-panel add path
        // uses) and show the identical ghost-row preview if so.
        dragPreviewRef.current?.setLanding((prev) => (prev === null ? prev : null));
        const boundary = dndBoundary(event);
        dragPreviewRef.current?.setInsert((prev) =>
          boundary === null
            ? prev === null
              ? prev
              : null
            : prev?.kind === 'new_track' && prev.index === boundary
              ? prev
              : { kind: 'new_track', index: boundary },
        );
        return;
      }
      dragPreviewRef.current?.setInsert((prev) => (prev === null ? prev : null));
      const { track: fromTrack, clipId } = data;
      const i = idxOf(fromTrack, clipId);
      if (i < 0) return;
      const clip = clipsOf(fromTrack)[i];
      const toTrack = overTrack;
      const moved = dragPx(event);
      if (!moved) return;
      const deltaFrames = Math.round((moved.contentX / pxPerSec) * fps);
      // D-413 — head or tail onto a beat first; the landing rule below then
      // resolves that frame to a real slot exactly as before.
      const intendedFrame = snapClipToBeat(clip.start_frame + deltaFrames, endFrame(clip, fps) - clip.start_frame);
      const snapFrames = insertSnapFrames;
      // `toTrack` came from `laneDropTrack`, which only ever returns a real
      // track index — so this cannot be the `undefined` that crashed
      // `resolveClipLanding` on `dest.clips` (B-122).
      const { startFrame, ripple } = resolveClipLanding(tracks[toTrack], clip.id, clip, intendedFrame, snapFrames, fps);
      dragPreviewRef.current?.setLanding((prev) => {
        if (
          prev &&
          prev.fromTrack === fromTrack &&
          prev.toTrack === toTrack &&
          prev.clipId === clipId &&
          prev.startFrame === startFrame &&
          prev.ripple === ripple
        ) {
          return prev; // no real change — same discipline as onDragOver's setDragOver
        }
        // B-077 — a TIMELINE-frame footprint, not `clip.duration`'s raw
        // (source-frame) value — see `TimelineDragPreview`'s own doc for why.
        return { fromTrack, toTrack, clipId, startFrame, duration: sourceFramesToTimeline(clip, clip.duration, fps), ripple };
      });
    };

  /** D-201 — no `useCallback`, same reasoning as `onDndDragMove` just above. */
  const onDndDragEnd =
    (event: DragEndEvent) => {
      // B-122 — the three drag kinds sharing this `DndContext`, each narrowed
      // by a real runtime check rather than an `as` cast (see `dndTargets.ts`).
      // `TransitionDragData` stays with its own feature (D-226); the two that
      // were confusable with each other are the ones that moved.
      const raw = event.active.data.current;
      const clipDrag = asClipDrag(raw);
      const headerDrag = asTrackHeaderDrag(raw);
      const transitionDrag =
        raw && (raw as TransitionDragData).type === 'transition' ? (raw as TransitionDragData) : null;
      // B-374 — a pointer press focused the dragged clip body (dnd-kit makes it
      // a `tabIndex={0}` button). A move past a neighbour re-orders the lane's
      // DOM, the moved node loses focus, and React's commit then restores it:
      // reads every ancestor's scroll position and calls `focus()`, forced
      // layouts of the freshly moved 300-clip page. After a mouse drop nothing
      // needs the clip focused (the shortcuts are window-level, D-273), so it is
      // blurred here, before the commit. `blur()`, not focusing the pane: a
      // `focus()` checks focusability and scrolls into view, itself a forced
      // layout of the dirty page (measured ~14 ms). A keyboard drag keeps
      // dnd-kit's own focus restore.
      if (clipDrag && !(event.activatorEvent instanceof KeyboardEvent)) {
        const focused = document.activeElement;
        if (focused instanceof HTMLElement && focused.closest('[data-chroma-clip-drag]')) focused.blur();
      }
      setActiveDrag(null);
      setClipGrab(null);
      dragPreviewRef.current?.setLanding((prev) => (prev === null ? prev : null));
      // B-145 — the drag's real displacement, for every branch below that
      // resolves a position. `dragScrollOriginRef` is deliberately NOT cleared
      // here: `dndBoundary` further down reads it too, and this handler has a
      // dozen early returns. It is overwritten by the next `onDndDragStart`
      // and cleared by `onDndDragCancel`, and nothing reads it outside a drag.
      const moved = dragPx(event);

      // D-226 — a transition dragged out of the palette. Its only legal target
      // is a real CUT on a video track, so the drop resolves to the nearest one
      // within `TRANSITION_SNAP_PX` and is refused (with a real reason) rather
      // than snapped to something arbitrary — a transition is not a clip, it
      // cannot land "roughly there".
      if (transitionDrag) {
        // B-122 — a transition dropped on a track HEADER used to reach here as
        // a lane drop with `track: undefined`; it survived only because of the
        // `if (!tr) return` below, which the clip path did not have. Now the
        // narrowing itself refuses it, and `trackIdx` is always a real track.
        const trackIdx = laneDropTrack(event.over?.data.current, tracks.length);
        if (trackIdx === null || !timeline) return;
        const tr = tracks[trackIdx];
        // The pointer's real x: `dragPx` is the whole drag's movement, and
        // `activatorEvent` is the original pointer event it started from — the
        // pair gives an absolute position without needing a rect measurement,
        // the same relative-plus-origin approach the clip drag above uses.
        // B-145 — the SCREEN displacement, since it is being added to a
        // `clientX` and then converted to content space by `- rect.left +
        // scrollLeft` right here; adding the content one would count the
        // scroll twice.
        const activator = event.activatorEvent as PointerEvent | MouseEvent | undefined;
        const rect = editAreaRef.current?.getBoundingClientRect();
        if (!rect || !moved || typeof activator?.clientX !== 'number') return;
        const contentX = activator.clientX + moved.screenX - rect.left + scroll.getState().left;
        const frame = Math.round(((contentX - START_LEFT_PX) / pxPerSec) * fps);
        const snapFrames = Math.max(1, Math.round((TRANSITION_SNAP_PX / pxPerSec) * fps));
        const cuts = tr.kind === 'video' ? cutFrames(tr, fps) : [];
        const cut = nearestCut(cuts, frame, snapFrames);
        if (cut === null) {
          setDropError(
            tr.kind !== 'video'
              ? 'Transitions apply to video tracks only.'
              : cuts.length === 0
                ? 'That track has no cut — a transition needs two clips touching end to start.'
                : 'Drop a transition right on a cut between two clips.',
          );
          return;
        }
        const duration = defaultTransitionFrames(
          timeline,
          trackIdx,
          cut,
          fps,
          (c) => endFrame(c, fps) - c.start_frame,
        );
        const built = newTransition(transitionDrag.kind, cut, duration);
        if ('error' in built) {
          setDropError(built.error);
          return;
        }
        const check = checkTransition(timeline, trackIdx, built, fps);
        if (!check.ok) {
          setDropError(check.reason ?? 'that transition cannot go there');
          return;
        }
        setDropError(null);
        applyOp({ kind: 'add_transition', track: trackIdx, transition: built });
        return;
      }

      if (headerDrag) {
        // `over` is another `SortableTrackHeader` (every sortable item is
        // also a droppable, dnd-kit's own doc) — its `data.current.index`
        // is the CURRENT render's track index, exactly what `doMoveTrack`
        // (unchanged from D-094/D-097) already expects as `to`.
        // B-122 — a reorder resolves against another HEADER, never a lane.
        // These two questions look identical at the call site and have
        // different right answers, which is why `dndTargets.ts` gives each its
        // own function.
        const overIndex = headerDropIndex(event.over?.data.current, tracks.length);
        if (overIndex === null) return;
        doMoveTrack(headerDrag.index, overIndex);
        return;
      }
      if (!clipDrag) return;

      // clip — D-100: the ONLY move mechanism now, same-track or
      // cross-track alike (see `ClipBody`'s own doc for why the library's
      // former native move-drag is
      // gone). `over`'s track vs. this clip's own starting track is what
      // decides which case this is — no separate code path per gesture,
      // just a different `startFrame` computation.
      const { track: fromTrack, clipId } = clipDrag;
      const i = idxOf(fromTrack, clipId);
      if (i < 0) return;

      // B-122 — one question, one answer: `laneDropTrack` is `null` for "not
      // over anything", "over a HEADER rather than a lane" (the crash) and
      // "over a lane whose track no longer exists" alike, and every one of
      // those is the same non-landing. `toTrack` below is therefore always a
      // real track index, which is what `resolveClipLanding` requires.
      const overTrack = laneDropTrack(event.over?.data.current, tracks.length);
      // B-145 — no measurable displacement means dnd-kit never resolved a rect
      // for this drag, so there is no honest landing to compute. Refuse rather
      // than commit a `move` to whatever `clip.start_frame` already was: a
      // silent no-op op is still an undo entry and a save.
      if (!moved) return;
      if (overTrack === null) {
        dragPreviewRef.current?.setInsert((prev) => (prev === null ? prev : null));
        // D-117 — not over an existing track's lane: check whether
        // this is a real track-insertion boundary instead of just
        // cancelling. Mirrors the Sources-panel `onDrop`'s own
        // `add_track` (+ `move_track` when it's not a plain append) —
        // same op sequence, same reasoning, just reached from a dnd-kit
        // clip drag instead of a native-HTML5 media drag.
        const boundary = dndBoundary(event);
        if (boundary === null) return; // genuinely dropped nowhere real — cancel
        const clip = clipsOf(fromTrack)[i];
        const newTrackIdx = tracks.length;
        applyOp({ kind: 'add_track', trackKind: inferNewTrackKind(boundary) });
        if (boundary !== newTrackIdx) {
          applyOp({ kind: 'move_track', from: newTrackIdx, to: boundary });
        }
        // The clip's own source track index may itself have shifted if the
        // new track was inserted above it (`move_track`'s selection-follow
        // math, same as the Sources-panel path) — resolve `fromTrack` AFTER
        // that reposition, not before.
        const resolvedFromTrack = boundary !== newTrackIdx ? trackIndexAfterMove(fromTrack, newTrackIdx, boundary) : fromTrack;
        const deltaFrames = Math.round((moved.contentX / pxPerSec) * fps);
        const intendedFrame = Math.max(0, clip.start_frame + deltaFrames);
        // The new track is guaranteed empty — no gap/ripple resolution
        // needed, `intendedFrame` is always a safe landing.
        applyOp({ kind: 'move', fromTrack: resolvedFromTrack, toTrack: boundary, clip: i, startFrame: intendedFrame, ripple: false });
        setSelection([{ track: boundary, id: clipId }]);
        return;
      }
      const toTrack = overTrack;
      const clip = clipsOf(fromTrack)[i];
      // D-104 — `moved.contentX` is the net pointer movement for the whole
      // drag, in timeline-content px, converted to frames the same way
      // `xToFrame` does (relative rather than absolute — no `rect`/`clientX`
      // needed). B-145 — it used to be `event.delta.x`, which is dnd-kit's own
      // scroll-adjusted translate and is wrong by the whole horizontal scroll
      // offset on this surface; `dragDelta.ts` has the mechanism. Used
      // for BOTH cases now: cross-track previously ignored horizontal
      // movement entirely and just kept the clip's original frame verbatim,
      // which is what silently landed a cross-track drop directly on top of
      // whatever already occupied that same time range on the destination
      // track. `resolveClipLanding` (mirroring `computeInsertion`, the same
      // placement algorithm a brand-new clip from Sources already uses) then
      // resolves that intended frame to a real slot — before/after/rippled-
      // between neighbours, never a silent overlap, for a same-track
      // reposition or a cross-track move alike (owner, live-tested: "i
      // should be able to drop it before any clip, between two clip or
      // after two clip, not on top of the clip... that should not be
      // possible"). This reverses D-096's cross-track-overlap-allowed
      // policy — see `EditOp`'s `move` case for the full reasoning.
      const deltaFrames = Math.round((moved.contentX / pxPerSec) * fps);
      // D-413 — head or tail onto a beat first; the landing rule below then
      // resolves that frame to a real slot exactly as before.
      const intendedFrame = snapClipToBeat(clip.start_frame + deltaFrames, endFrame(clip, fps) - clip.start_frame);
      const snapFrames = insertSnapFrames;
      const { startFrame, ripple } = resolveClipLanding(tracks[toTrack], clip.id, clip, intendedFrame, snapFrames, fps);
      applyOp({ kind: 'move', fromTrack, toTrack, clip: i, startFrame, ripple });
      // A drag also selects the clip it moved — same-track or cross-track —
      // matching normal NLE expectations (dragging a clip is also picking
      // it), not just the old cross-track-only behaviour. Multi-select,
      // Phase 1 (D-107): a drag always replaces the whole selection with
      // just the dragged clip — multi-clip drag-move is the same deferred
      // Phase 3 as multi-clip "Move to" (see `doMoveToTrack`'s own doc).
      setSelection([{ track: toTrack, id: clipId }]);
    };

  /** B-116 — the one zoom entry point, for both the ctrl/pinch wheel and the
   *  toolbar's +/- buttons. Captures the timeline frame under the anchor
   *  BEFORE the zoom changes and hands it to the effect above, which puts that
   *  frame back under the same viewport x once the new zoom has been laid out.
   *
   *  `anchorClientX` is the real cursor position for a wheel zoom; `null` for
   *  a button press, which has none — `buttonZoomAnchorX` then supplies the
   *  playhead (or the viewport centre when the playhead is off screen). See
   *  `timelineZoom.ts` for why that is the right anchor for a button.
   *
   *  A zoom already at `MIN_PX_PER_SEC`/`MAX_PX_PER_SEC` sets no anchor at
   *  all: nothing is going to move, and leaving a stale anchor behind would
   *  make the NEXT zoom restore a point the user has since scrolled away
   *  from. */
  const zoomBy = (factor: number, anchorClientX: number | null) => {
    const next = clampPxPerSec(pxPerSec * factor);
    if (next === pxPerSec) return;
    const rect = editAreaRef.current?.getBoundingClientRect();
    const width = rect?.width ?? viewportWidth;
    const viewportX =
      anchorClientX !== null && rect
        ? anchorClientX - rect.left
        : buttonZoomAnchorX(
            useEditorTimelineStore.getState().playhead,
            fps,
            pxPerSec,
            scroll.getState().left,
            START_LEFT_PX,
            width,
          );
    zoomAnchorRef.current = {
      frame: frameAtViewportX(viewportX, fps, pxPerSec, scroll.getState().left, START_LEFT_PX),
      viewportX,
    };
    setPxPerSec(next);
  };
  // The wheel listener is attached once, for the component's whole life, so it
  // reads the current closure through this ref instead of a stale one (the
  // same `onSeekEndRef` pattern `@apelles/player`'s transport already uses for
  // a callback that outlives the render it came from).
  //
  // Written in an effect, not during render: the React Compiler (D-201) bails
  // out of a whole component that touches a ref during render ("Cannot access
  // refs during render"), and `reactCompiler.test.ts` holds this file to zero
  // bailouts — which matters here more than anywhere, since this is the app's
  // highest-update-frequency surface. No dependency array on purpose: the ref
  // must track the LATEST closure, so this runs after every commit.
  useEffect(() => {
    zoomByRef.current = zoomBy;
  });

  const zoomIn = () => zoomBy(ZOOM_STEP, null);
  const zoomOut = () => zoomBy(1 / ZOOM_STEP, null);
  // D-432 P3 / B-348 — keyboard zoom (= / -), the buttons' own anchored step.
  useShortcut('edit.zoom_in', zoomIn);
  useShortcut('edit.zoom_out', zoomOut);

  // D-058 — the labeled-tick interval adapts to the current zoom ("nice
  // numbers": widen as pxPerSec shrinks, narrow as it grows) rather than the
  // library's fixed `scale` prop; `scaleWidth` (the library's "px per one
  // `scale`-second unit") is then derived so what's actually on screen stays
  // continuous even though `tickSeconds` itself only takes discrete values.
  const tickSeconds = niceTickIntervalSeconds(pxPerSec, TICK_TARGET_PX, 1 / fps);

  /** D-437 S4 — what the lanes call back into: one object with a permanent
   *  identity (`useLaneActions`), forwarding to this render's handlers, so a
   *  memoised `LaneClip` is not re-rendered by a pane render. */
  const laneActions = useLaneActions({
    onClipPointerDownCapture: (e, track, clipId) => editGesture.onClipPointerDownCapture(e, track, clipId),
    onClipClick,
    onToggleCurve: (track, id, param) => setCurveEditor(param === null ? null : { track, id, param }),
  });
  /** D-437 — clips the lanes keep mounted wherever the scroll is: the dnd-kit
   *  drag source (unmounting it mid-drag breaks the drag). The selection and
   *  the focused clip are pinned by the lanes themselves. */
  const draggedClipId = activeDrag?.type === 'clip' ? activeDrag.clipId : null;
  const pinnedClipIds = useMemo(() => new Set<string>(draggedClipId === null ? [] : [draggedClipId]), [draggedClipId]);
  /** The timeline's length in frames, for the playhead slider's `aria-valuemax`. */
  let durationFrames = 0;
  for (const t of tracks) for (const c of t.clips) durationFrames = Math.max(durationFrames, endFrame(c, fps));
  const getScroller = useCallback(() => scrollerRef.current, []);

  const otherTracks = primary ? tracks.map((_, i) => i).filter((i) => i !== primary.track) : [];

  // D-117 — the Inspector (selectedClip/applyTransform/keyframe ops) moved
  // out to `EditorInspectorPanel.tsx`, a sibling of this component rendered
  // full-height in `EditorTab.tsx` instead of a third pane nested in here —
  // see that file's doc for the "why". `selection`/`selectedGap` stay
  // sourced from `useEditorTimelineStore` (lifted in the same pass) so both
  // components read the exact same selection without prop-drilling.

  // D-098 — `DragOverlay` content: a small floating pill following the
  // pointer for whichever drag is active, a real cursor-follow preview
  // native HTML5 drag/drop never gave us (B-027's own drag-ghost complaint
  // was a symptom of that gap, not a one-off bug — the browser's default
  // drag image is a frozen DOM snapshot captured once at `dragstart`).
  const dragOverlayLabel =
    activeDrag?.type === 'track-header'
      ? labels[activeDrag.index]
      : activeDrag?.type === 'clip'
        ? (clipsOf(activeDrag.track)[idxOf(activeDrag.track, activeDrag.clipId)]?.name ?? activeDrag.clipId)
        : null;

  // D-119 — owner, live: "when we drag use the proper preview instead of
  // dotted line how other editors do it." The pill above stays as the
  // `track`-reorder ghost (there's no "picture content" for a track header
  // to preview), but a `clip` drag now gets the clip's real filmstrip +
  // waveform in the overlay — the same visual `LaneClip` already
  // builds for the resting clip, not a generic placeholder. Capped at
  // `MAX_DRAG_GHOST_PX` — this is a cursor-follow *preview*, not a literal
  // render of the clip at full timeline zoom; an hour-long clip dragged at
  // 100% would otherwise produce an unusable, off-screen-sized ghost.
  const dragOverlayClip =
    activeDrag?.type === 'clip' ? clipsOf(activeDrag.track)[idxOf(activeDrag.track, activeDrag.clipId)] : null;
  const dragOverlayTrack = activeDrag?.type === 'clip' ? tracks[activeDrag.track] : null;
  const dragOverlayKind = dragOverlayClip && dragOverlayTrack ? clipKindOf(dragOverlayClip, dragOverlayTrack.kind) : 'video';
  // D-432 P3 — the ghost is drawn at its own track's height.
  const dragOverlayTrackHeight = activeDrag?.type === 'clip' ? (rowHeights[activeDrag.track] ?? viewClipHeight) : viewClipHeight;
  // B-137 — the cap above is what made the ghost detach from the pointer: a
  // capped ghost anchored (by `DragOverlay`, unavoidably) at the dragged
  // clip's LEFT EDGE has no spatial relationship to a press two-thirds of the
  // way along a clip, and at the default zoom every clip longer than ~3.5s is
  // capped. `dragGhostWindow` turns the ghost into the slice of the clip
  // around the grab point; the modifier below shifts it right by that same
  // offset so the slice lands under the cursor. Falls back to the clip's own
  // frames × zoom width when dnd-kit could not measure the node (no clip
  // grab), which reproduces the pre-B-137 geometry exactly rather than
  // guessing.
  const dragOverlayClipWidth = dragOverlayClip
    ? (clipGrab?.widthPx ?? (dragOverlayClip.duration / (dragOverlayClip.source_fps ?? fps)) * pxPerSec)
    : 0;
  const dragGhost = dragGhostWindow(dragOverlayClipWidth, clipGrab?.offsetPx ?? 0);
  const dragOverlayWidth = dragOverlayClip ? dragGhost.widthPx : 0;
  const dragOverlayFullSecs = dragOverlayClip ? dragOverlayClip.duration / (dragOverlayClip.source_fps ?? fps) : 0;
  /** Source-seconds per on-screen pixel of THIS clip — derived from the clip's
   *  own measured width rather than from `pxPerSec`, so a clip with a speed
   *  change maps its window back to the right part of the media. */
  const dragOverlaySecsPerPx = dragOverlayClipWidth > 0 ? dragOverlayFullSecs / dragOverlayClipWidth : 0;
  const dragOverlayStartSecs = dragOverlayClip
    ? dragOverlayClip.source_start / (dragOverlayClip.source_fps ?? fps) + dragGhost.startPx * dragOverlaySecsPerPx
    : 0;
  // `min` so the short-clip case — where `MIN_DRAG_GHOST_PX` makes the ghost
  // WIDER than the clip — still asks for the clip's own duration and not a
  // stretched-out over-read of the media, exactly as it did before B-137.
  const dragOverlayDurationSecs = Math.min(dragOverlayFullSecs, dragOverlayWidth * dragOverlaySecsPerPx);
  /** B-137 — the whole fix, in dnd-kit's own canonical extension point.
   *  `PositionedOverlay` pins the ghost to `activeNodeRect.left` and then adds
   *  this transform (read in its bundled source), so shifting x by the window's
   *  own offset into the clip is exactly what puts the grabbed slice under the
   *  pointer — and is a no-op (`startPx === 0`) for every clip that fits inside
   *  the cap, which is why short clips are untouched by this. */
  const dragGhostToPointer: Modifier = ({ transform }) => ({ ...transform, x: transform.x + dragGhost.startPx });

  // B-069 fix: these two cases used to `return` early, ABOVE several
  // useMemo/useCallback hooks that follow in this component (linkCheck, the
  // DnD handlers) — a real Rules-of-Hooks violation. React only detects a
  // mismatched hook count once the SET of hooks actually called differs
  // between renders of the same component instance (e.g. `timeline` flips
  // from null to non-null, or `tracks.length` crosses 0), which is exactly
  // what happened live: "Rendered fewer/more hooks than during the previous
  // render," and it took the whole render tree (and the control-server
  // bridge reading from it) down with no error boundary to catch it. Hooks
  // must run unconditionally on every render — only the JSX below may
  // branch, so this check moved down here, after every hook call above.
  // (D-201 unwrapped the `useMemo`/`useCallback` this note names on `linkCheck`
  // and the DnD handlers, so those specific ones are no longer hooks. Real
  // hooks still sit above this line and more will be added, so these early
  // returns must STAY here, below every hook call, regardless.)
  if (!timeline) return null;

  if (tracks.length === 0) {
    // a brand new timeline (`chroma_timeline_create`) has no tracks yet —
    // the first drop creates one (see `applyOp`'s 'add_clip' handling).
    // v0.3.0 (§4.13) — placeholder V1 / A1 lanes and one line, not a dashed
    // box. The drop handlers stay on this wrapper.
    return (
      <div className="h-full w-full" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        <TimelineEmptyState action={emptyAction} dragOver={dragOver} />
      </div>
    );
  }

  return (
    <DndContext
      sensors={dndSensors}
      onDragStart={onDndDragStart}
      onDragMove={onDndDragMove}
      onDragEnd={onDndDragEnd}
      onDragCancel={onDndDragCancel}
    >
      <div
        className={
          // D-432 P2 / B-342 — `isolate`: the whole timeline is one stacking
          // context, so its inner layers (`--z-timeline-*`) can never paint
          // over the shell's floating surfaces (the agent dock, popovers).
          'isolate flex flex-col min-h-0 h-full bg-bg-primary outline-none ' +
          (dragOver ? 'ring-2 ring-inset ring-accent' : '')
        }
        tabIndex={0}
      >
      <TooltipProvider>
        {/* v0.3.0 (B-354 / B-359 item 4) — the mockup's grouping, in three
            columns so the centre is truly centred (a `1fr auto 1fr` grid,
            the mock's `.ttool`): tools | Split, Marker, Transitions |
            contextual actions · switcher + timecode · Snapping, Skimming, Beat
            grid, Clip Appearance | the zoom slider. */}
        <div
          data-chroma-timeline-toolbar=""
          className="grid h-9 shrink-0 grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)] items-center gap-2 border-b border-border-color bg-surface px-2 text-text-primary"
        >
          <div data-chroma-toolbar-group="left" className="flex min-w-0 items-center gap-1 overflow-hidden">
            {/* D-261 — the trim palette. It sits here, first among the actions
                that operate on the clips already in the timeline, because unlike
                every other button in this row it is MODAL: it changes what the
                next drag means rather than doing something once. A separator
                keeps that distinction visible instead of letting five icon
                buttons read as five more one-shot actions.

                Adobe's own panel is a vertical strip docked to the timeline's
                edge; this is the same set of buttons in this app's existing
                toolbar row, which is where every other timeline action already
                lives (CLAUDE.md: match the app's convention, and Adobe's own page
                notes the panel can be oriented either way). See
                `TrimToolbar.tsx` for the icon choices and their provenance. */}
            <TrimToolbar active={trimTool} onSelect={selectTrimTool} />
            <Separator orientation="vertical" className="mx-1 h-4" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={doSplit}
                    disabled={selection.length === 0}
                    data-testid={TIMELINE_TEST_IDS.split}
                    aria-label="Split at playhead"
                  >
                    <SplitHorizontalIcon />
                  </Button>
                }
              />
              <TooltipContent>
                <span className="font-medium">Split</span>
                <span className="ml-1.5 text-text-secondary">
                  Split every selected clip at the playhead
                </span>
              </TooltipContent>
            </Tooltip>
            {/* D-248 — the Title (D-211) and Adjust (D-230) buttons stood here.
                They are library items, not timeline actions, and both references
                describe them as things you DRAG out of the effects library — so
                they moved to `EditLibraryRail.tsx` on the left edge of the tab,
                where they are now a real drag source as well as the same
                click-to-add they were here. What is left in this toolbar is
                exactly what acts on the timeline you already have. */}
            {/* D-222 — markers. A marker annotates a POSITION in this timeline,
                so the add button belongs in this toolbar. The owner removed the
                toolbar's marker list / counter (2026-11-01): markers are listed,
                jumped to and deleted in the Index panel, and on the flag's own
                editor (B-114's delete stays reachable from both). */}
            <AddMarkerButton onAdd={() => doAddMarker(true)} shortcut="M" />
            {/* D-226 — the transitions library. Beside Title/Marker for the same
                reason those two sit together: all three are "bring something new
                into the edit", none is scoped to the current selection. The drag
                itself starts inside its popover — see `TimelineTransitions.tsx`. */}
            <TransitionsPaletteButton />
            {/* D-235 — the context-sensitive trim tool's readout. Resolve tells
                you which of the four trims you are about to get by swapping the
                cursor (`scratch/resolve-reference/trim.jpg`); this names it. Only
                present while Alt/Option is actually held, so it is a hint during
                the gesture rather than permanent toolbar furniture — and it says
                the arm key when nothing is hovered yet, which is the only
                discoverability this feature has. */}
            {trimArmed && (
              <span
                data-chroma-trim-hint=""
                role="status"
                className="rounded border border-border-color bg-surface px-2 py-1 text-[10px] text-text-secondary"
              >
                {hoverTrimMode ? (trimModeLabel(hoverTrimMode) ?? 'Trim') : 'Trim: hover a clip'}
              </span>
            )}
            {dropError && (
              <button
                type="button"
                onClick={() => setDropError(null)}
                className="max-w-[26rem] truncate rounded border border-border-color bg-surface px-2 py-1 text-left text-[10px] text-text-secondary"
                title={`${dropError} (click to dismiss)`}
              >
                {dropError}
              </button>
            )}
            {/* v0.3.0 (B-354) — Remove is contextual, like Unlink / Link / Close
                Gap: shown while a clip is selected. §4.9 drops it from the
                toolbar, but the clip has no context menu yet, so this stays the
                pointer's way to delete (the Delete key is the other). */}
            {selection.length > 0 && (
              <>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        onClick={doRemove}
                        disabled={selection.length === 0}
                        data-testid={TIMELINE_TEST_IDS.delete}
                        aria-label="Remove clip"
                      >
                        <TrashIcon />
                      </Button>
                    }
                  />
                  <TooltipContent>
                    <span className="font-medium">Remove</span>
                    <span className="ml-1.5 text-text-secondary">
                      Remove every selected clip (with its linked audio)
                    </span>
                  </TooltipContent>
                </Tooltip>
              </>
            )}
            {/* D-128 — only shown when the selection is actually linked: an
                Unlink button that's permanently present but almost always
                inert would be noise, and its whole meaning is "this clip HAS a
                linked half." Both reference NLEs put unlink on the clip's own
                context menu; this toolbar is where every other per-clip action
                in this pane already lives, so it goes here for consistency. */}
            {selectionIsLinked && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button variant="ghost" size="icon-sm" onClick={doUnlink} data-testid={TIMELINE_TEST_IDS.unlink} aria-label="Unlink audio and video">
                      <LinkBreakIcon />
                    </Button>
                  }
                />
                <TooltipContent>
                  <span className="font-medium">Unlink</span>
                  <span className="ml-1.5 text-text-secondary">
                    Break the A/V link so the picture and its audio can be trimmed and moved apart (an L-cut)
                  </span>
                </TooltipContent>
              </Tooltip>
            )}

            {/* D-138 — the manual counterpart to Unlink: shown only when the
                selection is actually shaped like a link candidate (exactly two
                clips, see `linkCheck`'s own doc) — same "don't show an action
                that's almost always inert" reasoning as Unlink above. Unlike
                Unlink, whether it's ENABLED can still say no (wrong track
                kind, already linked, a locked track) — the button stays
                visible but disabled in that case, with `linkCheck.result.
                reason` in the tooltip, so the reason is surfaced rather than
                the button just silently vanishing (the owner's own ask). */}
            {linkCheck && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={doLink}
                      disabled={!linkCheck.result.ok}
                      data-testid={TIMELINE_TEST_IDS.link}
                      aria-label="Link audio and video"
                    >
                      <LinkIcon />
                    </Button>
                  }
                />
                <TooltipContent>
                  <span className="font-medium">Link</span>
                  <span className="ml-1.5 text-text-secondary">
                    {linkCheck.result.ok
                      ? 'Link these two clips so they move, trim, split and delete together'
                      : linkCheck.result.reason}
                  </span>
                </TooltipContent>
              </Tooltip>
            )}

            {/* D-105 — the mirror-image toolbar action for a selected GAP
                (empty track space, not a clip): closes it, rippling everything
                after it earlier. A separate button rather than overloading
                "Remove" itself — the two selections are mutually exclusive, so
                at most one of these two buttons is ever enabled/relevant at
                once, but a distinct label/icon ("Close Gap"/`ArrowsInLineHorizontal`
                vs. "Remove"/`Trash`) makes clear this closes the space rather
                than just deleting something, matching the real, different
                underlying operation (D-105's `remove_gap` ripples; `remove`
                deliberately doesn't). Same Delete/Backspace keybinding covers
                both — see this component's `onKeyDown`. */}
            {/* B-236 — disabled, with the refusal's own reason in the tooltip,
                when `checkRemoveGap` says no: the same "surface the reason
                rather than silently do nothing" treatment the Link button
                (D-138) already gets. */}
            {selectedGap && gapCloseCheck && (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      variant="ghost"
                      size="icon-sm"
                      onClick={doRemoveGap}
                      disabled={!gapCloseCheck.ok}
                      data-testid={TIMELINE_TEST_IDS.removeGap}
                      aria-label="Close gap"
                    >
                      <ArrowsInLineHorizontalIcon />
                    </Button>
                  }
                />
                <TooltipContent>
                  <span className="font-medium">Close Gap</span>
                  <span className="ml-1.5 text-text-secondary">
                    {gapCloseCheck.ok
                      ? 'Close the selected gap — everything after it shifts left'
                      : gapCloseCheck.reason}
                  </span>
                </TooltipContent>
              </Tooltip>
            )}

            {/* D-080: cross-track move — see the module doc for why this is a
                dropdown and not a drag gesture. */}
            {primary && otherTracks.length > 0 && (
              <DropdownMenu>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <DropdownMenuTrigger
                        render={
                          <Button variant="ghost" size="icon-sm" aria-label="Move to another track">
                            <ArrowsLeftRightIcon />
                          </Button>
                        }
                      />
                    }
                  />
                  <TooltipContent>
                    <span className="font-medium">Move to</span>
                    <span className="ml-1.5 text-text-secondary">Move the selected clip to another track</span>
                  </TooltipContent>
                </Tooltip>
                <DropdownMenuContent align="start">
                  {otherTracks.map((i) => (
                    <DropdownMenuItem key={i} onClick={() => doMoveToTrack(i)}>
                      {labels[i]}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            )}

            {/* D-090's clip-transform popover was removed in D-102 — the
                persistent `ClipInspectorPanel` replaces it (D-117: now a
                full-height sibling panel in `EditorTab.tsx`, not nested here),
                same fields/ops, better UX for iterating on values, no reason
                to keep both. */}

          </div>
          <div data-chroma-toolbar-group="center" className="flex shrink-0 items-center justify-center px-1">
            {toolbarCenter}
          </div>
          <div data-chroma-toolbar-group="right" className="flex min-w-0 items-center justify-end gap-1">
              {/* D-249 — D-198's Export button stood here, at the far right of
                  this toolbar. It is now in the Edit tab's own top strip
                  (`EditorTab.tsx`), beside the Inspector toggle: delivering the
                  finished cut is the tab's terminal action, not one of the
                  per-clip edit actions this strip holds, and the owner asked for
                  it there directly (an arrow drawn from it up to the top bar).
                  The dialog component is unchanged — only where it is mounted. */}
            {/* D-432 P3 — Snapping (N) and Skimming (S); v0.3.0 — then the Beat
                grid (its tempo, beat snapping and "Snap cuts to beats" in one
                popover, where the readout and two buttons used to sit loose
                in this row), Clip Appearance, and the zoom slider (§4.9). */}
            <SnapSkimToggles />
            <TimelineBeatControl
              active={beatView.track !== null}
              readout={
                beatView.track === null
                  ? null
                  : beatView.errors.length > 0
                    ? 'beats failed'
                    : beatView.pending.length > 0
                      ? 'analysing beats…'
                      : `${Math.round(beatView.tempoBpm)} BPM`
              }
              readoutTitle={beatView.errors.map((e) => `${e.path}: ${e.error}`).join('\n') || undefined}
              notice={beatNotice}
              beatSnap={beatSnap}
              snapping={snapping}
              onBeatSnapChange={setBeatSnap}
              canSnapCuts={!!primary && !snappingCuts}
              onSnapCuts={doSnapCutsToBeats}
            />
            <ClipAppearanceButton />
            <Separator orientation="vertical" className="mx-1 h-4" />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="sm" onClick={zoomOut} data-testid={TIMELINE_TEST_IDS.zoomOut} aria-label="Zoom out">
                    <MagnifyingGlassMinusIcon />
                  </Button>
                }
              />
              <TooltipContent>Zoom out (−, or ctrl/pinch-scroll over the timeline)</TooltipContent>
            </Tooltip>
            <TimelineZoomSlider
              className="w-24"
              pxPerSec={pxPerSec}
              testId={TIMELINE_TEST_IDS.toolbarZoomSlider}
              // The playhead (or the view centre) holds still, as the +/-
              // buttons do: the same `zoomBy` with no pointer anchor.
              onZoom={(px) => zoomBy(px / pxPerSec, null)}
            />
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="sm" onClick={zoomIn} data-testid={TIMELINE_TEST_IDS.zoomIn} aria-label="Zoom in">
                    <MagnifyingGlassPlusIcon />
                  </Button>
                }
              />
              <TooltipContent>Zoom in (=, or ctrl/pinch-scroll over the timeline)</TooltipContent>
            </Tooltip>
          </div>
        </div>
      </TooltipProvider>

      {/* D-094: the header/edit-area split is now a real `ResizablePanelGroup`
          (was a fixed `width: HEADER_WIDTH` sidebar) — the owner's standing
          "resizable-by-nature panels" rule in `CLAUDE.md`, applied to the
          track-header column since this pass was already in this file. */}
      <ResizablePanelGroup
        orientation="horizontal"
        className="relative flex-1 min-h-0"
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        {/* Track header sidebar (D-080) — not a library feature, see the
            module doc. Offset by the same ruler+margin the lanes' scroller
            starts at, so a header's block lines up with its row, not the
            ruler. D-437 S8: its vertical scroll is a `translateY` written by
            `applyScrollSinks` (no React render per scroll frame). */}
        <ResizablePanel
          defaultSize={HEADER_WIDTH}
          minSize={HEADER_MIN_WIDTH}
          maxSize={HEADER_MAX_WIDTH}
          className="relative shrink-0 border-r border-border-color bg-surface overflow-hidden"
        >
          <div
            ref={headerColumnRef}
            className="absolute left-0 right-0"
            style={{ top: RULER_AND_MARGIN_PX }}
          >
            {/* D-098 — real `@dnd-kit/sortable` list, replacing D-094's
                native HTML5 `draggable` track-reorder handle + hand-rolled
                `draggedTrack`/`dragOverTrack` state (see the module doc /
                `TrackHeader.tsx`'s own doc for why). `items` is the
                CURRENT render's track ids in order — `SortableContext` uses
                it to compute the live "other rows slide out of the way"
                animation during a drag. */}
            <SortableContext items={tracks.map((_, i) => trackDragId(i))} strategy={verticalListSortingStrategy}>
              {tracks.map((track, i) => {
                const isVideo = track.kind === 'video';
                const muted = track.kind === 'audio' && (track.gain ?? DEFAULT_TRACK_GAIN) <= 0;
                const locked = !!track.locked;
                const hidden = isVideo && !!track.hidden;
                const syncLocked = track.sync_locked ?? DEFAULT_SYNC_LOCKED;
                return (
                  <TrackHeader
                    key={i}
                    index={i}
                    kind={track.kind}
                    height={rowHeights[i]}
                    ownHeight={track.height ?? null}
                    badge={badges[i]}
                    label={labels[i]}
                    renamed={!!track.name?.trim()}
                    muted={muted}
                    locked={locked}
                    hidden={hidden}
                    syncLocked={syncLocked}
                    duck={{
                      // Defaulted here, once, so the control never has to read
                      // an absent field as falsy — `0 ms` attack/release is a
                      // real (instant, clicky) setting, not "unset".
                      from: track.duck_from ?? null,
                      db: track.duck_db ?? 0,
                      attackMs: track.duck_attack_ms ?? DEFAULT_DUCK_ATTACK_MS,
                      releaseMs: track.duck_release_ms ?? DEFAULT_DUCK_RELEASE_MS,
                    }}
                    trackLabels={labels}
                    onToggleLock={() => toggleLock(i)}
                    onToggleHidden={() => toggleHidden(i)}
                    onToggleMute={() => toggleMute(i)}
                    onToggleSyncLocked={() => toggleSyncLocked(i)}
                    onDuckChange={(patch) => changeDuck(i, patch)}
                    onRemove={() => doRemoveTrack(i)}
                    beatGrid={track.beat_grid != null}
                    onToggleBeats={() => (track.beat_grid != null ? setBeatGrid(null, null) : setBeatGrid(i, {}))}
                    target={!!track.target}
                    onToggleTarget={() => applyOp({ kind: 'set_target_track', track: track.target ? null : i })}
                    onRename={(name) => applyOp({ kind: 'set_track_name', track: i, name })}
                    onSetHeight={(height) => applyOp({ kind: 'set_track_height', track: i, height })}
                    onHeightDragStart={startTrackHeightDrag}
                  />
                );
              })}
            </SortableContext>
          </div>
        </ResizablePanel>

        <ResizableHandle id={TIMELINE_TEST_IDS.headerResize} />

        <ResizablePanel className="relative min-h-0 overflow-hidden">
          {/* D-233 — the edit area and the curve lane are a real vertical
              `ResizablePanelGroup`, per CLAUDE.md's standing "every
              resizable-by-nature pane must actually be resizable" rule: how
              tall the lane is IS how finely you can author an ease.

              Nested inside this panel rather than beside the whole
              header/edit-area group on purpose — that makes the lane inherit
              the edit area's exact horizontal extent, so a keyframe dot lands
              under the frame of the clip above it with no second alignment
              calculation to drift (see `ClipCurveEditor`'s own module doc),
              and it leaves the track-header column full height where it
              belongs. */}
          <ResizablePanelGroup orientation="vertical" className="h-full min-h-0">
            <ResizablePanel className="relative min-h-0 overflow-hidden">
          <div
            ref={attachEditArea}
            data-testid={TIMELINE_TEST_IDS.editArea}
            // D-434 — the view state, readable by a UI test without reaching
            // into the component. Plain attributes React already diffs: no
            // extra render, no subscriber. The two scroll attributes are NOT
            // here: D-437 S8 writes them imperatively (`applyScrollSinks`), as
            // a scroll no longer renders this pane.
            {...{
              [TIMELINE_VIEW_ATTRS.pxPerSec]: pxPerSec,
              [TIMELINE_VIEW_ATTRS.fps]: fps,
              [TIMELINE_VIEW_ATTRS.startLeft]: START_LEFT_PX,
              [TIMELINE_VIEW_ATTRS.rowHeight]: viewClipHeight,
              [TIMELINE_VIEW_ATTRS.rowsTop]: RULER_AND_MARGIN_PX,
              // D-432 P3 — every row's top (one past the last), as tracks
              // have their own heights now.
              [TIMELINE_VIEW_ATTRS.rowTops]: rowTops.join(','),
            }}
            className="relative h-full overflow-hidden"
            // D-250 — the cursor half of Resolve's own context-sensitive trim
            // affordance ("You'll see the cursor change to different types of
            // trim tools as you move your mouse"), with the standard keywords
            // rather than the four bitmaps `trim.jpg` shows. On the AREA, not
            // on each clip, so one write covers every element under the
            // pointer (the hovered body gets its own, see `onTrimHoverMove`).
            // `undefined` when nothing is armed leaves every
            // existing cursor (`ClipBody`'s `cursor-grab`, the handles' own)
            // exactly as it was.
            style={hoverTrimMode ? { cursor: trimModeCursor(hoverTrimMode) } : undefined}
            // D-100 — owner: "clicking outside does not make it
            // undeselected." A click anywhere in this area that ISN'T on a
            // clip (its lane slot, `[data-chroma-clip-slot]`, D-437 S4) clears
            // selection. Bubble-order safety, not a race: the slot's own
            // `onClick` (`laneActions.onClipClick`) fires first, since it is
            // the inner target; THIS handler runs after, on the same click,
            // and only clears when `closest` finds no slot ancestor — a real
            // clip click never reaches the clearing branch.
            //
            // D-105 — owner: "we should be able to delete the gap as well
            // select and delete." Extended (not replaced): a click that
            // isn't on a clip now also checks whether it landed on a REAL,
            // closeable gap (`gapAt`, same helper `remove_gap`'s own `applyOp`
            // case uses — the click target and the eventual op can never
            // disagree about what counts as a gap) — if so, select the gap
            // instead of just clearing. Anywhere else (a genuine dead zone —
            // trailing empty space past the last clip, or below every track
            // row) still falls through to a plain clear, same as before.
            onPointerDown={onEditAreaPointerDown}
            // D-235 — the smart trim tool's "which mode am I about to get?"
            // readout. Inert unless Alt/Option is held; see `onTrimHoverMove`.
            onPointerMove={onTrimHoverMove}
            onPointerLeave={onTrimHoverLeave}
            onClick={(e) => {
              // D-137 — the click that terminates a real marquee drag must not
              // also run the clear-selection branch below and undo what the
              // marquee just selected. The flag is set only by a marquee that
              // actually passed its activation threshold, and is cleared both
              // here (when consumed) and at the next `pointerdown` (so an
              // interrupted gesture can never swallow an unrelated later
              // click). A press that stayed below the threshold sets nothing
              // and falls straight through to the existing behaviour.
              if (marqueeClickSuppressedRef.current) {
                marqueeClickSuppressedRef.current = false;
                return;
              }
              if ((e.target as HTMLElement).closest('[data-chroma-clip-slot]')) return;
              const rect = editAreaRef.current?.getBoundingClientRect();
              if (rect) {
                const { left: scrollLeft, top: scrollTop } = scroll.getState();
                const y = e.clientY - rect.top - RULER_AND_MARGIN_PX + scrollTop;
                const trackIdx = trackAtY(rowTops, y);
                // B-326 — a click on empty track space (not a clip — that
                // returned above) moves the playhead there, the Resolve /
                // Premiere default (the ruler's own press seeks too).
                // Below the ruler only: the ruler's own click already seeks.
                if (y >= 0 && e.clientX - rect.left + scrollLeft >= START_LEFT_PX) {
                  const seekFrame = Math.round(((e.clientX - rect.left + scrollLeft - START_LEFT_PX) / pxPerSec) * fps);
                  seekPlayhead(snapFrameToBeat(seekFrame));
                }
                if (trackIdx >= 0 && trackIdx < tracks.length) {
                  const frame = Math.round(((e.clientX - rect.left + scrollLeft - START_LEFT_PX) / pxPerSec) * fps);
                  const gap = gapAt(tracks[trackIdx], frame, fps);
                  if (gap) {
                    setSelection([]);
                    setSelectedGap({ track: trackIdx, frame });
                    return;
                  }
                }
              }
              setSelection([]);
              setSelectedGap(null);
            }}
          >
            {/* D-437 S4 — Apelles' own lanes (they replaced
                `@xzdarcy/react-timeline-editor`'s edit area): one native
                scroller from `RULER_AND_MARGIN_PX` down, both axes, culled to
                the scroll window, every clip a memoised `LaneClip`. */}
            <TimelineLanes
              tracks={tracks}
              trackLabels={labels}
              fps={fps}
              pxPerSec={pxPerSec}
              startLeftPx={START_LEFT_PX}
              tickSeconds={tickSeconds}
              rowTops={rowTops}
              rowHeights={rowHeights}
              topPx={RULER_AND_MARGIN_PX}
              viewportWidth={viewportWidth}
              scroll={scroll}
              bandRatio={bandRatio}
              showClipNames={showClipNames}
              showClipBadges={showClipBadges}
              selection={selection}
              syncLinkedIds={syncLinkedIds}
              avLinkedIds={avLinkedIds}
              cutStyleById={cutStyleById}
              curveEditor={curveEditor}
              pinnedClipIds={pinnedClipIds}
              actions={laneActions}
              scrollerRef={scrollerRef}
              onScroll={onTimelineScroll}
            >
              {/* D-437 S8 — the content-space overlays: inside the scroller's
                  content, in content coordinates (`START_LEFT_PX + sec ×
                  pxPerSec`, a row's own top), so they ride native scrolling
                  with the clips and a scroll re-renders none of them. */}
              {/* D-105 — the selected gap's own persistent highlight (not a
                  live drag preview like the two overlays above — this stays
                  up until the selection changes). `gapAt` re-derives the exact
                  pixel span from the SAME `selectedGap.frame` the toolbar/
                  keyboard delete action reads — recomputed from the live
                  `tracks[selectedGap.track]` on every render rather than
                  cached at selection time, so the highlight always matches
                  what a delete would actually close (e.g. if an unrelated edit
                  elsewhere shifted this gap's bounds since it was selected). */}
              {selectedGap &&
                (() => {
                  const t = tracks[selectedGap.track];
                  const gap = t && gapAt(t, selectedGap.frame, fps);
                  if (!gap) return null;
                  return (
                    <div
                      // Owner feedback, 2026-09-10: the old dashed outline read
                      // as an unstyled placeholder ("this looks bad"). A glassy
                      // translucent fill — soft gradient, backdrop blur, a
                      // hairline border instead of a dashed one, rounded
                      // corners — reads as a real selection state rather than
                      // scaffolding, matching this kit's other glass surfaces
                      // (e.g. the transport bar's own popovers).
                      data-testid={TIMELINE_TEST_IDS.gapSelection}
                      className="pointer-events-none absolute z-(--z-timeline-overlay) rounded-xs border border-selection/60 bg-selection/10"
                      style={{
                        left: START_LEFT_PX + (gap.gapStart / fps) * pxPerSec,
                        width: ((gap.gapEnd - gap.gapStart) / fps) * pxPerSec,
                        top: rowTops[selectedGap.track],
                        height: rowHeights[selectedGap.track],
                      }}
                    />
                  );
                })()}
              {/* D-226 — one badge per transition, spanning its own window and
                  centred on its cut. Rendered in the same content layer as the
                  gap highlight and the drag previews, because a
                  transition belongs to the EDIT POINT between two clips and not to
                  either of them — drawing it inside a clip's own `LaneClip`
                  would tie it to one of the two and make it vanish when that
                  clip is culled. */}
              <TransitionBadges
                tracks={tracks}
                fps={fps}
                pxPerSec={pxPerSec}
                startLeftPx={START_LEFT_PX}
                rowHeight={viewClipHeight}
                rowTops={rowTops}
                onChange={(track, id, patch: TransitionPatch) =>
                  applyOp({ kind: 'set_transition', track, id, patch })
                }
                onRemove={(track, id) => applyOp({ kind: 'remove_transition', track, id })}
              />
              {/* B-160 / D-304 — the four live drag-preview overlays (the
                  snapped insertion line, the new-track ghost row, the sync-lock
                  ripple ghosts and the A/V-link ghosts) moved into their own
                  component, which OWNS the state driving them. They update on
                  every pointer-move tick of a drag; keeping that state here made
                  each of those ticks re-render this whole pane. All four are
                  still `z-30`, still absolutely positioned (in the lanes'
                  content space since D-437 S8), and still painted in the same
                  order relative to each other — see that file's own doc.

                  D-113 originally also rendered a filled dashed box at the
                  clip-move landing frame, matching the new-track ghost's visual
                  language. Owner, live, after D-119 gave the `DragOverlay` ghost
                  real filmstrip content: "we have 3 things — the previous place,
                  the new thumbnail preview, and the dotted line — let's remove
                  the dot." With a real picture-content ghost already following
                  the cursor at the resolved landing position, that second box was
                  drawing the same information twice, so only the ghosts derived
                  from the landing remain. */}
              <TimelineDragPreview
                ref={dragPreviewRef}
                timeline={timeline}
                tracks={tracks}
                fps={fps}
                pxPerSec={pxPerSec}
                startLeftPx={START_LEFT_PX}
                rowHeight={viewClipHeight}
                rowTops={rowTops}
              />
              {/* D-098 — one real `useDroppable` target per track, always
                  mounted (see `TrackDropZone`'s own doc for why — a real
                  mid-drag droppable-registration timing bug found live), only
                  pointer-interactive while a clip-type `@dnd-kit/core` drag is
                  active. In the lanes' content coordinates (D-437 S8). */}
              {/* D-137 — the marquee itself. `pointer-events-none` for the same
                  reason every other overlay in this file is: it must never
                  become a hit target, least of all one covering the clips its
                  own gesture is selecting. Painted above the drag ghosts
                  (`z-40`) since it is the thing the user is actively drawing.
                  Its geometry is derived from the rect's TIMELINE units on every
                  render (`marqueeContentBox`), not stored in pixels, so a
                  ctrl-wheel zoom mid-drag rescales the band with the content it
                  actually encloses, and (inside the scroller, D-437 S8) a scroll
                  moves it natively. */}
              {marquee && (
                <div
                  data-testid={TIMELINE_TEST_IDS.marquee}
                  className="pointer-events-none absolute z-(--z-timeline-overlay) rounded-xs border border-accent bg-accent/15"
                  style={marqueeContentBox(marquee, marqueeGeometry)}
                />
              )}
              {tracks.map((_, i) => (
                <TrackDropZone key={i} track={i} top={rowTops[i]} height={rowHeights[i]} />
              ))}
              {/* D-432 P3 — each lane's bottom edge drags its track's height, as
                  the header's does (§4.8). A thin band straddling the line
                  between two rows: a clip sits 1 px inside its lane, so this
                  takes at most a pixel of either clip. Double-click resets. */}
              {tracks.map((_, i) => (
                <div
                  key={`height-${i}`}
                  data-testid={TIMELINE_TEST_IDS.laneHeightResize}
                  data-chroma-track={i}
                  data-chroma-no-marquee=""
                  aria-hidden
                  className="absolute left-0 right-0 z-(--z-timeline-clip-controls) cursor-row-resize"
                  style={{
                    top: rowTops[i + 1] - LANE_HEIGHT_ZONE_PX / 2,
                    height: LANE_HEIGHT_ZONE_PX,
                  }}
                  onPointerDown={(e) => {
                    e.stopPropagation();
                    startTrackHeightDrag(e, i);
                  }}
                  onClick={(e) => e.stopPropagation()}
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    applyOp({ kind: 'set_track_height', track: i, height: null });
                  }}
                />
              ))}
            </TimelineLanes>
            {/* D-437 S4 — our own playhead (transform-only, its own layer,
                driven through `playheadRef`; never a render per frame, D-325).
                Only its head (in the ruler) and the band under it take the
                pointer (B-346, B-349). D-232 — its drag is the timeline's
                tape scrub: it pauses a running transport and drives the same
                scrub-audio calls the ruler's drag and the player's position
                bar use. */}
            <Playhead
              ref={playheadRef}
              fps={fps}
              pxPerSec={pxPerSec}
              startLeftPx={START_LEFT_PX}
              rulerHeightPx={RULER_HEIGHT_PX}
              bandHeightPx={MARKER_STRIP_HEIGHT}
              durationFrames={durationFrames}
              getScroller={getScroller}
              snapFrame={snapFrameToBeat}
              onScrubStart={(frame) => {
                setPlaying(false);
                setPlayhead(frame);
                beginScrub(frame);
              }}
              onScrub={(frame) => {
                setPlayhead(frame);
                updateScrub(frame);
              }}
              onScrubEnd={endScrub}
            />
            {/* D-432 P3 / B-350 — our own ruler: press seeks (a running
                transport keeps running, B-326), press-and-drag scrubs (pausing,
                with scrub audio — the same calls as the playhead head's drag). */}
            {/* D-437 S8 — the pinned strips (ruler, beat lane, markers, curve
                lane) draw in viewport coordinates; each reads the live
                `scrollLeft` through `WithScrollLeft`, which re-renders it (and
                not this pane) on a horizontal scroll. */}
            <WithScrollLeft store={scroll}>
              {(scrollLeft) => (
                <TimelineRuler
                  fps={fps}
                  pxPerSec={pxPerSec}
                  scrollLeft={scrollLeft}
                  startLeftPx={START_LEFT_PX}
                  viewportWidth={viewportWidth}
                  tickSeconds={tickSeconds}
                  snapFrame={snapFrameToBeat}
                  onScrubStart={(frame) => {
                    rulerScrubRef.current = false;
                    seekPlayhead(frame);
                  }}
                  onScrub={(frame) => {
                    if (!rulerScrubRef.current) {
                      rulerScrubRef.current = true;
                      setPlaying(false);
                      beginScrub(frame);
                    }
                    setPlayhead(frame);
                    updateScrub(frame);
                  }}
                  onScrubEnd={() => {
                    if (rulerScrubRef.current) endScrub();
                    rulerScrubRef.current = false;
                  }}
                />
              )}
            </WithScrollLeft>
            {/* D-250 — the armed trim mode, named AT THE POINTER. Resolve's own
                copy for this feature is explicit that the signal belongs there
                ("You'll see the cursor change to different types of trim tools
                as you move your mouse"); D-235 could not ship its four cursor
                bitmaps and put the readout in the toolbar instead, which is the
                right information in a place the eye is not — the owner, editing
                live, asked "how to toggle between roll/slip/ripple etc?" with
                that readout already shipped. Same `resolveTrimMode` call the two
                commit paths use (via `hoverTrimMode`), so it still cannot
                promise an edit the press would not make.

                `pointer-events-none` so it can never eat the very gesture it is
                describing, and its position is written imperatively — see
                `placeTrimBadge`. */}
            <div
              ref={trimBadgeRef}
              data-chroma-trim-badge=""
              role="status"
              hidden={!hoverTrimMode}
              className="pointer-events-none absolute left-0 top-0 z-(--z-timeline-edit-feedback) whitespace-nowrap rounded-sm bg-surface-raised px-1.5 py-1 text-2xs leading-tight text-text-primary shadow-popover"
            >
              <span className="font-medium">{hoverTrimMode ? trimModeLabel(hoverTrimMode) : ''}</span>
              {hoverTrimMode && trimModeHint(hoverTrimMode) && (
                <span className="ml-1.5 text-text-secondary">{trimModeHint(hoverTrimMode)}</span>
              )}
            </div>
            {/* D-432 P3 — where a track-height drag will put the row's bottom
                edge; positioned by `startTrackHeightDrag`, hidden otherwise. */}
            <div
              ref={heightGuideRef}
              data-testid={TIMELINE_TEST_IDS.trackHeightGuide}
              hidden
              aria-hidden
              className="pointer-events-none absolute top-0 right-0 left-0 z-(--z-timeline-edit-feedback) h-px bg-selection"
            />
            {/* D-222 — the marker flag strip, in the band between the ruler's
                ticks and track row 0 (`RULER_AND_MARGIN_PX` reserves it). Last in this container so it paints over the
                row lines and drag ghosts: a marker must stay visible while a
                clip is being dragged past it. NOT scroll-offset here — it
                takes `scrollLeft` (from the scroll store, D-437 S8) and derives
                each flag's own x, like the ruler, and it is pinned vertically (a
                marker belongs to the ruler, not to a scrolled track row), so
                `scrollTop` is deliberately not applied. */}
            {/* D-413 — the beat lane, under the marker flags (a marker stays
                the thing you can click) and over the clips. */}
            {beatView.beats.length > 0 && (
              <WithScrollLeft store={scroll}>
                {(scrollLeft) => (
                  <BeatLane
                    beats={beatView.beats}
                    fps={fps}
                    pxPerSec={pxPerSec}
                    scrollLeft={scrollLeft}
                    startLeftPx={START_LEFT_PX}
                    viewportWidth={viewportWidth}
                  />
                )}
              </WithScrollLeft>
            )}
            {timeline && (
              <WithScrollLeft store={scroll}>
                {(scrollLeft) => (
                  <MarkerStrip
                    timeline={timeline}
                    fps={fps}
                    pxPerSec={pxPerSec}
                    scrollLeft={scrollLeft}
                    startLeftPx={START_LEFT_PX}
                    onJump={setPlayhead}
                    onPatch={(id, patch) => applyOp({ kind: 'set_marker', id, patch })}
                    onRemove={(id) => applyOp({ kind: 'remove_marker', id })}
                    editingId={editingMarkerId}
                    onEditingIdChange={setEditingMarkerId}
                    // D-432 P3 / B-348 — a dragged marker snaps to clip edges, the
                    // playhead and the other markers while Snapping (N) is on.
                    snapTargets={(movingId) => {
                      const st = useEditorTimelineStore.getState();
                      if (!useTimelineViewStore.getState().snapping || !st.timeline) return null;
                      const others = markersOf(st.timeline)
                        .filter((m) => m.id !== movingId)
                        .map((m) => m.frame);
                      return snapTargets(st.timeline, null, [st.playhead, ...others]);
                    }}
                  />
                )}
              </WithScrollLeft>
            )}
            {/* B-348 — the In / Out range, on the ruler's tick row. */}
            <WithScrollLeft store={scroll}>
              {(scrollLeft) => (
                <TimelineRange fps={fps} pxPerSec={pxPerSec} scrollLeft={scrollLeft} startLeftPx={START_LEFT_PX} />
              )}
            </WithScrollLeft>
            {/* D-432 P3 — the skim line: positioned by the skimming listener
                above, hidden unless skimming is on and the pointer is here. */}
            <div
              ref={skimLineRef}
              data-testid={TIMELINE_TEST_IDS.skimLine}
              hidden
              aria-hidden
              className="pointer-events-none absolute top-0 bottom-0 left-0 z-(--z-timeline-playhead) w-px bg-skimmer"
            />
            {/* D-432 P2 — the trim brackets, the edge-pinned delta readout, the
                snap guide and the Blade line (one set per pane, positioned
                imperatively by `useEditGesture`). */}
            <EditFeedbackLayer ref={feedbackRef} />
            {/* v0.3.0 (§4.13) — tracks but no clips: the instruction over the
                lanes (clicks pass through everywhere but its button). */}
            {tracks.every((t) => t.clips.length === 0) && <TimelineNoClipsHint action={emptyAction} />}
          </div>
            </ResizablePanel>

            {curveEditorClip && (
              <>
                <ResizableHandle id={TIMELINE_TEST_IDS.curveResize} />
                <ResizablePanel
                  defaultSize={CURVE_LANE_HEIGHT}
                  minSize={CURVE_LANE_MIN_HEIGHT}
                  className="relative min-h-0 overflow-hidden border-t border-border-color"
                >
                  <WithScrollLeft store={scroll}>
                    {(scrollLeft) => (
                      <ClipCurveEditor
                        clip={curveEditorClip.clip}
                        track={curveEditorClip.track}
                        clipIndex={curveEditorClip.index}
                        param={curveEditorClip.param}
                        fps={fps}
                        pxPerSec={pxPerSec}
                        scrollLeft={scrollLeft}
                        startLeftPx={START_LEFT_PX}
                        disabled={!!tracks[curveEditorClip.track]?.locked}
                        onClose={() => setCurveEditor(null)}
                      />
                    )}
                  </WithScrollLeft>
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
      </div>
      {/* B-137 — `modifiers` is dnd-kit's own extension point for exactly this,
          and is deliberately preferred over positioning the ghost by hand:
          `PositionedOverlay` owns the overlay's `left`/`top`, so a competing
          inline offset would be a second positioning system on one element,
          which is the shape this file has already been burned by twice
          (D-098/D-100). See `dragGhostToPointer` above. */}
      <DragOverlay dropAnimation={null} modifiers={[dragGhostToPointer]}>
        {dragOverlayClip ? (
          <div
            // B-137 — a stable hook for the regression test to find this ghost
            // and read back where it really is mid-drag; a `DragOverlay` child
            // is otherwise only identifiable by its Tailwind classes.
            data-chroma-drag-ghost=""
            data-testid={TIMELINE_TEST_IDS.dragGhost}
            // D-432 §5 — the ghost is the clip itself (same anatomy, same
            // opaque colour) with the selection outline: no shadow, ring or
            // blur, which re-rasterise every frame of a drag.
            className={
              'pointer-events-none relative overflow-hidden rounded-xs outline-2 -outline-offset-2 outline-selection ' +
              CLIP_KIND_CLASSES[dragOverlayKind].body
            }
            style={{ width: dragOverlayWidth, height: dragOverlayTrackHeight - 2 * CLIP_VERTICAL_INSET_PX }}
          >
            <ClipBlock
              clip={{
                ...dragOverlayClip,
                // the ghost shows the dragged window of the clip (B-137), so its
                // source range is that window's, in the clip's own frames
                source_start: Math.round(dragOverlayStartSecs * (dragOverlayClip.source_fps ?? fps)),
                duration: Math.round(dragOverlayDurationSecs * (dragOverlayClip.source_fps ?? fps)),
              }}
              kind={dragOverlayKind}
              trackHeight={dragOverlayTrackHeight}
              bandRatio={bandRatio}
              showName={showClipNames}
              showBadges={showClipBadges}
              widthPx={dragOverlayWidth}
              fps={fps}
            />
          </div>
        ) : (
          dragOverlayLabel && (
            <div className="pointer-events-none rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-button-text shadow-lg">
              {dragOverlayLabel}
            </div>
          )
        )}
      </DragOverlay>
    </DndContext>
  );
}
