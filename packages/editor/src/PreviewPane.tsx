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
 * Audio session churn (D-130): the audio effect is keyed on whether a timeline
 * exists, not on the timeline object — see that effect's comment. And both
 * audio commands carry a monotonic `seq` (`nextAudioSeq`), because since D-125
 * they are `(async)` Tauri commands and so no longer execute in the order they
 * were invoked — see that constant's comment and `chroma/audio.rs`'s
 * `begin_request`.
 *
 * Audio (D-049): `chroma_audio_play(playhead)` / `chroma_audio_stop()` are
 * fired at exactly the same `playing` transitions that (re)baseline the video
 * rAF loop below — both start from the same playhead frame at the same
 * moment and then run independently against real wall-clock time (video via
 * `performance.now()`, audio via the device's own clock inside Rust). See
 * `chroma/audio.rs`'s module doc for why that's the deliberate sync model
 * rather than a tighter per-frame coupling. No audio during scrub (paused) —
 * only real Play produces sound, per D-049 scope.
 *
 * Playback-start cost (D-125): pressing Play used to cost several seconds of
 * dead air. Three things here contributed, all fixed: play and scrub asked for
 * *different* preview resolutions (which respawns every backend decode pipe),
 * the play loop re-requested the frame already on screen (a backward seek,
 * which respawns them again), and `chroma_timeline_frame` ran on Tauri's main
 * thread so `chroma_audio_play` queued behind a full decode — arriving late,
 * which the open-loop audio clock then carried as a permanent offset. The
 * dominant cause was on the Rust side (`chroma/decode_pipe.rs`); see D-125.
 *
 * Mute/volume + fullscreen (D-126): `muted`/`volume` are local UI state, not
 * project data — real-time monitoring volume, applied in `audio.rs`'s output
 * callback via `chroma_audio_set_volume`, entirely separate from any track's
 * actual `gain`. Fullscreen uses the real browser Fullscreen API on a local
 * wrapper `<div>` around `<Player>` (not a ref forwarded through `Player`
 * itself, which stays presentational-only) — a `fullscreenchange` listener
 * keeps `isFullscreen` in sync with reality, since the browser's own Esc
 * handling exits fullscreen without ever calling this component's own click
 * handler.
 *
 * On-canvas transform handles (D-136, Phase 1 of
 * `docs/notes/on-canvas-transform.md`): `<TransformOverlay>` renders as a
 * sibling of the `<img>`, both children of `surfaceRef` — an
 * absolutely-positioned DOM/SVG overlay, not a second `<canvas>`, per that
 * note's own finding that the preview surface is a plain `<img>` and
 * `<Player>`'s `surface` slot already accepts any ReactNode. No prop drilling
 * needed: it reads the same `useEditorTimelineStore` selection this file
 * does, independently.
 *
 * Canvas/composition boundary + settings (D-199,
 * `docs/notes/preview-canvas-boundary.md`): `<CanvasBoundary>` is a THIRD
 * sibling in that same stack — always drawn (selection-independent, unlike
 * `TransformOverlay`), under it in z-order. `<CanvasSettingsPopover>` sits in
 * the toolbar next to the Inspector toggle. `useCompositionSize` refetches
 * itself on the backend's own `chroma://project-settings-changed` broadcast
 * (B-086) — this file no longer needs to plumb a refresh token through
 * `CanvasSettingsPopover`'s `onSaved` for that; see that hook's own doc.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2 } from 'lucide-react';
import { Player } from '@chroma/player';

import { useEditorTimelineStore } from './timelineStore';
import { timelineDuration, timelineFps } from './timeline';
import { TransformOverlay } from './TransformOverlay';
import { CanvasBoundary } from './CanvasBoundary';
import { CanvasSettingsPopover } from './CanvasSettingsPopover';
import { useCompositionSize } from './useCompositionSize';

