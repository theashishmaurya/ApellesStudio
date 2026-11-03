/**
 * @apelles/editor — the preview pane (D-041, transport migrated to
 * `@apelles/player` — D-039 roadmap "Next" item 1).
 *
 * **The picture is native (D-454).** The pane's surface is a transparent hole
 * in the webview; under it, a `CAMetalLayer` shows the frame the GPU render
 * engine drew, with no read-back, no JPEG and no IPC payload
 * (`chroma::preview_surface`, `docs/notes/preview-gpu-surface.md`). This file
 * owns the transport state and the overlays; `nativePreview.ts` keeps the
 * native layer under the surface and tells Rust which frame to show while
 * paused (the playhead, a skimmed frame, the same frame after an edit landed
 * — B-088's `savedVersion` rule), and hands playback over to Rust. Until D-454
 * the picture was an `<img>` fed by `chroma_timeline_frame` (decode,
 * composite, read back, JPEG, IPC, decode again in WebContent; D-217/D-290)
 * and played by a `requestAnimationFrame` loop here; that path is deleted.
 *
 * **Playback (D-454).** Play hands the loop to Rust: it is clocked by the
 * display (one queued drawable) and slaved to the audio clock
 * (`apelles_media::audio_clock`), and reports each frame it shows, which moves
 * the store's playhead; the end of the timeline stops the transport. A rate
 * change or a seek while playing restarts it from the playhead, exactly the
 * re-baselining a Play toggle does (D-280, B-326). Audio (D-049/D-050) still
 * starts and stops at the same transitions, from this file (see the audio
 * effect); the picture now follows the sound rather than both free-running.
 *
 * Audio session churn (D-130): the audio effect is keyed on whether a timeline
 * exists, not on the timeline object — see that effect's comment. Both audio
 * commands carry a monotonic `seq` (`nextAudioSeq`, `audioTransport.ts`),
 * because they are `(async)` Tauri commands and do not run in issue order.
 *
 * Tape-style scrub audio + the waveform strip (D-232): the position bar's drag
 * is a real gesture (`Player`'s `onSeekStart`/`onSeekEnd`), driving
 * `scrubAudio.ts`, the same single Rust transport playback uses.
 *
 * Playback RATE (D-280): the transport can review the timeline at 0.25x–8x.
 * The picture follows the audio clock, which plays at that rate
 * pitch-preserved (`apelles_media::timestretch`). It is not a clip's
 * Speed/Retime property (D-236): nothing here writes to the project.
 *
 * Mute/volume (D-126/D-266): `muted`/`volume` are monitoring state in
 * `timelineStore`, applied in `audio.rs`'s output callback, separate from any
 * track's `gain`, and driven by `editor_set_audio_monitor` too.
 *
 * **Fullscreen (D-454, replacing D-126's DOM fullscreen).** The window's
 * native fullscreen, with the viewer given the whole window
 * (`data-viewer-fullscreen`, `app/src/styles.css`), as Final Cut's viewer does.
 * The DOM Fullscreen API would move the page into a fullscreen window of its
 * own, which the native picture is not in. Esc, the green button and
 * Ctrl-Cmd-F all leave it; the window's fullscreen state comes back as an
 * event, so the layout follows however it was left.
 *
 * On-canvas transform handles (D-136), the canvas boundary (D-199), the safe
 * area (D-431), crop (D-443), highlights (D-396), captions (D-316) and the
 * two-up trim viewer (D-432) are DOM siblings in the surface, over the hole,
 * and keep the pointer. Canvas click-to-select (D-204) is a capture-phase
 * behaviour on the surface (`useCanvasClipPick`).
 *
 * Preview viewport zoom + pan (D-218): a DISPLAY-only magnification, state in
 * `timelineStore`'s `previewView`, math in `previewZoom.ts`, applied in one
 * place, `usePreviewContentBox`: the picture's box every overlay measures and
 * the box the native presenter draws the frame in, so the picture and the
 * overlays cannot disagree. Ctrl/pinch-wheel zooms about the pointer, a plain
 * wheel pans (the timeline's own split).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { BrandedLoader } from '@apelles/ui';
import { audioPlay, audioSetVolume, audioStop, onWindowFullscreen, setPreviewFullscreen } from '@apelles/bridge';
import { Player, useContentBox, type PlayerProps } from '@apelles/player';
import { useShortcut } from '@apelles/keymap';

import { useEditorTimelineStore } from './timelineStore';
import { TwoUpViewer } from './TwoUpViewer';
import { createShuttle } from './shuttle';
import { timelineDuration, timelineFps } from './timeline';
import { TransformOverlay } from './TransformOverlay';
import { DynamicZoomOverlay } from './DynamicZoomOverlay';
import { CropOverlay } from './CropOverlay';
import { HighlightOverlay } from './HighlightOverlay';
import { CaptionTransformOverlay } from './CaptionTransformOverlay';
import { CanvasBoundary } from './CanvasBoundary';
import { SafeAreaOverlay } from './SafeAreaOverlay';
import { SafeAreaMenu } from './SafeAreaMenu';
import { editPoints, nextEditPoint, prevEditPoint } from './editPoints';
import { useCanvasClipPick } from './useCanvasClipPick';
import { EditOverlay } from './EditOverlay';
import { useCompositionSize } from './useCompositionSize';
import { usePreviewContentBox } from './usePreviewContentBox';
import {
  fitPointAt,
  FIT_VIEW,
  MAX_PREVIEW_ZOOM,
  MIN_PREVIEW_ZOOM,
  isFitView,
  pannedByPixels,
  steppedZoom,
} from './previewZoom';
import { useNativePreview } from './nativePreview';
import { nextAudioSeq } from './audioTransport';
import { beginScrub, endScrub, isScrubbing, updateScrub } from './scrubAudio';
import { ScrubWaveform } from './ScrubWaveform';
import { PreviewConversionNotice, usePendingConversionsAtPlayhead } from './PreviewConversionNotice';

/** The attribute on `<html>` that gives the viewer the whole window while the
 *  window is in native fullscreen (`app/src/styles.css`). */
