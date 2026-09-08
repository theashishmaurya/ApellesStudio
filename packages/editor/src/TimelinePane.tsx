/**
 * @chroma/editor — the timeline strip (D-041; drag-to-track D-046 pass 3;
 * mature-timeline-UI pass D-051; position-model + ruler fixes D-058;
 * multi-track UI D-080).
 *
 * `@xzdarcy/react-timeline-editor` with one row PER TRACK (D-080 — was one
 * fixed row, the video track, before this pass). Each clip is an "action".
 * Drag the body → `move` (same-track only, see below); drag an edge →
 * `trim_start` / `trim_end`; "Split at playhead" → `split`; select + Delete
 * / × → `remove`; drop a Sources-panel pool item onto a lane → `add_clip`
 * on that lane's track. Every edit goes through the store (`applyOp` →
 * debounced `chroma_timeline_set` → `chroma_timeline_get` refetch). Time in
 * the editor is seconds (frame / fps).
 *
 * D-058: every clip's on-screen position is read from its own `start_frame`
 * (`timeline.ts`'s `Clip.start_frame`, mirroring `chroma-timeline`'s D-054
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
 *     field anywhere yet (`chroma_timeline::Track` has no `locked`/`solo`)
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
  // D-211 — the Add-title action's own icon. `Type` is the letterform icon
  // both references use for a text/title generator, and nothing else in this
  // toolbar has claimed it.
  Type,
  // D-128 — the A/V-unlink action. Deliberately `Unlink`, not the `Unlink2`
  // below: that one is already the track header's sync-lock toggle, and
  // sync-lock and an A/V link are different relationships (see
  // `avLinkedIds`), so they must not share an icon.
  Unlink,
  Unlink2,
  Unlock,
  Volume2,
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
  Input,
  Popover,
  PopoverContent,
  PopoverTrigger,
  ResizableHandle,
  ResizablePanel,
  ResizablePanelGroup,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@chroma/ui';

import { useEditorTimelineStore, type Selection } from './timelineStore';
import {
  AddMarkerButton,
  MarkerListMenu,
  MarkerStrip,
  MARKER_STRIP_HEIGHT,
} from './TimelineMarkers';
import { Waveform } from './Waveform';
import { Filmstrip } from './Filmstrip';
import { ClipFadeOverlay } from './ClipFadeOverlay';
import { EditorExportDialog } from './EditorExportDialog';
import {
  niceTickIntervalSeconds,
  formatTimecode,
  MIN_PX_PER_SEC,
  MAX_PX_PER_SEC,
  DEFAULT_PX_PER_SEC,
  RULER_HEIGHT_PX,
} from './ruler';
import {
  CHROMA_MEDIA_DRAG_MIME,
  DEFAULT_DUCK_ATTACK_MS,
  DEFAULT_DUCK_RELEASE_MS,
  DEFAULT_SYNC_LOCKED,
  DEFAULT_TITLE_SECONDS,
  DEFAULT_TRACK_GAIN,
  checkLink,
  computeInsertion,
  endFrame,
  gapAt,
  linkedClipIds,
  linkedClipsFromDraggedMedia,
  newMarker,
  newTextClipFields,
  newTextLayer,
  resolveClipLanding,
  sourceFramesToTimeline,
  syncLinkedClipIds,
  syncLinkedClipIdsAtPosition,
  timelineFps,
  trackIndexAfterMove,
  videoTrackIndex,
  type Clip,
  type DraggedMedia,
  type LinkCheck,
  type LinkTarget,
  type Timeline,
  type Track,
} from './timeline';
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
const START_LEFT_PX = 20;
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

/** "Video 1" / "Audio 1" / "Video 2" … — numbered per kind, matching the
 *  label this file always showed for the single video track before D-080. */
