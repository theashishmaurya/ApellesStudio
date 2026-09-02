/**
 * @chroma/editor — the preview pane + transport bar (D-041).
 *
 * A plain `<img>` fed by `chroma_timeline_frame(playhead)` (a lightweight
 * backend decode→jpeg — no grade, no compositing). Play is a wall-clock
 * `requestAnimationFrame` loop that advances the playhead and refetches,
 * dropping frames to stay real-time (same pattern as the Colorist tab's
 * `ChromaTimeline.tsx`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';

import { useEditorTimelineStore } from './timelineStore';
import { timelineDuration, timelineFps } from './timeline';

const SCRUB_LONG_EDGE = 960;
const PLAY_LONG_EDGE = 640;

function fmtTimecode(frame: number, fps: number): string {
  const totalSecs = frame / fps;
  const h = Math.floor(totalSecs / 3600);
  const m = Math.floor((totalSecs % 3600) / 60);
  const s = Math.floor(totalSecs % 60);
  const f = Math.round(frame % fps);
  const pad = (n: number, w = 2) => String(n).padStart(w, '0');
  return `${pad(h)}:${pad(m)}:${pad(s)}:${pad(f)}`;
}

export function PreviewPane() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const playing = useEditorTimelineStore((s) => s.playing);
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);
  const setPlaying = useEditorTimelineStore((s) => s.setPlaying);

  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [decodeErr, setDecodeErr] = useState<string | null>(null);
  const inFlight = useRef(false);
  const pending = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);

  const fps = timelineFps(timeline);
  const duration = timelineDuration(timeline);
  const lastFrame = Math.max(0, duration - 1);

  const fetchFrame = useCallback(async (frame: number, longEdge: number) => {
    if (inFlight.current) {
      pending.current = frame;
      return;
    }
    inFlight.current = true;
    try {
      const src = await invoke<string>('chroma_timeline_frame', {
        pos: Math.max(0, Math.round(frame)),
        maxLongEdge: longEdge,
      });
      setFrameSrc(src);
      setDecodeErr(null);
    } catch (e) {
      setDecodeErr(String(e));
    } finally {
      inFlight.current = false;
      if (pending.current !== null) {
        const n = pending.current;
        pending.current = null;
        fetchFrame(n, longEdge);
      }
    }
  }, []);

  // scrub: refetch on playhead change while paused
  useEffect(() => {
    if (playing || !timeline) return;
    fetchFrame(playhead, SCRUB_LONG_EDGE);
  }, [playhead, playing, timeline, fetchFrame]);

  // play: wall-clock rAF loop, frame-dropping to stay real-time
  useEffect(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (!playing || !timeline || duration <= 1) return;

    const startFrame = useEditorTimelineStore.getState().playhead;
    const startTime = performance.now();
    let busy = false;
    let lastRequested = -1;
    let stopped = false;

    const tick = async () => {
      if (stopped) return;
      const elapsed = (performance.now() - startTime) / 1000;
      const want = startFrame + Math.floor(elapsed * fps);
      if (want >= duration) {
        setPlayhead(lastFrame);
        setPlaying(false);
        return;
      }
      if (!busy && want !== lastRequested) {
        busy = true;
        lastRequested = want;
        setPlayhead(want);
        try {
          const src = await invoke<string>('chroma_timeline_frame', {
            pos: want,
            maxLongEdge: PLAY_LONG_EDGE,
          });
          setFrameSrc(src);
        } catch {
          /* keep going — a heavy clip can drop frames */
        }
        busy = false;
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
  }, [playing, timeline, duration, fps, lastFrame, setPlayhead, setPlaying]);

  const step = (d: number) => {
    if (playing) setPlaying(false);
    setPlayhead(playhead + d);
  };

  return (
    <div className="flex flex-col min-h-0 flex-1 bg-bg-primary">
      <div className="flex-1 min-h-0 flex items-center justify-center overflow-hidden bg-black/40">
        {frameSrc ? (
          <img src={frameSrc} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
        ) : (
          <div className="text-sm text-text-secondary">
            {decodeErr ? `preview error: ${decodeErr}` : 'no frame'}
          </div>
        )}
      </div>

      <div className="shrink-0 flex items-center gap-2 px-3 py-2 border-t border-border-color bg-surface text-text-primary">
        <button
          type="button"
          className="px-2 py-1 rounded text-xs hover:bg-hover-color"
          onClick={() => step(-1)}
          title="Step back one frame"
        >
          ◀
        </button>
        <button
          type="button"
          className="px-3 py-1 rounded text-xs font-medium bg-accent text-button-text hover:opacity-90"
          onClick={() => setPlaying(!playing)}
        >
          {playing ? 'Pause' : 'Play'}
        </button>
        <button
          type="button"
          className="px-2 py-1 rounded text-xs hover:bg-hover-color"
          onClick={() => step(1)}
          title="Step forward one frame"
        >
          ▶
        </button>
        <span className="ml-2 text-xs tabular-nums text-text-secondary">
          {fmtTimecode(playhead, fps)} / {fmtTimecode(lastFrame, fps)}
        </span>
        <span className="text-xs tabular-nums text-text-secondary">
          · f{playhead} / {lastFrame}
        </span>
        <div className="flex-1" />
        <span className="text-[11px] text-text-secondary/70">
          preview ≤ {playing ? PLAY_LONG_EDGE : SCRUB_LONG_EDGE}px · {fps.toFixed(2)} fps
        </span>
      </div>
    </div>
  );
}