export const VIEWER_FULLSCREEN_ATTR = 'data-viewer-fullscreen';


/** The transport's outer buttons go to edit points, not the ends (D-432 P5). */
const EDIT_POINT_LABELS = { start: 'Previous edit point (↑)', end: 'Next edit point (↓)' } as const;

/** D-432 P5 — the viewer header's format line: `1920×1080 · 24p`. */
export function viewerFormatLabel(size: { width: number; height: number } | null, fps: number): string {
  const rate = Number.isInteger(fps) ? String(fps) : fps.toFixed(2);
  return size ? `${size.width}×${size.height} · ${rate}p` : `${rate}p`;
}

export interface PreviewPaneProps {
  /** D-432 P5 — caller-owned controls at the viewer header's far left (the
   *  Edit tab's browser toggle). D-249's `headerActions` slot is not this:
   *  it held Export and went with it to the shell (D-251). */
  headerStart?: ReactNode;
  /** …and at its far right (the Inspector toggle). */
  headerEnd?: ReactNode;
}

/** D-437 S10 — `Player` fed the live playhead: the position bar and the
 *  timecode are the only parts of the viewer that change on every played
 *  frame, so they are the only part that renders for one. Everything else is
 *  handed down from `PreviewPane` unchanged (the picture surface keeps its
 *  identity, so React skips it). */
function PlayheadPlayer(props: Omit<PlayerProps, 'frame'>) {
  const frame = useEditorTimelineStore((s) => s.playhead);
  return <Player {...props} frame={frame} />;
}

