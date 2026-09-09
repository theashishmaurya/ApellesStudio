/**
 * @apelles/editor — the timeline strip (D-041; drag-to-track D-046 pass 3;
 * mature-timeline-UI pass D-051; position-model + ruler fixes D-058;
 * multi-track UI D-080).
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
 *     library's own scrollable edit area, one fixed-`ROW_HEIGHT` block per
 *     track, kept in vertical sync with the library's own scroll via its
 *     `onScroll` prop (`OnScrollParams.scrollTop`, from `react-virtualized`
 *     — the library's own scroll mechanism) applied as a CSS transform.
 *   - **No native cross-row (cross-track) drag** — checked before building
 *     D-080: `onActionMoveEnd`'s `row` param is always the action's
 *     *starting* row, and there is no drop-target-row concept anywhere in
 *     the library's own action-drag path. D-080 shipped a "Move to ▾"
 *     toolbar dropdown instead (kept below as a fallback affordance — see
 *     D-094). **D-094 adds the real drag gesture**: each clip's rendered
 *     content (`getActionRender`) gets a small `GripVertical` handle at its
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
 *     library's own fixed layout constants (`.timeline-editor-time-area`'s
 *     32px ruler + `.timeline-editor-edit-area`'s 10px margin-top, read
 *     from the library's bundled CSS, not guessed) plus the tracked
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
 *   - **Edge-trim + snapping are native**, already wired here before this
 *     pass: `flexible: true` on every action gives interact.js-driven
 *     resize handles with an automatic `ew-resize` hover cursor on each
 *     clip's left/right 10px edge zone, and `dragLine` (already `true`)
 *     turns on the library's built-in drag/resize snap-assist against every
 *     other action's edges *and* the playhead — no code needed for either.
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
 * track row 0, which `timeline-overrides.css` widens to `MARKER_STRIP_HEIGHT`
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
 * It therefore cannot collide with D-137's marquee, D-207's fades or D-222's
 * markers for a reason none of those needed: it never competes for a press.
 * Nothing about how a drag STARTS changes; only which op is committed at the
 * END of one. The mode rule itself, and the Resolve/FCP/Premiere research
 * behind it, is `trimMode.ts` — pure and unit-tested, including `resizeEndOp`/
 * `bodyDragOp`, which the two commit handlers here are thin adapters over
 * (that split is load-bearing: the timeline library's own interact.js resize
 * does not run under jsdom at all, so the edge decision is only testable as a
 * pure function — see `TimelinePane.trim.dom.test.tsx`'s header).
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
 * D-058 (ruler): tick labels are real timecode (`ruler.ts`'s
 * `formatTimecode`, `HH:MM:SS` or `HH:MM:SS:FF` depending on the current
 * tick density) via `getScaleRender`, and the labeled-tick interval
 * (`scale`, seconds) is recomputed from `pxPerSec` on every zoom change via
 * `niceTickIntervalSeconds` — the library's own `scale` prop is a single
 * fixed value with no adaptive-density concept of its own (checked in its
 * bundled source before writing this).
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type DragEvent,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from 'react';
import type { TimelineRow, TimelineAction } from '@xzdarcy/timeline-engine';
import { Timeline as TimelineEditor, type TimelineState } from '@xzdarcy/react-timeline-editor';
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';
import './timeline-overrides.css';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DragMoveEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import {
  AudioLines,
  ArrowRightLeft,
  // D-149 — the track-header ducking control's icon: "push this track down."
  ChevronsDown,
  Eye,
  EyeOff,
  Film,
  FoldHorizontal,
  GripVertical,
  // D-138 — the A/V-link action's own icon. Deliberately `Link`, not `Link2`
  // below: that one is already the track header's sync-lock-ON icon, and
  // sync-lock and an A/V link are different relationships (see
  // `avLinkedIds`), so — same reasoning as `Unlink`/`Unlink2` just below —
  // they must not share an icon.
  Link,
  Link2,
  Lock,
  Scissors,
  Trash2,
  // D-230 — the badge on an adjustment clip's own body. `Wand2` is the
  // closest match to the wand Resolve itself puts on its Effects tab
  // (`scratch/resolve-reference/adjustments.jpg`). D-248: it is no longer
  // ALSO this toolbar's Add-adjustment icon — that action, and `Type` with
  // it, moved to `EditLibraryRail.tsx`.
  Wand2,
  // D-128 — the A/V-unlink action. Deliberately `Unlink`, not the `Unlink2`
  // below: that one is already the track header's sync-lock toggle, and
  // sync-lock and an A/V link are different relationships (see
  // `avLinkedIds`), so they must not share an icon.
  Unlink,
  Unlink2,
  Unlock,
  Volume2,
  Spline,
  VolumeX,
  ZoomIn,
  ZoomOut,
} from 'lucide-react';
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
  ScrubbableNumberInput,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
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
  MarkerListMenu,
  MarkerStrip,
  MARKER_STRIP_HEIGHT,
} from './TimelineMarkers';
import {
  TransitionBadges,
  TransitionsPaletteButton,
  TRANSITION_SNAP_PX,
  defaultTransitionFrames,
  nearestCut,
  type TransitionDragData,
  type TransitionPatch,
} from './TimelineTransitions';
import { Waveform } from './Waveform';
import { beginScrub, endScrub, updateScrub } from './scrubAudio';
import { Filmstrip } from './Filmstrip';
import { ClipFadeOverlay } from './ClipFadeOverlay';
import {
  niceTickIntervalSeconds,
  formatTimecode,
  MIN_PX_PER_SEC,
  MAX_PX_PER_SEC,
  DEFAULT_PX_PER_SEC,
  RULER_HEIGHT_PX,
} from './ruler';
// B-116 — anchored zoom: keep whatever is under the cursor (wheel) or the
// playhead (buttons) under it across a zoom step.
import { buttonZoomAnchorX, frameAtViewportX, scrollLeftForAnchor } from './timelineZoom';
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
  checkTransition,
  computeInsertion,
  cutFrames,
  endFrame,
  captionLines,
  gapAt,
  newTransition,
  linkedClipIds,
  linkedClipsFromDraggedMedia,
  newMarker,
  resolveClipLanding,
  sourceFramesToTimeline,
  syncLinkedClipIds,
  syncLinkedClipIdsAtPosition,
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
  bodyDragOp,
  edgeIsEditPoint,
  resizeEndOp,
  resolveTrimMode,
  trimModeCursor,
  trimModeHint,
  trimModeLabel,
  trimToolOwns,
  TRIM_ARM_HINT,
  type TrimMode,
  type TrimTool,
  type TrimZone,
} from './trimMode';
import { TrimToolbar } from './TrimToolbar';
import { adjustmentSummary } from './adjustment';
import {
  canStartMarquee,
  clipsInMarquee,
  composeMarqueeSelection,
  marqueeActivated,
  marqueeAnchorFromPoint,
  marqueeOverlayBox,
  marqueeRect,
  type MarqueeAnchor,
  type MarqueeRect,
  type MarqueeViewport,
} from './marquee';

const EFFECT_ID = 'clip';
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
const ROW_HEIGHT = 52;
/** how long a rippled clip's highlight stays visible (ms) */
const RIPPLE_FLASH_MS = 550;
/** D-250 — how far below-right of the pointer the armed trim-mode badge sits.
 *  Clear of a standard macOS cursor's own ~16px glyph, so the badge never
 *  covers the thing it is annotating. */
const TRIM_BADGE_OFFSET_PX = 16;
/** Track header sidebar default width (D-080; widened D-090 for the lock/
 *  hide/rearrange row) — now the `ResizablePanel`'s `defaultSize` (D-094:
 *  the sidebar became genuinely resizable, per the owner's standing
 *  "resizable-by-nature panels" rule in `CLAUDE.md`), not a fixed `width`. */
const HEADER_WIDTH = 156;
const HEADER_MIN_WIDTH = 110;
const HEADER_MAX_WIDTH = 340;
/** The ruler bar (`ruler.ts`'s `RULER_HEIGHT_PX`) + `.timeline-editor-edit-
 *  area`'s `margin-top`, i.e. exactly
 *  where row 0 starts on screen — which `dropTargetTrack` (D-080) and every
 *  absolutely-positioned overlay in this file need in order to convert a
 *  `clientY` into a track index (and back).
 *
 *  D-222 — that margin is the library's own 10px NO LONGER: the marker strip
 *  lives in it, and `timeline-overrides.css` widens it to
 *  `MARKER_STRIP_HEIGHT` via the `--chroma-marker-strip-height` custom
 *  property this pane sets. One definition, in `TimelineMarkers.tsx`, read by
 *  both the CSS and this constant — see that file and the override's own
 *  comment. */
const RULER_AND_MARGIN_PX = RULER_HEIGHT_PX + MARKER_STRIP_HEIGHT;
/** The library's own `startLeft` prop (px before frame 0) — kept as a named
 *  constant (D-095) since `xToFrame` below needs the exact same value the
 *  `<TimelineEditor startLeft={...}>` prop uses to convert a drop's
 *  `clientX` into a timeline frame; mirrors the library's own `Pt()`
 *  left-px→seconds helper (`(left - startLeft) / scaleWidth * scale`, which
 *  reduces to `/ pxPerSec` since `scaleWidth = tickSeconds * pxPerSec` —
 *  checked against its bundled source, not guessed). */
const START_LEFT_PX = 32;

/** D-233 — below this clip width (px) the curve button is not drawn.
 *
 *  Same rule, and same reason, as D-207's fade handles disappearing under
 *  36px: on a zoomed-out timeline a clip is a sliver, and a button pinned to
 *  its corner would cover the whole thing — including the edge-trim zones
 *  underneath it. A little wider than the fade threshold because this target
 *  is inset past the right trim zone rather than sitting on a corner. */
const CURVE_BUTTON_MIN_CLIP_PX = 48;

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
/** D-128 — how coarsely the horizontal scroll position is bucketed before it
 *  reaches the filmstrip. `getActionRender` below rebuilds every clip's DOM
 *  when its inputs change, and this file's own module doc already flags that
 *  as the expensive path; feeding it a raw per-pixel `scrollLeft` would run
 *  it on every scroll frame. The filmstrip's request window is snapped
 *  outward and overscanned by half a viewport anyway (`Filmstrip.tsx`), so a
 *  bucket this size is always well inside what has already been fetched — it
 *  costs nothing visually and turns "once per scrolled pixel" into "once per
 *  200px scrolled." */
const FILMSTRIP_SCROLL_BUCKET_PX = 200;
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
 *  of `ROW_HEIGHT`'s own value. Deliberately a thin band, not half the row:
 *  most of each row still resolves to "drop onto this existing track" (the
 *  pre-D-097 behaviour) — only hovering close to where two rows actually
 *  meet offers the mid-stack insert. ~22% of `ROW_HEIGHT` on each side
 *  (~44% combined) was picked as the deliberate trade-off between "reliably
 *  offers the affordance without pixel-perfect aim" and "doesn't eat so
 *  much of each row that an ordinary same-track drop near an edge
 *  accidentally triggers it." */
const TRACK_INSERT_BAND_PX = Math.round(ROW_HEIGHT * 0.22);

function clampPxPerSec(w: number): number {
  return Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, w));
}

/** One `TimelineRow` per track (D-080) — `row.id` is the track's own index
 *  (stringified), the stable key every callback below maps back to
 *  `timeline.tracks[i]` with. A fallback action id is namespaced by track
 *  index (`t{track}-clip-{i}`), not just `clip-{i}` — with a single track
 *  before D-080, a bare per-row index could never collide; with several
 *  tracks it could, so this stays unique across the whole timeline, not
 *  just within one row. */
function buildRows(tl: Timeline, fps: number): TimelineRow[] {
  return tl.tracks.map((track, ti) => {
    const actions: TimelineAction[] = track.clips.map((clip, i) => ({
      id: clip.id || `t${ti}-clip-${i}`,
      start: clip.start_frame / fps,
      // B-077 — `endFrame` now converts `clip.duration` (source frames, per
      // the `Clip` doc) through its own `source_fps` before adding it to
      // `start_frame` (timeline frames) — this used to add them directly,
      // which is exactly the bug that displayed a 47.86s screen recording as
      // 88s in a 24fps project (`duration / fps` with no fps conversion at
      // all, `2113 / 24`, nothing to do with the clip's real length).
      end: endFrame(clip, fps) / fps,
      effectId: EFFECT_ID,
      // D-100 — `movable: false`: the library's own native move-drag
      // (`interact.js`, `enableDragging` in its bundled source — confirmed
      // by reading it, not guessed) is now permanently disabled for every
      // clip. Owner: "there are two drag sources, one is handle and one is
      // clip itself... we should have the whole thing draggable and single
      // drag point handling all the drag related work" — two independently
      // implemented move systems on the same element (this library's native
      // drag, and the dnd-kit-based system D-098 added for cross-track)
      // were racing for the same gesture, the real root cause of that
      // whole session's stuck-overlay/broken-drag cluster, not two
      // unrelated bugs. `flexible: true` (edge-trim) is UNCHANGED and
      // fully independent of `movable` in the library's own source
      // (`enableResizing` never reads `movable`) — trim stays exactly as
      // it's worked since D-051, genuinely a different gesture in any real
      // NLE, not part of this unification. `ClipBody` (module scope,
      // below) is now the ONLY thing that moves a clip, same-track or
      // cross-track alike.
      flexible: true,
      movable: false,
    }));
    return { id: String(ti), actions };
  });
}

