/**
 * @apelles/editor — the preview pane (D-041, transport migrated to
 * `@apelles/player` — D-039 roadmap "Next" item 1).
 *
 * A plain `<img>` fed by `chroma_timeline_frame(playhead)` (a lightweight
 * backend decode→jpeg — no grade, no compositing). Play is a wall-clock
 * `requestAnimationFrame` loop that advances the playhead and refetches,
 * dropping frames to stay real-time (same pattern as the Colorist tab's
 * `ChromaTimeline.tsx`). This frame-fetch + play-loop logic is tab-owned and
 * stays here — only the rendered transport JSX (the hand-rolled button row)
 * moved to `<Player>`, which is purely presentational.
 *
 * **What triggers a refetch (B-088).** `chroma_timeline_frame` takes only a
 * position: it composites the open project's **persisted** manifest, so the
 * only two things that can make it return a different picture are the
 * playhead moving and the backend's own copy of the timeline changing. The
 * scrub effect below depends on exactly those two — `playhead` and the
 * store's `savedVersion` — and pointedly NOT on the `timeline` object, which
 * changes identity ~400 ms *before* the edit it carries has been persisted.
 * See that effect's own comment for the failure that caused.
 *
 * Audio session churn (D-130): the audio effect is keyed on whether a timeline
 * exists, not on the timeline object — see that effect's comment. And both
 * audio commands carry a monotonic `seq` (`nextAudioSeq`, `audioTransport.ts`),
 * because since D-125 they are `(async)` Tauri commands and so no longer
 * execute in the order they were invoked — see that module's own doc and
 * `chroma/audio.rs`'s `begin_request`.
 *
 * Tape-style scrub audio + the waveform strip (D-232, roadmap item 27): the
 * position bar's drag is now a real *gesture* (`Player`'s `onSeekStart`/
 * `onSeekEnd`), driving `scrubAudio.ts` — so dragging the playhead makes sound,
 * where "no audio during scrub" used to be the documented behaviour just below.
 * That is the same single Rust transport playback uses, which is why the play
 * effect below now also refuses to start under a live scrub. `<ScrubWaveform>`
 * is handed to `Player`'s `waveform` slot and shown when the store's
 * `waveformView` is on. See D-232.
 *
 * Audio (D-049): `chroma_audio_play(playhead)` / `chroma_audio_stop()` are
 * fired at exactly the same `playing` transitions that (re)baseline the video
 * rAF loop below — both start from the same playhead frame at the same
 * moment and then run independently against real wall-clock time (video via
 * `performance.now()`, audio via the device's own clock inside Rust). See
 * `chroma/audio.rs`'s module doc for why that's the deliberate sync model
 * rather than a tighter per-frame coupling. (D-049 scoped scrub audio out
 * entirely; D-232 put it back, as its own position-driven mode — see above.)
 *
 * Frame payload (D-217): `chroma_timeline_frame` answers with the JPEG's raw
 * bytes (an `ArrayBuffer`), not a `data:image/jpeg;base64,…` string, and this
 * file wraps them in a `Blob` object URL — see `PREVIEW_MIME` and `frameUrl`.
 * Base64 turned out NOT to be where playback's time went (0.01 ms/frame in
 * Rust, measured); the real cost was the CPU compositor, fixed in `edit.rs` in
 * the same pass. The binary payload stayed because it is strictly cheaper on
 * this side too — no hundreds-of-KB string to parse and base64-decode per
 * displayed frame — not because it was the bottleneck. See D-217.
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
 * Mute/volume + fullscreen (D-126): `muted`/`volume` are UI state, not project
 * data — real-time monitoring volume, applied in `audio.rs`'s output callback
 * via `chroma_audio_set_volume`, entirely separate from any track's actual
 * `gain`. **They moved out of this component's `useState` and into
 * `timelineStore` in D-266**, unchanged in meaning, so that
 * `editor_set_audio_monitor` drives the same two values the speaker button and
 * the slider do instead of a parallel copy — the same lift, for the same
 * reason, `waveformView` got in D-232. Fullscreen uses the real browser
 * Fullscreen API on a local
 * wrapper `<div>` around `<Player>` (not a ref forwarded through `Player`
 * itself, which stays presentational-only) — a `fullscreenchange` listener
 * keeps `isFullscreen` in sync with reality, since the browser's own Esc
 * handling exits fullscreen without ever calling this component's own click
 * handler.
 *
 * On-canvas transform handles (D-136, Phase 1 of
 * `docs/notes/on-canvas-transform.md`): `<TransformOverlay>` renders as a
 * sibling of the `<img>`, both children of the preview surface div — an
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
 *
 * Canvas click-to-select (D-204, fixing B-085): `useCanvasClipPick` is a
 * BEHAVIOUR, not a fifth thing in the overlay stack — it listens on
 * the preview surface in the capture phase and decides, per press, whether
 * that press is a selection or a `TransformOverlay` drag. It is deliberately not
 * an overlay div: a full-bleed hit layer under `TransformOverlay` cannot work,
 * because a full-frame clip's own transform box is full-bleed too and would
 * swallow every press. See that hook's own doc.
 *
 * Preview viewport zoom + pan (D-218, roadmap item 25's "No canvas/preview
 * zoom control"; owner, live, with a screenshot: "i should be able to zoom in
 * the canvas also"): a DISPLAY-only magnification of the composited frame —
 * it touches no `Clip.scale`/`position_*` and no composition size. The state
 * is `timelineStore`'s `previewView` (UI state, like `selection`, and for
 * D-216's reasons: not undoable, not persisted), the math is
 * `previewZoom.ts`, and it is applied in exactly TWO places, which is what
 * keeps the picture and the overlays from ever disagreeing:
 *   1. **the `<img>`** — a CSS `translate(...) scale(...)` about its own
 *      centre. A compositor-only transform, so a zoom or a pan costs no
 *      layout, no re-decode and no IPC (the picture is a server-rendered
 *      JPEG — see `docs/notes/on-canvas-transform.md`'s "no cheap live
 *      re-render" finding, which is exactly why zoom must not be a re-render).
 *   2. **`usePreviewContentBox`** — the same transform, arithmetically, on
 *      the `useContentBox` fit rect all three overlays measure against.
 * `zoomedContentBox`'s output is precisely the `<img>`'s own transformed box,
 * so `TransformOverlay`'s handles, `CanvasBoundary`'s frame and
 * `useCanvasClipPick`'s hit test all stay correct at every zoom level and pan
 * offset with no change to any of their own fraction<->pixel math.
 *
 * The gesture split mirrors `TimelinePane.tsx`'s own, deliberately, so muscle
 * memory transfers within the tab: **ctrl/pinch-wheel zooms** (anchored at the
 * pointer), a **plain wheel pans**. See `onWheel` below for why `ctrlKey` is
 * the right test and why the listener has to be a native non-passive one.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { Loader2 } from 'lucide-react';
import { Player, useContentBox } from '@apelles/player';
import { useShortcut } from '@apelles/keymap';

import { useEditorTimelineStore } from './timelineStore';
import { timelineDuration, timelineFps } from './timeline';
import { TransformOverlay } from './TransformOverlay';
import { DynamicZoomOverlay } from './DynamicZoomOverlay';
import { CanvasBoundary } from './CanvasBoundary';
import { useCanvasClipPick } from './useCanvasClipPick';
import { CanvasSettingsPopover } from './CanvasSettingsPopover';
import { EditOverlay } from './EditOverlay';
import { useCompositionSize } from './useCompositionSize';
import {
  fitPointAt,
  FIT_VIEW,
  MAX_PREVIEW_ZOOM,
  MIN_PREVIEW_ZOOM,
  isFitView,
  pannedByPixels,
  steppedZoom,
} from './previewZoom';
import { recordPreviewTiming } from './previewTiming';
import { nextAudioSeq } from './audioTransport';
import { beginScrub, endScrub, isScrubbing, updateScrub } from './scrubAudio';
import { ScrubWaveform } from './ScrubWaveform';

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
 * The wire format `chroma_timeline_frame` answers in (D-217).
 *
 * It hands back the JPEG's raw bytes as an `ArrayBuffer` — a `tauri::ipc::
 * Response`, which Tauri's IPC delivers as `application/octet-stream` — rather
 * than the `data:image/jpeg;base64,…` string it returned until D-217. Rust
 * knows the format; the bytes do not carry it, so the `Blob` this side has to
 * be told, and that is the one place the two ends have to agree. See D-217 for
 * why the blank/out-of-range frame is a 1×1 JPEG now rather than a PNG: it is
 * this constant that a second format would have broken.
 */