function trackLabels(tl: Timeline): string[] {
  let videoN = 0;
  let audioN = 0;
  return tl.tracks.map((t) => (t.kind === 'video' ? `Video ${++videoN}` : `Audio ${++audioN}`));
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
 *  reason the field lives on `chroma_timeline::Track` and not on `Clip`. It
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
            <Input
              type="number"
              step={1}
              max={0}
              className={num}
              value={duckDb}
              onChange={(e) => onChange({ duckDb: Number(e.target.value) })}
            />
          </label>
          <label className={row}>
            <span className="text-text-secondary">Attack (ms)</span>
            <Input
              type="number"
              step={5}
              min={0}
              className={num}
              value={attackMs}
              onChange={(e) => onChange({ attackMs: Number(e.target.value) })}
            />
          </label>
          <label className={row}>
            <span className="text-text-secondary">Release (ms)</span>
            <Input
              type="number"
              step={10}
              min={0}
              className={num}
              value={releaseMs}
              onChange={(e) => onChange({ releaseMs: Number(e.target.value) })}
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
    data: { type: 'track' as const, index },
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
    data: { type: 'track' as const, track },
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
  const editAreaRef = useRef<HTMLDivElement>(null);
  const fps = timelineFps(timeline);
  const tracks = timeline?.tracks ?? [];
  const labels = useMemo(() => (timeline ? trackLabels(timeline) : []), [timeline]);

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
  useEffect(() => {
    const el = editAreaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setPxPerSec((w) => clampPxPerSec(w * factor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // D-128 — keep `viewportWidth` honest across window and panel resizes.
  useEffect(() => {
    const el = editAreaRef.current;
    if (!el) return;
    setViewportWidth(el.clientWidth);
    const ro = new ResizeObserver(() => setViewportWidth(el.clientWidth));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

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
  const [activeDrag, setActiveDrag] = useState<
    { type: 'track'; index: number } | { type: 'clip'; track: number; clipId: string } | null
  >(null);
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
   *  `y` isn't close to one. `tracksLength` itself (past the last row) is
   *  unconditional — there's nothing else there to resolve to (D-096's
   *  original behaviour, unchanged). Every OTHER boundary (0 = above the
   *  first track, 1..tracksLength-1 = between two existing tracks) only
   *  counts within `TRACK_INSERT_BAND_PX` of the line where two rows
   *  actually meet — see that constant's own doc for why. Shared by
   *  `onDragOver` (preview) and `onDrop` (the real op) so they can never
   *  disagree about where a drop actually lands. */
  const trackInsertBoundary = (y: number, tracksLength: number): number | null => {
    if (tracksLength === 0) return null;
    if (y >= tracksLength * ROW_HEIGHT) return tracksLength;
    if (y < 0) return null;
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
  const inferNewTrackKind = (index: number): 'video' | 'audio' => {
    if (index > 0 && tracks[index - 1]) return tracks[index - 1].kind;
    if (tracks[index]) return tracks[index].kind;
    return 'video';
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
    // for `y < 0`, while `onDragOver`'s own preview shows NOTHING for that
    // same case (see its `if (y < 0)` branch below) - a real drop could land
    // on a track the user was never shown a preview for. Now both agree:
    // clamp into range instead of a hidden special case, so whatever track
    // the preview pointed at is always the one the drop actually uses.
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
    const isMediaDrag = e.dataTransfer.types.includes(CHROMA_MEDIA_DRAG_MIME);
    if (!isMediaDrag) return;
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
    if (y < 0) {
      setInsertPreview((prev) => (prev === null ? prev : null));
      return;
    }
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
  // D-098 — no longer handles a `CHROMA_CLIP_MOVE_MIME` payload: cross-track
  // clip move is `onDndDragEnd` (a real `@dnd-kit/core` drag) now. This
  // handler is Sources-panel media drops only.
  const onDrop = (e: DragEvent) => {
    setDragOver(false);
    setInsertPreview(null);
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
    const linkedAudio = audio ?? undefined;

    const rect = editAreaRef.current?.getBoundingClientRect();
    const y = rect ? e.clientY - rect.top - RULER_AND_MARGIN_PX + scrollTop : -1;
    const boundary = rect && tracks.length > 0 ? trackInsertBoundary(y, tracks.length) : null;
    if (boundary !== null) {
      // D-096/D-097 — dropped at a real track-insertion boundary: past the
      // last row, above the first, or between two existing ones. `add_track`
      // always appends at the end (`chroma_timeline::Timeline::add_track`),
      // computed from this render's own `tracks.length` since every op
      // below runs synchronously in this one handler, before either the
      // store or this component re-renders — so a brand-new track is
      // reliably at that index the instant it's created.
      const newTrackIdx = tracks.length;
      const kind = inferNewTrackKind(boundary);
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
      return;
    }

    const track = dropTargetTrack(e);
    const trackData = tracks[track];
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
            background: track?.kind === 'audio' ? 'rgba(120,170,110,0.55)' : 'rgba(90,120,180,0.55)',
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
          {clip && !clip.text && track?.kind === 'video' && (
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
    if (i < 0) return;
    const c = clipsOf(ti)[i];
    if (dir === 'left') {
      const delta = s2f(start) - c.start_frame;
      if (delta !== 0) applyOp({ kind: 'trim_start', track: ti, clip: i, delta });
    } else {
      const delta = s2f(end) - endFrame(c, fps);
      if (delta !== 0) applyOp({ kind: 'trim_end', track: ti, clip: i, delta });
    }
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

  /** D-211 — add a text/title clip at the playhead, on the TOPMOST video
   *  track, and select it so the Inspector's own Title section opens on it
   *  ready to type into.
   *
   *  **Track 0, deliberately.** Track index order is compositing z-order in
   *  this model (D-086, lower index = on top), so the topmost video track is
   *  where a title composites over the picture — the same "drag it into the
   *  timeline ABOVE your video tracks" placement Resolve's own titles feature
   *  describes (`scratch/resolve-reference/`, "Incredible 2D and 3D Titles").
   *  If there is no video track at all, `add_clip` creates one; `videoTrackIndex`
   *  is what finds the topmost existing one.
   *
   *  Placed at the playhead with `ripple: false`, so it lands in whatever
   *  space is there and simply doesn't place if that space is occupied —
   *  never silently pushing the edit around, which is `add_clip`'s own
   *  documented non-ripple contract. Adding a second title over the first is
   *  then "move the playhead, or add a track," the same as for any clip.
   *
   *  Goes through the exact `newTextLayer` + `newTextClipFields` + `add_clip`
   *  path `editor_add_text_clip` (MCP) uses — one implementation under both
   *  interfaces, per CLAUDE.md's own "same op/store action underneath both". */
  const doAddTitle = () => {
    const tl = useEditorTimelineStore.getState().timeline;
    if (!tl) return;
    const layer = newTextLayer({ content: 'Title' });
    // `newTextLayer` only fails on a caller-supplied value; this call site
    // passes a literal, so the guard is a type narrow, not a real branch.
    if ('error' in layer) return;
    const track = Math.max(videoTrackIndex(tl), 0);
    const clip = newTextClipFields(layer, Math.round(DEFAULT_TITLE_SECONDS * fps));
    applyOp({ kind: 'add_clip', track, clip, startFrame: playhead });
    const after = useEditorTimelineStore.getState().timeline;
    if (after?.tracks[track]?.clips.some((c) => c.id === clip.id)) {
      setSelection([{ track, id: clip.id }]);
    }
  };

  /** D-222 — drop a marker at the playhead. Not clip-scoped and never
   *  refused: a marker annotates a POSITION in the edit, so there is nothing
   *  to select first and no track lock to respect (see `Timeline.markers`).
   *  `newMarker` owns id generation and the default colour, so this button and
   *  `editor_add_marker` build an identical marker. */
  const doAddMarker = () => {
    const marker = newMarker(playhead);
    // `newMarker` only rejects a caller-supplied colour or a non-finite frame;
    // this call site passes neither, so the guard is a type narrow, not a real
    // branch (same shape as `doAddTitle`'s own `newTextLayer` guard above).
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
    const { startFrame, ripple } = resolveClipLanding(tracks[toTrack], clip.id, clip, clip.start_frame, snapFrames, fps);
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
  // up/down buttons. `move_track(from, to)` mirrors `chroma_timeline::
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
    const data = event.active.data.current as
      | { type: 'track'; index: number }
      | { type: 'clip'; track: number; clipId: string }
      | undefined;
    if (!data) return;
    setActiveDrag(data);
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
  const dndBoundary = (event: DragMoveEvent | DragEndEvent): number | null => {
    const rect = editAreaRef.current?.getBoundingClientRect();
    const translated = event.active.rect.current.translated;
    if (!rect || !translated || tracks.length === 0) return null;
    const y = translated.top - rect.top - RULER_AND_MARGIN_PX + scrollTop;
    return trackInsertBoundary(y, tracks.length);
  };

  /** D-201 — no `useCallback` (see the note above `getActionRender`): its old
   *  array listed `idxOf`/`clipsOf`, plain arrows re-created on every render,
   *  so it never memoized anything — while still bailing the compiler out of
   *  the whole component. */
  const onDndDragMove =
    (event: DragMoveEvent) => {
      const data = event.active.data.current as
        | { type: 'track'; index: number }
        | { type: 'clip'; track: number; clipId: string }
        | undefined;
      const overData = event.over?.data.current as { type: 'track'; track: number } | undefined;
      if (!data || data.type !== 'clip') {
        setClipDragPreview((prev) => (prev === null ? prev : null));
        setInsertPreview((prev) => (prev === null ? prev : null));
        return;
      }
      if (!overData || overData.type !== 'track') {
        // Not over an existing track's droppable — check whether this is a
        // real track-insertion boundary (same helper the Sources-panel add
        // path uses) and show the identical ghost-row preview if so.
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
      const toTrack = overData.track;
      const deltaFrames = Math.round((event.delta.x / pxPerSec) * fps);
      const intendedFrame = clip.start_frame + deltaFrames;
      const snapFrames = Math.round((INSERT_SNAP_PX / pxPerSec) * fps);
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
      const data = event.active.data.current as
        | { type: 'track'; index: number }
        | { type: 'clip'; track: number; clipId: string }
        | undefined;
      setActiveDrag(null);
      setClipDragPreview((prev) => (prev === null ? prev : null));
      if (!data) return;

      if (data.type === 'track') {
        // `over` is another `SortableTrackHeader` (every sortable item is
        // also a droppable, dnd-kit's own doc) — its `data.current.index`
        // is the CURRENT render's track index, exactly what `doMoveTrack`
        // (unchanged from D-094/D-097) already expects as `to`.
        const overData = event.over?.data.current as { type: 'track'; index: number } | undefined;
        if (!overData || overData.type !== 'track') return;
        doMoveTrack(data.index, overData.index);
        return;
      }

      // clip — D-100: the ONLY move mechanism now, same-track or
      // cross-track alike (see `buildRows`'s `movable: false` doc and
      // `ClipBody`'s own doc for why the library's native move-drag is
      // gone). `over`'s track vs. this clip's own starting track is what
      // decides which case this is — no separate code path per gesture,
      // just a different `startFrame` computation.
      const { track: fromTrack, clipId } = data;
      const i = idxOf(fromTrack, clipId);
      if (i < 0) return;
      const overData = event.over?.data.current as { type: 'track'; track: number } | undefined;
      if (!overData || overData.type !== 'track') {
        setInsertPreview((prev) => (prev === null ? prev : null));
        // D-117 — not over an existing track's droppable: check whether
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
      const toTrack = overData.track;
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
  const zoomIn = () => setPxPerSec((w) => clampPxPerSec(w * ZOOM_STEP));
  const zoomOut = () => setPxPerSec((w) => clampPxPerSec(w / ZOOM_STEP));

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
    activeDrag?.type === 'track'
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
        onKeyDown={(e) => {
          // D-222 — `M` drops a marker at the playhead, the shortcut DaVinci
          // Resolve, Premiere and Final Cut all bind to exactly this action.
          // Guarded on the modifiers being clear so it can never shadow a
          // system/browser chord (⌘M minimises on macOS), and on the press not
          // coming from a text field — this pane's toolbar and its popovers
          // contain real `<input>`s, and typing "m" in one must type an "m".
          if ((e.key === 'm' || e.key === 'M') && !e.metaKey && !e.ctrlKey && !e.altKey) {
            const el = e.target as HTMLElement | null;
            const tag = el?.tagName;
            if (tag !== 'INPUT' && tag !== 'TEXTAREA' && el?.isContentEditable !== true) {
              e.preventDefault();
              doAddMarker();
              return;
            }
          }
          if (e.key === 'Delete' || e.key === 'Backspace') {
            // D-105 — a selected gap takes the same Delete/Backspace as a
            // selected clip; the two are mutually exclusive (see
            // `selectedGap`'s own doc), so at most one branch ever fires.
            if (selection.length > 0) {
              e.preventDefault();
              doRemove();
            } else if (selectedGap) {
              e.preventDefault();
              doRemoveGap();
            }
          }
        }}
      >
      <TooltipProvider>
        <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-border-color bg-surface text-text-primary">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={doSplit}
                  disabled={selection.length === 0}
                  aria-label="Split at playhead"
                >
                  <Scissors />
                  Split
                </Button>
              }
            />
            <TooltipContent>Split every selected clip at the playhead</TooltipContent>
          </Tooltip>
          {/* D-211 — the Edit tab's only affordance for creating a title.
              In this toolbar rather than the Sources panel because a title
              has no media-pool item behind it: it is generated, not
              imported, so "add one to the timeline" is the whole gesture.
              Not selection-dependent (like Export's own button below, and
              unlike Split/Remove) — you add a title, you don't add one TO
              something. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="sm" onClick={doAddTitle} aria-label="Add title">
                  <Type />
                  Title
                </Button>
              }
            />
            <TooltipContent>
              Add a text title at the playhead, on the topmost video track — edit its text, font, size
              and colour in the Inspector
            </TooltipContent>
          </Tooltip>
          {/* D-222 — markers. The add action sits with Title above (both are
              "put something new at the playhead", neither is selection-scoped);
              the jump list appears beside it only once there is something to
              jump to. */}
          <AddMarkerButton onAdd={doAddMarker} shortcut="M" />
          <MarkerListMenu timeline={timeline} fps={fps} onJump={setPlayhead} />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={doRemove}
                  disabled={selection.length === 0}
                  aria-label="Remove clip"
                >
                  <Trash2 />
                  Remove
                </Button>
              }
            />
            <TooltipContent>Remove every selected clip (with its linked audio)</TooltipContent>
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
                  <Button variant="ghost" size="sm" onClick={doUnlink} aria-label="Unlink audio and video">
                    <Unlink />
                    Unlink
                  </Button>
                }
              />
              <TooltipContent>
                Break the A/V link so the picture and its audio can be trimmed and moved apart (an L-cut)
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
                    size="sm"
                    onClick={doLink}
                    disabled={!linkCheck.result.ok}
                    aria-label="Link audio and video"
                  >
                    <Link />
                    Link
                  </Button>
                }
              />
              <TooltipContent>
                {linkCheck.result.ok
                  ? 'Link these two clips so they move, trim, split and delete together'
                  : linkCheck.result.reason}
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
                  <Button variant="ghost" size="sm" onClick={doRemoveGap} aria-label="Close gap">
                    <FoldHorizontal />
                    Close Gap
                  </Button>
                }
              />
              <TooltipContent>Close the selected gap — everything after it shifts left</TooltipContent>
            </Tooltip>
          )}

          {/* D-080: cross-track move — see the module doc for why this is a
              dropdown and not a drag gesture. */}
          {primary && otherTracks.length > 0 && (
            <DropdownMenu>
              <DropdownMenuTrigger
                render={
                  <Button variant="ghost" size="sm" aria-label="Move to another track">
                    <ArrowRightLeft />
                    Move to
                  </Button>
                }
              />
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
            {/* D-198 — the Edit tab's own Export button + dialog + queue,
                the same "no Export affordance at all" gap the owner pointed
                at a real screenshot to flag. Lives here, at the far right of
                THIS toolbar (not clip-selection-dependent like Split/Remove
                to its left), next to the zoom controls — the other
                always-available, not-selection-scoped action on this
                strip. */}
            <EditorExportDialog />
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
          <div
            ref={editAreaRef}
            data-bench-id="timeline-edit-area"
            className="relative h-full overflow-hidden"
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
              onCursorDrag={(time) => setPlayhead(s2f(time))}
              onChange={() => false}
              onActionResizeEnd={onActionResizeEndCb}
            />
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
                dragOverlayTrack?.kind === 'audio' ? 'rgba(120,170,110,0.55)' : 'rgba(90,120,180,0.55)',
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
