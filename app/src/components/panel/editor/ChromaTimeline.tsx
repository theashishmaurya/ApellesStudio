// Chroma — the video UI. Replaces the filmstrip when a clip is loaded: a frame-
// thumbnail strip with a playhead, plus play/step controls. Click/drag the strip
// to seek. Lives in the BottomBar.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Pause, Play, SkipBack, SkipForward } from 'lucide-react';
import { useChromaStore } from '../../../store/useChromaStore';
import { useEditorStore } from '../../../store/useEditorStore';
import MaskKeyframeBar from '../../chroma/MaskKeyframeBar';

interface FrameThumb {
  frame: number;
  dataUrl: string;
}

const THUMB_COUNT = 48;

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

export default function ChromaTimeline() {
  const videoInfo = useChromaStore((s) => s.videoInfo);
  const currentFrame = useChromaStore((s) => s.currentFrame);
  const setCurrentFrame = useChromaStore((s) => s.setCurrentFrame);
  const bumpFrameNonce = useChromaStore((s) => s.bumpFrameNonce);

  const [thumbs, setThumbs] = useState<FrameThumb[]>([]);
  const [loading, setLoading] = useState(false);
  const [playing, setPlaying] = useState(false);

  const stripRef = useRef<HTMLDivElement>(null);
  const seekInFlight = useRef(false);
  const pending = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const rafRef = useRef<number | null>(null);
  const playedRef = useRef(false);

  useEffect(() => {
    if (!videoInfo?.isVideo) {
      setThumbs([]);
      return;
    }
    let cancelled = false;
    setPlaying(false);
    setThumbs([]);
    setLoading(true);
    invoke<FrameThumb[]>('chroma_frame_thumbnails', { count: THUMB_COUNT })
      .then((t) => !cancelled && setThumbs(t))
      .catch((e) => console.error('chroma_frame_thumbnails failed', e))
      .finally(() => !cancelled && setLoading(false));
    return () => {
      cancelled = true;
    };
  }, [videoInfo?.path, videoInfo?.isVideo]);

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
      const el = stripRef.current;
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

  const playheadPct =
    videoInfo.frameCount > 1 ? (currentFrame / (videoInfo.frameCount - 1)) * 100 : 0;
  const t = videoInfo.fps > 0 ? currentFrame / videoInfo.fps : 0;

  return (
    <div
      className="w-full h-full flex flex-col gap-1.5 select-none"
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
          {fmtTime(t)} / {fmtTime(videoInfo.durationSecs)} · f{currentFrame} / {videoInfo.frameCount - 1}
        </span>
      </div>

      {/* mask keyframe track (D-034) — only visible with a shape mask active */}
      <MaskKeyframeBar />

      {/* thumbnail strip + playhead */}
      <div
        ref={stripRef}
        className="relative flex-1 min-h-0 rounded-md overflow-hidden bg-bg-primary cursor-pointer"
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
        <div className="absolute inset-0 flex">
          {thumbs.map((th) => (
            <img
              key={th.frame}
              src={th.dataUrl}
              draggable={false}
              className="h-full flex-1 object-cover pointer-events-none border-r border-black/20"
              style={{ minWidth: 0 }}
            />
          ))}
          {thumbs.length === 0 && (
            <div className="w-full h-full flex items-center justify-center text-xs text-text-secondary">
              {loading ? 'building timeline…' : 'no frames'}
            </div>
          )}
        </div>
        <div
          className="absolute top-0 bottom-0 w-[3px] bg-white pointer-events-none"
          style={{
            left: `calc(${playheadPct}% - 1.5px)`,
            boxShadow: '0 0 0 1px rgba(0,0,0,0.7), 0 0 8px rgba(0,0,0,0.6)',
          }}
        >
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-3 h-3 rounded-sm bg-white shadow" />
        </div>
      </div>
    </div>
  );
}
