/**
 * @chroma/editor — the preview pane (D-041, transport migrated to
 * `@chroma/player` — D-039 roadmap "Next" item 1).
 *
 * A plain `<img>` fed by `chroma_timeline_frame(playhead)` (a lightweight
 * backend decode→jpeg — no grade, no compositing). Play is a wall-clock
 * `requestAnimationFrame` loop that advances the playhead and refetches,
 * dropping frames to stay real-time (same pattern as the Colorist tab's
 * `ChromaTimeline.tsx`). This frame-fetch + play-loop logic is tab-owned and
 * stays here — only the rendered transport JSX (the hand-rolled button row)
 * moved to `<Player>`, which is purely presentational.
 *
 * Audio (D-049): `chroma_audio_play(playhead)` / `chroma_audio_stop()` are
 * fired at exactly the same `playing` transitions that (re)baseline the video
 * rAF loop below — both start from the same playhead frame at the same
 * moment and then run independently against real wall-clock time (video via
 * `performance.now()`, audio via the device's own clock inside Rust). See
 * `chroma/audio.rs`'s module doc for why that's the deliberate sync model
 * rather than a tighter per-frame coupling. No audio during scrub (paused) —
 * only real Play produces sound, per D-049 scope.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2 } from 'lucide-react';
import { Player } from '@chroma/player';

import { useEditorTimelineStore } from './timelineStore';
import { timelineDuration, timelineFps } from './timeline';

const SCRUB_LONG_EDGE = 960;
const PLAY_LONG_EDGE = 640;

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

  // audio (D-049): start/stop in lockstep with the same `playing` transitions
  // that (re)baseline the video rAF loop above — both begin from the same
  // playhead frame at the same moment, then free-run independently against
  // real wall-clock time (see chroma/audio.rs's module doc for why). No
  // audio during scrub (paused) — only real Play produces sound.
  useEffect(() => {
    if (!playing || !timeline) {
      invoke('chroma_audio_stop').catch(() => {});
      return;
    }
    const startFrame = useEditorTimelineStore.getState().playhead;
    invoke('chroma_audio_play', { startFrame }).catch((e) => {
      // A clip with no audio stream isn't an error on the Rust side
      // (chroma_audio_play returns Ok(()) and just plays nothing) — a
      // rejection here is a real decode/device failure. Not fatal to video
      // playback, so just log it rather than surfacing a preview error.
      console.warn('chroma_audio_play failed:', e);
    });
    return () => {
      invoke('chroma_audio_stop').catch(() => {});
    };
  }, [playing, timeline]);

  const step = (d: number) => {
    if (playing) setPlaying(false);
    setPlayhead(playhead + d);
  };

  return (
    <Player
      title="Timeline"
      surface={
        // D-062: a plain "no frame" text was doing double duty for two very
        // different states — "still waiting on the first frame" (normal,
        // e.g. right after dropping a clip onto an empty timeline — the
        // scrub fetch just hasn't resolved yet) and "genuinely nothing to
        // show." Both rendered identical static gray text, so a real fetch
        // in flight read exactly like a stuck/broken preview — the owner's
        // own live testing flagged this as ambiguous. Once any frame has
        // loaded, `frameSrc` never goes back to `null` on its own (only a
        // remount resets it — see the module doc's scrub-effect note), so
        // this spinner only ever appears on a genuine first-load, not on
        // ordinary scrub/play frame-to-frame fetches, which still keep the
        // previous frame visible while the next one loads (unchanged).
        decodeErr ? (
          <div className="text-sm text-text-secondary">preview error: {decodeErr}</div>
        ) : frameSrc ? (
          <img src={frameSrc} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
        ) : timeline ? (
          <div className="flex flex-col items-center gap-2 text-text-secondary">
            <Loader2 className="size-5 animate-spin" />
            <span className="text-xs">Loading preview…</span>
          </div>
        ) : (
          <div className="text-sm text-text-secondary">no frame</div>
        )
      }
      frame={playhead}
      total={lastFrame}
      fps={fps}
      playing={playing}
      onPlayPause={() => setPlaying(!playing)}
      onStep={step}
      onSeek={(f) => {
        setPlaying(false);
        setPlayhead(f);
      }}
    />
  );
}
