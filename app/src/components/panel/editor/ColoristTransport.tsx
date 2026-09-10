// Apelles — the Colorist tab's transport (D-295; was `ChromaTimeline.tsx`,
// D-031's frame-thumbnail strip).
//
// What it is: play / pause / step, a **scrub bar** over the clip currently
// being graded, the mask-keyframe track (D-034), and a timecode readout. It
// lives in the BottomBar, in place of RapidRAW's photo `Filmstrip` whenever
// the loaded item is a video.
//
// What it does NOT do — and this is the point of D-295: it is not a timeline.
// It shows no thumbnails, no clips, no tracks, and no other shot. The Edit tab
// owns the one real timeline in this app; a second, frame-thumbnail one in
// Colorist duplicated it (the owner: "no point of having a timeline" here) and
// after D-294 it was also actively misleading — the strip was built from the
// whole SOURCE file while the transport it sat under counts the CLIP's own
// frames. What is genuinely lost with the thumbnails is visual "where am I in
// this shot" scanning; the scrub bar keeps the capability that mattered
// (scrubbing within the shot you are grading) and the Edit tab's own filmstrip
// keeps the one that was duplicated.
//
// **Frames here are CLIP-LOCAL (D-294/B-147).** `videoInfo.frameCount` is the
// clip's length on the Edit timeline, frame 0 is the clip's in-point, and the
// backend maps both through the clip's own trim. Nothing in this file knows
// that — it just counts the frames the backend reports, which is exactly why
// the fix belonged in `chroma::colorist_view` and not here.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useChromaStore } from '../../../store/useChromaStore';
import { useEditorStore } from '../../../store/useEditorStore';
import MaskKeyframeBar from '../../chroma/MaskKeyframeBar';

// D-031: grade at a reduced long edge during playback (ffmpeg downscales the
// decode, the WGSL grade runs at this size). Full-res is restored on pause.
// ~1280 clears 30 fps on 4K footage with headroom; drop toward 960 if a
// low-end GPU can't keep up.
const PLAYBACK_LONG_EDGE = 1280;

function fmtTime(secs: number): string {
  if (!isFinite(secs) || secs < 0) secs = 0;
  const m = Math.floor(secs / 60);
  const s = secs - m * 60;
  return `${m}:${s.toFixed(1).padStart(4, '0')}`;
}

