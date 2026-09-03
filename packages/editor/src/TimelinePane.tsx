/**
 * @chroma/editor — the timeline strip (D-041; drag-to-track D-046 pass 3;
 * mature-timeline-UI pass D-051; position-model + ruler fixes D-056).
 *
 * `@xzdarcy/react-timeline-editor` with one row (the video track). Each clip is
 * an "action". Drag the body → `move`; drag an edge → `trim_start` /
 * `trim_end`; "Split at playhead" → `split`; select + Delete / × → `remove`;
 * drop a Sources-panel pool item → `add_clip`. Every edit goes through the
 * store (`applyOp` → debounced `chroma_timeline_set` → `chroma_timeline_get`
 * refetch). Time in the editor is seconds (frame / fps).
 *
 * D-056: every clip's on-screen position is read from its own `start_frame`
 * (`timeline.ts`'s `Clip.start_frame`, mirroring `chroma-timeline`'s D-054
 * field) — not re-derived from summed preceding durations, which is what
 * this file did before this pass and is the actual root cause of "drag from
 * Sources doesn't work" / "edge-trim doesn't work" (see D-056 in
 * `docs/08-decisions.md` for the full bug writeup). A gap can now genuinely
 * appear on screen (after a left-edge trim, or a remove) — that's real,
 * matches what's on disk, and is exactly what a normal NLE's non-ripple trim
 * looks like, not a glitch.
 *
 * Drag-to-track (D-046): plain HTML5 drag/drop, not a shared `DndContext` —
 * the Sources panel is docked at the shell level (`@chroma/shell`) while this
 * pane lives inside the Edit tab's content (`@chroma/editor`), and D-039's
 * layer direction means shell can't depend on a tab package to share a drag
 * context. Native drag events cross that boundary for free. This also gives
 * the "scoped to the Edit tab being active" narrowing the roadmap item
 * allowed for free: an inactive tab's panel is `hidden` (D-039's Shell keeps
 * every tab mounted), and a `display:none` element isn't a valid drop target
 * — see the D-046 decision.
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
 *     clip id's timeline start frame across `track.clips` changes and
 *     briefly `animate-pulse`s whichever ids shifted — a trim/remove/move
 *     that shifts a clip is visibly, not just numerically, felt. (D-056: a
 *     trim/remove no longer *ripples* downstream clips by construction —
 *     see the position-model note above — so this now mostly fires for a
 *     `move`; kept as-is since a future ripple-mode trim would want it too.)
 *   - **Per-track colour coding is deliberately not built** — the Editor
 *     timeline is still genuinely single-video-track today (D-041/D-045);
 *     seeing "Video 1" labelled here is honest, a synthetic N-track palette
 *     would not be. Real multi-track visual polish is gated on a future
 *     multi-track-*authoring* feature, not on this pass — see D-051.
 *
 * D-056 (ruler): tick labels are real timecode (`ruler.ts`'s
 * `formatTimecode`, `HH:MM:SS` or `HH:MM:SS:FF` depending on the current
 * tick density) via `getScaleRender`, and the labeled-tick interval
 * (`scale`, seconds) is recomputed from `pxPerSec` on every zoom change via
 * `niceTickIntervalSeconds` — the library's own `scale` prop is a single
 * fixed value with no adaptive-density concept of its own (checked in its
 * bundled source before writing this).
 */

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { TimelineRow, TimelineAction } from '@xzdarcy/timeline-engine';
import { Timeline as TimelineEditor, type TimelineState } from '@xzdarcy/react-timeline-editor';
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';
import { Film, Scissors, Trash2, ZoomIn, ZoomOut } from 'lucide-react';
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@chroma/ui';

import { useEditorTimelineStore } from './timelineStore';
import { Waveform } from './Waveform';
import { niceTickIntervalSeconds, formatTimecode } from './ruler';
import {
  CHROMA_MEDIA_DRAG_MIME,
  clipFromDraggedMedia,
  endFrame,
  timelineFps,
  videoTrackIndex,
  type DraggedMedia,
  type Timeline,
  type Track,
} from './timeline';

const EFFECT_ID = 'clip';
/** how many pixels a labeled ruler tick should target, at any zoom (D-056
 *  item 4 — `niceTickIntervalSeconds`'s target, see `ruler.ts`). */
const TICK_TARGET_PX = 70;
/** zoom is now tracked as px-per-second directly (renamed from the old
 *  `scaleWidth`, which only meant "px per second" because `scale` used to be
 *  hardcoded to 1 — see the D-056 ruler doc below); same bounds as before. */
const DEFAULT_PX_PER_SEC = 90;
const MIN_PX_PER_SEC = 16;
const MAX_PX_PER_SEC = 480;
const ZOOM_STEP = 1.2;
const ROW_HEIGHT = 52;
/** how long a rippled clip's highlight stays visible (ms) */
const RIPPLE_FLASH_MS = 550;

function clampPxPerSec(w: number): number {
  return Math.min(MAX_PX_PER_SEC, Math.max(MIN_PX_PER_SEC, w));
}