export function PreviewPane({ headerStart, headerEnd }: PreviewPaneProps) {
  const timeline = useEditorTimelineStore((s) => s.timeline);
  // D-437 S10 — no reactive `playhead` here: this pane rendered on every
  // played frame for three readers, now each off React state — the scrub fetch
  // is a store subscription (below), a frame step reads the store at the
  // click, and the transport's position bar and timecode render in their own
  // `PlayheadPlayer`. A played frame renders this pane zero times.
  const playing = useEditorTimelineStore((s) => s.playing);
  // B-088 — the scrub effect's refetch trigger. NOT `timeline`: see that
  // effect's own comment, and `savedVersion`'s doc in `timelineStore.ts`.
  const savedVersion = useEditorTimelineStore((s) => s.savedVersion);
  const setPlayhead = useEditorTimelineStore((s) => s.setPlayhead);
  const setPlaying = useEditorTimelineStore((s) => s.setPlaying);
  // B-326 — a seek while playing re-baselines the video loop and audio session.
  const seekEpoch = useEditorTimelineStore((s) => s.seekEpoch);
  // D-232 — the waveform strip's own visibility. Store state, not local
  // `useState`, so `editor_set_waveform_view` drives the same flag the human's
  // toggle does; see the field's own doc in `timelineStore.ts`.
  const waveformView = useEditorTimelineStore((s) => s.waveformView);
  const setWaveformView = useEditorTimelineStore((s) => s.setWaveformView);
  // D-280 — the transport's playback RATE. Store state for the same reason
  // `waveformView` is: `editor_set_playback_rate` has to drive the very same
  // value the human's control does. Not a clip's Speed property — see the
  // field's own doc in `timelineStore.ts`.
  const playbackRate = useEditorTimelineStore((s) => s.playbackRate);
  const setPlaybackRate = useEditorTimelineStore((s) => s.setPlaybackRate);


  // D-136 — the container `TransformOverlay`, `CanvasBoundary`,
  // `useCanvasClipPick` and the native presenter all measure the picture's box
  // against: the preview surface, not `Player`'s outer viewport div.
  //
  // **State + a callback ref, not `useRef` (B-085 follow-up).** Every
  // consumer's measurement effect has to re-run when the element appears, and
  // a ref object populated mid-commit tells nobody.
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
    audioSetVolume(muted ? 0 : volume).catch(() => {});
  }, [muted, volume]);


  // D-454 — fullscreen is the WINDOW's native fullscreen, with the viewer
  // given the whole window (see the module doc). `viewerFullscreen` is the
  // layout; `enteredNative` remembers whether this pane put the window into
  // fullscreen (so leaving gives back a window the person had already made
  // fullscreen); the window's own state arrives as an event, so Esc, the green
  // button and Ctrl-Cmd-F all end the layout too.
  const [isFullscreen, setIsFullscreen] = useState(false);
  const enteredNative = useRef(false);
  const windowFullscreen = useRef(false);
  useEffect(
    () =>
      onWindowFullscreen((full) => {
        windowFullscreen.current = full;
        if (!full) {
          enteredNative.current = false;
          setIsFullscreen(false);
        }
      }),
    [],
  );
  const toggleFullscreen = useCallback(() => {
    if (isFullscreen) {
      setIsFullscreen(false);
      if (enteredNative.current) {
        enteredNative.current = false;
        void setPreviewFullscreen(false);
      }
      return;
    }
    setIsFullscreen(true);
    if (!windowFullscreen.current) {
      enteredNative.current = true;
      void setPreviewFullscreen(true);
    }
  }, [isFullscreen]);
  useEffect(() => {
    if (!isFullscreen) return;
    const root = document.documentElement;
    root.setAttribute(VIEWER_FULLSCREEN_ATTR, '');
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleFullscreen();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      root.removeAttribute(VIEWER_FULLSCREEN_ATTR);
      window.removeEventListener('keydown', onKey);
    };
  }, [isFullscreen, toggleFullscreen]);

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
  // D-411 Phase 0 — keyed on WHICH timeline (a short and the long-form are
  // two frames in one project), its own size override, and the saved revision.
  const compSize = useCompositionSize(
    timeline ? { id: timeline.id, output: timeline.output, revision: savedVersion } : null,
  );

  // D-204 (B-085) — canvas click-to-select. A behaviour, not a surface: it
  // listens on the preview surface in the CAPTURE phase so it can decide, per
  // press, whether this is a selection or a `TransformOverlay` drag — see that
  // hook's own doc for why no z-ordered overlay div can make that call
  // correctly.
  useCanvasClipPick(surfaceEl, compSize);

  // D-453 — a source under the playhead still being converted to optimized
  // media cannot be drawn: say so (which file, how far along, Cancel) instead
  // of a black frame or the decode's error. Changes only when that set does.
  const pendingConversions = usePendingConversionsAtPlayhead();

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

  // D-454 — the picture's box (fit + zoom and pan), the same one every overlay
  // measures, and the native preview drawn in it.
  const pictureBox = usePreviewContentBox(surfaceEl, compSize);
  const nativePreview = useNativePreview(surfaceEl, pictureBox);

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

  // D-453 (conform) — the last source under the playhead finished converting
  // (or the playhead left it): the frame that could not be drawn while it
  // converted is drawn again, so the picture appears without the user having
  // to nudge the playhead.
  const hadPendingConversions = useRef(false);
  const redrawPreview = nativePreview.redraw;
  useEffect(() => {
    const has = pendingConversions.length > 0;
    if (hadPendingConversions.current && !has) redrawPreview();
    hadPendingConversions.current = has;
  }, [pendingConversions, redrawPreview]);

  // audio (D-049): start/stop at the same `playing` transitions that start and
  // stop the native playback loop (`nativePreview.ts`). The loop follows the
  // audio clock this session drives (D-454), so the picture stays where the
  // sound is. No audio during scrub (paused) beyond D-232's tape scrub.
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
      if (!isScrubbing()) audioStop(nextAudioSeq()).catch(() => {});
      return;
    }
    const startFrame = useEditorTimelineStore.getState().playhead;
    // D-280 — `rate` makes the audio session run the timeline this many times
    // faster, PITCH-PRESERVED (`apelles_media::timestretch`), so fast review is
    // still intelligible rather than chipmunked or silent. It is a session
    // parameter, not a live one: a rate change re-runs this effect, which stops
    // the old session and starts a fresh one from the playhead the picture is
    // on — the same instant the video loop above re-baselines its own clock.
    audioPlay(startFrame, nextAudioSeq(), playbackRate).catch((e) => {
      // A clip with no audio stream isn't an error on the Rust side
      // (chroma_audio_play returns Ok(()) and just plays nothing) — a
      // rejection here is a real decode/device failure. Not fatal to video
      // playback, so just log it rather than surfacing a preview error.
      console.warn('chroma_audio_play failed:', e);
    });
    return () => {
      if (!isScrubbing()) audioStop(nextAudioSeq()).catch(() => {});
    };
    // D-280 — `playbackRate` joins `playing`/`hasTimeline` deliberately: it is
    // the third thing that genuinely changes what this session should be
    // playing. Adding it here and to the video loop above is what keeps the two
    // clocks starting from the same frame at the same moment (D-130's note
    // about NOT depending on the `timeline` object still stands — a rate is a
    // transport fact, not a timeline one, so this adds no session churn).
  }, [playing, hasTimeline, playbackRate, seekEpoch]);

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
    setPlayhead(useEditorTimelineStore.getState().playhead + d);
  };

  // D-273 — the Edit tab's transport shortcuts. Space/←/→ were bound to
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

  // D-432 P5 — the transport's outer buttons and Up / Down: previous / next
  // edit point (`editPoints.ts`). Read from the store at the moment of the
  // press, so this costs no subscription.
  const goToEdit = (dir: 'prev' | 'next') => {
    const { timeline: tl, playhead: at } = useEditorTimelineStore.getState();
    const points = editPoints(tl);
    if (playing) setPlaying(false);
    setPlayhead(dir === 'prev' ? prevEditPoint(points, at) : nextEditPoint(points, at));
  };
  useShortcut('edit.prev_edit', () => goToEdit('prev'), { enabled: hasTimeline });
  useShortcut('edit.next_edit', () => goToEdit('next'), { enabled: hasTimeline });

  // B-348 — J / K / L shuttle (`shuttle.ts`) and the I / O marks. The shuttle
  // controller is built once over the store; `kHeldRef` is true while K is down
  // (set by K's own handler, cleared by keyup / blur) so J / L step a frame.
  const shuttle = useMemo(
    () =>
      createShuttle({
        getPlaying: () => useEditorTimelineStore.getState().playing,
        setPlaying: (p) => useEditorTimelineStore.getState().setPlaying(p),
        getPlaybackRate: () => useEditorTimelineStore.getState().playbackRate,
        setPlaybackRate: (r) => useEditorTimelineStore.getState().setPlaybackRate(r),
        getPlayhead: () => useEditorTimelineStore.getState().playhead,
        seek: (f) => useEditorTimelineStore.getState().seekPlayhead(f),
        getFps: () => timelineFps(useEditorTimelineStore.getState().timeline),
        schedule: (tick) => {
          const id = requestAnimationFrame(tick);
          return () => cancelAnimationFrame(id);
        },
        now: () => performance.now(),
      }),
    [],
  );
  const kHeldRef = useRef(false);
  useEffect(() => {
    const release = () => {
      kHeldRef.current = false;
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'KeyK') release();
    };
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('blur', release);
    const unsubscribe = useEditorTimelineStore.subscribe((st, prev) => {
      if (st.playing !== prev.playing) shuttle.playingChanged(st.playing);
    });
    return () => {
      window.removeEventListener('keyup', onKeyUp);
      window.removeEventListener('blur', release);
      unsubscribe();
      shuttle.dispose();
    };
  }, [shuttle]);
  useShortcut('edit.shuttle_forward', () => shuttle.press('forward', kHeldRef.current), { enabled: hasTimeline });
  useShortcut('edit.shuttle_back', () => shuttle.press('reverse', kHeldRef.current), { enabled: hasTimeline });
  useShortcut(
    'edit.shuttle_stop',
    () => {
      kHeldRef.current = true;
      shuttle.stop();
    },
    { enabled: hasTimeline },
  );
  useShortcut('edit.mark_in', () => {
    const st = useEditorTimelineStore.getState();
    st.setMarks({ inPoint: st.playhead });
  }, { enabled: hasTimeline });
  useShortcut('edit.mark_out', () => {
    const st = useEditorTimelineStore.getState();
    st.setMarks({ outPoint: st.playhead });
  }, { enabled: hasTimeline });
  useShortcut('edit.clear_marks', () => useEditorTimelineStore.getState().setMarks({ inPoint: null, outPoint: null }), {
    enabled: hasTimeline,
  });

  return (
    // D-454 — the viewer's fullscreen root (`data-viewer-fullscreen-root`):
    // while the window is in native fullscreen for the viewer, this pane
    // covers the window and everything else is hidden (`app/src/styles.css`).
    // D-451 — `data-preview-hole`: transparent, so the native picture under
    // the webview shows through (`nativePreview.ts`).
    <div
      data-preview-hole
      data-viewer-fullscreen-root={isFullscreen ? '' : undefined}
      className="relative flex min-h-0 flex-1 flex-col bg-bg-primary"
    >
      {/* D-239 — the seven edit types' drop overlay. Mounted here, over the
          WHOLE pane rather than inside `surface` below, deliberately: it has to
          be reachable while the preview is still showing its spinner or "no
          frame", which is exactly the state a first drop onto an empty timeline
          happens in. It arms itself off a media drag and renders nothing
          otherwise, so it costs an unmounted component the rest of the time. */}
      <EditOverlay />
      <PlayheadPlayer
        title={timeline?.name || 'Untitled timeline'}
        formatLabel={viewerFormatLabel(compSize, fps)}
        headerStart={headerStart}
        headerEnd={headerEnd}
        onSkipStart={() => goToEdit('prev')}
        onSkipEnd={() => goToEdit('next')}
        skipLabels={EDIT_POINT_LABELS}
        muted={muted}
        onMuteToggle={() => setAudioMonitor({ muted: !muted })}
        volume={volume}
        onVolumeChange={(v) => setAudioMonitor({ volume: v })}
        onFullscreen={toggleFullscreen}
        isFullscreen={isFullscreen}
        // D-280 — the transport's playback rate. `setPlaybackRate` clamps, so
        // `Player` can hand back whatever the custom field produced without
        // this file (or the Rust session) having to trust it.
        rate={playbackRate}
        onRateChange={setPlaybackRate}
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
          timeline ? (
            // D-218 — `overflow-hidden`: a zoomed-in picture's overlay boxes
            // are larger than this surface and are clipped at its edge. It
            // cannot introduce a scrollbar, so it cannot change what
            // `useContentBox` measures here — the pan is a transform of the
            // box, never real scroll.
            <div
              ref={setSurfaceEl}
              data-preview-surface
              className="relative flex h-full w-full items-center justify-center overflow-hidden"
            >
              <CanvasBoundary container={surfaceEl} size={compSize} />
              {/* D-431 — the platform safe-area guide: a view aid over the
                  picture, pointer-events none, never part of an export. */}
              <SafeAreaOverlay container={surfaceEl} size={compSize} />
              {/* D-234 — mutually exclusive by construction: each renders
                  `null` when the other owns the picture. */}
              <TransformOverlay container={surfaceEl} />
              <DynamicZoomOverlay container={surfaceEl} />
              {/* D-443 — the crop mode's edge handles, only for the clip the
                  Inspector armed it for. */}
              <CropOverlay container={surfaceEl} />
              {/* D-396 — the clip's highlight boxes, only while "Edit boxes"
                  is on for it. */}
              <HighlightOverlay container={surfaceEl} />
              {/* D-316 — the caption box, only for a selected caption clip. */}
              <CaptionTransformOverlay container={surfaceEl} size={compSize} />
              {/* D-432 P3 — the two-up trim viewer, only while a roll / slip /
                  slide is dragged; on top of everything. */}
              <TwoUpViewer />
              {/* B-369 — the branded loader until the first frame is on screen;
                  a conversion in progress, or any error the surface reports,
                  instead. Over the hole, so the surface (and the native layer
                  under it) stays mounted. */}
              {pendingConversions.length > 0 ? (
                // D-453 (conform) — a source under the playhead is still being
                // converted: which file, how far, Cancel. Over the surface, so
                // the native view stays mounted under it.
                <div className="absolute inset-0 flex items-center justify-center bg-bg-primary">
                  <PreviewConversionNotice pending={pendingConversions} />
                </div>
              ) : nativePreview.error ? (
                <div className="absolute inset-x-0 bottom-2 text-center text-sm text-text-secondary">
                  preview error: {nativePreview.error}
                </div>
              ) : nativePreview.hasFrame ? null : (
                <div className="absolute inset-0 flex items-center justify-center">
                  <BrandedLoader variant="compact" label="Loading preview…" />
                </div>
              )}
            </div>
          ) : (
            <div className="text-sm text-text-secondary">no frame</div>
          )
        }
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
        viewControls={<SafeAreaMenu size={compSize} />}
        waveformOn={waveformView}
        onWaveformToggle={() => setWaveformView(!waveformView)}
      />
    </div>
  );
}