const PREVIEW_MIME = 'image/jpeg';

// D-249 added a `headerActions` prop here (`Player`'s own `menu` slot) for
// the Edit tab's Export dialog; D-251 moved Export again, out of this tab
// entirely, to `@apelles/shell`'s chrome bar (see `EditorTab.tsx`'s own note
// at its `<PreviewPane />` call site and `Shell.tsx`'s module doc). Nothing
// else ever used the slot, so the prop is removed rather than left with no
// caller — `Player`'s own `menu` prop is untouched and still generally
// available to any future caller that needs it.
export function PreviewPane() {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const playhead = useEditorTimelineStore((s) => s.playhead);
  const playing = useEditorTimelineStore((s) => s.playing);
  // B-088 — the scrub effect's refetch trigger. NOT `timeline`: see that
  // effect's own comment, and `savedVersion`'s doc in `timelineStore.ts`.
  const savedVersion = useEditorTimelineStore((s) => s.savedVersion);
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);
  const setPlaying = useEditorTimelineStore((s) => s.setPlaying);
  // D-232 — the waveform strip's own visibility. Store state, not local
  // `useState`, so `editor_set_waveform_view` drives the same flag the human's
  // toggle does; see the field's own doc in `timelineStore.ts`.
  const waveformView = useEditorTimelineStore((s) => s.waveformView);
  const setWaveformView = useEditorTimelineStore((s) => s.setWaveformView);

  const [frameSrc, setFrameSrc] = useState<string | null>(null);
  const [decodeErr, setDecodeErr] = useState<string | null>(null);
  // D-217 — the object URL `frameSrc` currently points at. An object URL lives
  // until it is revoked, and playback mints one per displayed frame, so the
  // previous one is released as the next replaces it (and the last one on
  // unmount, below). Revoking the OLD url right after handing React the NEW one
  // is safe: the `<img>` is being pointed away from it in the same commit, so
  // no load that matters is still reading it.
  const frameUrl = useRef<string | null>(null);
  const inFlight = useRef(false);
  const pending = useRef<number | null>(null);
  const rafRef = useRef<number | null>(null);
  // D-136 — the container `TransformOverlay`, `CanvasBoundary` and
  // `useCanvasClipPick` all measure their content box against. Must be the
  // same element the `<img>` is `object-contain`-fit within, i.e. its own
  // parent, not `Player`'s outer viewport div (which also holds letterboxing
  // bars this must NOT include).
  //
  // **State + a callback ref, not `useRef` (B-085 follow-up, 2026-09-07).**
  // This element only exists once the first frame has decoded, and a ref
  // object populated mid-commit tells nobody: every consumer's measurement
  // effect had already run against `null` (the composition size resolves in
  // milliseconds, the frame in hundreds), stored a 0×0 box, and never re-ran.
  // Holding the node in state makes it appearing a real render, which is what
  // React's docs prescribe for exactly this. See `useContentBox`'s own note.
  const [surfaceEl, setSurfaceEl] = useState<HTMLDivElement | null>(null);

  // D-126/D-266 — mute/volume: monitoring state, not project data (see the
  // module doc). `volume` is the last non-zero level, remembered across a
  // mute toggle so unmuting restores it instead of resetting to unity. In the
  // store rather than in `useState` so `editor_set_audio_monitor` writes the
  // very same values this reads — see the fields' own docs in `timelineStore`.
  const muted = useEditorTimelineStore((s) => s.monitorMuted);
  const volume = useEditorTimelineStore((s) => s.monitorVolume);
  const setAudioMonitor = useEditorTimelineStore((s) => s.setAudioMonitor);
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
  // Whether a timeline exists at all, as a boolean — deliberately not the
  // object. Two effects below depend on this exact distinction, for two
  // different reasons (D-130's audio-session churn, and B-088's stale
  // preview); see each of their own comments.
  const hasTimeline = timeline !== null;

  // D-199 — the canvas/composition boundary overlay's size, selection-
  // independent (unlike `TransformOverlay`'s per-clip `useClipGeometry`).
  // Refetches itself on a `CanvasSettingsPopover` save via the backend's own
  // `chroma://project-settings-changed` broadcast (B-086) — see that hook's
  // own doc.
  const compSize = useCompositionSize(!!timeline);

  // D-204 (B-085) — canvas click-to-select. A behaviour, not a surface: it
  // listens on the preview surface in the CAPTURE phase so it can decide, per
  // press, whether this is a selection or a `TransformOverlay` drag — see that
  // hook's own doc for why no z-ordered overlay div can make that call
  // correctly.
  useCanvasClipPick(surfaceEl, compSize);

  // ---- D-218: preview viewport zoom + pan --------------------------------
  //
  // The FIT box — `useContentBox` with no zoom applied. Deliberately the raw
  // fit rect and not `usePreviewContentBox`'s zoomed one: everything below
  // converts a SCREEN delta into `previewZoom.ts`'s fit-box fractions, and
  // the fit box is the fixed reference frame those fractions are defined
  // against (see that module's own units note). Same element + same size the
  // three overlays measure, so it is the same rect by construction.
  const fitBox = useContentBox(surfaceEl, compSize);
  const previewView = useEditorTimelineStore((s) => s.previewView);
  const setPreviewView = useEditorTimelineStore((s) => s.setPreviewView);

  // The wheel listener below is registered once per surface element and reads
  // both of these through refs rather than closing over them, so a zoom, a
  // pan or a panel resize never tears down and re-adds a listener on the
  // preview's hottest surface. (`useCanvasClipPick` re-registering per render
  // is a known, separately-tracked cost — roadmap item 25; this does not add
  // a second one.)
  const fitRef = useRef(fitBox);
  const viewRef = useRef(previewView);
  useEffect(() => {
    fitRef.current = fitBox;
    viewRef.current = previewView;
  }, [fitBox, previewView]);

  /** The `<img>`'s own CSS transform — the picture half of the zoom. A
   *  `translate` + `scale` about the element's default centre origin, which
   *  is exactly what `zoomedContentBox` computes arithmetically for the
   *  overlays, so the two cannot drift. `undefined` at fit so the common case
   *  sets no transform at all. */
  const imageTransform = isFitView(previewView)
    ? undefined
    : `translate(${previewView.panX * fitBox.width}px, ${previewView.panY * fitBox.height}px) scale(${previewView.zoom})`;

  const zoomBy = useCallback(
    (direction: 'in' | 'out', anchor: { x: number; y: number }) => {
      setPreviewView((prev) => steppedZoom(prev, anchor, direction));
    },
    [setPreviewView],
  );

  // The toolbar buttons have no pointer to anchor to, so they zoom about the
  // fit box's centre — `{x: 0, y: 0}` in fit-relative space.
  const zoomIn = useCallback(() => zoomBy('in', { x: 0, y: 0 }), [zoomBy]);
  const zoomOut = useCallback(() => zoomBy('out', { x: 0, y: 0 }), [zoomBy]);
  const zoomReset = useCallback(() => setPreviewView(FIT_VIEW), [setPreviewView]);

  // Scroll-wheel zoom / pan — the same split, for the same reasons, as
  // `TimelinePane.tsx`'s own (read its comment; this is the deliberate mirror
  // of it, not a second invention):
  //   - A native, NON-PASSIVE listener rather than React's `onWheel`, which
  //     React attaches passively by default and which therefore silently
  //     ignores `preventDefault()` — without that call the webview runs its
  //     own ctrl+wheel PAGE zoom on top of ours.
  //   - `ctrlKey` is the test, not a physical Ctrl key: a trackpad PINCH and
  //     an explicit Ctrl+scroll both arrive as a `wheel` with `ctrlKey: true`,
  //     synthesized by the browser itself, while a plain two-finger scroll
  //     arrives with `ctrlKey: false`. So pinch/Ctrl = zoom, plain = pan,
  //     which is the standard web/canvas convention and the one the timeline
  //     already trained the user on.
  //   - `preventDefault` only when the gesture actually does something: at
  //     fit there is nothing to pan to (`clampPreviewView` pins the pan to
  //     zero), so a plain scroll is left entirely alone rather than being
  //     swallowed.
  useEffect(() => {
    const el = surfaceEl;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      const fit = fitRef.current;
      if (fit.width <= 0 || fit.height <= 0) return;
      const rect = el.getBoundingClientRect();
      if (e.ctrlKey) {
        e.preventDefault();
        const anchor = fitPointAt({ x: e.clientX - rect.left, y: e.clientY - rect.top }, fit);
        setPreviewView((prev) => steppedZoom(prev, anchor, e.deltaY < 0 ? 'in' : 'out'));
        return;
      }
      if (viewRef.current.zoom <= 1) return;
      e.preventDefault();
      setPreviewView((prev) => pannedByPixels(prev, fit, e.deltaX, e.deltaY));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [surfaceEl, setPreviewView]);

  /** Put one freshly-fetched frame's bytes on screen, releasing the previous
   *  frame's object URL (D-217 — see `frameUrl`'s own note). */
  const showFrame = useCallback((bytes: ArrayBuffer) => {
    // D-219 (debug-tooling piece 5) — one timestamp per frame that reaches
    // the screen, so `debug_frame_timing` can report the real playback
    // interval D-217 had no way to measure. `import.meta.env.DEV` is folded
    // to `false` by `vite build`, so this line and `previewTiming.ts` itself
    // are dropped from a production bundle — it is a compile-time gate, not
    // a flag.
    if (import.meta.env.DEV) recordPreviewTiming('paint');
    const url = URL.createObjectURL(new Blob([bytes], { type: PREVIEW_MIME }));
    const previous = frameUrl.current;
    frameUrl.current = url;
    setFrameSrc(url);
    if (previous) URL.revokeObjectURL(previous);
  }, []);

  useEffect(
    () => () => {
      if (frameUrl.current) URL.revokeObjectURL(frameUrl.current);
      frameUrl.current = null;
    },
    [],
  );

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
        const bytes = await invoke<ArrayBuffer>('chroma_timeline_frame', {
          pos: Math.max(0, Math.round(at)),
          maxLongEdge: longEdge,
        });
        showFrame(bytes);
        setDecodeErr(null);
      } catch (e) {
        setDecodeErr(String(e));
      }
      next = pending.current;
      pending.current = null;
    }
    inFlight.current = false;
  }, [showFrame]);

  // scrub: refetch on playhead change — or on a real backend timeline
  // change — while paused.
  //
  // **B-088 — keyed on `savedVersion`, NOT on the `timeline` object.**
  // `chroma_timeline_frame` composites the project's PERSISTED manifest off
  // disk; it is handed no timeline. `applyOp` updates the store's `timeline`
  // optimistically and persists it 400 ms later (`SAVE_DEBOUNCE_MS`). So
  // depending on `timeline`'s identity meant every edit fired exactly one
  // fetch, ~400 ms BEFORE the state it was supposed to show existed on the
  // backend — the frame that came back was the pre-edit picture, and since
  // nothing changed identity again once the save landed, nothing ever
  // refetched. The preview sat one edit behind for the rest of the session,
  // with no error: transforms set via the Inspector or the MCP surface
  // appeared to do nothing, and dragging `TransformOverlay`'s handles moved
  // its box (drawn from the live store) over a picture that never moved.
  // `savedVersion` bumps only when the backend really does hold the new
  // timeline, which is exactly when a refetch can return something new.
  useEffect(() => {
    if (playing || !hasTimeline) return;
    fetchFrame(playhead, PREVIEW_LONG_EDGE);
  }, [playhead, playing, hasTimeline, savedVersion, fetchFrame]);

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
      // D-219 — the other half of the frame-timing readout: how often the rAF
      // loop got to run at all. A stalled `raf` channel next to a healthy
      // `paint` one is the signature of a THROTTLED (backgrounded) window,
      // which is precisely the blocker that stopped D-217 measuring this from
      // outside. Same `import.meta.env.DEV` compile-time gate as `showFrame`.
      if (import.meta.env.DEV) recordPreviewTiming('raf');
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
          const bytes = await invoke<ArrayBuffer>('chroma_timeline_frame', {
            pos: want,
            maxLongEdge: PREVIEW_LONG_EDGE,
          });
          showFrame(bytes);
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
  }, [playing, timeline, duration, fps, lastFrame, setPlayhead, setPlaying, fetchFrame, showFrame]);

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
  useEffect(() => {
    if (!playing || !hasTimeline) {
      // D-232 — a live scrub owns the SAME transport (see `scrubAudio.ts`), so
      // an unconditional stop here would kill it: the position bar's own drag
      // sets `playing` false on its first move, which runs exactly this branch.
      // A scrub's end is `endScrub`'s business and nothing else's.
      if (!isScrubbing()) invoke('chroma_audio_stop', { seq: nextAudioSeq() }).catch(() => {});
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
      if (!isScrubbing()) invoke('chroma_audio_stop', { seq: nextAudioSeq() }).catch(() => {});
    };
  }, [playing, hasTimeline]);

  // D-232 — the transport's own scrub gesture. `Player` reports the position
  // bar's drag as a real start/move/end triple (`onSeek` alone cannot tell a
  // drag from a programmatic seek), and this hands each straight to the shared
  // driver, which is the same one `TimelinePane`'s cursor drag uses.
  const onSeekStart = useCallback(
    (frame: number) => {
      setPlaying(false);
      setPlayhead(frame);
      beginScrub(frame);
    },
    [setPlaying, setPlayhead],
  );
  const onSeekMove = useCallback(
    (frame: number) => {
      setPlaying(false);
      setPlayhead(frame);
      updateScrub(frame);
    },
    [setPlaying, setPlayhead],
  );

  const step = (d: number) => {
    if (playing) setPlaying(false);
    setPlayhead(playhead + d);
  };

  // D-272 — the Edit tab's transport shortcuts. Space/←/→ were bound to
  // NOTHING before this pass: the preview had click-only transport buttons and
  // not one key anywhere in the app reached them, which is the owner's own
  // report ("play should play the preview"). Verified by audit, not assumed —
  // there was no `Space` handler in `packages/*` or `app/src` at all outside
  // Colorist's own `cycle_zoom`.
  //
  // Registered here rather than in `Player` because `Player` is the shared,
  // stateless presentation component all three tabs embed (D-039): it is
  // handed `playing`/`onPlayPause` and owns neither. This pane owns the Edit
  // tab's transport state, so it is what can claim the action. The Motion tab
  // has its own transport and can claim the same registry ids later without
  // either pane learning about the other — only one of them is ever in scope.
  //
  // Gated on a timeline actually being loaded, so Space in an empty Edit tab
  // stays inert rather than toggling a `playing` flag with nothing to play.
  useShortcut('edit.play_pause', () => setPlaying(!playing), { enabled: hasTimeline });
  useShortcut('edit.frame_back', () => step(-1), { enabled: hasTimeline });
  useShortcut('edit.frame_forward', () => step(1), { enabled: hasTimeline });

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
          only this component owns `useCompositionSize`. */}
      <CanvasSettingsPopover />
      {/* D-239 — the seven edit types' drop overlay. Mounted here, over the
          WHOLE pane rather than inside `surface` below, deliberately: it has to
          be reachable while the preview is still showing its spinner or "no
          frame", which is exactly the state a first drop onto an empty timeline
          happens in. It arms itself off a media drag and renders nothing
          otherwise, so it costs an unmounted component the rest of the time. */}
      <EditOverlay />
      <Player
        title="Timeline"
        muted={muted}
        onMuteToggle={() => setAudioMonitor({ muted: !muted })}
        volume={volume}
        onVolumeChange={(v) => setAudioMonitor({ volume: v })}
        onFullscreen={toggleFullscreen}
        isFullscreen={isFullscreen}
        // D-218 — the zoom cluster, mirroring the timeline toolbar's own. A
        // bound is expressed by withholding that direction's callback, which
        // `Player` renders as a disabled button (its own documented
        // contract) — the same information the timeline conveys by its
        // `clampPxPerSec` simply not moving, made visible here because a
        // preview zoom has a reset the timeline's does not.
        zoom={previewView.zoom}
        onZoomIn={previewView.zoom < MAX_PREVIEW_ZOOM ? zoomIn : undefined}
        onZoomOut={previewView.zoom > MIN_PREVIEW_ZOOM ? zoomOut : undefined}
        onZoomReset={isFitView(previewView) ? undefined : zoomReset}
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
            // D-218 — `overflow-hidden`: a zoomed-in picture (and the
            // overlay boxes drawn over it) is larger than this surface, and
            // must be clipped at the surface's own edge rather than spilling
            // over the transport bar. It cannot introduce a scrollbar and so
            // cannot change what `useContentBox` measures here — the pan is a
            // transform, never real scroll (see D-218 for why that
            // distinction is the whole design).
            <div
              ref={setSurfaceEl}
              data-preview-surface
              className="relative flex h-full w-full items-center justify-center overflow-hidden"
            >
              <img
                src={frameSrc}
                alt=""
                draggable={false}
                className="max-h-full max-w-full object-contain"
                // D-218 — the picture half of the viewport zoom. Compositor-
                // only, so a zoom/pan costs no layout and no re-decode; the
                // overlays get the arithmetically identical transform through
                // `usePreviewContentBox`. See this module's own doc.
                style={{ transform: imageTransform }}
              />
              <CanvasBoundary container={surfaceEl} size={compSize} />
              {/* D-234 — the two overlays are mutually exclusive by
                  construction: each renders `null` when the other owns the
                  picture (`TransformOverlay` stands aside for the armed clip,
                  `DynamicZoomOverlay` draws only for it), so both can be
                  mounted unconditionally and neither needs this pane to know
                  which mode is active. */}
              <TransformOverlay container={surfaceEl} />
              <DynamicZoomOverlay container={surfaceEl} />
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
        // D-232 — a position-bar drag is a scrub gesture, not a series of
        // unrelated seeks: `onSeekStart` claims the audio transport,
        // `onSeek` steers it, `onSeekEnd` releases it (including on unmount
        // mid-drag — `Player` guarantees that pairing).
        onSeek={onSeekMove}
        onSeekStart={onSeekStart}
        onSeekEnd={endScrub}
        waveform={<ScrubWaveform />}
        waveformOn={waveformView}
        onWaveformToggle={() => setWaveformView(!waveformView)}
      />
    </div>
  );
}