/** A clip body's fill, per its track's kind.
 *
 *  D-229 gave the subtitle lane its own entry and, in doing so, replaced the
 *  inline `kind === 'audio' ? … : …` ternary this file used in two places —
 *  a two-way ternary cannot express a third kind without silently colouring
 *  it as video, which is the bug a lookup avoids by construction.
 *
 *  These stay literal `rgba()` rather than `--color-*` tokens because they are
 *  what the pre-existing code already used here and are deliberately
 *  translucent overlays on the filmstrip beneath them; unifying the timeline's
 *  clip-body palette onto the token set is a real, separate cleanup, not
 *  something to half-do while adding a lane. */
const CLIP_BODY_BACKGROUND: Record<'video' | 'audio' | 'subtitle', string> = {
  video: 'rgba(90,120,180,0.55)',
  audio: 'rgba(120,170,110,0.55)',
  // A warm sand, the closest token-free match to the reference's own tan cue
  // blocks, and distinct from both the blue video and green audio bodies.
  subtitle: 'rgba(190,165,110,0.55)',
};

/** "Video 1" / "Audio 1" / "Subtitle 1" … — numbered per kind, matching the
 *  label this file always showed for the single video track before D-080.
 *  D-229 added the subtitle lane, named the way the reference names it
 *  (`scratch/resolve-reference/captioning.jpg` shows "Subtitle 1"). */
function trackLabels(tl: Timeline): string[] {
  let videoN = 0;
  let audioN = 0;
  let subN = 0;
  return tl.tracks.map((t) => {
    if (t.kind === 'audio') return `Audio ${++audioN}`;
    if (t.kind === 'subtitle') return `Subtitle ${++subN}`;
    return `Video ${++videoN}`;
  });
}

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

/** D-098 — real `@dnd-kit/sortable` drag id for track `index`, and the
 *  `data` payload every drag source/target below reads back in `onDragEnd`
 *  to tell a track-reorder apart from a clip cross-track move (two
 *  independent drag "kinds" sharing one `DndContext`, disambiguated by
 *  `event.active.data.current.type`, not by id shape). */
function trackDragId(index: number): string {
  return `track:${index}`;
}

/** D-149 — the track-header ducking control: which track ducks this one, and
 *  the three real DSP numbers behind it.
 *
 *  **A track-header control, not a clip Inspector one**, because ducking is a
 *  relationship between two tracks rather than a property of a clip — the same
 *  reason the field lives on `apelles_timeline::Track` and not on `Clip`. It
 *  sits behind a popover rather than inline because the header row is already
 *  dense (grip, kind, name, lock, sync-lock, hide/mute, remove) and four
 *  controls would not fit at `ROW_HEIGHT`; the trigger button lights up when
 *  ducking is actually on, so the state is legible without opening it.
 *
 *  **Offered on audio tracks only**, matching this header's existing, deliberate
 *  per-kind split (mute is audio-only, hide is video-only). The engine and the
 *  `set_track_duck` MCP tool will duck ANY track — a video track's embedded
 *  audio included — but post-D-129 a video clip's sound lives on its own linked
 *  audio track, so putting the control on every video header would be clutter
 *  in the case where it does nothing. Documented rather than silent: an agent
 *  can still reach the rarer case.
 *
 *  Defined at module scope for the same remount-safety reason
 *  `SortableTrackHeader` is (see its doc). */
function TrackDuckControl({
  index,
  duckFrom,
  duckDb,
  attackMs,
  releaseMs,
  trackLabels,
  onChange,
}: {
  index: number;
  duckFrom: number | null;
  duckDb: number;
  attackMs: number;
  releaseMs: number;
  /** every track's display label, indexed by track — the options this track can
   *  be ducked from (itself excluded: a track ducking on its own clips would
   *  attenuate exactly the audio triggering it, and Rust ignores it anyway). */
  trackLabels: string[];
  onChange: (patch: {
    duckFrom?: number | null;
    duckDb?: number;
    attackMs?: number;
    releaseMs?: number;
  }) => void;
}) {
  const active = duckFrom != null && duckDb !== 0;
  const num = 'h-6 w-16 px-1 text-[10px]';
  const row = 'flex items-center justify-between gap-2';
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="ghost"
            size="icon-xs"
            className={active ? 'text-accent' : undefined}
            aria-label={active ? 'Ducking settings (on)' : 'Ducking settings'}
            title={
              active
                ? `Ducked ${duckDb} dB by ${trackLabels[duckFrom] ?? `track ${duckFrom + 1}`}`
                : 'Ducking — lower this track while another one plays'
            }
          >
            <ChevronsDown className="size-3" />
          </Button>
        }
      />
      <PopoverContent className="w-64 p-3 text-xs">
        <div className="flex flex-col gap-2">
          <label className={row}>
            <span className="text-text-secondary">Duck from</span>
            <Select
              value={duckFrom == null ? DUCK_OFF : String(duckFrom)}
              onValueChange={(v) => onChange({ duckFrom: v === DUCK_OFF ? null : Number(v) })}
            >
              <SelectTrigger className="h-6 w-32 text-[11px]">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={DUCK_OFF}>Off</SelectItem>
                {trackLabels.map((label, i) =>
                  i === index ? null : (
                    <SelectItem key={i} value={String(i)}>
                      {label}
                    </SelectItem>
                  ),
                )}
              </SelectContent>
            </Select>
          </label>
          <label className={row}>
            <span className="text-text-secondary">Amount (dB)</span>
            {/* Negative — a duck is a reduction. Not clamped: a positive value
                boosts, which is unusual but well-defined, the same latitude
                `gain > 1` already has. */}
            <ScrubbableNumberInput
              step={1}
              max={0}
              className={num}
              value={duckDb}
              onValueChange={(duckDb) => onChange({ duckDb })}
            />
          </label>
          <label className={row}>
            <span className="text-text-secondary">Attack (ms)</span>
            <ScrubbableNumberInput
              step={5}
              min={0}
              className={num}
              value={attackMs}
              onValueChange={(attackMs) => onChange({ attackMs })}
            />
          </label>
          <label className={row}>
            <span className="text-text-secondary">Release (ms)</span>
            <ScrubbableNumberInput
              step={10}
              min={0}
              className={num}
              value={releaseMs}
              onValueChange={(releaseMs) => onChange({ releaseMs })}
            />
          </label>
          {/* Not decoration: these are the two numbers that ARE the feel of a
              ducker, and a user who reads them as an abstract "strength" will
              set them wrong. Stating what they actually mean is the same
              discipline the Fade section's own note follows. */}
          <p className="text-text-secondary/60 pt-1 text-[10px] leading-snug">
            Lowers this track while the chosen track has a clip playing. Attack is how fast it
            drops (short, so the duck beats the first word); release is how fast it comes back
            (long, so the bed doesn&apos;t pump between words).
          </p>
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** The `<Select>` value standing for "no ducking". A sentinel string, because
 *  Base UI's `Select` uses `""` for "nothing selected" and `null` is not a
 *  value it round-trips — the same reason `ClipInspectorPanel` uses a
 *  `CUSTOM_CURVE` sentinel rather than an empty option. */
const DUCK_OFF = 'off';

/** D-098 — a track header row, now a real `@dnd-kit/sortable` item
 *  (replacing D-094's native HTML5 `draggable` + hand-rolled
 *  `draggedTrack`/`dragOverTrack` state and per-row `onDragOver`/`onDrop`).
 *  Defined at module scope, not nested in `TimelinePane` — a component
 *  declared inside another component's body gets a new identity every
 *  render, which would force-remount this on every parent re-render and
 *  break `useSortable`'s own drag-state continuity; every dnd-kit-based
 *  component in this file follows the same rule. `setNodeRef` goes on the
 *  whole row (so the real "other rows slide out of the way" animation
 *  `@dnd-kit/sortable` is actually for applies to the row, not just the
 *  handle); `attributes`/`listeners` are spread ONLY on the small grip
 *  icon (the standard dnd-kit "drag handle" pattern) so the rest of the
 *  row — the lock/hide/mute/remove buttons — stays plain-clickable. */
function SortableTrackHeader({
  index,
  height,
  isVideo,
  muted,
  locked,
  hidden,
  syncLocked,
  label,
  duck,
  trackLabels,
  onToggleLock,
  onToggleHidden,
  onToggleMute,
  onToggleSyncLocked,
  onDuckChange,
  onRemove,
}: {
  index: number;
  height: number;
  isVideo: boolean;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
  syncLocked: boolean;
  label: string;
  /** D-149 — this track's ducking settings, already defaulted by the caller. */
  duck: { from: number | null; db: number; attackMs: number; releaseMs: number };
  /** D-149 — every track's label, for the "duck from" picker. */
  trackLabels: string[];
  onToggleLock: () => void;
  onToggleHidden: () => void;
  onToggleMute: () => void;
  onToggleSyncLocked: () => void;
  onDuckChange: (patch: {
    duckFrom?: number | null;
    duckDb?: number;
    attackMs?: number;
    releaseMs?: number;
  }) => void;
  onRemove: () => void;
}) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: trackDragId(index),
    // B-122 — `'track-header'`, not `'track'`. `useSortable` makes this a
    // DROPPABLE as well as a draggable, and `TrackDropZone` (the row lane) was
    // a droppable calling itself `'track'` too — with a `track` field where
    // this one has `index`. Every `event.over` reader discriminated on that
    // one string, so the two were indistinguishable and a clip dropped on a
    // HEADER read as a lane drop with `track: undefined`. See `dndTargets.ts`.
    data: { type: 'track-header' as const, index } satisfies TrackHeaderDragData,
  });
  const style: CSSProperties = {
    height,
    transform: DndCSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.4 : 1,
  };
  return (
    <div
      ref={setNodeRef}
      style={style}
      className={
        'flex flex-col justify-center gap-0.5 px-1.5 border-b border-border-color/60 text-text-secondary ' +
        (locked ? 'opacity-60 ' : '')
      }
    >
      <div className="flex items-center gap-1">
        {/* D-098 — real `move_track` behaviour is now driven by
            `@dnd-kit/sortable` instead of native HTML5 `draggable`,
            specifically because native HTML5 drag was reported live as
            unreliable on Tauri's macOS WKWebView (D-097's own doc) despite
            passing every check this session's Chromium-based harness could
            run — a real, honest gap dnd-kit's pointer/keyboard-sensor
            model (not native browser drag internals) is meant to close. */}
        <div
          className="cursor-grab p-1 -m-1 text-text-secondary/60 hover:text-text-secondary active:cursor-grabbing shrink-0"
          {...attributes}
          {...listeners}
          title="Drag to reorder track"
          aria-label="Drag to reorder track"
        >
          <GripVertical className="size-3" />
        </div>
        {isVideo ? <Film className="size-3 shrink-0" /> : <AudioLines className="size-3 shrink-0" />}
        <span className="text-[10px] font-medium truncate flex-1">{label}</span>
      </div>
      <div className="flex items-center gap-1">
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onToggleLock}
          aria-label={locked ? 'Unlock track' : 'Lock track'}
          title={locked ? 'Unlock track' : 'Lock track'}
        >
          {locked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
        </Button>
        {/* D-106 — cross-track ripple sync toggle, a real per-track concept
            distinct from `locked` above (see `Track.sync_locked`'s own
            doc). Placed right next to lock/hide, matching where Resolve
            puts its own Sync Lock in the track header. */}
        <Button
          variant="ghost"
          size="icon-xs"
          onClick={onToggleSyncLocked}
          aria-label={syncLocked ? 'Disable sync lock' : 'Enable sync lock'}
          title={
            syncLocked
              ? 'Sync lock on — ripples on other tracks shift this one too'
              : 'Sync lock off — ripples on other tracks skip this one'
          }
        >
          {syncLocked ? <Link2 className="size-3" /> : <Unlink2 className="size-3" />}
        </Button>
        {isVideo && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onToggleHidden}
            aria-label={hidden ? 'Show track' : 'Hide track'}
            title={hidden ? 'Show track (excluded from compositing)' : 'Hide track'}
          >
            {hidden ? <EyeOff className="size-3" /> : <Eye className="size-3" />}
          </Button>
        )}
        {!isVideo && (
          <Button
            variant="ghost"
            size="icon-xs"
            onClick={onToggleMute}
            aria-label={muted ? 'Unmute track' : 'Mute track'}
            title={muted ? 'Unmute track' : 'Mute track'}
          >
            {muted ? <VolumeX className="size-3" /> : <Volume2 className="size-3" />}
          </Button>
        )}
        {/* D-149 — ducking, right beside mute: both are this track's mix
            settings, as against lock/sync-lock/hide which are editing and
            compositing concerns. Audio tracks only — see `TrackDuckControl`. */}
        {!isVideo && (
          <TrackDuckControl
            index={index}
            duckFrom={duck.from}
            duckDb={duck.db}
            attackMs={duck.attackMs}
            releaseMs={duck.releaseMs}
            trackLabels={trackLabels}
            onChange={onDuckChange}
          />
        )}
        <Button
          variant="ghost"
          size="icon-xs"
          className="ml-auto text-red-400 hover:text-red-400"
          onClick={onRemove}
          aria-label="Remove track"
          title="Remove track"
        >
          <Trash2 className="size-3" />
        </Button>
      </div>
    </div>
  );
}