function buildRow(tl: Timeline, fps: number): TimelineRow {
  const ti = videoTrackIndex(tl);
  const track = tl.tracks[ti];
  // D-046: a freshly `chroma_timeline_create`d timeline has `tracks: []` —
  // the "no video track yet" state `TimelinePane`'s own empty-drop-zone
  // guard handles below, but `editorData` (this fn) is computed by a
  // `useMemo` that runs before that guard's early return, so it needs its
  // own guard rather than assuming `track` exists.
  if (!track) return { id: 'video', actions: [] };
  // D-056: position comes directly from the clip's own `start_frame` (real,
  // possibly gapped, per D-054) — not re-derived from summed preceding
  // durations, which is what silently assumed "always back to back" long
  // after that stopped being true and is the root cause this pass fixed.
  const actions: TimelineAction[] = track.clips.map((clip, i) => ({
    id: clip.id || `clip-${i}`,
    start: clip.start_frame / fps,
    end: endFrame(clip) / fps,
    effectId: EFFECT_ID,
    flexible: true,
    movable: true,
  }));
  return { id: 'video', actions };
}

/** id -> timeline start frame for every clip on `track` — the snapshot the
 *  ripple-highlight effect diffs against the previous one. */
function startFramesById(track: Track | undefined): Map<string, number> {
  const m = new Map<string, number>();
  if (!track) return m;
  track.clips.forEach((c) => m.set(c.id, c.start_frame));
  return m;
}