export default function ColoristTransport() {
  const videoInfo = useChromaStore((s) => s.videoInfo);
  const currentFrame = useChromaStore((s) => s.currentFrame);
  const setCurrentFrame = useChromaStore((s) => s.setCurrentFrame);
  const bumpFrameNonce = useChromaStore((s) => s.bumpFrameNonce);

  const [playing, setPlaying] = useState(false);

  const barRef = useRef<HTMLDivElement>(null);
  const seekInFlight = useRef(false);
  const pending = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const playedRef = useRef(false);

  // Switching to another shot (or another clip) must not leave the transport
  // running against the previous one's length.
  useEffect(() => {
    setPlaying(false);
  }, [videoInfo?.path, videoInfo?.frameCount]);

  const doSeek = useCallback(
    async (frame: number) => {
      if (seekInFlight.current) {
        pending.current = frame;
        return;
      }
      seekInFlight.current = true;
      try {
        await invoke('chroma_seek', { frame });
        bumpFrameNonce();
      } catch (e) {
        console.error(e);
      } finally {
        seekInFlight.current = false;
        if (pending.current !== null) {
          const n = pending.current;
          pending.current = null;
          doSeek(n);
        }
      }
    },
    [bumpFrameNonce],
  );

  const goToFrame = useCallback(
    (frame: number) => {
      if (!videoInfo) return;
      const f = Math.max(0, Math.min(videoInfo.frameCount - 1, Math.round(frame)));
      setCurrentFrame(f);
      doSeek(f);
    },
    [videoInfo, setCurrentFrame, doSeek],
  );

  const seekFromClientX = useCallback(
    (clientX: number) => {
      const el = barRef.current;
      if (!el || !videoInfo) return;
      const rect = el.getBoundingClientRect();
      const ratio = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      goToFrame(ratio * (videoInfo.frameCount - 1));
    },
    [videoInfo, goToFrame],
  );

  // D-031 real-time playback: a requestAnimationFrame loop locked to a wall
  // clock. Each iteration computes the frame the clip *should* be on now
  // (`startFrame + floor(elapsed * fps)`), skips any frames we couldn't render
  // in time (audio-less playback stays real-time), and drives the fused
  // `chroma_play_frame` command — one IPC call that decodes (scaled) + swaps +
  // grades at playback res. No frame-dropping mutex, no setInterval drift.
  useEffect(() => {
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    }
    if (!playing || !videoInfo) return;

    const fps = videoInfo.fps > 0 ? videoInfo.fps : 24;
    const startFrame = useChromaStore.getState().currentFrame;
    const startTime = performance.now();
    let busy = false;
    let lastRequested = -1;
    let stopped = false;
    playedRef.current = true;

    const tick = async () => {
      if (stopped) return;
      const elapsed = (performance.now() - startTime) / 1000;
      const want = startFrame + Math.floor(elapsed * fps);

      if (want >= videoInfo.frameCount) {
        setCurrentFrame(videoInfo.frameCount - 1);
        setPlaying(false);
        return;
      }

      if (!busy && want !== lastRequested) {
        busy = true;
        lastRequested = want;
        setCurrentFrame(want);
        const { adjustments, previewOverride } = useEditorStore.getState();
        try {
          await invoke('chroma_play_frame', {
            frame: want,
            jsAdjustments: previewOverride ?? adjustments,
            targetResolution: PLAYBACK_LONG_EDGE,
          });
        } catch (e) {
          console.error('chroma_play_frame failed', e);
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
  }, [playing, videoInfo, setCurrentFrame, setPlaying]);

  // On pause, settle the current frame back to full resolution (playback graded
  // at PLAYBACK_LONG_EDGE). `goToFrame` re-decodes native + regrades full-res.
  useEffect(() => {
    if (playing || !playedRef.current) return;
    playedRef.current = false;
    goToFrame(useChromaStore.getState().currentFrame);
  }, [playing, goToFrame]);

  if (!videoInfo?.isVideo) return null;

  const lastFrame = Math.max(0, videoInfo.frameCount - 1);
  const playheadPct = lastFrame > 0 ? (currentFrame / lastFrame) * 100 : 0;
  const t = videoInfo.fps > 0 ? currentFrame / videoInfo.fps : 0;

  return (
    <div
      className="w-full flex flex-col gap-1.5 select-none"
      data-chroma-panel="colorist-transport"
      onClick={(e) => e.stopPropagation()}
      onWheel={(e) => e.stopPropagation()}
    >
      {/* controls row */}
      <div className="flex items-center gap-2 text-text-primary">
        <button className="p-1 rounded hover:bg-surface" onClick={() => goToFrame(currentFrame - 1)} title="Previous frame">
          <SkipBack size={15} />
        </button>
        <button className="p-1 rounded hover:bg-surface" onClick={() => setPlaying((p) => !p)} title={playing ? 'Pause' : 'Play'}>
          {playing ? <Pause size={15} /> : <Play size={15} />}
        </button>
        <button className="p-1 rounded hover:bg-surface" onClick={() => goToFrame(currentFrame + 1)} title="Next frame">
          <SkipForward size={15} />
        </button>
        <div className="flex-1" />
        <span className="text-[11px] tabular-nums text-text-secondary">
          {fmtTime(t)} / {fmtTime(videoInfo.durationSecs)} · f{currentFrame} / {lastFrame}
        </span>
      </div>

      {/* mask keyframe track (D-034) — only visible with a shape mask active */}
      <MaskKeyframeBar />

      {/* scrub bar — a jog track with a played-portion fill and a handle, the
          shape Resolve's own Color-page viewer uses (scratch/resolve-reference).
          A plain div rather than an `<input type=range>`: the playhead has to
          be draggable *and* click-to-seek anywhere on the track while a
          `pointerdown` on it must not also reach the canvas underneath, which
          the native control's own capture behaviour fights. */}
      <div
        ref={barRef}
        role="slider"
        aria-label="Scrub"
        aria-valuemin={0}
        aria-valuemax={lastFrame}
        aria-valuenow={currentFrame}
        tabIndex={0}
        className="relative h-4 flex items-center cursor-pointer touch-none"
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft') goToFrame(currentFrame - 1);
          else if (e.key === 'ArrowRight') goToFrame(currentFrame + 1);
          else return;
          e.preventDefault();
        }}
        onPointerDown={(e) => {
          e.stopPropagation(); // keep the editor canvas from also panning/zooming
          draggingRef.current = true;
          (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
          seekFromClientX(e.clientX);
        }}
        onPointerMove={(e) => {
          if (draggingRef.current) seekFromClientX(e.clientX);
        }}
        onPointerUp={() => {
          draggingRef.current = false;
        }}
      >
        <div className="absolute left-0 right-0 h-1.5 rounded-full bg-bg-primary" />
        <div
          className="absolute left-0 h-1.5 rounded-full bg-accent/70 pointer-events-none"
          style={{ width: `${playheadPct}%` }}
        />
        <div
          className="absolute w-3 h-3 rounded-full bg-text-primary shadow pointer-events-none"
          style={{ left: `calc(${playheadPct}% - 6px)` }}
        />
      </div>
    </div>
  );
}