/** D-100 — the clip body itself, now the ONE real drag source for both
 *  same-track reposition and cross-track move (replacing D-098's separate
 *  top-strip `ClipMoveHandle` AND the timeline library's own native
 *  `interact.js` move-drag — see `buildRows`'s `movable: false` doc for the
 *  real story: two independently-built move systems on one element were
 *  racing for the same gesture, the actual root cause of a whole session's
 *  stuck-overlay/broken-drag reports, not separate bugs). Module-scope for
 *  the same remount-safety reason as `SortableTrackHeader`/`TrackDropZone`.
 *
 *  Safe to cover the FULL clip now, unlike D-098's inset strip: with
 *  `movable: false`, the library's own `interact.js` move listener is never
 *  even initialized for this action (confirmed in its bundled source,
 *  `enableDragging: !disabled && movable`) — there's no second system left
 *  to race for the same `pointerdown`, so no `stopPropagation` gymnastics
 *  are needed either (D-098's own capture-vs-bubble same-element ordering
 *  bug simply doesn't apply once there's only one listener on this element
 *  to begin with). The library's own edge-trim resize handles
 *  (`.timeline-editor-action-{left,right}-stretch`) are unaffected — they're
 *  siblings rendered by the library itself, outside this component
 *  entirely, and `enableResizing` never reads `movable`.
 *
 *  `onDndDragEnd` (in `TimelinePane`) already resolves same-track vs.
 *  cross-track purely from WHERE this lands (`event.over`'s track vs. this
 *  clip's own starting track) — that logic was built for D-098's own
 *  same-track regression fix and needed no changes for this unification,
 *  it was already exactly the right shape. */
function ClipBody({
  track,
  clipId,
  className,
  style,
  children,
}: {
  track: number;
  clipId: string;
  className: string;
  style?: CSSProperties;
  children: ReactNode;
}) {
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: `clip:${track}:${clipId}`,
    data: { type: 'clip' as const, track, clipId },
  });
  return (
    <div
      ref={setNodeRef}
      // D-137 — the marker marquee-select's own gesture guard tests for. This
      // element is THE `@dnd-kit/core` `useDraggable` node inside the edit
      // area, so `listeners` below is where dnd-kit's `PointerSensor`
      // activator actually lives; a `pointerdown` anywhere in this subtree is
      // a press dnd-kit's sensor claims. `canStartMarquee` (`marquee.ts`)
      // refuses to begin a marquee for any event with this attribute on its
      // propagation path, which makes "marquee" and "clip drag" mutually
      // exclusive by DOM position rather than by ordering or precedence —
      // see that module's doc, and D-094–D-100 for why this file does not
      // settle two drag systems on one element any other way.
      data-chroma-clip-drag=""
      // D-235 — which clip this body belongs to, readable from the DOM. The
      // smart trim tool's hover affordance has to answer "which mode would a
      // press right here commit?" from a raw `pointermove` whose target may be
      // the library's own stretch handle (a sibling of this element, rendered
      // outside this component), so it resolves the action wrapper first and
      // looks this pair up inside it. dnd-kit's own `id` already encodes the
      // same pair, but it is not exposed on the DOM node in any documented way.
      data-chroma-track={track}
      data-chroma-clip-id={clipId}
      // D-250 — where the smart trim tool is announced when it is NOT armed.
      // D-235's four edits are reachable only by already knowing to hold
      // Alt/Option, and its readout appears only once that key is down, so
      // nothing on this surface ever said the key does anything — the owner
      // asked "how to toggle between roll/slip/ripple etc?" with the feature
      // shipped. A `title` is the right cost for a hint you need exactly once:
      // it is on the thing the gesture acts on, it costs no pixels, and it is
      // read out by a screen reader. The badge (armed) and this (unarmed) are
      // the two halves of one affordance.
      title={TRIM_ARM_HINT}
      className={className + ' cursor-grab active:cursor-grabbing ' + (isDragging ? 'opacity-30' : '')}
      style={style}
      {...attributes}
      {...listeners}
    >
      {children}
    </div>
  );
}