/**
 * One preview resolution for both scrub and play (D-125). D-031 originally
 * dropped playback to a smaller long edge because decode was the bottleneck;
 * with per-layer decode pipes and hardware decode it no longer is — measured
 * against this project's real footage, two 4K HEVC layers sustain ~110 fps at
 * 960 vs ~105 fps at 640, and three layers still sustain ~81 fps. Meanwhile a
 * *different* long edge between scrub and play changes the ffmpeg scaler
 * arguments, which forces every decode pipe to respawn and keyframe-seek on
 * every single Play/Pause toggle — a measured 550-650 ms of dead air each time
 * for two to three 4K HEVC layers, and a real part of the "clicking Play takes
 * seconds" report this fixes. One value means toggling Play just continues the
 * existing sequential decode.
 */
const PREVIEW_LONG_EDGE = 960;

/**
 * Monotonic stamp for every audio transport command (D-130).
 *
 * `chroma_audio_play` / `chroma_audio_stop` are `#[tauri::command(async)]`
 * since D-125, which means each `invoke` becomes its own `tokio::spawn`ed task
 * on a multi-threaded runtime — they no longer run in the order they were
 * issued, and two can run at once. The play/stop protocol depends entirely on
 * that order (a pause's stop must not land on top of the resume's play; the
 * newest play must win), so the order is sent explicitly instead of assumed:
 * Rust drops any request a newer one has already overtaken.
 *
 * Seeded from `Date.now()` rather than starting at 1 so a page reload (dev HMR,
 * or a webview reload in the shipped app) still produces stamps above whatever
 * the previous page got to — the Rust side's high-water mark lives in the
 * process, which outlives the page. That holds unless a page issues more than
 * one command per elapsed millisecond of its whole lifetime, which a
 * user-driven transport never does.
 *
 * Same request-token pattern `timelineStore.ts`'s `load()` uses for the same
 * class of bug (B-034 / D-112).
 */
