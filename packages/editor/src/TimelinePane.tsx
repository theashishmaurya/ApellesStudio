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
 *   - **No native cross-row (cross-track) drag** — also checked before
 *     building: `onActionMoveEnd`'s `row` param is always the action's
 *     *starting* row, and there is no drop-target-row concept anywhere in
 *     the library's action-drag path (`onRowDragStart`/`onRowDragEnd` are
 *     for dragging a whole ROW to reorder rows, a different feature, see
 *     `enableRowDrag`). A clip-body drag (`onActionMoveEnd`) therefore stays
 *     same-track, same as before this pass — moving a clip to a *different*
 *     track is a real, working, but non-drag affordance instead: a "Move
 *     to ▾" dropdown on the toolbar, enabled when a clip is selected and
 *     more than one track exists. Flagged here as a known gap, not silently
 *     omitted: a live drag-between-tracks gesture would need a custom
 *     pointer-driven override of the library's own action drag handling,
 *     scoped out of this pass.
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

import { useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { TimelineRow, TimelineAction } from '@xzdarcy/timeline-engine';
import { Timeline as TimelineEditor, type TimelineState } from '@xzdarcy/react-timeline-editor';
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';
import './timeline-overrides.css';
import {
  AudioLines,
  ArrowRightLeft,
  ChevronDown,
  ChevronUp,
  Diamond,
  Eye,
  EyeOff,
  Film,
  Lock,
  Plus,
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
/** Track header sidebar width (D-080; widened D-090 for the lock/hide/
 *  rearrange row) — fixed, matches `ROW_HEIGHT` rows. */
const HEADER_WIDTH = 156;
/** `.timeline-editor-time-area` (32px, the ruler bar) + `.timeline-editor-
 *  edit-area`'s `margin-top` (10px) — read from the library's own bundled
 *  CSS (`react-timeline-editor.css`), not guessed, since `dropTargetTrack`
 *  (D-080) needs to know exactly where row 0 actually starts on screen to
 *  convert a drop's `clientY` into a track index. */
const RULER_AND_MARGIN_PX = 42;

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
      flexible: true,
      movable: true,
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

export function TimelinePane() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const [selected, setSelected] = useState<Selection | null>(null);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [rippled, setRippled] = useState<Set<string>>(new Set());
  const [scrollTop, setScrollTop] = useState(0);

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

  /** D-080: which track a Sources-panel drop lands on, from the drop
   *  event's `clientY` — see the module doc's "Dropping a Sources-panel
   *  clip" section for the exact layout constants this reads. Falls back to
   *  the first video track (this file's pre-D-080 default) if the pointer
   *  is above/below every row. */
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
  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(CHROMA_MEDIA_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver((prev) => (prev ? prev : true));
  };
  const onDragLeave = () => setDragOver((prev) => (prev ? false : prev));
  const onDrop = (e: DragEvent) => {
    setDragOver(false);
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
    applyOp({ kind: 'add_clip', track: dropTargetTrack(e), clip });
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
        <div
          className={
            'relative h-full w-full overflow-hidden rounded ' +
            (isSel ? 'ring-2 ring-accent ' : '') +
            (isRippled ? 'ring-2 ring-accent animate-pulse ' : '')
          }
          style={{
            background: isSel
              ? 'var(--color-accent)'
              : track?.kind === 'audio'
                ? 'rgba(120,170,110,0.55)'
                : 'rgba(90,120,180,0.55)',
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
              hit-testing problem in what we paint on top of it. */}
          <div
            className={
              'relative z-10 flex h-full items-center px-2 text-[11px] font-medium truncate pointer-events-none ' +
              (isSel ? 'text-text-primary' : 'text-button-text')
            }
          >
            {clip?.name ?? action.id}
          </div>
        </div>
      );
    },
    [tracks, selected, rippled, pxPerSec, fps],
  );

  const onClickAction = useCallback(
    (_e: unknown, { action, row }: { action: TimelineAction; row: TimelineRow }) =>
      setSelected({ track: Number(row.id), id: action.id }),
    [],
  );

  const onTimelineScroll = useCallback(({ scrollTop: st }: { scrollTop: number }) => setScrollTop(st), []);

  const onActionMoveEndCb = useCallback(
    ({ action, row, start }: { action: TimelineAction; row: TimelineRow; start: number }) => {
      // D-058/D-080: a clip-body drag repositions it within its own row
      // (`move`, overlap-rejected — mirrors `chroma-timeline::Timeline::
      // move_clip`'s same-track case) — the library has no cross-row action
      // drag (see the module doc), so `fromTrack` and `toTrack` are always
      // the same here; a real cross-track move goes through the "Move to ▾"
      // toolbar action instead.
      const ti = Number(row.id);
      const i = idxOf(ti, action.id);
      if (i < 0) return;
      const startFrame = Math.max(0, s2f(start));
      applyOp({ kind: 'move', fromTrack: ti, toTrack: ti, clip: i, startFrame });
    },
    [tracks, fps, applyOp],
  );

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

  const doAddTrack = (kind: 'video' | 'audio') => applyOp({ kind: 'add_track', trackKind: kind });

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

  // Up/down over native `enableRowDrag` — checked the library's bundled
  // types first: row-drag reorders `editorData` itself but hands back only
  // the reordered id list with no clean "this row moved from index A to B"
  // delta, and nothing here owns `editorData`'s order independently of
  // `timeline.tracks` (`buildRows` derives it fresh every render) — mapping
  // a full reordered-id-list callback back into a single `move_track(from,
  // to)` call reliably would need real time to get right without risking a
  // silent desync between what the library shows and what's on disk. A
  // single-step swap via a button needs none of that: `from`/`to` are
  // already known integers. `move_track(from, to)` with adjacent indices is
  // exactly a swap, so the selection-follow logic below only needs to swap.
  const doMoveTrack = (from: number, to: number) => {
    if (to < 0 || to >= tracks.length) return;
    applyOp({ kind: 'move_track', from, to });
    if (selected?.track === from) setSelected({ track: to, id: selected.id });
    else if (selected?.track === to) setSelected({ track: from, id: selected.id });
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

  return (
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

          <div className="mx-1 h-4 w-px bg-border-color" />

          {/* D-080: add tracks. */}
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="sm" onClick={() => doAddTrack('video')} aria-label="Add video track">
                  <Plus />
                  <Film />
                </Button>
              }
            />
            <TooltipContent>Add a video track</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="sm" onClick={() => doAddTrack('audio')} aria-label="Add audio track">
                  <Plus />
                  <AudioLines />
                </Button>
              }
            />
            <TooltipContent>Add an audio track</TooltipContent>
          </Tooltip>

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

      <div className="relative flex-1 min-h-0 flex" onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
        {/* Track header sidebar (D-080) — not a library feature, see the
            module doc. `translateY` keeps it in step with the library's own
            vertical scroll (tracked via `onScroll` below), offset by the
            same ruler+margin the edit area itself is offset by so a
            header's block lines up with its row, not the ruler. */}
        <div
          className="shrink-0 border-r border-border-color bg-surface overflow-hidden relative"
          style={{ width: HEADER_WIDTH }}
        >
          <div
            className="absolute left-0 right-0"
            style={{ top: RULER_AND_MARGIN_PX - scrollTop }}
          >
            {tracks.map((track, i) => {
              const isVideo = track.kind === 'video';
              const muted = !isVideo && (track.gain ?? DEFAULT_TRACK_GAIN) <= 0;
              const locked = !!track.locked;
              const hidden = isVideo && !!track.hidden;
              return (
                <div
                  key={i}
                  className={
                    'flex flex-col justify-center gap-0.5 px-1.5 border-b border-border-color/60 text-text-secondary ' +
                    (locked ? 'opacity-60' : '')
                  }
                  style={{ height: ROW_HEIGHT }}
                >
                  <div className="flex items-center gap-1">
                    {isVideo ? <Film className="size-3 shrink-0" /> : <AudioLines className="size-3 shrink-0" />}
                    <span className="text-[10px] font-medium truncate flex-1">{labels[i]}</span>
                    {/* D-090 — rearrange: track index order is compositing
                        z-order (`move_track`), not cosmetic. Up/down over
                        native row-drag — see the module doc for why. */}
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => doMoveTrack(i, i - 1)}
                      disabled={i === 0}
                      aria-label="Move track up"
                      title="Move track up (higher priority)"
                    >
                      <ChevronUp className="size-3" />
                    </Button>
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => doMoveTrack(i, i + 1)}
                      disabled={i === tracks.length - 1}
                      aria-label="Move track down"
                      title="Move track down (lower priority)"
                    >
                      <ChevronDown className="size-3" />
                    </Button>
                  </div>
                  <div className="flex items-center gap-1">
                    <Button
                      variant="ghost"
                      size="icon-xs"
                      onClick={() => toggleLock(i)}
                      aria-label={locked ? 'Unlock track' : 'Lock track'}
                      title={locked ? 'Unlock track' : 'Lock track'}
                    >
                      {locked ? <Lock className="size-3" /> : <Unlock className="size-3" />}
                    </Button>
                    {isVideo && (
                      <Button
                        variant="ghost"
                        size="icon-xs"
                        onClick={() => toggleHidden(i)}
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
                        onClick={() => toggleMute(i)}
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
                      onClick={() => doRemoveTrack(i)}
                      aria-label="Remove track"
                      title="Remove track"
                    >
                      <Trash2 className="size-3" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div ref={editAreaRef} className="relative flex-1 min-h-0 overflow-hidden">
          <TimelineEditor
            ref={editorRef}
            editorData={editorData}
            effects={effects}
            scale={tickSeconds}
            scaleWidth={libScaleWidth}
            getScaleRender={(sec) => formatTimecode(sec, fps, tickSeconds)}
            startLeft={20}
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
            onActionMoveEnd={onActionMoveEndCb}
            onActionResizeEnd={onActionResizeEndCb}
          />
        </div>
      </div>
    </div>
  );
}
