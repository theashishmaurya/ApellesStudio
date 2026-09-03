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
 *   - **Ripple visual feedback is custom**: a small effect diffs each
 *     clip id's timeline start frame across every track's clips changes and
 *     briefly `animate-pulse`s whichever ids shifted — a trim/remove/move
 *     that shifts a clip is visibly, not just numerically, felt. (D-058: a
 *     trim/remove no longer *ripples* downstream clips by construction —
 *     see the position-model note above — so this now mostly fires for a
 *     `move`; kept as-is since a future ripple-mode trim would want it too.)
 *
 * D-058 (ruler): tick labels are real timecode (`ruler.ts`'s
 * `formatTimecode`, `HH:MM:SS` or `HH:MM:SS:FF` depending on the current
 * tick density) via `getScaleRender`, and the labeled-tick interval
 * (`scale`, seconds) is recomputed from `pxPerSec` on every zoom change via
 * `niceTickIntervalSeconds` — the library's own `scale` prop is a single
 * fixed value with no adaptive-density concept of its own (checked in its
 * bundled source before writing this).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type DragEvent, type ReactNode } from 'react';
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
  type DragStartEvent,
} from '@dnd-kit/core';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS as DndCSS } from '@dnd-kit/utilities';
import {
  AudioLines,
  ArrowRightLeft,
  Diamond,
  Eye,
  EyeOff,
  Film,
  GripVertical,
  Lock,
  Scissors,
  SlidersHorizontal,
  Trash2,
  Unlock,
  Volume2,
  VolumeX,
  X,
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
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@chroma/ui';

import { useEditorTimelineStore } from './timelineStore';
import { Waveform } from './Waveform';
import { niceTickIntervalSeconds, formatTimecode } from './ruler';
import {
  CHROMA_MEDIA_DRAG_MIME,
  DEFAULT_TRACK_GAIN,
  clipFromDraggedMedia,
  computeInsertion,
  endFrame,
  timelineFps,
  videoTrackIndex,
  type Clip,
  type DraggedMedia,
  type Timeline,
  type Track,
} from './timeline';
import {
  clearClipKeyframes,
  clipSourceFrame,
  removeClipKeyframe,
  upsertClipKeyframe,
} from './clipKeyframes';

const EFFECT_ID = 'clip';
/** how many pixels a labeled ruler tick should target, at any zoom (D-058
 *  item 4 — `niceTickIntervalSeconds`'s target, see `ruler.ts`). */
const TICK_TARGET_PX = 70;
/** zoom is now tracked as px-per-second directly (renamed from the old
 *  `scaleWidth`, which only meant "px per second" because `scale` used to be
 *  hardcoded to 1 — see the D-058 ruler doc below); same bounds as before. */
const DEFAULT_PX_PER_SEC = 90;
const MIN_PX_PER_SEC = 16;
const MAX_PX_PER_SEC = 480;
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
/** `.timeline-editor-time-area` (32px, the ruler bar) + `.timeline-editor-
 *  edit-area`'s `margin-top` (10px) — read from the library's own bundled
 *  CSS (`react-timeline-editor.css`), not guessed, since `dropTargetTrack`
 *  (D-080) needs to know exactly where row 0 actually starts on screen to
 *  convert a drop's `clientY` into a track index. */
const RULER_AND_MARGIN_PX = 42;
/** The library's own `startLeft` prop (px before frame 0) — kept as a named
 *  constant (D-095) since `xToFrame` below needs the exact same value the
 *  `<TimelineEditor startLeft={...}>` prop uses to convert a drop's
 *  `clientX` into a timeline frame; mirrors the library's own `Pt()`
 *  left-px→seconds helper (`(left - startLeft) / scaleWidth * scale`, which
 *  reduces to `/ pxPerSec` since `scaleWidth = tickSeconds * pxPerSec` —
 *  checked against its bundled source, not guessed). */
const START_LEFT_PX = 20;
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
const INSERT_SNAP_PX = 16;
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
      end: endFrame(clip) / fps,
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

interface Selection {
  track: number;
  id: string;
}

/** D-098 — real `@dnd-kit/sortable` drag id for track `index`, and the
 *  `data` payload every drag source/target below reads back in `onDragEnd`
 *  to tell a track-reorder apart from a clip cross-track move (two
 *  independent drag "kinds" sharing one `DndContext`, disambiguated by
 *  `event.active.data.current.type`, not by id shape). */
function trackDragId(index: number): string {
  return `track:${index}`;
}

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
  label,
  onToggleLock,
  onToggleHidden,
  onToggleMute,
  onRemove,
}: {
  index: number;
  height: number;
  isVideo: boolean;
  muted: boolean;
  locked: boolean;
  hidden: boolean;
  label: string;
  onToggleLock: () => void;
  onToggleHidden: () => void;
  onToggleMute: () => void;
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
 *  the one trigger that happened to be found. The `isOver`-driven
 *  highlight still only shows during a real clip drag (`active` still
 *  gates the CSS, just not interactivity) — visual-only, harmless if
 *  ever stuck now instead of a functional blocker. */
function TrackDropZone({ track, top, height, active }: { track: number; top: number; height: number; active: boolean }) {
  const { setNodeRef, isOver } = useDroppable({
    id: `track-drop:${track}`,
    data: { type: 'track' as const, track },
  });
  return (
    <div
      ref={setNodeRef}
      className={
        'pointer-events-none absolute left-0 right-0 z-20 ' +
        (active && isOver ? 'bg-accent/10 outline outline-accent/60 -outline-offset-1' : '')
      }
      style={{ top, height }}
    />
  );
}

export function TimelinePane() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [rippled, setRippled] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);
  // D-095 — horizontal scroll, needed alongside `scrollTop` to convert a
  // drop's `clientX` into a timeline frame (`xToFrame` below); the library
  // reports both through the same `onScroll` callback (`OnScrollParams`,
  // `react-virtualized`), `scrollTop` just never needed `scrollLeft` before
  // this pass since nothing read a horizontal drop position.
  const [scrollLeft, setScrollLeft] = useState(0);

  const editorRef = useRef<TimelineState>(null);
  const editAreaRef = useRef<HTMLDivElement>(null);
  const fps = timelineFps(timeline);
  const tracks = timeline?.tracks ?? [];
  const labels = useMemo(() => (timeline ? trackLabels(timeline) : []), [timeline]);

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
      if (before !== undefined && before !== start) shifted.add(id);
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
   *  be. `DraggedMedia`/`MediaItem` (`timeline.ts` / `@chroma/bridge`)
   *  carry NO real audio-vs-video signal today — checked, not assumed
   *  (`MediaItem`'s only probed-info field is `video?: MediaVideoInfo`,
   *  there's no `MediaAudioInfo`/`mediaType`; `clipFromDraggedMedia` itself
   *  can't build a clip at all without a `frameCount`, i.e. today's
   *  Sources-panel drag flow doesn't support audio-only media landing on
   *  the timeline in the first place) — so this can't derive the new
   *  track's kind from the dragged item itself without a real backend model
   *  change (out of scope here). The next-best real signal is drop
   *  *context*: continue whatever kind cluster the insertion point is
   *  adjacent to — the track directly above the boundary (or, at the very
   *  top, the track directly below it) — rather than a hardcoded literal
   *  (the actual pre-D-097 bug: every auto-created track was unconditionally
   *  `'video'`, regardless of where the drop landed). */
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
      edges.add(endFrame(c));
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
    const covering = track.clips.find((c) => frame >= c.start_frame && frame < endFrame(c));
    if (covering) {
      const mid = covering.start_frame + covering.duration / 2;
      return frame < mid ? covering.start_frame : endFrame(covering);
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
    if (y < 0) return timeline ? videoTrackIndex(timeline) : 0;
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
    const clip = clipFromDraggedMedia(media);
    if (!clip) return; // unprobed / offline media has no known length — nothing to place

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
        if (selected) {
          const followed = trackIndexAfterMove(selected.track, newTrackIdx, boundary);
          if (followed !== selected.track) setSelected({ track: followed, id: selected.id });
        }
      }
      applyOp({ kind: 'add_clip', track: boundary, clip });
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
        ? computeInsertion(trackData, xToFrame(e, rect), clip.duration, Math.round((INSERT_SNAP_PX / pxPerSec) * fps))
        : null;
    if (insertion) {
      applyOp({ kind: 'add_clip', track, clip, startFrame: insertion.startFrame, ripple: insertion.ripple });
    } else {
      applyOp({ kind: 'add_clip', track, clip });
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
  // tracks' worth on every tick is what actually froze the UI. `useCallback`
  // with real dependency arrays keeps these stable across renders that don't
  // actually change anything these functions read.
  const getActionRender = useCallback(
    (action: TimelineAction, row: TimelineRow) => {
      const ti = Number(row.id);
      const track = tracks[ti];
      const i = idxOf(ti, action.id);
      const clip = i >= 0 ? clipsOf(ti)[i] : null;
      const isSel = selected?.track === ti && selected.id === action.id;
      const isRippled = rippled.has(action.id);
      const pxWidth = (action.end - action.start) * pxPerSec;
      return (
        <ClipBody
          track={ti}
          clipId={action.id}
          className={
            'relative h-full w-full overflow-hidden rounded ' +
            (isSel ? 'ring-2 ring-accent ' : '') +
            (isRippled ? 'ring-2 ring-accent animate-pulse ' : '')
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
          {clip && track?.kind === 'video' && (
            <Waveform
              sourcePath={clip.source_path}
              startSecs={clip.source_start / fps}
              durationSecs={clip.duration / fps}
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
          <div className="relative z-10 flex h-full items-center px-2 text-[11px] font-medium truncate pointer-events-none text-button-text">
            {clip?.name ?? action.id}
          </div>
        </ClipBody>
      );
    },
    [tracks, selected, rippled, pxPerSec, fps],
  );

  const onClickAction = useCallback(
    (_e: unknown, { action, row }: { action: TimelineAction; row: TimelineRow }) =>
      setSelected({ track: Number(row.id), id: action.id }),
    [],
  );

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
  const onActionResizeEndCb = useCallback(
    ({
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
        const delta = s2f(end) - endFrame(c);
        if (delta !== 0) applyOp({ kind: 'trim_end', track: ti, clip: i, delta });
      }
    },
    [tracks, fps, applyOp],
  );

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

  // D-080: split now requires a selection — with N tracks, "at the
  // playhead" alone no longer says which track's clip. Standard-NLE
  // reading: split whatever's currently selected, if the playhead actually
  // falls inside it (the existing `atFrame` bounds check inside `applyOp`
  // already no-ops otherwise).
  const doSplit = () => {
    if (!selected) return;
    const i = idxOf(selected.track, selected.id);
    if (i < 0) return;
    applyOp({ kind: 'split', track: selected.track, clip: i, atFrame: playhead });
  };

  const doRemove = () => {
    if (!selected) return;
    const i = idxOf(selected.track, selected.id);
    if (i >= 0) applyOp({ kind: 'remove', track: selected.track, clip: i });
    setSelected(null);
  };

  // D-080: "Move to another track" — the library has no cross-row drag (see
  // the module doc), so this is the real, working affordance for it: pick a
  // destination track from the toolbar dropdown, the clip keeps its own
  // `start_frame` (only the track changes) unless that would overlap
  // something already there, in which case `applyOp` no-ops it (same
  // "just don't do it" contract every other op here already has).
  const doMoveToTrack = (toTrack: number) => {
    if (!selected) return;
    const i = idxOf(selected.track, selected.id);
    if (i < 0) return;
    const clip = clipsOf(selected.track)[i];
    applyOp({ kind: 'move', fromTrack: selected.track, toTrack, clip: i, startFrame: clip.start_frame });
    setSelected({ track: toTrack, id: selected.id });
  };

  // D-096 — no more explicit "add track" buttons (removed per owner
  // feedback, D-080's toolbar affordance): a track is now created implicitly
  // by dropping a Sources-panel clip past the last real row — see `onDrop`'s
  // "new_track" branch, which calls `applyOp({ kind: 'add_track', ... })`
  // directly rather than through a named wrapper like this one used to be.

  const doRemoveTrack = (track: number) => {
    applyOp({ kind: 'remove_track', track });
    if (selected?.track === track) setSelected(null);
  };

  const toggleMute = (track: number) => {
    const t = tracks[track];
    if (!t) return;
    const muted = (t.gain ?? DEFAULT_TRACK_GAIN) <= 0;
    applyOp({ kind: 'set_track_gain', track, gain: muted ? DEFAULT_TRACK_GAIN : 0 });
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
  const trackIndexAfterMove = (idx: number, from: number, to: number): number => {
    if (idx === from) return to;
    if (from < to) return idx > from && idx <= to ? idx - 1 : idx;
    return idx >= to && idx < from ? idx + 1 : idx;
  };

  const doMoveTrack = (from: number, to: number) => {
    if (from < 0 || from >= tracks.length || to < 0 || to >= tracks.length || from === to) return;
    applyOp({ kind: 'move_track', from, to });
    if (selected) {
      const newTrack = trackIndexAfterMove(selected.track, from, to);
      if (newTrack !== selected.track) setSelected({ track: newTrack, id: selected.id });
    }
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

  const onDndDragCancel = useCallback(() => setActiveDrag(null), []);

  const onDndDragEnd = useCallback(
    (event: DragEndEvent) => {
      const data = event.active.data.current as
        | { type: 'track'; index: number }
        | { type: 'clip'; track: number; clipId: string }
        | undefined;
      setActiveDrag(null);
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
      if (!overData || overData.type !== 'track') return; // dropped outside any track — cancel, nothing to do
      const toTrack = overData.track;
      const clip = clipsOf(fromTrack)[i];
      if (toTrack === fromTrack) {
        // Same track: a real reposition (D-096/B-027's own fix, now the
        // ONLY path for this, not a fallback) — `event.delta.x` is the net
        // pointer movement for the whole drag, in screen px, converted to
        // frames the same way `xToFrame` does, just relative rather than
        // absolute (no `rect`/`clientX` needed).
        const deltaFrames = Math.round((event.delta.x / pxPerSec) * fps);
        const startFrame = Math.max(0, clip.start_frame + deltaFrames);
        applyOp({ kind: 'move', fromTrack, toTrack, clip: i, startFrame });
      } else {
        // Cross-track: keeps its own `start_frame` (D-094's original
        // behaviour), overlap allowed (D-096).
        applyOp({ kind: 'move', fromTrack, toTrack, clip: i, startFrame: clip.start_frame });
      }
      // A drag also selects the clip it moved — same-track or cross-track —
      // matching normal NLE expectations (dragging a clip is also picking
      // it), not just the old cross-track-only behaviour.
      setSelected({ track: toTrack, id: clipId });
    },
    [applyOp, clipsOf, idxOf, doMoveTrack, pxPerSec, fps],
  );

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

  const otherTracks = selected ? tracks.map((_, i) => i).filter((i) => i !== selected.track) : [];

  // D-090 — clip-transform popover + keyframing, wired to `set_clip_
  // transform`/`set_clip_keyframes` (D-089). `selectedClip` is `null` for a
  // stale selection (removed clip/track) — the trigger button below is
  // disabled in that case, same guard every other selection-gated toolbar
  // action here already uses.
  const selectedIdx = selected ? idxOf(selected.track, selected.id) : -1;
  const selectedClip: Clip | null = selected && selectedIdx >= 0 ? clipsOf(selected.track)[selectedIdx] : null;
  const selectedTrackLocked = selected ? !!tracks[selected.track]?.locked : false;
  // Keyframes are interpolated against the clip's own SOURCE frame, not the
  // absolute timeline position — see `clipKeyframes.ts`'s doc.
  const clipKfSourceFrame = selectedClip ? clipSourceFrame(selectedClip, playhead) : 0;
  const clipKeyframes = selectedClip?.chroma_keyframes ?? [];
  const keyedHere = clipKeyframes.some((k) => k.frame === Math.round(clipKfSourceFrame));

  const applyTransform = (
    patch: Partial<{ opacity: number; position_x: number; position_y: number; scale: number; rotation: number }>,
  ) => {
    if (!selected || !selectedClip || selectedIdx < 0) return;
    applyOp({
      kind: 'set_clip_transform',
      track: selected.track,
      clip: selectedIdx,
      opacity: patch.opacity ?? selectedClip.opacity ?? 1,
      position_x: patch.position_x ?? selectedClip.position_x ?? 0,
      position_y: patch.position_y ?? selectedClip.position_y ?? 0,
      scale: patch.scale ?? selectedClip.scale ?? 1,
      rotation: patch.rotation ?? selectedClip.rotation ?? 0,
    });
  };

  const doUpsertKeyframe = () => {
    if (!selected || !selectedClip || selectedIdx < 0) return;
    applyOp({
      kind: 'set_clip_keyframes',
      track: selected.track,
      clip: selectedIdx,
      keyframes: upsertClipKeyframe(clipKeyframes, clipKfSourceFrame, {
        opacity: selectedClip.opacity ?? 1,
        position_x: selectedClip.position_x ?? 0,
        position_y: selectedClip.position_y ?? 0,
        scale: selectedClip.scale ?? 1,
        rotation: selectedClip.rotation ?? 0,
      }),
    });
  };

  const doRemoveKeyframeHere = () => {
    if (!selected || selectedIdx < 0) return;
    applyOp({
      kind: 'set_clip_keyframes',
      track: selected.track,
      clip: selectedIdx,
      keyframes: removeClipKeyframe(clipKeyframes, clipKfSourceFrame) ?? [],
    });
  };

  const doClearKeyframes = () => {
    if (!selected || selectedIdx < 0) return;
    applyOp({
      kind: 'set_clip_keyframes',
      track: selected.track,
      clip: selectedIdx,
      keyframes: clearClipKeyframes() ?? [],
    });
  };

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

  return (
    <DndContext sensors={dndSensors} onDragStart={onDndDragStart} onDragEnd={onDndDragEnd} onDragCancel={onDndDragCancel}>
      <div
        className={
          'flex flex-col min-h-0 h-full bg-bg-primary outline-none ' +
          (dragOver ? 'ring-2 ring-inset ring-accent' : '')
        }
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
            e.preventDefault();
            doRemove();
          }
        }}
      >
      <TooltipProvider>
        <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-border-color bg-surface text-text-primary">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="sm" onClick={doSplit} disabled={!selected} aria-label="Split at playhead">
                  <Scissors />
                  Split
                </Button>
              }
            />
            <TooltipContent>Split the selected clip at the playhead</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="sm" onClick={doRemove} disabled={!selected} aria-label="Remove clip">
                  <Trash2 />
                  Remove
                </Button>
              }
            />
            <TooltipContent>Remove the selected clip</TooltipContent>
          </Tooltip>

          {/* D-080: cross-track move — see the module doc for why this is a
              dropdown and not a drag gesture. */}
          {selected && otherTracks.length > 0 && (
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

          {/* D-090 — clip transform + keyframes: opacity/position/scale/
              rotation, the interim popover this file's own D-086 doc comment
              flagged as coming next. Disabled when the selected clip's track
              is locked (the underlying ops already no-op for this — see
              `applyOp`'s `TrackLocked` mirror — disabling the trigger too so
              it doesn't look like a live control that silently does nothing). */}
          {selectedClip && (
            <Popover>
              <PopoverTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={selectedTrackLocked}
                    aria-label="Clip transform"
                  >
                    <SlidersHorizontal />
                    Transform
                  </Button>
                }
              />
              <PopoverContent align="start" className="w-64">
                <div className="flex flex-col gap-2.5 text-xs">
                  <div className="text-text-primary font-medium">Clip transform</div>
                  <label className="flex items-center justify-between gap-2">
                    <span className="text-text-secondary">Opacity</span>
                    <Input
                      type="number"
                      step={0.05}
                      min={0}
                      max={1}
                      className="h-7 w-20 text-right"
                      value={selectedClip.opacity ?? 1}
                      onChange={(e) => applyTransform({ opacity: Number(e.target.value) })}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2">
                    <span className="text-text-secondary">Position X</span>
                    <Input
                      type="number"
                      step={1}
                      className="h-7 w-20 text-right"
                      value={selectedClip.position_x ?? 0}
                      onChange={(e) => applyTransform({ position_x: Number(e.target.value) })}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2">
                    <span className="text-text-secondary">Position Y</span>
                    <Input
                      type="number"
                      step={1}
                      className="h-7 w-20 text-right"
                      value={selectedClip.position_y ?? 0}
                      onChange={(e) => applyTransform({ position_y: Number(e.target.value) })}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2">
                    <span className="text-text-secondary">Scale</span>
                    <Input
                      type="number"
                      step={0.05}
                      min={0}
                      className="h-7 w-20 text-right"
                      value={selectedClip.scale ?? 1}
                      onChange={(e) => applyTransform({ scale: Number(e.target.value) })}
                    />
                  </label>
                  <label className="flex items-center justify-between gap-2">
                    <span className="text-text-secondary">Rotation</span>
                    <Input
                      type="number"
                      step={1}
                      className="h-7 w-20 text-right"
                      value={selectedClip.rotation ?? 0}
                      onChange={(e) => applyTransform({ rotation: Number(e.target.value) })}
                    />
                  </label>

                  {/* D-090 — keyframing, the exact interaction
                      `RelightPanel.tsx` uses for relight-light keyframes
                      (Diamond icon, `keyedHere` highlight, add/update/
                      delete-here/clear-all) — see `clipKeyframes.ts`'s doc
                      for why this is a small local mirror rather than a
                      cross-package import of `app/src/utils/maskKeyframes.ts`. */}
                  <div className="flex items-center gap-2 text-[11px] text-text-secondary select-none pt-1 border-t border-border-color mt-0.5">
                    <Button
                      variant="ghost"
                      size="xs"
                      className={`gap-1 px-1.5 ${keyedHere ? 'text-accent' : 'text-text-primary'}`}
                      onClick={doUpsertKeyframe}
                      title={keyedHere ? 'Update this clip keyframe' : 'Keyframe this clip at the current frame'}
                    >
                      <Diamond size={11} fill={keyedHere ? 'currentColor' : 'none'} />
                      {clipKeyframes.length === 0 ? 'Keyframe clip' : keyedHere ? 'Update key' : 'Add key'}
                    </Button>
                    {clipKeyframes.length > 0 && (
                      <>
                        <span className="tabular-nums">
                          {clipKeyframes.length} key{clipKeyframes.length === 1 ? '' : 's'}
                        </span>
                        {keyedHere && (
                          <Button
                            variant="ghost"
                            size="icon-xs"
                            onClick={doRemoveKeyframeHere}
                            title="Delete the keyframe at this frame"
                          >
                            <X size={12} />
                          </Button>
                        )}
                        <Button variant="ghost" size="xs" onClick={doClearKeyframes} title="Remove all keyframes">
                          Clear
                        </Button>
                      </>
                    )}
                  </div>
                </div>
              </PopoverContent>
            </Popover>
          )}

          <div className="ml-auto flex items-center gap-0.5">
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
                return (
                  <SortableTrackHeader
                    key={i}
                    index={i}
                    height={ROW_HEIGHT}
                    isVideo={isVideo}
                    muted={muted}
                    locked={locked}
                    hidden={hidden}
                    label={labels[i]}
                    onToggleLock={() => toggleLock(i)}
                    onToggleHidden={() => toggleHidden(i)}
                    onToggleMute={() => toggleMute(i)}
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
            onClick={(e) => {
              if (!(e.target as HTMLElement).closest('.timeline-editor-action')) setSelected(null);
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
            {/* D-098 — one real `useDroppable` target per track, always
                mounted (see `TrackDropZone`'s own doc for why — a real
                mid-drag droppable-registration timing bug found live), only
                pointer-interactive while a clip-type `@dnd-kit/core` drag is
                active. Positioned in the same `editAreaRef`-relative
                coordinate space every other overlay in this file already
                uses. */}
            {tracks.map((_, i) => (
              <TrackDropZone
                key={i}
                track={i}
                top={RULER_AND_MARGIN_PX + i * ROW_HEIGHT - scrollTop}
                height={ROW_HEIGHT}
                active={activeDrag?.type === 'clip'}
              />
            ))}
          </div>
        </ResizablePanel>
      </ResizablePanelGroup>
      </div>
      <DragOverlay dropAnimation={null}>
        {dragOverlayLabel && (
          <div className="pointer-events-none rounded-md bg-accent px-2 py-1 text-[11px] font-medium text-button-text shadow-lg">
            {dragOverlayLabel}
          </div>
        )}
      </DragOverlay>
    </DndContext>
  );
}