export function TimelinePane() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const [selected, setSelected] = useState<string | null>(null);
  const [pxPerSec, setPxPerSec] = useState(DEFAULT_PX_PER_SEC);
  const [rippled, setRippled] = useState<Set<string>>(new Set());

  const editorRef = useRef<TimelineState>(null);
  const editAreaRef = useRef<HTMLDivElement>(null);
  const fps = timelineFps(timeline);
  const ti = timeline ? videoTrackIndex(timeline) : 0;
  const track: Track | undefined = timeline?.tracks[ti];

  // keep the editor's own cursor in step with the store playhead (step buttons,
  // the play loop, clicks in the preview transport)
  useEffect(() => {
    editorRef.current?.setTime(playhead / fps);
  }, [playhead, fps]);

  // Scroll-wheel zoom (D-051) — the library has no wheel handling of its own
  // (checked before writing this), so this is a plain native listener rather
  // than React's `onWheel` (which React attaches passively by default,
  // silently ignoring `preventDefault`, letting the page scroll underneath
  // the zoom). Any wheel tick over the edit area zooms; there is no
  // separate pan-vs-zoom modifier key — the library's own horizontal
  // scrollbar (drag or shift-scroll, standard browser behaviour) covers pan.
  useEffect(() => {
    const el = editAreaRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const factor = e.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP;
      setPxPerSec((w) => clampPxPerSec(w * factor));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Ripple visual feedback (D-051) — diff each clip id's timeline start frame
  // against the previous render; anything that moved (chiefly a `move` now,
  // since D-056 made trim/remove non-rippling by construction — see the
  // module doc) gets a brief `animate-pulse` highlight in `getActionRender`
  // below. A brand new track (nothing to compare against yet) or a clip that
  // simply didn't exist before (add_clip, split's new right-hand clip) is
  // correctly excluded — `prev.get(id)` is `undefined` for those, not "shifted".
  const prevStartsRef = useRef<Map<string, number> | null>(null);
  useEffect(() => {
    const starts = startFramesById(track);
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
  }, [track]);

  const editorData = useMemo<TimelineRow[]>(
    () => (timeline ? [buildRow(timeline, fps)] : [{ id: 'video', actions: [] }]),
    [timeline, fps],
  );

  const effects = useMemo(() => ({ [EFFECT_ID]: { id: EFFECT_ID, name: 'clip' } }), []);

  const [dragOver, setDragOver] = useState(false);

  const onDragOver = (e: DragEvent) => {
    if (!e.dataTransfer.types.includes(CHROMA_MEDIA_DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    setDragOver(true);
  };
  const onDragLeave = () => setDragOver(false);
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
    applyOp({ kind: 'add_clip', track: ti, clip });
  };

  if (!timeline) return null;

  if (!track) {
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

  const idxOf = (actionId: string) => track.clips.findIndex((c) => (c.id || '') === actionId);

  const s2f = (sec: number) => Math.round(sec * fps);

  const doSplit = () => {
    const at = playhead;
    // D-056: look up by real `start_frame`, not summed preceding durations —
    // a clip covering `at` may not even be the array-order-nearest one once
    // a gap exists.
    for (let i = 0; i < track.clips.length; i++) {
      const c = track.clips[i];
      if (at > c.start_frame && at < endFrame(c)) {
        applyOp({ kind: 'split', track: ti, clip: i, atFrame: at });
        return;
      }
    }
  };

  const doRemove = () => {
    if (!selected) return;
    const i = idxOf(selected);
    if (i >= 0) applyOp({ kind: 'remove', track: ti, clip: i });
    setSelected(null);
  };

  const zoomPct = Math.round((pxPerSec / DEFAULT_PX_PER_SEC) * 100);
  const zoomIn = () => setPxPerSec((w) => clampPxPerSec(w * ZOOM_STEP));
  const zoomOut = () => setPxPerSec((w) => clampPxPerSec(w / ZOOM_STEP));

  // D-056 — the labeled-tick interval adapts to the current zoom ("nice
  // numbers": widen as pxPerSec shrinks, narrow as it grows) rather than the
  // library's fixed `scale` prop; `scaleWidth` (the library's "px per one
  // `scale`-second unit") is then derived so what's actually on screen stays
  // continuous even though `tickSeconds` itself only takes discrete values.
  const tickSeconds = niceTickIntervalSeconds(pxPerSec, TICK_TARGET_PX, 1 / fps);
  const libScaleWidth = tickSeconds * pxPerSec;

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
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <TooltipProvider>
        <div className="shrink-0 flex items-center gap-1 px-3 py-1.5 border-b border-border-color bg-surface text-text-primary">
          <Tooltip>
            <TooltipTrigger
              render={
                <Button variant="ghost" size="sm" onClick={doSplit} aria-label="Split at playhead">
                  <Scissors />
                  Split
                </Button>
              }
            />
            <TooltipContent>Split the clip at the playhead</TooltipContent>
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
          {selected && <span className="ml-1 text-[11px] text-text-secondary/70">selected: {selected}</span>}

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

      <div ref={editAreaRef} className="relative flex-1 min-h-0 overflow-hidden">
        {/* Single-track label (D-051) — deliberately not a colour-coded
            per-track header system: the Editor timeline is genuinely
            single-video-track today (D-041/D-045), so this names the one
            real track rather than implying a multi-track UI that doesn't
            exist yet. */}
        <div className="pointer-events-none absolute left-1.5 top-1.5 z-10 flex items-center gap-1 rounded bg-bg-primary/70 px-1.5 py-0.5 text-[10px] font-medium text-text-secondary/80">
          <Film className="size-3" />
          Video 1
        </div>
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
          getActionRender={(action) => {
            const i = idxOf(action.id);
            const clip = i >= 0 ? track.clips[i] : null;
            const isSel = action.id === selected;
            const isRippled = rippled.has(action.id);
            const pxWidth = (action.end - action.start) * pxPerSec;
            return (
              <div
                className={
                  'relative h-full w-full overflow-hidden rounded ' +
                  (isSel ? 'ring-2 ring-accent ' : '') +
                  (isRippled ? 'ring-2 ring-accent animate-pulse ' : '')
                }
                style={{ background: isSel ? 'var(--color-accent)' : 'rgba(90,120,180,0.55)' }}
              >
                {clip && (
                  <Waveform
                    sourcePath={clip.source_path}
                    startSecs={clip.source_start / fps}
                    durationSecs={clip.duration / fps}
                    width={pxWidth}
                    height={ROW_HEIGHT}
                  />
                )}
                {/* D-056/B-013: `pointer-events-none` is load-bearing, not
                    decorative. This label's `z-10` (needed so it paints
                    above the Waveform canvas) has no isolating stacking
                    context between it and the library's own absolutely-
                    positioned `.timeline-editor-action-{left,right}-stretch`
                    resize handles (siblings of this whole content block,
                    rendered *after* it in the DOM but `z-index: auto`) — a
                    block-level, unconstrained-width div, this label
                    silently spans the clip's full width, including both
                    10px edge zones, and (confirmed live: a real pointer
                    event at the handle's coordinates hit-tested to *this*
                    div, not the handle, until this was added) ate every
                    resize-handle pointerdown before interact.js ever saw
                    it. That's why edge-trim visually did nothing — not a
                    `flexible`/`dragLine` problem (D-051 was right about the
                    library's own mechanism), a hit-testing problem in what
                    we paint on top of it. */}
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
          }}
          onClickAction={(_e, { action }) => setSelected(action.id)}
          onClickTimeArea={(time) => {
            setPlayhead(s2f(time));
            return true;
          }}
          onCursorDrag={(time) => setPlayhead(s2f(time))}
          onChange={() => false}
          onActionMoveEnd={({ action, start }) => {
            // D-056: a clip-body drag repositions it (`move`, overlap-
            // rejected — mirrors `chroma-timeline::Timeline::move_clip`'s
            // same-track case) rather than the old array-splice `reorder`,
            // which stopped affecting position entirely once `start_frame`
            // became authoritative (D-054) — using it here would have made
            // dragging a clip's body visibly do nothing.
            const i = idxOf(action.id);
            if (i < 0) return;
            const startFrame = Math.max(0, s2f(start));
            applyOp({ kind: 'move', track: ti, clip: i, startFrame });
          }}
          onActionResizeEnd={({ action, start, end, dir }) => {
            const i = idxOf(action.id);
            if (i < 0) return;
            const c = track.clips[i];
            if (dir === 'left') {
              const delta = s2f(start) - c.start_frame;
              if (delta !== 0) applyOp({ kind: 'trim_start', track: ti, clip: i, delta });
            } else {
              const delta = s2f(end) - endFrame(c);
              if (delta !== 0) applyOp({ kind: 'trim_end', track: ti, clip: i, delta });
            }
          }}
        />
      </div>
    </div>
  );
}
