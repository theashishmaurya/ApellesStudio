/**
 * @chroma/editor — the timeline strip (D-041).
 *
 * `@xzdarcy/react-timeline-editor` with one row (the video track). Each clip is
 * an "action". Drag the body → `reorder`; drag an edge → `trim_start` /
 * `trim_end`; "Split at playhead" → `split`; select + Delete / × → `remove`.
 * Every edit goes through the store (`applyOp` → debounced `chroma_timeline_set`
 * → `chroma_timeline_get` refetch). Time in the editor is seconds (frame / fps).
 */

import { useMemo, useState } from 'react';
import type { TimelineRow, TimelineAction } from '@xzdarcy/timeline-engine';
import { Timeline as TimelineEditor } from '@xzdarcy/react-timeline-editor';
import '@xzdarcy/react-timeline-editor/dist/react-timeline-editor.css';

import { useEditorTimelineStore } from './timelineStore';
import { clipStartFrame, timelineFps, videoTrackIndex, type Timeline } from './timeline';

const EFFECT_ID = 'clip';
const SCALE_SEC = 1;
const SCALE_WIDTH = 90;

function buildRow(tl: Timeline, fps: number): TimelineRow {
  const ti = videoTrackIndex(tl);
  const track = tl.tracks[ti];
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

  const fps = timelineFps(timeline);
  const ti = timeline ? videoTrackIndex(timeline) : 0;

  const editorData = useMemo<TimelineRow[]>(
    () => (timeline ? [buildRow(timeline, fps)] : [{ id: 'video', actions: [] }]),
    [timeline, fps],
  );

  const effects = useMemo(() => ({ [EFFECT_ID]: { id: EFFECT_ID, name: 'clip' } }), []);

  if (!timeline) return null;
  const track = timeline.tracks[ti];

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
      className="flex flex-col min-h-0 h-full bg-bg-primary"
      tabIndex={0}
      onKeyDown={(e) => {
        if ((e.key === 'Delete' || e.key === 'Backspace') && selected) {
          e.preventDefault();
          doRemove();
        }
      }}
    >
      <div className="shrink-0 flex items-center gap-2 px-3 py-1.5 border-b border-border-color bg-surface text-text-primary">
        <span className="text-xs font-medium text-text-secondary">Timeline</span>
        <button
          type="button"
          className="px-2 py-1 rounded text-xs bg-accent text-button-text hover:opacity-90"
          onClick={doSplit}
        >
          Split at playhead
        </button>
        <button
          type="button"
          className="px-2 py-1 rounded text-xs hover:bg-hover-color disabled:opacity-40"
          onClick={doRemove}
          disabled={!selected}
        >
          Remove clip
        </button>
        {selected && <span className="text-[11px] text-text-secondary/70">selected: {selected}</span>}
      </div>

      <div className="flex-1 min-h-0 overflow-hidden">
        <TimelineEditor
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