/** D-098 — one droppable target per track, overlaid on the edit area at
 *  that track's real on-screen position (same `RULER_AND_MARGIN_PX +
 *  index*ROW_HEIGHT - scrollTop` math `insertPreview`'s overlays already
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
 *  `clipDragPreview`'s own precisely-sized/positioned placeholder overlay
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
      className="pointer-events-none absolute left-0 right-0 z-20"
      style={{ top, height }}
    />
  );
}

export function TimelinePane() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);
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
   *  real interactive entry points (`onClickAction` for a clip, the edit
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
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [rippled, setRippled] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  // D-095 — horizontal scroll, needed alongside `scrollTop` to convert a
  // drop's `clientX` into a timeline frame (`xToFrame` below); the library
  // reports both through the same `onScroll` callback (`OnScrollParams`,
  // `react-virtualized`), `scrollTop` just never needed `scrollLeft` before
  // this pass since nothing read a horizontal drop position.
  const [scrollLeft, setScrollLeft] = useState(0);
  // D-128 — the filmstrip fetches only the source range a clip is actually
  // showing, so it needs the width of the scroll viewport, not just the
  // clip's own width. `editAreaRef` is the library's scrollable edit area
  // (the track-header column is a separate `ResizablePanel`), so its client
  // width IS the viewport. Tracked with a `ResizeObserver` because a panel
  // drag resizes it without any React state changing.
  const [viewportWidth, setViewportWidth] = useState(0);

  const editorRef = useRef<TimelineState>(null);
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
  const attachEditArea = useCallback((node: HTMLDivElement | null) => {
    editAreaRef.current = node;
    setEditArea(node);
  }, []);
  const fps = timelineFps(timeline);
  const tracks = timeline?.tracks ?? [];
  const labels = useMemo(() => (timeline ? trackLabels(timeline) : []), [timeline]);

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
  // from the current selection would touch (shift or block), rendered as a
  // secondary highlight in `getActionRender` below. Recomputed only when the
  // selection or the timeline actually changes, not on every render.
  // D-128 — see `FILMSTRIP_SCROLL_BUCKET_PX`.
  const filmstripScrollLeft =
    Math.round(scrollLeft / FILMSTRIP_SCROLL_BUCKET_PX) * FILMSTRIP_SCROLL_BUCKET_PX;

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

  // keep the editor's own cursor in step with the store playhead (step buttons,
  // the play loop, clicks in the preview transport)
  useEffect(() => {
    editorRef.current?.setTime(playhead / fps);
  }, [playhead, fps]);

  // D-232 — unmounting mid-drag (a tab switch, a project close) still ends the
  // scrub gesture. `onCursorDragEnd` cannot fire for a component that is gone,
  // and a scrub that outlived its gesture would hold the audio output device
  // open for the rest of the session. `endScrub` is idempotent, so this costs
  // nothing on an ordinary unmount.
  useEffect(() => endScrub, []);

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
  // here) and falls through to the library's own scrollable edit-area
  // container (`overflow: overlay` in its bundled CSS — real native
  // browser scroll, not something this file has to reimplement), which is
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
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      zoomByRef.current(factor, e.clientX);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
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
   *  the timeline library's own scrollable content width is derived from
   *  `scaleWidth` (i.e. from `pxPerSec`), so a `setScrollLeft` issued before
   *  React has re-rendered with the new zoom would be clamped against the OLD
   *  content width and silently lose the anchor on every zoom-in. */
  useEffect(() => {
    const anchor = zoomAnchorRef.current;
    if (!anchor) return;
    zoomAnchorRef.current = null;
    const next = scrollLeftForAnchor(anchor.frame, anchor.viewportX, fps, pxPerSec, START_LEFT_PX);
    editorRef.current?.setScrollLeft(next);
    // Kept in step directly rather than waiting for the library's own
    // `onScroll` to echo it back: every drop/drag/overlay conversion in this
    // file reads this state, and a zoom must not leave them a frame behind.
    setScrollLeft((prev) => (prev === next ? prev : next));
  }, [pxPerSec, fps]);

  // D-128 — keep `viewportWidth` honest across window and panel resizes.
  useEffect(() => {
    const el = editAreaRef.current;
    if (!el) return;
    setViewportWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
    // B-123 — see the `wheel` effect above; same late-mount, same fix.
  }, [editArea]);

  // --------------------------------------------------------------------- //
  // D-235 — the context-sensitive trim tool (roadmap item 27). A FIFTH
  // gesture family on this surface, and like D-137's marquee and D-207's fade
  // handles it earns a note here because the coexistence story is the whole
  // design. It does NOT add a sixth pointer listener: it re-reads the two
  // drags this pane already has (the library's edge resize, and `ClipBody`'s
  // dnd-kit drag) and, when armed, commits a different op at the end of the
  // same gesture. Nothing about how a drag STARTS changes, so nothing it
  // could collide with changes either.
  //
  // The mode rule itself lives in `trimMode.ts` (pure, unit-tested) together
  // with the reference research behind it. Two things have to be captured here
  // that the pure part cannot see for itself:
  //
  //   1. `trimArmed` — whether Alt/Option is held RIGHT NOW, for the hover
  //      affordance (the readable stand-in for Resolve's four swapped
  //      cursors). Purely cosmetic; no gesture reads it.
  //   2. `trimPressRef` — the modifiers and the in-row Y position of the press
  //      a gesture actually began from. The timeline library's resize
  //      callbacks hand back no event at all (checked in its own typings:
  //      `onActionResizeStart/Resizing/ResizeEnd` carry only action/row/start/
  //      end/dir), so the modifier state HAS to be captured from the raw
  //      pointerdown. A capture-phase listener on the edit area sees that
  //      press before either drag system claims it, and cannot swallow it —
  //      it only reads.
  //
  // Resolved at PRESS time, not continuously, and deliberately: Resolve
  // resolves its own mode from where the pointer is before the click (the
  // cursor tells you which trim you are about to get), and a mode that could
  // change halfway through a drag would mean the op committed was not the one
  // the user aimed at.
  const [trimArmed, setTrimArmed] = useState(false);
  const trimPressRef = useRef<{ altKey: boolean; shiftKey: boolean; bodyYRatio: number; tool: TrimTool } | null>(null);

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
  const [trimTool, setTrimToolState] = useState<TrimTool>('select');
  const trimToolRef = useRef<TrimTool>('select');
  const selectTrimTool = (tool: TrimTool) => {
    trimToolRef.current = tool;
    setTrimToolState((prev) => (prev === tool ? prev : tool));
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
      // The library's own action wrapper — the one element whose rect is the
      // clip's real on-screen row box, which is what Resolve's slip-above /
      // slide-below split needs. Its class name was read out of the library's
      // bundled CSS (`.timeline-editor-action`), not guessed.
      const action = target?.closest('.timeline-editor-action');
      const rect = action?.getBoundingClientRect();
      trimPressRef.current = {
        altKey: e.altKey,
        shiftKey: e.shiftKey,
        bodyYRatio: rect && rect.height > 0 ? (e.clientY - rect.top) / rect.height : 0,
        // D-261 — the active tool is captured with the modifiers, and for the
        // same stated reason (see this ref's doc): the edit a gesture commits
        // must be the one the user aimed at when they pressed, so a tool
        // shortcut typed mid-drag cannot retarget a drag already in flight.
        // Read from the ref, not the state, so this listener never re-binds.
        tool: trimToolRef.current,
      };
    };
    el.addEventListener('pointerdown', onPointerDown, true);
    return () => el.removeEventListener('pointerdown', onPointerDown, true);
    // B-123 — `editArea`, not `[]`. THIS is the listener whose absence made
    // the whole D-235/D-250 smart trim tool inert in the real app: with no
    // capture-phase press to read, `trimPressRef` stayed `null`, every
    // gesture resolved unarmed, and Alt+drag silently fell back to the plain
    // move/trim it has always been — while the badge and cursor (React props,
    // bound with the JSX) kept correctly announcing "Slip"/"Roll".
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
    const action = target?.closest('.timeline-editor-action');
    if (!action) return null;
    const body = action.querySelector<HTMLElement>('[data-chroma-clip-drag]');
    const ti = Number(body?.dataset.chromaTrack);
    const clipId = body?.dataset.chromaClipId;
    if (!clipId || !Number.isInteger(ti)) return null;
    const i = idxOf(ti, clipId);
    if (i < 0) return null;
    const zone: TrimZone = target?.closest('.timeline-editor-action-left-stretch')
      ? 'edge-start'
      : target?.closest('.timeline-editor-action-right-stretch')
        ? 'edge-end'
        : 'body';
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
    if (hoveredBody) hoveredBody.style.cursor = next ? trimModeCursor(next) : '';
    cursorOverrideElRef.current = hoveredBody;
  };
  const onTrimHoverLeave = () => {
    setHoverTrimMode((prev) => (prev === null ? prev : null));
    if (cursorOverrideElRef.current) {
      cursorOverrideElRef.current.style.cursor = '';
      cursorOverrideElRef.current = null;
    }
  };

  // Ripple visual feedback (D-051) — diff each clip id's timeline start frame
  // against the previous render; anything that moved (chiefly a `move` now,
  // since D-058 made trim/remove non-rippling by construction — see the
  // module doc) gets a brief `animate-pulse` highlight in `getActionRender`
  // below. A brand new track (nothing to compare against yet) or a clip that
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
    setRippled(shifted);
    const t = setTimeout(() => setRippled(new Set()), RIPPLE_FLASH_MS);
    return () => clearTimeout(t);
  }, [timeline]);

  const editorData = useMemo<TimelineRow[]>(
    () => (timeline ? buildRows(timeline, fps) : [{ id: '0', actions: [] }]),
    [timeline, fps],
  );

  const effects = useMemo(() => ({ [EFFECT_ID]: { id: EFFECT_ID, name: 'clip' } }), []);

  const [dragOver, setDragOver] = useState(false);
  // D-098 — track reorder and cross-track clip move are now real
  // `@dnd-kit/core`/`@dnd-kit/sortable` drags, not native HTML5 `draggable`
  // (see the module doc on `SortableTrackHeader`/`ClipBody` for why —
  // reported live as unreliable on Tauri's WKWebView). `activeDrag` is the
  // one shared `<DndContext>`'s notion of "what's currently being dragged"
  // — drives the `DragOverlay` ghost and whether `TrackDropZone` overlays
  // exist in the DOM at all (only during a clip-type drag).
  const [activeDrag, setActiveDrag] = useState<TrackHeaderDragData | ClipDragData | null>(null);
  // D-113 — owner, live: "when i drag and drop it shows whole track as
  // white make only the track length and where it is actually going to
  // go, placeholder kindda." The full-row wash `TrackDropZone` used to
  // paint is gone (see that component's own updated doc); this is the
  // real, precisely-sized/positioned replacement — the SAME resolved
  // landing (`resolveClipLanding`) `onDndDragEnd` would actually apply,
  // computed live on every `onDragMove` tick instead of only at drop time.
  // Cleared on drag end/cancel and whenever the active drag isn't a clip
  // drag at all (or isn't currently over a real track).
  const [clipDragPreview, setClipDragPreview] = useState<{
    fromTrack: number;
    toTrack: number;
    clipId: string;
    startFrame: number;
    /** B-077 — a TIMELINE-frame footprint (`sourceFramesToTimeline`), not the
     *  dragged clip's raw `.duration` (source frames) — this is a ripple
     *  shift AMOUNT applied to `start_frame`-space positions. */
    duration: number;
    ripple: boolean;
  } | null>(null);

  // D-113 — owner, live: "if both are synced, then both should move
  // together and hover together." A live drag only ripples OTHER
  // sync-locked tracks when the resolved landing actually needs one
  // (`ripple: true` — the same condition `applyOp`'s `move` case gates the
  // real `propagateSyncLockRipple` call on); every affected clip is
  // rendered as its own ghost, shifted by the dragged clip's own duration
  // — the exact delta `shiftClipsAtOrAfter` would apply for real on drop —
  // so what's previewed during the drag matches what actually happens
  // when it's released, not an approximation of it.
  //
  // B-077 — both `clipDragPreview.duration` and each ghost's own `duration`
  // below are TIMELINE-frame footprints (`sourceFramesToTimeline`), not the
  // clips' raw (source-frame) `.duration` fields: `shiftedStart` is a
  // `start_frame`-space position (needs a timeline-frame shift, matching the
  // real `shiftClipsAtOrAfter` ripple this previews) and the render below
  // divides `duration` by the project's own `fps` for its pixel width — both
  // wrong for a `.duration` still in the dragged/ghost clip's own native rate.
  const dragSyncGhosts = useMemo(() => {
    if (!timeline || !clipDragPreview || !clipDragPreview.ripple) return [];
    const linkedIds = syncLinkedClipIdsAtPosition(timeline, clipDragPreview.toTrack, clipDragPreview.startFrame);
    if (linkedIds.size === 0) return [];
    const ghosts: { id: string; track: number; shiftedStart: number; duration: number }[] = [];
    tracks.forEach((t, ti) => {
      if (ti === clipDragPreview.toTrack) return; // same-track shift already IS the placeholder's own landing
      for (const c of t.clips) {
        if (linkedIds.has(c.id)) {
          ghosts.push({
            id: c.id,
            track: ti,
            shiftedStart: c.start_frame + clipDragPreview.duration,
            duration: sourceFramesToTimeline(c, c.duration, fps),
          });
        }
      }
    });
    return ghosts;
  }, [timeline, clipDragPreview, tracks, fps]);

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
    };
    window.addEventListener('blur', onBlur);
    return () => window.removeEventListener('blur', onBlur);
  }, []);

  /** D-095/D-096/D-097 — live feedback for a Sources-panel drag: `'edge'`
   *  shows an insertion line snapped to the nearest clip boundary on the row
   *  under the pointer (the dragged clip's real duration is unreadable
   *  until drop — HTML5 `dataTransfer.getData` is drop-only, see
   *  `onDragOver`'s own doc — so this can only show *where* it'll snap, not
   *  yet whether that's an open gap or a ripple; `onDrop` resolves that for
   *  real via `computeInsertion`), `'new_track'` shows the ghost row at
   *  insertion boundary `index` — `0..tracks.length` (D-097: any internal
   *  boundary or above the first track, not just past the last one — see
   *  `trackInsertBoundary`). Cleared on drag-leave/drop; never set for a
   *  cross-track clip-move drag (that path doesn't ripple/insert or create
   *  tracks). */
  const [insertPreview, setInsertPreview] = useState<
    { kind: 'edge'; track: number; frame: number } | { kind: 'new_track'; index: number } | null
  >(null);

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
  // below): `onDrop` is the only place `dragOver`/`insertPreview` reset,
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
      setInsertPreview((prev) => (prev === null ? prev : null));
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
  const marqueeViewport: MarqueeViewport = {
    fps,
    pxPerSec,
    scrollLeft,
    scrollTop,
    startLeftPx: START_LEFT_PX,
    rulerPx: RULER_AND_MARGIN_PX,
    rowHeight: ROW_HEIGHT,
  };
  const marqueeLatestRef = useRef<{ viewport: MarqueeViewport; timeline: Timeline | null }>({
    viewport: marqueeViewport,
    timeline,
  });
  useEffect(() => {
    marqueeLatestRef.current = { viewport: marqueeViewport, timeline };
  });

  /** Pointer position → timeline units, against the CURRENT viewport. */
  const marqueePointTo = useCallback((clientX: number, clientY: number): MarqueeAnchor | null => {
    const rect = editAreaRef.current?.getBoundingClientRect();
    if (!rect) return null;
    return marqueeAnchorFromPoint(clientX - rect.left, clientY - rect.top, marqueeLatestRef.current.viewport);
  }, []);

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
    if (y >= tracksLength * ROW_HEIGHT) return tracksLength;
    if (y < 0) return 0;
    const b = Math.round(y / ROW_HEIGHT);
    if (b >= 0 && b <= tracksLength && Math.abs(y - b * ROW_HEIGHT) <= TRACK_INSERT_BAND_PX) return b;
    return null;
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
    const contentX = e.clientX - rect.left + scrollLeft;
    return Math.round(((contentX - START_LEFT_PX) / pxPerSec) * fps);
  };

  /** D-095/D-100 — nearest clip edge (start/end of any clip on `track`, or
   *  0) to `frame`, within `INSERT_SNAP_PX` at the current zoom; if nothing
   *  edge-snaps, falls back to whichever half of the clip CURRENTLY UNDER
   *  `frame` is closer (mirrors `computeInsertion`'s own D-100 fallback
   *  exactly — the live preview and the real drop-time decision must never
   *  disagree, or the snap line lies about where the clip will actually
   *  land). `null` only for a drop with nothing nearby at all. */
  const nearestEdge = (track: Track, frame: number): number | null => {
    const snapFrames = Math.round((INSERT_SNAP_PX / pxPerSec) * fps);
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
    const y = e.clientY - rect.top - RULER_AND_MARGIN_PX + scrollTop;
    // Gap-on-add fix: this used to silently fall back to `videoTrackIndex`
    // for `y < 0`, while `onDragOver`'s own preview showed NOTHING for that
    // same case - a real drop could land on a track the user was never shown
    // a preview for. Now both agree: clamp into range instead of a hidden
    // special case, so whatever track the preview pointed at is always the
    // one the drop actually uses. (B-115: `y < 0` no longer reaches here at
    // all — `onDrop` resolves it to insertion boundary 0, "a new track above
    // the top one", before ever calling this.)
    return Math.max(0, Math.min(tracks.length - 1, Math.floor(y / ROW_HEIGHT)));
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
      setInsertPreview((prev) => (prev === null ? prev : null));
      return;
    }
    const y = e.clientY - rect.top - RULER_AND_MARGIN_PX + scrollTop;
    const boundary = trackInsertBoundary(y, tracks.length);
    if (boundary !== null) {
      setInsertPreview((prev) =>
        prev?.kind === 'new_track' && prev.index === boundary ? prev : { kind: 'new_track', index: boundary },
      );
      return;
    }
    // B-115 — there used to be an `if (y < 0)` clear-the-preview branch here.
    // It is unreachable now: with at least one track (guaranteed above),
    // `trackInsertBoundary` resolves every `y < 0` to boundary 0 and returns
    // in the branch above, so nothing negative ever reaches this point.
    const track = Math.max(0, Math.min(tracks.length - 1, Math.floor(y / ROW_HEIGHT)));
    const edge = nearestEdge(tracks[track], xToFrame(e, rect));
    setInsertPreview((prev) =>
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
    setInsertPreview((prev) => (prev === null ? prev : null));
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
    const y = rect ? e.clientY - rect.top - RULER_AND_MARGIN_PX + scrollTop : -1;
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
      applyOp({ kind: 'add_clip', track: boundary, clip, linkedAudio });
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
        ? computeInsertion(trackData, xToFrame(e, rect), clip, Math.round((INSERT_SNAP_PX / pxPerSec) * fps), fps)
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
    setInsertPreview(null);
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
    const pair = linkedClipsFromDraggedMedia(media);
    if (!pair) return; // unprobed / offline media has no known length — nothing to place
    const { video: clip, audio } = pair;
    placeDroppedClip(e, clip, audio ?? undefined, null);
  };

  const clipsOf = (track: number): Track['clips'] => tracks[track]?.clips ?? [];
  const idxOf = (track: number, actionId: string) => clipsOf(track).findIndex((c) => (c.id || '') === actionId);

  const s2f = (sec: number) => Math.round(sec * fps);

  // B-024 (root cause of the reported freeze during drag-and-drop): these 5
  // props were previously inline arrow functions in the `<TimelineEditor>`
  // JSX below — a brand new function identity on EVERY render of
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
  const getActionRender =
    (action: TimelineAction, row: TimelineRow) => {
      const ti = Number(row.id);
      const track = tracks[ti];
      const i = idxOf(ti, action.id);
      const clip = i >= 0 ? clipsOf(ti)[i] : null;
      const isSel = isInSelection(selection, ti, action.id);
      const isRippled = rippled.has(action.id);
      // Owner, 2026-09-04: "for sync when i select one is should see all the
      // sync selected" — a real, distinct secondary ring (never the primary
      // `isSel` accent ring — a clip is either the selection or related to
      // it, the two states should never look the same) for every clip
      // `syncLinkedIds` says a ripple from the current selection would touch.
      const isSyncLinked = !isSel && syncLinkedIds.has(action.id);
      // D-128 — the selected clip's own A/V-linked half. Takes precedence
      // over the sync-lock ring when a clip is both (an A/V link is the
      // stronger, more specific statement about that clip), and uses the
      // accent token rather than the neutral `text-secondary` one, because a
      // linked half is genuinely part of what the user has hold of — it will
      // move, trim and delete with the selection.
      const isAvLinked = !isSel && avLinkedIds.has(action.id);
      // D-233 — which property the curve button would open, and whether this
      // clip's lane is the one currently open. `animatedParams` is served off
      // `clipKeyframes.ts`'s per-array `WeakMap` index (D-209), so asking it
      // once per clip per render is a map lookup, not a re-scan.
      const curveParam = clip ? (animatedParams(clip.chroma_keyframes)[0] ?? null) : null;
      const curveOpenHere = curveEditor?.track === ti && curveEditor?.id === action.id;
      // Owner, 2026-09-04: "for locked show muted color on clip" — the same
      // `opacity-60` treatment the track-header row already gets when
      // `track.locked` (D-080/D-090-era), extended to the clip bodies
      // themselves so the muted state reads at the clip level, not just from
      // glancing at the header.
      const isLockedTrack = !!track?.locked;
      const pxWidth = (action.end - action.start) * pxPerSec;
      return (
        <ClipBody
          track={ti}
          clipId={action.id}
          className={
            // D-207 — `group/clip` is what lets `ClipFadeOverlay`'s handles
            // reveal themselves on hover when a clip has no fade set yet
            // (named group, so it can never be captured by an unrelated
            // ancestor `group` elsewhere in the tree).
            'group/clip relative h-full w-full overflow-hidden rounded ' +
            (isSel ? 'ring-2 ring-accent ' : '') +
            (isRippled ? 'ring-2 ring-accent animate-pulse ' : '') +
            // Dashed, not a second solid ring: `ring-*` has no dashed style
            // in Tailwind, so this uses the outline utilities (v4:
            // width + style + colour), inset so it reads inside the clip
            // body like the rings above rather than bleeding into the row.
            (isAvLinked ? 'outline-2 outline-dashed outline-accent/70 -outline-offset-2 ' : '') +
            (isSyncLinked && !isAvLinked ? 'ring-2 ring-text-secondary ' : '') +
            (isLockedTrack ? 'opacity-60 ' : '')
          }
          style={{
            // D-100 — selection no longer swaps the background to
            // `var(--color-accent)`. Owner: "this make it hard to read...
            // white selected color is not visible" — the background swap
            // paired with the WRONG text-color token for it (see the label
            // below) made selected clips genuinely low-contrast. The clip's
            // own kind-based colour now stays constant; the `ring-2 ring-
            // accent` above (already existed, already the right token per
            // `CLAUDE.md`'s "no magic colours, use `--color-*`") is the
            // ONLY selection indicator now — a real outline, not a
            // background-colour gamble.
            background: CLIP_BODY_BACKGROUND[track?.kind ?? 'video'],
          }}
        >
          {/* D-211 — a TEXT clip has no picture to filmstrip and no audio to
              draw a waveform for; its content IS its visual. A tinted body
              with the title's own text across it, which is what both
              references show for a title/generator clip on the timeline.
              Rendered BEFORE the media branch below, and that branch's own
              `!clip.text` guard is what keeps `Filmstrip`/`Waveform` from
              being handed an empty `sourcePath` (they'd no-op, but a decode
              request for "" is a real IPC round trip per clip per zoom
              level). */}
          {clip?.text && (
            <div
              className="absolute inset-0 flex items-center justify-center overflow-hidden px-2"
              style={{ background: 'rgba(150,120,190,0.55)' }}
            >
              <span className="truncate text-[11px] font-semibold tracking-wide text-button-text/90">
                {clip.text.content || 'Title'}
              </span>
            </div>
          )}
          {/* D-229 — a CAPTION clip, like a title, has no picture and no
              audio: its cue text IS its visual, which is exactly what the
              reference frame shows (a tinted block with the caption written
              across it). Same placement and same reasoning as the title
              branch above, and the media branch's guard below excludes it for
              the same reason. */}
          {clip?.caption && (
            <div
              className="absolute inset-0 flex items-center overflow-hidden px-2"
              style={{ background: CLIP_BODY_BACKGROUND.subtitle }}
            >
              <span className="truncate text-[11px] font-medium text-button-text/90">
                {captionLines(clip.caption.text).join(' ') || 'Caption'}
              </span>
            </div>
          )}
          {/* D-230 — an ADJUSTMENT clip. Drawn from the real Resolve
              reference (`scratch/resolve-reference/adjustments.jpg`), which
              shows it as a flat, saturated, thumbnail-free bar carrying an
              `fx` badge and the words "Adjustment Clip" — deliberately unlike
              every clip around it, because it is the one clip on the timeline
              that contributes no picture of its own. Same slot and same
              guard structure as the text branch above (and the media branch's
              `!clip.text` guard is extended for it) so `Filmstrip`/`Waveform`
              are never handed this clip's empty `sourcePath`. */}
          {clip?.adjustment && (
            <div
              className="absolute inset-0 flex items-center gap-1.5 overflow-hidden px-2"
              style={{ background: 'rgba(70,110,205,0.72)' }}
            >
              <Wand2 className="size-3 shrink-0 text-button-text/90" aria-hidden />
              <span className="truncate text-[11px] font-semibold tracking-wide text-button-text/90">
                {clip.name || 'Adjustment Clip'}
              </span>
              {/* The correction's own summary, so the timeline says what this
                  clip actually does without a trip to the Inspector — the
                  equivalent of the effect name Resolve shows on the body. */}
              <span className="ml-auto truncate text-[10px] font-medium text-button-text/70">
                {adjustmentSummary(clip.adjustment)}
              </span>
            </div>
          )}
          {clip && !clip.text && !clip.caption && !clip.adjustment && track?.kind === 'video' && (
            <>
              {/* D-119 — real filmstrip thumbnails, the clip's actual picture
                  content tiled across its full width/height, replacing the
                  flat colour fill as the visual background. Waveform (below)
                  overlays a translucent amplitude strip anchored to the
                  bottom edge on top of it — same layering the reference
                  screenshot's own combined video+audio clips use — rather
                  than splitting the clip into hard top/bottom zones, which
                  at this project's compact `ROW_HEIGHT` (52px) would leave
                  neither signal legible. */}
              {/* D-128 — the visible slice of this clip, in px from its own
                  left edge. The filmstrip fetches only the source range that
                  covers, at a tile density matching the current zoom, instead
                  of a fixed 64-frame summary of the whole clip stretched to
                  fit (D-124's own named limitation, and the smeared tiles the
                  owner screenshotted against Palmier Pro's timeline). */}
              <Filmstrip
                sourcePath={clip.source_path}
                startSecs={clip.source_start / (clip.source_fps ?? fps)}
                durationSecs={clip.duration / (clip.source_fps ?? fps)}
                width={pxWidth}
                height={ROW_HEIGHT}
                visibleStartPx={filmstripScrollLeft - (START_LEFT_PX + action.start * pxPerSec)}
                visibleEndPx={
                  filmstripScrollLeft +
                  viewportWidth -
                  (START_LEFT_PX + action.start * pxPerSec)
                }
              />
              <div className="absolute inset-x-0 bottom-0" style={{ height: ROW_HEIGHT * 0.4 }}>
                <Waveform
                  sourcePath={clip.source_path}
                  startSecs={clip.source_start / (clip.source_fps ?? fps)}
                  durationSecs={clip.duration / (clip.source_fps ?? fps)}
                  width={pxWidth}
                  height={ROW_HEIGHT * 0.4}
                />
              </div>
            </>
          )}
          {/* D-128 — an audio-track clip gets a FULL-height waveform and no
              filmstrip. Until this pass no audio track ever had a clip on it
              (D-057 was mixing capability with no producer), so this branch
              had nothing to render and didn't exist; now that dropping a clip
              really creates one, a flat green fill would be the only thing
              you'd see on the half that matters most to read. No `Filmstrip`
              here on purpose: an audio clip has no picture worth showing, and
              D-124's filmstrip decode is exactly the cost not to pay twice
              per linked pair. */}
          {clip && track?.kind === 'audio' && (
            <Waveform
              sourcePath={clip.source_path}
              startSecs={clip.source_start / (clip.source_fps ?? fps)}
              durationSecs={clip.duration / (clip.source_fps ?? fps)}
              width={pxWidth}
              height={ROW_HEIGHT}
            />
          )}
          {/* D-058/B-013: `pointer-events-none` is load-bearing, not
              decorative. This label's `z-10` (needed so it paints above the
              Waveform canvas) has no isolating stacking context between it
              and the library's own absolutely-positioned
              `.timeline-editor-action-{left,right}-stretch` resize handles
              (siblings of this whole content block, rendered *after* it in
              the DOM but `z-index: auto`) — a block-level, unconstrained-
              width div, this label silently spans the clip's full width,
              including both 10px edge zones, and (confirmed live: a real
              pointer event at the handle's coordinates hit-tested to *this*
              div, not the handle, until this was added) ate every resize-
              handle pointerdown before interact.js ever saw it. That's why
              edge-trim visually did nothing — not a `flexible`/`dragLine`
              problem (D-051 was right about the library's own mechanism), a
              hit-testing problem in what we paint on top of it.
              D-100 — always `text-button-text` now, not conditional on
              `isSel`. That token is this app's own established "readable
              against `bg-accent`" colour (matches `ExportPresetsList.tsx`/
              `ProjectLauncher.tsx`'s own `bg-accent text-button-text`
              pairing, checked, not guessed) — the OLD code used it only
              for the non-selected case and switched to `text-text-primary`
              (meant for the app's default background, not an accent one)
              specifically when selected, which was backwards and the real
              other half of the contrast bug alongside the background
              swap above. `button-text` already reads fine against the
              plain video/audio clip colours too (no complaints there
              before this pass), so one token now covers both states. */}
          {/* D-207 — the fade rubber-band + its two draggable handles, on
              EVERY clip regardless of track kind: one fade pair drives picture
              and sound together in this model (`Clip::fade_in_frames`' own
              doc), so drawing it only on audio clips would split one feature
              into two. Rendered before the label so the label's own `z-10`
              still wins the paint order and stays legible (D-100). Its own
              module-scope component, so a fade drag re-renders one clip's
              overlay rather than this whole pane — see its module doc. */}
          {clip && (
            <ClipFadeOverlay
              track={ti}
              clipIndex={i}
              clip={clip}
              widthPx={pxWidth}
              heightPx={ROW_HEIGHT}
              fps={fps}
              pxPerSec={pxPerSec}
              disabled={isLockedTrack}
            />
          )}
          {/* D-233 — the curve-editor toggle, at the clip's top-right, which
              is where Resolve puts its own (`scratch/resolve-reference/
              curve.jpg`: a curve glyph and a keyframe glyph on the clip's
              name bar). Shown only on a clip that ACTUALLY animates
              something: a button that opens an empty lane is a button that
              teaches the user it does nothing.

              Same hit-target discipline the fade handles (D-207) and the move
              grip (D-094) already follow, and for the same B-013 reason: it
              is a small, bounded, `z-20` target that `stopPropagation`s, so
              dnd-kit's clip-move drag and the library's own right-edge trim
              zone both keep every pixel this button does not occupy. It sits
              inset from the right edge past that 10px trim zone. */}
          {clip && curveParam && pxWidth >= CURVE_BUTTON_MIN_CLIP_PX && (
            <button
              type="button"
              className="absolute right-3 top-0.5 z-20 rounded p-0.5 text-button-text/80 hover:bg-black/25 hover:text-button-text"
              title={
                curveOpenHere
                  ? 'Close the curve editor'
                  : `Edit ${clip.name || 'this clip'}'s ease curves`
              }
              aria-label="Toggle the curve editor for this clip"
              aria-pressed={curveOpenHere}
              onPointerDown={(e) => e.stopPropagation()}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                // Toggling off when it is already this clip's lane; otherwise
                // open on the clip's first animated property (declaration
                // order — see `animatedParams`), which the lane's own header
                // then lets you change.
                setCurveEditor(curveOpenHere ? null : { track: ti, id: action.id, param: curveParam });
              }}
            >
              <Spline size={11} />
            </button>
          )}
          <div className="relative z-10 flex h-full items-center px-2 text-[11px] font-medium truncate pointer-events-none text-button-text">
            {clip?.name ?? action.id}
          </div>
        </ClipBody>
      );
    };

  /** Multi-select, Phase 1 (D-107) — shift-click range-extends within the
   *  clicked clip's own track (ordered by `start_frame`, this model's real
   *  time order — Vec order is bookkeeping only, D-054); cmd/ctrl-click
   *  toggles the clicked clip in/out of the selection; a plain click
   *  replaces the whole selection with just this clip, unchanged from
   *  before. `e` is the library's own real `React.MouseEvent<HTMLElement,
   *  MouseEvent>` (checked against its `.d.ts`, not the loosely-typed
   *  `unknown` this handler used to cast it to) — `shiftKey`/`metaKey`/
   *  `ctrlKey` are real fields on it. */
  /** D-201 — no `useCallback` (see the note above `getActionRender`). */
  const onClickAction =
    (e: ReactMouseEvent<HTMLElement, MouseEvent>, { action, row }: { action: TimelineAction; row: TimelineRow }) => {
      setSelectedGap(null); // D-105 — clicking a clip always supersedes a gap selection
      const track = Number(row.id);
      const id = action.id;
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

  const onTimelineScroll = useCallback(({ scrollTop: st, scrollLeft: sl }: { scrollTop: number; scrollLeft: number }) => {
    setScrollTop(st);
    setScrollLeft(sl);
  }, []);

  // D-100 — the library's own `onActionMoveEnd` callback is gone: with
  // `movable: false` (see `buildRows`), the library never fires it at all
  // any more — `ClipBody`/`onDndDragEnd` is the only thing that moves a
  // clip now, same-track or cross-track alike. Kept as dead code this would
  // violate `CLAUDE.md`'s own "no dead code" rule, so it's removed rather
  // than left unused.
  /** D-201 — no `useCallback` (see the note above `getActionRender`): its old
   *  `[tracks, fps, applyOp]` array left out `s2f`, which the compiler infers
   *  and which is enough on its own to bail the whole component out. */
  const onActionResizeEndCb = ({
    action,
    row,
    start,
    end,
    dir,
  }: {
    action: TimelineAction;
    row: TimelineRow;
    start: number;
    end: number;
    dir: 'left' | 'right';
  }) => {
    const ti = Number(row.id);
    const i = idxOf(ti, action.id);
    if (i < 0 || !timeline) return;
    // D-235 — which edit this edge drag really was is decided by `resizeEndOp`
    // (pure, exhaustively unit-tested — see its own doc for why the decision
    // lives there rather than inline here). Unarmed, it returns exactly the two
    // ops this handler has always built: the plain, gap-leaving trim of D-058,
    // unchanged. Armed, the same drag becomes a roll at a real edit point or a
    // ripple anywhere else. The modifiers come from `trimPressRef` because the
    // library's resize callbacks carry no event at all (see that ref's doc).
    const op = resizeEndOp({
      tl: timeline,
      track: ti,
      clip: i,
      dir,
      startFrame: s2f(start),
      endFrame: s2f(end),
      press: trimPressRef.current,
    });
    if (op) applyOp(op);
  };

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
   *  linked clip's whole group, `split` cuts every member, either can prune a
   *  track). Re-reading between ops is what keeps the second op in a batch
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
      if (at) applyOp({ kind: 'split', track: at.track, clip: at.clip, atFrame: playhead });
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
  const doAddMarker = () => {
    const marker = newMarker(playhead);
    // `newMarker` only rejects a caller-supplied colour or a non-finite frame;
    // this call site passes neither, so the guard is a type narrow, not a real
    // branch.
    if ('error' in marker) return;
    applyOp({ kind: 'add_marker', marker });
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
   *  D-201 — no `useMemo` (see the note above `getActionRender`): its
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

  /** D-105 — the deliberate mirror image of `doRemove`: close a selected
   *  GAP, rippling everything after it earlier, rather than lifting a clip
   *  and leaving the space behind. */
  const doRemoveGap = () => {
    if (!selectedGap) return;
    applyOp({ kind: 'remove_gap', track: selectedGap.track, frame: selectedGap.frame });
    setSelectedGap(null);
  };

  // D-272 — every one of this pane's shortcuts, resolved from the registry.
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
  useShortcut('edit.add_marker', doAddMarker);
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
  useShortcut('edit.tool_select', () => selectTrimTool('select'));
  useShortcut('edit.tool_ripple', () => selectTrimTool('ripple'));
  useShortcut('edit.tool_roll', () => selectTrimTool('roll'));
  useShortcut('edit.tool_slip', () => selectTrimTool('slip'));
  useShortcut('edit.tool_slide', () => selectTrimTool('slide'));

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
    applyOp({ kind: 'set_track_gain', track, gain: muted ? DEFAULT_TRACK_GAIN : 0 });
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

  // D-094 — track reorder is now a real drag handle on each header row
  // (`GripVertical`, plain HTML5 drag/drop — same mechanism as the
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
    const next = clip ?? header;
    if (!next) return; // a transitions-palette drag — no overlay ghost of its own
    setActiveDrag(next);
  }, []);

  const onDndDragCancel = useCallback(() => {
    setActiveDrag(null);
    setClipDragPreview((prev) => (prev === null ? prev : null));
  }, []);

  // D-113 — live landing preview, the drag-tick-sensitive twin of
  // `onDndDragEnd`'s own landing computation below (same math, same
  // `resolveClipLanding` call — kept in sync deliberately, not copy-pasted
  // and left to drift: if `onDndDragEnd`'s computation ever changes, this
  // one needs to change with it). Fires on every pointer-move tick during
  // a drag, so the D-083 discipline that already governs every other
  // per-tick handler in this file applies here just as strictly: the
  // `setClipDragPreview` call is gated to only actually dispatch when the
  // resolved landing genuinely changed, not on every pixel of movement.
  //
  // D-201 audited this against roadmap item 21.3 ("does the drag re-render
  // through React state every pointer-move frame?") and the answer is no, for
  // every gesture in this pane: a clip drag writes only this local
  // `clipDragPreview`/`insertPreview` state (both change-gated), a marquee
  // writes only local `marquee`, a trim goes through the library's own resize
  // and reaches `applyOp` in `onActionResizeEndCb` — i.e. on resize END — and
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
   *  does it — `activatorEvent`'s own position plus the drag's `delta`, which
   *  dnd-kit does not expose directly — so there is one notion of "where did
   *  this drag actually end" in this file, not two. */
  const dndBoundary = (event: DragMoveEvent | DragEndEvent): number | null => {
    const rect = editAreaRef.current?.getBoundingClientRect();
    const translated = event.active.rect.current.translated;
    if (!rect || !translated || tracks.length === 0) return null;
    const activator = event.activatorEvent as PointerEvent | MouseEvent | undefined;
    if (typeof activator?.clientX !== 'number' || typeof activator?.clientY !== 'number') return null;
    const px = activator.clientX + event.delta.x;
    const py = activator.clientY + event.delta.y;
    if (px < rect.left || px > rect.right || py < rect.top || py > rect.bottom) return null;
    // D-117's own signal for WHICH boundary: the dragged `ClipBody`'s
    // translated top edge, which is what the user actually sees lining up
    // with a row. The pointer above answers "is this drop on the timeline at
    // all"; this answers "which line is it on".
    const y = translated.top - rect.top - RULER_AND_MARGIN_PX + scrollTop;
    return trackInsertBoundary(y, tracks.length);
  };

  /** D-201 — no `useCallback` (see the note above `getActionRender`): its old
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
        setClipDragPreview((prev) => (prev === null ? prev : null));
        setInsertPreview((prev) => (prev === null ? prev : null));
        return;
      }
      // D-235 — an armed drag is a slip or a slide, and neither one moves the
      // clip anywhere. Showing the move path's landing ghost for it would
      // promise a reposition that is never going to happen, so the preview is
      // suppressed for the whole gesture rather than left to contradict the op
      // that actually commits (`onDndDragEnd`).
      const armedActivator = event.activatorEvent as PointerEvent | MouseEvent | undefined;
      if (armedActivator?.altKey || trimPressRef.current?.altKey) {
        setClipDragPreview((prev) => (prev === null ? prev : null));
        setInsertPreview((prev) => (prev === null ? prev : null));
        return;
      }
      if (overTrack === null) {
        // Not over an existing track's lane — check whether this is a real
        // track-insertion boundary (same helper the Sources-panel add path
        // uses) and show the identical ghost-row preview if so.
        setClipDragPreview((prev) => (prev === null ? prev : null));
        const boundary = dndBoundary(event);
        setInsertPreview((prev) =>
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
      setInsertPreview((prev) => (prev === null ? prev : null));
      const { track: fromTrack, clipId } = data;
      const i = idxOf(fromTrack, clipId);
      if (i < 0) return;
      const clip = clipsOf(fromTrack)[i];
      const toTrack = overTrack;
      const deltaFrames = Math.round((event.delta.x / pxPerSec) * fps);
      const intendedFrame = clip.start_frame + deltaFrames;
      const snapFrames = Math.round((INSERT_SNAP_PX / pxPerSec) * fps);
      // `toTrack` came from `laneDropTrack`, which only ever returns a real
      // track index — so this cannot be the `undefined` that crashed
      // `resolveClipLanding` on `dest.clips` (B-122).
      const { startFrame, ripple } = resolveClipLanding(tracks[toTrack], clip.id, clip, intendedFrame, snapFrames, fps);
      setClipDragPreview((prev) => {
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
        // (source-frame) value — see `dragSyncGhosts`'s own doc for why.
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
      setActiveDrag(null);
      setClipDragPreview((prev) => (prev === null ? prev : null));

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
        // The pointer's real x: `event.delta` is the whole drag's movement, and
        // `activatorEvent` is the original pointer event it started from — the
        // pair gives an absolute position without needing a rect measurement,
        // the same relative-plus-origin approach the clip drag above uses.
        const activator = event.activatorEvent as PointerEvent | MouseEvent | undefined;
        const rect = editAreaRef.current?.getBoundingClientRect();
        if (!rect || typeof activator?.clientX !== 'number') return;
        const contentX = activator.clientX + event.delta.x - rect.left + scrollLeft;
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
      // cross-track alike (see `buildRows`'s `movable: false` doc and
      // `ClipBody`'s own doc for why the library's native move-drag is
      // gone). `over`'s track vs. this clip's own starting track is what
      // decides which case this is — no separate code path per gesture,
      // just a different `startFrame` computation.
      const { track: fromTrack, clipId } = clipDrag;
      const i = idxOf(fromTrack, clipId);
      if (i < 0) return;

      // D-235 — the body half of the context-sensitive trim tool. Armed with
      // Alt/Option, this same drag is a slip (upper band) or a slide (lower
      // band) instead of a move, per Resolve's own over-the-thumbnails /
      // under-the-thumbnails split — see `trimMode.ts` for the rule and its
      // provenance. Checked BEFORE any of the landing math below, because a
      // slip and a slide are not landings: neither one is allowed to change
      // which track the clip is on, so `event.over` is deliberately not
      // consulted at all.
      //
      // `event.activatorEvent` is the original pointerdown dnd-kit started
      // from, which is where its modifiers really are; `trimPressRef` supplies
      // the in-row Y that only the raw press knows. Both are read, rather than
      // either alone, so this agrees exactly with the edge path above about
      // what "armed" means.
      const activator = event.activatorEvent as PointerEvent | MouseEvent | undefined;
      const captured = trimPressRef.current;
      const press = captured && {
        // The activator is dnd-kit's own record of the press it started from,
        // and is authoritative for the modifiers; `trimPressRef` is the only
        // source for the in-row Y. Reading both, rather than either alone, is
        // what keeps this in exact agreement with the edge path about what
        // "armed" means.
        altKey: activator?.altKey ?? captured.altKey,
        shiftKey: activator?.shiftKey ?? captured.shiftKey,
        bodyYRatio: captured.bodyYRatio,
        // D-261 — the palette's tool as it was at press. Only `trimPressRef`
        // has this; dnd-kit's activator event knows nothing about it.
        tool: captured.tool,
      };
      if (timeline) {
        const op = bodyDragOp({
          tl: timeline,
          track: fromTrack,
          clip: i,
          delta: Math.round((event.delta.x / pxPerSec) * fps),
          press,
        });
        // A `null` op means either "this drag was never a slip/slide" or "it
        // was, but it moved no whole frame / the model refused it". Only the
        // first may fall through to the move path — otherwise a Slip that
        // clamped would silently become a MOVE, which is a different edit
        // entirely. So the question asked here is whether the gesture was
        // CLAIMED, not whether it produced an op: claimed by the Alt arm, or
        // (D-261) by a palette tool that owns body drags.
        const claimed = press !== null && (press.altKey || trimToolOwns(press.tool, 'body'));
        if (op || claimed) {
          if (op) applyOp(op);
          // Same "a drag also selects what it edited" rule the move path below
          // ends with — a slip/slide is still a pick.
          setSelection([{ track: fromTrack, id: clipId }]);
          return;
        }
      }

      // B-122 — one question, one answer: `laneDropTrack` is `null` for "not
      // over anything", "over a HEADER rather than a lane" (the crash) and
      // "over a lane whose track no longer exists" alike, and every one of
      // those is the same non-landing. `toTrack` below is therefore always a
      // real track index, which is what `resolveClipLanding` requires.
      const overTrack = laneDropTrack(event.over?.data.current, tracks.length);
      if (overTrack === null) {
        setInsertPreview((prev) => (prev === null ? prev : null));
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
        const deltaFrames = Math.round((event.delta.x / pxPerSec) * fps);
        const intendedFrame = Math.max(0, clip.start_frame + deltaFrames);
        // The new track is guaranteed empty — no gap/ripple resolution
        // needed, `intendedFrame` is always a safe landing.
        applyOp({ kind: 'move', fromTrack: resolvedFromTrack, toTrack: boundary, clip: i, startFrame: intendedFrame, ripple: false });
        setSelection([{ track: boundary, id: clipId }]);
        return;
      }
      const toTrack = overTrack;
      const clip = clipsOf(fromTrack)[i];
      // D-104 — `event.delta.x` is the net pointer movement for the whole
      // drag, in screen px, converted to frames the same way `xToFrame` does
      // (relative rather than absolute — no `rect`/`clientX` needed). Used
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
      const deltaFrames = Math.round((event.delta.x / pxPerSec) * fps);
      const intendedFrame = clip.start_frame + deltaFrames;
      const snapFrames = Math.round((INSERT_SNAP_PX / pxPerSec) * fps);
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

  const zoomPct = Math.round((pxPerSec / DEFAULT_PX_PER_SEC) * 100);

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
        : buttonZoomAnchorX(playhead, fps, pxPerSec, scrollLeft, START_LEFT_PX, width);
    zoomAnchorRef.current = {
      frame: frameAtViewportX(viewportX, fps, pxPerSec, scrollLeft, START_LEFT_PX),
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

  // D-058 — the labeled-tick interval adapts to the current zoom ("nice
  // numbers": widen as pxPerSec shrinks, narrow as it grows) rather than the
  // library's fixed `scale` prop; `scaleWidth` (the library's "px per one
  // `scale`-second unit") is then derived so what's actually on screen stays
  // continuous even though `tickSeconds` itself only takes discrete values.
  const tickSeconds = niceTickIntervalSeconds(pxPerSec, TICK_TARGET_PX, 1 / fps);
  const libScaleWidth = tickSeconds * pxPerSec;

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
  // waveform in the overlay — the same visual `getActionRender` already
  // builds for the resting clip, not a generic placeholder. Capped at
  // `MAX_OVERLAY_PX` — this is a cursor-follow *preview*, not a literal
  // render of the clip at full timeline zoom; an hour-long clip dragged at
  // 100% would otherwise produce an unusable, off-screen-sized ghost.
  const dragOverlayClip =
    activeDrag?.type === 'clip'
      ? clipsOf(activeDrag.track)[idxOf(activeDrag.track, activeDrag.clipId)]
      : null;
  const dragOverlayTrack = activeDrag?.type === 'clip' ? tracks[activeDrag.track] : null;
  const MAX_OVERLAY_PX = 320;
  const dragOverlayWidth = dragOverlayClip
    ? Math.max(60, Math.min(MAX_OVERLAY_PX, (dragOverlayClip.duration / (dragOverlayClip.source_fps ?? fps)) * pxPerSec))
    : 0;

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
    return (
      <div
        className={
          'h-full w-full flex flex-col items-center justify-center gap-2 text-center px-6 border-2 border-dashed rounded-none transition-colors ' +
          (dragOver ? 'border-accent bg-accent/5' : 'border-transparent')
        }
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <Film className="size-6 text-text-secondary/50" />
        <p className="text-xs text-text-secondary">
          Empty timeline — drag a clip from Sources to get started.
        </p>
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
          'flex flex-col min-h-0 h-full bg-bg-primary outline-none ' +
          (dragOver ? 'ring-2 ring-inset ring-accent' : '')
        }
        // D-222 — the one place `MARKER_STRIP_HEIGHT` crosses into CSS:
        // `timeline-overrides.css` widens the timeline library's own
        // ruler/edit-area gap to exactly this, so the strip has room and
        // `RULER_AND_MARGIN_PX` (which every overlay's `top` is measured from)
        // stays true. Set here rather than written as a literal in the
        // stylesheet so there is a single definition of the number.
        style={{ '--chroma-marker-strip-height': `${MARKER_STRIP_HEIGHT}px` } as CSSProperties}
        tabIndex={0}
      >
      <TooltipProvider>
        <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-border-color bg-surface text-text-primary">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={doSplit}
                  disabled={selection.length === 0}
                  aria-label="Split at playhead"
                >
                  <Scissors />
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
          <Separator orientation="vertical" className="mx-1 h-5" />
          <TrimToolbar active={trimTool} onSelect={selectTrimTool} />
          <Separator orientation="vertical" className="mx-1 h-5" />
          {/* D-248 — the Title (D-211) and Adjust (D-230) buttons stood here.
              They are library items, not timeline actions, and both references
              describe them as things you DRAG out of the effects library — so
              they moved to `EditLibraryRail.tsx` on the left edge of the tab,
              where they are now a real drag source as well as the same
              click-to-add they were here. What is left in this toolbar is
              exactly what acts on the timeline you already have. */}
          {/* D-222 — markers. A marker annotates a POSITION in this timeline,
              so unlike the library items it genuinely belongs in this toolbar;
              the list appears beside the add button only once there is
              something in it. */}
          <AddMarkerButton onAdd={doAddMarker} shortcut="M" />
          <MarkerListMenu
            timeline={timeline}
            fps={fps}
            onJump={setPlayhead}
            // B-114 — the same `remove_marker` op the strip's own popover
            // Delete drives (see `MarkerListMenu`'s doc for why the list
            // needed its own delete at all).
            onRemove={(id) => applyOp({ kind: 'remove_marker', id })}
          />
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
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  onClick={doRemove}
                  disabled={selection.length === 0}
                  aria-label="Remove clip"
                >
                  <Trash2 />
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
                  <Button variant="ghost" size="icon-sm" onClick={doUnlink} aria-label="Unlink audio and video">
                    <Unlink />
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
                    aria-label="Link audio and video"
                  >
                    <Link />
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
              once, but a distinct label/icon ("Close Gap"/`FoldHorizontal`
              vs. "Remove"/`Trash2`) makes clear this closes the space rather
              than just deleting something, matching the real, different
              underlying operation (D-105's `remove_gap` ripples; `remove`
              deliberately doesn't). Same Delete/Backspace keybinding covers
              both — see this component's `onKeyDown`. */}
          {selectedGap && (
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="icon-sm" onClick={doRemoveGap} aria-label="Close gap">
                    <FoldHorizontal />
                  </Button>
                }
              />
              <TooltipContent>
                <span className="font-medium">Close Gap</span>
                <span className="ml-1.5 text-text-secondary">
                  Close the selected gap — everything after it shifts left
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
                          <ArrowRightLeft />
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

          <div className="ml-auto flex items-center gap-0.5">
            {/* D-249 — D-198's Export button stood here, at the far right of
                this toolbar. It is now in the Edit tab's own top strip
                (`EditorTab.tsx`), beside the Inspector toggle: delivering the
                finished cut is the tab's terminal action, not one of the
                per-clip edit actions this strip holds, and the owner asked for
                it there directly (an arrow drawn from it up to the top bar).
                The dialog component is unchanged — only where it is mounted. */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="sm" onClick={zoomOut} aria-label="Zoom out">
                    <ZoomOut />
                  </Button>
                }
              />
              <TooltipContent>Zoom out (or scroll down over the timeline)</TooltipContent>
            </Tooltip>
            <span className="w-10 text-center text-[11px] tabular-nums text-text-secondary/70">{zoomPct}%</span>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button variant="ghost" size="sm" onClick={zoomIn} aria-label="Zoom in">
                    <ZoomIn />
                  </Button>
                }
              />
              <TooltipContent>Zoom in (or scroll up over the timeline)</TooltipContent>
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
            module doc. `translateY` keeps it in step with the library's own
            vertical scroll (tracked via `onScroll` below), offset by the
            same ruler+margin the edit area itself is offset by so a
            header's block lines up with its row, not the ruler. */}
        <ResizablePanel
          defaultSize={HEADER_WIDTH}
          minSize={HEADER_MIN_WIDTH}
          maxSize={HEADER_MAX_WIDTH}
          className="relative shrink-0 border-r border-border-color bg-surface overflow-hidden"
        >
          <div
            className="absolute left-0 right-0"
            style={{ top: RULER_AND_MARGIN_PX - scrollTop }}
          >
            {/* D-098 — real `@dnd-kit/sortable` list, replacing D-094's
                native HTML5 `draggable` track-reorder handle + hand-rolled
                `draggedTrack`/`dragOverTrack` state (see the module doc /
                `SortableTrackHeader`'s own doc for why). `items` is the
                CURRENT render's track ids in order — `SortableContext` uses
                it to compute the live "other rows slide out of the way"
                animation during a drag. */}
            <SortableContext items={tracks.map((_, i) => trackDragId(i))} strategy={verticalListSortingStrategy}>
              {tracks.map((track, i) => {
                const isVideo = track.kind === 'video';
                const muted = !isVideo && (track.gain ?? DEFAULT_TRACK_GAIN) <= 0;
                const locked = !!track.locked;
                const hidden = isVideo && !!track.hidden;
                const syncLocked = track.sync_locked ?? DEFAULT_SYNC_LOCKED;
                return (
                  <SortableTrackHeader
                    key={i}
                    index={i}
                    height={ROW_HEIGHT}
                    isVideo={isVideo}
                    muted={muted}
                    locked={locked}
                    hidden={hidden}
                    syncLocked={syncLocked}
                    label={labels[i]}
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
                  />
                );
              })}
            </SortableContext>
          </div>
        </ResizablePanel>

        <ResizableHandle />

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
            data-bench-id="timeline-edit-area"
            className="relative h-full overflow-hidden"
            // D-250 — the cursor half of Resolve's own context-sensitive trim
            // affordance ("You'll see the cursor change to different types of
            // trim tools as you move your mouse"), with the standard keywords
            // rather than the four bitmaps `trim.jpg` shows. On the AREA, not
            // on each clip: the two edge modes are resolved over the library's
            // own stretch handles, which are rendered by the library and are
            // not ours to style. `undefined` when nothing is armed leaves every
            // existing cursor (`ClipBody`'s `cursor-grab`, the handles' own)
            // exactly as it was.
            style={hoverTrimMode ? { cursor: trimModeCursor(hoverTrimMode) } : undefined}
            // D-100 — owner: "clicking outside does not make it
            // undeselected." A click anywhere in this area that ISN'T on a
            // clip (`.timeline-editor-action`, the library's own class for
            // one — checked in its bundled source, not guessed) clears
            // selection. Bubble-order safety, not a race: the library's own
            // `onClickAction` (set via the `onClickAction` prop below) fires
            // on the action itself first, since it's the innermost target;
            // THIS handler runs after, on the same click, and only clears
            // when `closest` finds no action ancestor — a real clip click
            // never reaches the clearing branch.
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
              if ((e.target as HTMLElement).closest('.timeline-editor-action')) return;
              const rect = editAreaRef.current?.getBoundingClientRect();
              if (rect) {
                const y = e.clientY - rect.top - RULER_AND_MARGIN_PX + scrollTop;
                const trackIdx = Math.floor(y / ROW_HEIGHT);
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
            <TimelineEditor
              ref={editorRef}
              editorData={editorData}
              effects={effects}
              scale={tickSeconds}
              scaleWidth={libScaleWidth}
              getScaleRender={(sec) => formatTimecode(sec, fps, tickSeconds)}
              startLeft={START_LEFT_PX}
              rowHeight={ROW_HEIGHT}
              autoScroll
              dragLine
              style={{ width: '100%', height: '100%' }}
              onScroll={onTimelineScroll}
              getActionRender={getActionRender}
              onClickAction={onClickAction}
              onClickTimeArea={(time) => {
                setPlayhead(s2f(time));
                return true;
              }}
              // D-232 — the timeline's own tape-scrub gesture. The library
              // already distinguishes the three phases of a cursor drag, which
              // is exactly what scrub audio needs and what `onCursorDrag`
              // alone cannot express: `onSeek`-shaped callbacks cannot tell a
              // drag apart from a programmatic seek. Same shared driver the
              // player's position bar uses, so both gestures feed the one Rust
              // scrub transport.
              onCursorDragStart={(time) => {
                const frame = s2f(time);
                setPlaying(false);
                setPlayhead(frame);
                beginScrub(frame);
              }}
              onCursorDrag={(time) => {
                const frame = s2f(time);
                setPlayhead(frame);
                updateScrub(frame);
              }}
              onCursorDragEnd={() => endScrub()}
              onChange={() => false}
              onActionResizeEnd={onActionResizeEndCb}
            />
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
              className="pointer-events-none absolute left-0 top-0 z-40 whitespace-nowrap rounded border border-border-color bg-surface px-1.5 py-1 text-[10px] leading-tight text-text-primary shadow-md"
            >
              <span className="font-medium">{hoverTrimMode ? trimModeLabel(hoverTrimMode) : ''}</span>
              {hoverTrimMode && trimModeHint(hoverTrimMode) && (
                <span className="ml-1.5 text-text-secondary">{trimModeHint(hoverTrimMode)}</span>
              )}
            </div>
            {/* D-095/D-096/D-097 — the live drop-preview overlay: an
                insertion line snapped to a clip edge, or a ghost row at a
                track-insertion boundary. `pointer-events-none` so it never
                steals the drag's own dragover/drop targeting from the
                library/edit-area underneath — purely visual, positioned in
                the same `editAreaRef`-relative coordinate space `xToFrame`/
                `dropTargetTrack` already compute against. */}
            {insertPreview?.kind === 'edge' && (
              <div
                className="pointer-events-none absolute z-30 bg-accent"
                style={{
                  left: START_LEFT_PX + (insertPreview.frame / fps) * pxPerSec - scrollLeft,
                  top: RULER_AND_MARGIN_PX + insertPreview.track * ROW_HEIGHT - scrollTop,
                  width: 2,
                  height: ROW_HEIGHT,
                }}
              />
            )}
            {insertPreview?.kind === 'new_track' && (
              <div
                // B-115 — a stable hook for "the drag is offering a new track
                // HERE", the same `data-chroma-*` convention D-219 established
                // for naming a surface without matching on a Tailwind class
                // string that changes whenever the styling does.
                data-chroma-new-track-preview={insertPreview.index}
                className="pointer-events-none absolute left-0 right-0 z-30 border-2 border-dashed border-accent/70 bg-accent/10"
                style={{
                  // D-097 — past the last row (`index === tracks.length`)
                  // there's no row below to overlap into, so the ghost sits
                  // flush under the last real row, unchanged from D-096.
                  // Every other boundary (above the first track, or between
                  // two existing ones) centers the ghost ON the boundary
                  // line, half-overlapping each neighboring row — the
                  // standard "squeeze a new row in here" NLE affordance.
                  top:
                    RULER_AND_MARGIN_PX +
                    insertPreview.index * ROW_HEIGHT -
                    (insertPreview.index === tracks.length ? 0 : ROW_HEIGHT / 2) -
                    scrollTop,
                  height: ROW_HEIGHT,
                }}
              />
            )}
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
                    className="pointer-events-none absolute z-20 border-2 border-dashed border-accent bg-accent/15"
                    style={{
                      left: START_LEFT_PX + (gap.gapStart / fps) * pxPerSec - scrollLeft,
                      width: ((gap.gapEnd - gap.gapStart) / fps) * pxPerSec,
                      top: RULER_AND_MARGIN_PX + selectedGap.track * ROW_HEIGHT - scrollTop,
                      height: ROW_HEIGHT,
                    }}
                  />
                );
              })()}
            {/* D-226 — one badge per transition, spanning its own window and
                centred on its cut. Rendered here, in the same overlay layer as
                the gap highlight and the drag previews above, because a
                transition belongs to the EDIT POINT between two clips and not to
                either of them — drawing it inside a clip's own
                `getActionRender` body would tie it to one of the two and make it
                vanish when that clip is re-rendered. */}
            <TransitionBadges
              tracks={tracks}
              fps={fps}
              pxPerSec={pxPerSec}
              scrollLeft={scrollLeft}
              scrollTop={scrollTop}
              startLeftPx={START_LEFT_PX}
              rowHeight={ROW_HEIGHT}
              rulerAndMarginPx={RULER_AND_MARGIN_PX}
              onChange={(track, id, patch: TransitionPatch) =>
                applyOp({ kind: 'set_transition', track, id, patch })
              }
              onRemove={(track, id) => applyOp({ kind: 'remove_transition', track, id })}
            />
            {/* D-113 — owner, live: "have track horizontal lines as well."
                The library's own bundled CSS draws no row separators at all
                (checked, not assumed) — real, missing, not just faint. One
                thin line per track's bottom edge, `z-0` so every real
                overlay/clip paints over it, `border-border-color` (the same
                real token the track-header sidebar's own row dividers
                already use, not a new literal). */}
            {tracks.map((_, i) => (
              <div
                key={`row-line-${i}`}
                className="pointer-events-none absolute left-0 right-0 z-0 border-b border-border-color/60"
                style={{ top: RULER_AND_MARGIN_PX + i * ROW_HEIGHT - scrollTop, height: ROW_HEIGHT }}
              />
            ))}
            {/* D-113 originally rendered a filled dashed box here at the
                clip-move landing frame, matching `insertPreview`'s
                `'new_track'` visual language. Owner, live, after D-119 gave
                the `DragOverlay` ghost real filmstrip content: "we have 3
                things — the previous place, the new thumbnail preview, and
                the dotted line — let's remove the dot." With a real
                picture-content ghost already following the cursor at the
                resolved landing position, this second box was drawing the
                same information twice. Removed — `clipDragPreview` (the
                state) stays, `dragSyncGhosts` below still derives its own
                sync-linked-track ghosts from it; only this box's own render
                is gone. */}
            {/* D-113 — owner, live: "if both are synced, then both should
                move together and hover together." One ghost per
                `dragSyncGhosts` entry, at that clip's OWN track, shifted by
                the dragged clip's duration — a live preview of the real
                ripple the drop would apply to every sync-linked track, not
                just the one track being dragged onto. A slightly different
                visual weight from the primary landing placeholder above
                (`ring-text-secondary`-toned, matching D-111's own selection-
                time sync-linked ring, not the primary accent) — related to
                the drop, not the drop's own destination. */}
            {dragSyncGhosts.map((g) => (
              <div
                key={`sync-ghost-${g.id}`}
                className="pointer-events-none absolute z-30 rounded border-2 border-dashed border-text-secondary/70 bg-text-secondary/10"
                style={{
                  left: START_LEFT_PX + (g.shiftedStart / fps) * pxPerSec - scrollLeft,
                  width: (g.duration / fps) * pxPerSec,
                  top: RULER_AND_MARGIN_PX + g.track * ROW_HEIGHT - scrollTop,
                  height: ROW_HEIGHT,
                }}
              />
            ))}
            {/* D-098 — one real `useDroppable` target per track, always
                mounted (see `TrackDropZone`'s own doc for why — a real
                mid-drag droppable-registration timing bug found live), only
                pointer-interactive while a clip-type `@dnd-kit/core` drag is
                active. Positioned in the same `editAreaRef`-relative
                coordinate space every other overlay in this file already
                uses. */}
            {/* D-137 — the marquee itself. `pointer-events-none` for the same
                reason every other overlay in this file is: it must never
                become a hit target, least of all one covering the clips its
                own gesture is selecting. Painted above the drag ghosts
                (`z-40`) since it is the thing the user is actively drawing.
                Its geometry is derived from the rect's TIMELINE units on every
                render (`marqueeOverlayBox`), not stored in pixels, so a scroll
                or a ctrl-wheel zoom mid-drag moves and rescales the band with
                the content it actually encloses rather than sliding off it. */}
            {marquee && (
              <div
                data-bench-id="timeline-marquee"
                className="pointer-events-none absolute z-40 rounded-[2px] border border-accent bg-accent/15"
                style={marqueeOverlayBox(marquee, marqueeViewport)}
              />
            )}
            {tracks.map((_, i) => (
              <TrackDropZone key={i} track={i} top={RULER_AND_MARGIN_PX + i * ROW_HEIGHT - scrollTop} height={ROW_HEIGHT} />
            ))}
            {/* D-222 — the marker flag strip, in the band between the ruler's
                ticks and track row 0 (`timeline-overrides.css` widened that
                band to fit it). Last in this container so it paints over the
                row lines and drag ghosts: a marker must stay visible while a
                clip is being dragged past it. NOT scroll-offset here — it
                takes `scrollLeft` and derives each flag's own x, exactly like
                every other overlay above, and it is pinned vertically (a
                marker belongs to the ruler, not to a scrolled track row), so
                `scrollTop` is deliberately not applied. */}
            {timeline && (
              <MarkerStrip
                timeline={timeline}
                fps={fps}
                pxPerSec={pxPerSec}
                scrollLeft={scrollLeft}
                startLeftPx={START_LEFT_PX}
                onJump={setPlayhead}
                onPatch={(id, patch) => applyOp({ kind: 'set_marker', id, patch })}
                onRemove={(id) => applyOp({ kind: 'remove_marker', id })}
              />
            )}
          </div>
            </ResizablePanel>

            {curveEditorClip && (
              <>
                <ResizableHandle />
                <ResizablePanel
                  defaultSize={CURVE_LANE_HEIGHT}
                  minSize={CURVE_LANE_MIN_HEIGHT}
                  className="relative min-h-0 overflow-hidden border-t border-border-color"
                >
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
                </ResizablePanel>
              </>
            )}
          </ResizablePanelGroup>
        </ResizablePanel>
      </ResizablePanelGroup>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragOverlayClip ? (
          <div
            className="pointer-events-none relative overflow-hidden rounded shadow-lg ring-2 ring-accent"
            style={{
              width: dragOverlayWidth,
              height: ROW_HEIGHT,
              background:
                CLIP_BODY_BACKGROUND[dragOverlayTrack?.kind ?? 'video'],
            }}
          >
            {dragOverlayTrack?.kind === 'video' && (
              <>
                <Filmstrip
                  sourcePath={dragOverlayClip.source_path}
                  startSecs={dragOverlayClip.source_start / (dragOverlayClip.source_fps ?? fps)}
                  durationSecs={dragOverlayClip.duration / (dragOverlayClip.source_fps ?? fps)}
                  width={dragOverlayWidth}
                  height={ROW_HEIGHT}
                />
                <div className="absolute inset-x-0 bottom-0" style={{ height: ROW_HEIGHT * 0.4 }}>
                  <Waveform
                    sourcePath={dragOverlayClip.source_path}
                    startSecs={dragOverlayClip.source_start / (dragOverlayClip.source_fps ?? fps)}
                    durationSecs={dragOverlayClip.duration / (dragOverlayClip.source_fps ?? fps)}
                    width={dragOverlayWidth}
                    height={ROW_HEIGHT * 0.4}
                  />
                </div>
              </>
            )}
            {/* D-128 — same full-height waveform for an audio clip being
                dragged, so the overlay looks like the clip it came from. */}
            {dragOverlayTrack?.kind === 'audio' && (
              <Waveform
                sourcePath={dragOverlayClip.source_path}
                startSecs={dragOverlayClip.source_start / (dragOverlayClip.source_fps ?? fps)}
                durationSecs={dragOverlayClip.duration / (dragOverlayClip.source_fps ?? fps)}
                width={dragOverlayWidth}
                height={ROW_HEIGHT}
              />
            )}
            <div className="absolute left-1 top-0.5 z-10 truncate text-[11px] font-medium text-button-text">
              {dragOverlayClip.name}
            </div>
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
