/**
 * @chroma/editor — the timeline strip (D-041; drag-to-track D-046 pass 3).
 *
 * `@xzdarcy/react-timeline-editor` with one row (the video track). Each clip is
 * an "action". Drag the body → `reorder`; drag an edge → `trim_start` /
 * `trim_end`; "Split at playhead" → `split`; select + Delete / × → `remove`;
 * drop a Sources-panel pool item → `add_clip`. Every edit goes through the
 * store (`applyOp` → debounced `chroma_timeline_set` → `chroma_timeline_get`
 * refetch). Time in the editor is seconds (frame / fps).
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
 */

import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react';
import type { TimelineRow, TimelineAction } from '@xzdarcy/timeline-engine';
import { Timeline as TimelineEditor, type TimelineState } from '@xzdarcy/react-timeline-editor';
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';
import { Film, Scissors, Trash2 } from 'lucide-react';
import { Button, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@chroma/ui';

import { useEditorTimelineStore } from './timelineStore';
import {
  CHROMA_MEDIA_DRAG_MIME,
  clipFromDraggedMedia,
  clipStartFrame,
  timelineFps,
  videoTrackIndex,
  type DraggedMedia,
  type Timeline,
} from './timeline';

const EFFECT_ID = 'clip';
const SCALE_SEC = 1;
const SCALE_WIDTH = 90;

function buildRow(tl: Timeline, fps: number): TimelineRow {
  const ti = videoTrackIndex(tl);
  const track = tl.tracks[ti];
  // D-046: a freshly `chroma_timeline_create`d timeline has `tracks: []` —
  // the "no video track yet" state `TimelinePane`'s own empty-drop-zone
  // guard handles below, but `editorData` (this fn) is computed by a
  // `useMemo` that runs before that guard's early return, so it needs its
  // own guard rather than assuming `track` exists.
  if (!track) return { id: 'video', actions: [] };
  const actions: TimelineAction[] = track.clips.map((clip, i) => {
    const startF = clipStartFrame(track, i);
    return {
      id: clip.id || `clip-${i}`,
      start: startF / fps,
      end: (startF + clip.duration) / fps,
      effectId: EFFECT_ID,
      flexible: true,
      movable: true,
    };
  });
  return { id: 'video', actions };
}

export function TimelinePane() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);
  const applyOp = useEditorTimelineStore((s) => s.applyOp);
  const [selected, setSelected] = useState<string | null>(null);

  const editorRef = useRef<TimelineState>(null);
  const fps = timelineFps(timeline);
  const ti = timeline ? videoTrackIndex(timeline) : 0;

  // keep the editor's own cursor in step with the store playhead (step buttons,
  // the play loop, clicks in the preview transport)
  useEffect(() => {
    editorRef.current?.setTime(playhead / fps);
  }, [playhead, fps]);

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
  const track = timeline.tracks[ti];

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
    let acc = 0;
    for (let i = 0; i < track.clips.length; i++) {
      const c = track.clips[i];
      if (at > acc && at < acc + c.duration) {
        applyOp({ kind: 'split', track: ti, clip: i, atFrame: at });
        return;
      }
      acc += c.duration;
    }
  };

  const doRemove = () => {
    if (!selected) return;
    const i = idxOf(selected);
    if (i >= 0) applyOp({ kind: 'remove', track: ti, clip: i });
    setSelected(null);
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
        </div>
      </TooltipProvider>

      <div className="flex-1 min-h-0 overflow-hidden">
        <TimelineEditor
          ref={editorRef}
          editorData={editorData}
          effects={effects}
          scale={SCALE_SEC}
          scaleWidth={SCALE_WIDTH}
          startLeft={20}
          rowHeight={44}
          autoScroll
          dragLine
          style={{ width: '100%', height: '100%' }}
          getActionRender={(action) => {
            const i = idxOf(action.id);
            const clip = i >= 0 ? track.clips[i] : null;
            const isSel = action.id === selected;
            return (
              <div
                className={
                  'h-full w-full flex items-center px-2 text-[11px] font-medium truncate rounded ' +
                  (isSel ? 'ring-2 ring-accent text-text-primary' : 'text-button-text')
                }
                style={{ background: isSel ? 'var(--color-accent)' : 'rgba(90,120,180,0.55)' }}
              >
                {clip?.name ?? action.id}
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
            const from = idxOf(action.id);
            if (from < 0) return;
            const dropFrame = s2f(start);
            // target index = clips whose midpoint sits before the drop point
            let to = 0;
            let acc = 0;
            track.clips.forEach((c, i) => {
              if (i === from) return;
              if (acc + c.duration / 2 < dropFrame) to = i < from ? i + 1 : i;
              acc += c.duration;
            });
            to = Math.min(Math.max(to, 0), track.clips.length - 1);
            if (to !== from) applyOp({ kind: 'reorder', track: ti, from, to });
          }}
          onActionResizeEnd={({ action, start, end, dir }) => {
            const i = idxOf(action.id);
            if (i < 0) return;
            const startF = clipStartFrame(track, i);
            const c = track.clips[i];
            if (dir === 'left') {
              const delta = s2f(start) - startF;
              if (delta !== 0) applyOp({ kind: 'trim_start', track: ti, clip: i, delta });
            } else {
              const delta = s2f(end) - (startF + c.duration);
              if (delta !== 0) applyOp({ kind: 'trim_end', track: ti, clip: i, delta });
            }
          }}
        />
      </div>
    </div>
  );
}