let audioSeq = Date.now();
const nextAudioSeq = () => ++audioSeq;

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
  // D-136 — the container `TransformOverlay` measures its content box
  // against (`useContentBox`'s `containerRef`). Must be the same element the
  // `<img>` is `object-contain`-fit within, i.e. its own parent, not
  // `Player`'s outer viewport div (which also holds letterboxing bars this
  // ref must NOT include).
  const surfaceRef = useRef<HTMLDivElement>(null);

  // D-126 — mute/volume: local monitoring state, not project data (see the
  // module doc). `volume` is the last non-zero level, remembered across a
  // mute toggle so unmuting restores it instead of resetting to unity.
  const [muted, setMuted] = useState(false);
  const [volume, setVolume] = useState(1);
  useEffect(() => {
    invoke('chroma_audio_set_volume', { volume: muted ? 0 : volume }).catch(() => {});
  }, [muted, volume]);

  // D-126 — fullscreen: a local wrapper ref (not forwarded through `Player`,
  // which stays presentational) + a real `fullscreenchange` listener, since
  // the browser's own Esc handling exits fullscreen without ever calling
  // `toggleFullscreen` below — this is the only reliable way to keep
  // `isFullscreen` correct regardless of *how* fullscreen was exited.
  const fullscreenRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === fullscreenRef.current);
    document.addEventListener('fullscreenchange', onChange);
    return () => document.removeEventListener('fullscreenchange', onChange);
  }, []);
  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void fullscreenRef.current?.requestFullscreen();
    }
  }, []);

  const fps = timelineFps(timeline);
  const duration = timelineDuration(timeline);
  const lastFrame = Math.max(0, duration - 1);

  // D-199 — the canvas/composition boundary overlay's size, selection-
  // independent (unlike `TransformOverlay`'s per-clip `useClipGeometry`).
  // Refetches itself on a `CanvasSettingsPopover` save via the backend's own
  // `chroma://project-settings-changed` broadcast (B-086) — see that hook's
  // own doc.
  const compSize = useCompositionSize(!!timeline);

  // D-201 — two shapes here exist for the React Compiler's sake, both exactly
  // equivalent to what they replaced (see
  // `docs/notes/react-compiler-coverage.md`), because ONE unsupported
  // construct anywhere in a component makes the compiler skip auto-memoizing
  // the WHOLE component — and `PreviewPane` re-renders on every playhead tick
  // during playback, so that is a real cost:
  //   1. `try/catch` followed by the former `finally` body inline, rather than
  //      `try/catch/finally`. The compiler cannot lower a `finally` clause at
  //      all. Equivalent here because the `catch` swallows everything and
  //      neither block contains a `return`, so the tail is unconditionally
  //      reached on both paths.
  //   2. A `while` drain loop rather than the tail-recursive call this used to
  //      make into itself. A `const`-bound function referring to its own
  //      binding reads to the compiler as "accessed before it is declared"
  //      (and, as a named function expression, trips an internal error).
  //      Equivalent because the old recursion happened synchronously right
  //      after clearing `inFlight`/`pending`, with no `await` in between, so
  //      no other caller could ever interleave — exactly what the loop does,
  //      just without leaving and re-entering the function. Nothing awaits
  //      `fetchFrame`, so the loop resolving later than the old call did is
  //      unobservable.
  const fetchFrame = useCallback(async (frame: number, longEdge: number) => {
    if (inFlight.current) {
      pending.current = frame;
      return;
    }
    inFlight.current = true;
    let next: number | null = frame;
    while (next !== null) {
      const at = next;
      try {
        const src = await invoke<string>('chroma_timeline_frame', {
          pos: Math.max(0, Math.round(at)),
          maxLongEdge: longEdge,
        });
        setFrameSrc(src);
        setDecodeErr(null);
      } catch (e) {
        setDecodeErr(String(e));
      }
      next = pending.current;
      pending.current = null;
    }
    inFlight.current = false;
  }, []);

  // scrub: refetch on playhead change while paused
  useEffect(() => {
    if (playing || !timeline) return;
    fetchFrame(playhead, PREVIEW_LONG_EDGE);
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
    // `startFrame` is already the frame on screen — the paused scrub effect
    // fetched it. Seeding `lastRequested` with it (rather than -1) skips a
    // redundant re-request of a frame we already have, which on the Rust side
    // is a *backward* step for that clip's decode pipe and so would force a
    // full ffmpeg respawn + keyframe seek at the exact moment playback starts
    // (D-125).
    let lastRequested = startFrame;
    // A scrub fetch may still be in flight from just before Play was pressed.
    // `chroma_timeline_frame` runs off the main thread now (D-125), so the two
    // really can overlap — they share `inFlight` so they can't interleave
    // requests into the same decode pipes, and any queued scrub frame is
    // dropped rather than fired mid-playback.
    pending.current = null;
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
      if (!inFlight.current && want !== lastRequested) {
        inFlight.current = true;
        lastRequested = want;
        setPlayhead(want);
        try {
          const src = await invoke<string>('chroma_timeline_frame', {
            pos: want,
            maxLongEdge: PREVIEW_LONG_EDGE,
          });
          setFrameSrc(src);
        } catch {
          /* keep going — a heavy clip can drop frames */
        }
        // D-201 — the former `finally` body, inline: see `fetchFrame`'s own
        // note above for why this is a plain tail rather than a `finally`
        // clause, and why it is exactly equivalent here.
        inFlight.current = false;
        // Drain exactly like `fetchFrame` does. Pausing mid-fetch makes the
        // scrub effect run while this request is still in flight, so it parks
        // its frame in `pending` — without this it would never be fetched and
        // the preview would sit on the last frame playback happened to render
        // rather than the paused one. (`pending` can only be non-null once
        // `playing` is already false: the scrub effect early-returns while
        // playing, and play start clears it.)
        const queued = pending.current;
        if (queued !== null) {
          pending.current = null;
          fetchFrame(queued, PREVIEW_LONG_EDGE);
        }
      }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      stopped = true;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = null;
    };
    // `fetchFrame` is a `useCallback` with no deps, so it is referentially
    // stable and never re-runs this effect — listed because the play loop now
    // really does call it (to drain a scrub frame queued during a pause).
  }, [playing, timeline, duration, fps, lastFrame, setPlayhead, setPlaying, fetchFrame]);

  // audio (D-049): start/stop in lockstep with the same `playing` transitions
  // that (re)baseline the video rAF loop above — both begin from the same
  // playhead frame at the same moment, then free-run independently against
  // real wall-clock time (see chroma/audio.rs's module doc for why). No
  // audio during scrub (paused) — only real Play produces sound.
  //
  // Keyed on whether a timeline exists, NOT on the timeline object (D-130).
  // `timeline` is replaced by a brand-new object on every `load()` — including
  // the `EditorTab` window-`focus` refetch, which fires on the very click that
  // starts playback — and on every `applyOp`. Depending on its identity meant
  // any of those tore the audio session down and started a fresh one from
  // whatever the playhead had reached by then: you heard a second of audio,
  // then heard it again from a slightly different point. That is the "voice
  // loops / overlaps by a couple of seconds" report, and it only became
  // audible once D-125 made a session produce sound immediately instead of
  // spending its first few hundred ms emitting silence.
  //
  // Nothing about the session actually depends on this object: `run_session`
  // resolves its sources in Rust from the open project's own active timeline,
  // not from anything passed in here. A real change that matters — the project
  // closing, a different timeline becoming active — still stops playback,
  // because that flips `playing` or empties `timeline` outright.
  const hasTimeline = timeline !== null;
  useEffect(() => {
    if (!playing || !hasTimeline) {
      invoke('chroma_audio_stop', { seq: nextAudioSeq() }).catch(() => {});
      return;
    }
    const startFrame = useEditorTimelineStore.getState().playhead;
    invoke('chroma_audio_play', { startFrame, seq: nextAudioSeq() }).catch((e) => {
      // A clip with no audio stream isn't an error on the Rust side
      // (chroma_audio_play returns Ok(()) and just plays nothing) — a
      // rejection here is a real decode/device failure. Not fatal to video
      // playback, so just log it rather than surfacing a preview error.
      console.warn('chroma_audio_play failed:', e);
    });
    return () => {
      invoke('chroma_audio_stop', { seq: nextAudioSeq() }).catch(() => {});
    };
  }, [playing, hasTimeline]);

  const step = (d: number) => {
    if (playing) setPlaying(false);
    setPlayhead(playhead + d);
  };

  return (
    // D-126 — the real fullscreen target. `bg-bg-primary` matters here: a
    // fullscreened element has no ambient page background behind it, so
    // without an explicit one this would show through to black/transparent
    // outside the player's own content on displays with a different aspect
    // ratio than the video.
    <div ref={fullscreenRef} className="relative flex min-h-0 flex-1 flex-col bg-bg-primary">
      {/* D-199 — the canvas-size popover's own trigger button is
          self-positioned (`absolute top-2 right-10`, see that component's
          doc) against this div's own `relative`, the same pattern
          `EditorTab.tsx`'s Inspector toggle uses against ITS `relative`
          wrapper one level up. Rendered here (not `EditorTab.tsx`) because
          only this component owns `compSizeVersion`/`useCompositionSize`. */}
      <CanvasSettingsPopover />
      <Player
        title="Timeline"
        muted={muted}
        onMuteToggle={() => setMuted((m) => !m)}
        volume={volume}
        onVolumeChange={setVolume}
        onFullscreen={toggleFullscreen}
        isFullscreen={isFullscreen}
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
            <div ref={surfaceRef} className="relative flex h-full w-full items-center justify-center">
              <img src={frameSrc} alt="" draggable={false} className="max-h-full max-w-full object-contain" />
              <CanvasBoundary containerRef={surfaceRef} size={compSize} />
              <TransformOverlay containerRef={surfaceRef} />
            </div>
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
    </div>
  );
}
