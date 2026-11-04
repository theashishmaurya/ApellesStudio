/**
 * nativePreview.ts — the Edit preview on its native GPU surface (D-451; the
 * product preview since D-454, `docs/notes/preview-gpu-surface.md`).
 *
 * What it is: the hook `PreviewPane` runs to drive the Rust side
 * (`chroma::preview_surface`) through `@apelles/bridge`:
 *   - **the surface:** start the presenter on mount, keep the native
 *     `CAMetalLayer` exactly under the preview — it reads the surface's
 *     rectangle once per animation frame and sends it, with the picture's box
 *     (the same composition-fit box every overlay measures,
 *     `usePreviewContentBox`, zoom and pan included), only when either
 *     changed — and take it down on unmount. While the view is shown, `<html
 *     data-native-preview>` makes every element marked `data-preview-hole`
 *     transparent (the "hole" the layer shows through, B-006's mechanism);
 *   - **what is shown while paused:** the playhead's frame, a skimmed frame
 *     (`previewPeek.ts`), the same frame again when the backend's timeline
 *     changed (`savedVersion`, B-088) or the render size did (a resize, once
 *     it settles) — latest-wins, one request in flight
 *     ({@link createShowQueue});
 *   - **playback:** Play hands the loop to Rust (clocked by the display,
 *     slaved to the audio clock) and follows it: each frame it shows comes
 *     back as an event that moves the store's playhead, and the end of the
 *     timeline stops the transport.
 *
 * What it does NOT do: carry pixels, draw overlays (they stay in the DOM over
 * the hole and keep the pointer), or start the audio (the pane's audio effect
 * does, at the same transition, as before). The geometry and the show queue
 * are plain functions, unit-tested without a browser (`nativePreview.test.ts`).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import {
  onPreviewPlayhead,
  onPreviewPresent,
  placePreviewSurface,
  playPreviewSurface,
  showPreviewSurfaceFrame,
  showPreviewSurfaceTwoUp,
  startPreviewSurface,
  stopPreviewSurface,
  type PreviewSurfacePlacement,
  type PreviewSurfaceRect,
  type PreviewSurfaceTwoUpHalf,
} from '@apelles/bridge';

import { notifyPreviewFrameShown } from './loadPerf';
import { usePreviewPeekStore, type TwoUpHalf as TwoUpHalfView, type TwoUpView } from './previewPeek';
import { recordPreviewSpan, recordPreviewTiming } from './previewTiming';
import { timelineDuration, timelineFps } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import type { ContentBoxLike } from './transformGeometry';

/** The attribute on `<html>` that opens the hole. */
export const NATIVE_PREVIEW_ATTR = 'data-native-preview';

/** How long the layout must hold still before a frame is drawn again at a new
 *  render size (`needsRender`): a panel drag changes it in 128 px steps
 *  (`Placement::render_long_edge`), and redrawing on every step would ask the
 *  decoder for the same frame at each size it passes through. */
export const RERENDER_SETTLE_MS = 150;

/** Starts and stops in the order the effects asked for them: a remount runs
 *  the old effect's stop before the new one's start, and the Rust side must
 *  see them in that order too. */
let lifecycle: Promise<unknown> = Promise.resolve();

/** The play requests' monotonic stamp (`chroma_preview_surface_play` drops
 *  an older request that arrives after a newer one). */
let playSeq = 0;
function nextPlaySeq(): number {
  playSeq += 1;
  return playSeq;
}

export function sameRect(a: PreviewSurfaceRect | null, b: PreviewSurfaceRect | null): boolean {
  if (!a || !b) return a === b;
  return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
}

function rectOf(r: { left: number; top: number; width: number; height: number }): PreviewSurfaceRect {
  return { x: r.left, y: r.top, width: r.width, height: r.height };
}

/** `rgb(…)` / `rgba(…)` → 0-1 RGBA; anything else (a transparent pane) → black. */
export function cssColorToRgba(css: string): [number, number, number, number] {
  const m = /rgba?\(\s*([\d.]+)[ ,]+([\d.]+)[ ,]+([\d.]+)(?:[ ,/]+([\d.]+))?\s*\)/.exec(css);
  if (!m) return [0, 0, 0, 1];
  const a = m[4] === undefined ? 1 : Number(m[4]);
  if (a === 0) return [0, 0, 0, 1];
  return [Number(m[1]) / 255, Number(m[2]) / 255, Number(m[3]) / 255, 1];
}

/** The picture's box in viewport CSS pixels: the content box (surface-local)
 *  moved to where the surface is. `null` before the composition size is known. */
export function pictureRect(view: PreviewSurfaceRect, box: ContentBoxLike): PreviewSurfaceRect | null {
  if (!(box.width > 0 && box.height > 0)) return null;
  return { x: view.x + box.offsetX, y: view.y + box.offsetY, width: box.width, height: box.height };
}

/**
 * The placement for one measurement: the surface's rectangle, the picture's
 * box (zoom and pan included) and the letterbox colour. With no picture box
 * yet, the picture is the whole view.
 */
export function placementFromRects(
  view: PreviewSurfaceRect,
  picture: PreviewSurfaceRect | null,
  background: [number, number, number, number],
  visible: boolean,
): PreviewSurfacePlacement {
  const usable = picture && picture.width > 0 && picture.height > 0 ? picture : view;
  return {
    view,
    picture: usable,
    background,
    visible: visible && view.width >= 1 && view.height >= 1,
  };
}

/** A show queue's surroundings, injectable for the tests. */
export interface ShowQueueDeps {
  show: (position: number) => Promise<unknown>;
  onShown: (position: number) => void;
  onError: (error: string) => void;
}

/**
 * Latest-wins: one request in flight, the newest wanted position next, the
 * ones in between dropped (a scrub at 60 Hz asks faster than a decode seek
 * answers). A position already on screen is not asked for again unless it was
 * invalidated (`force`): the timeline changed under it, or the render size.
 * Nothing is asked before {@link ShowQueue.ready} (the surface has a size).
 */
export interface ShowQueue {
  want: (position: number, force?: boolean) => void;
  /** The surface is placed: show what is wanted. */
  ready: () => void;
  /** Playback put `position` on screen itself. */
  markShown: (position: number) => void;
  shown: () => number | null;
}

export function createShowQueue(deps: ShowQueueDeps): ShowQueue {
  let isReady = false;
  let inFlight = false;
  let wanted: number | null = null;
  let onScreen: number | null = null;
  const pump = () => {
    if (!isReady || inFlight || wanted === null) return;
    const position = wanted;
    wanted = null;
    inFlight = true;
    deps
      .show(position)
      .then(() => {
        onScreen = position;
        deps.onShown(position);
      })
      .catch((e: unknown) => deps.onError(String(e)))
      .finally(() => {
        inFlight = false;
        pump();
      });
  };
  return {
    want: (position, force = false) => {
      if (force) onScreen = null;
      if (position === onScreen && !inFlight) {
        wanted = null;
        return;
      }
      wanted = position;
      pump();
    },
    ready: () => {
      isReady = true;
      pump();
    },
    markShown: (position) => {
      onScreen = position;
    },
    shown: () => onScreen,
  };
}

export interface NativePreviewState {
  /** A first frame has reached the screen (the loader can go). */
  hasFrame: boolean;
  /** The last error the surface reported, or `null`. */
  error: string | null;
  /** Draw the paused frame again although its position did not change (the
   *  picture under it did: a source finished converting, D-453's conform).
   *  Stable across renders. */
  redraw: () => void;
}

/**
 * Roadmap 00r 5d (c) — the two-up trim viewer's two halves as
 * `showPreviewSurfaceTwoUp` takes them, or `null` when no roll, slip or slide
 * is being dragged.
 *
 * The surface has ONE owner: while a two-up is in the peek store it is what
 * the preview shows, in place of the timeline's frame at the playhead, and
 * `TwoUpViewer` draws only the labels, timecodes and divider over it.
 *
 * A half with no source file (a title, a gap) maps to `null` — that side is
 * drawn black and its own label says so. A source frame is rounded and pinned
 * at zero, the unit the decoder takes.
 */
export function twoUpHalves(view: TwoUpView | null): {
  left: PreviewSurfaceTwoUpHalf | null;
  right: PreviewSurfaceTwoUpHalf | null;
} | null {
  if (!view) return null;
  const half = (h: TwoUpHalfView): PreviewSurfaceTwoUpHalf | null =>
    h.sourcePath ? { sourcePath: h.sourcePath, sourceFrame: Math.max(0, Math.round(h.sourceFrame)) } : null;
  return { left: half(view.left), right: half(view.right) };
}

/**
 * Drive the native preview under `surface` (the preview surface element),
 * with the picture at `box` (its composition-fit content box, zoom and pan
 * included). Mounted while the Edit tab shows a timeline.
 */
export function useNativePreview(surface: HTMLElement | null, box: ContentBoxLike): NativePreviewState {
  const [hasFrame, setHasFrame] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const boxRef = useRef(box);
  const redrawRef = useRef<() => void>(() => {});
  const redraw = useCallback(() => redrawRef.current(), []);
  useEffect(() => {
    boxRef.current = box;
  }, [box]);

  useEffect(() => {
    if (!surface) return;
    let live = true;
    let started = false;
    let inFlight = false;
    let sent: PreviewSurfacePlacement | null = null;
    let raf = 0;
    let settle: ReturnType<typeof setTimeout> | null = null;
    const store = useEditorTimelineStore;
    const queue = createShowQueue({
      show: (position) => {
        const began = performance.now();
        const twoUp = twoUpHalves(usePreviewPeekStore.getState().twoUp);
        const shown = twoUp
          ? showPreviewSurfaceTwoUp(twoUp.left, twoUp.right)
          : showPreviewSurfaceFrame(position);
        return shown.then(() => {
          if (import.meta.env.APELLES_DEBUG_TOOLS === 'true') {
            recordPreviewSpan('scrub', performance.now() - began);
            recordPreviewTiming('paint');
          }
        });
      },
      onShown: () => {
        if (!live) return;
        setHasFrame(true);
        setError(null);
        // B-369 — the open's loader waits for this (and a debug build measures it).
        notifyPreviewFrameShown();
      },
      onError: (e) => {
        if (live) setError(e);
      },
    });
    // The letterbox is the colour the surface's container paints, read before
    // the hole makes it transparent.
    const background = cssColorToRgba(getComputedStyle(surface.parentElement ?? surface).backgroundColor);
    // The hole is open only while the native view is shown under it: the tabs
    // stay mounted when hidden, and an open hole over another tab would let the
    // (transparent) window show through wherever that tab paints nothing. It
    // opens once a visible placement has landed (the view is up first) and
    // closes before a hidden one is sent (the page paints first).
    const root = document.documentElement;
    const setHole = (open: boolean) => {
      if (open) root.setAttribute(NATIVE_PREVIEW_ATTR, '');
      else root.removeAttribute(NATIVE_PREVIEW_ATTR);
    };

    const paused = (): number | null => {
      const st = store.getState();
      if (st.playing || !st.timeline) return null;
      return usePreviewPeekStore.getState().skimFrame ?? st.playhead;
    };

    redrawRef.current = () => {
      const at = paused();
      if (at !== null) queue.want(at, true);
    };

    const tick = () => {
      if (!live) return;
      raf = requestAnimationFrame(tick);
      if (!started || inFlight) return;
      const view = rectOf(surface.getBoundingClientRect());
      const next = placementFromRects(view, pictureRect(view, boxRef.current), background, !document.hidden);
      if (
        sent &&
        sent.visible === next.visible &&
        sameRect(sent.view, next.view) &&
        sameRect(sent.picture, next.picture)
      ) {
        return;
      }
      const first = sent === null;
      sent = next;
      inFlight = true;
      if (!next.visible) setHole(false);
      placePreviewSurface(next)
        .then((report) => {
          if (live && next.visible) setHole(true);
          if (first) queue.ready();
          if (report.needsRender && !first) {
            if (settle) clearTimeout(settle);
            settle = setTimeout(() => {
              settle = null;
              const at = paused();
              if (at !== null) queue.want(at, true);
            }, RERENDER_SETTLE_MS);
          }
        })
        .catch((e: unknown) => {
          if (live) setError(String(e));
        })
        .finally(() => {
          inFlight = false;
        });
    };

    // While paused: the playhead's frame, a skimmed one, or the same one again
    // after the backend's timeline changed.
    const unsubscribeStore = store.subscribe((s, prev) => {
      if (s.playing) return;
      if (s.savedVersion !== prev.savedVersion) {
        const at = paused();
        if (at !== null) queue.want(at, true);
        return;
      }
      if (s.playhead !== prev.playhead && usePreviewPeekStore.getState().skimFrame === null) {
        queue.want(s.playhead);
      }
    });
    const unsubscribePeek = usePreviewPeekStore.subscribe((s, prev) => {
      const twoUpChanged = s.twoUp !== prev.twoUp;
      if (s.skimFrame === prev.skimFrame && !twoUpChanged) return;
      const at = paused();
      // A two-up drag moves its two source frames while the playhead stays
      // put, and its end restores the timeline's frame at that same position,
      // so neither can be skipped as "already on screen".
      if (at !== null) queue.want(at, twoUpChanged);
    });

    // Playback: the Rust loop owns the picture and reports each frame it shows.
    const unlistenPlayhead = onPreviewPlayhead((e) => {
      if (!live) return;
      const st = store.getState();
      if (!st.playing) return;
      queue.markShown(e.frame);
      if (import.meta.env.APELLES_DEBUG_TOOLS === 'true') recordPreviewTiming('paint');
      st.setPlayhead(e.frame);
      if (e.ended) st.setPlaying(false);
    });
    // Debug builds only: the loop's display ticks, for `debug_frame_timing`.
    const unlistenPresent =
      import.meta.env.APELLES_DEBUG_TOOLS === 'true' ? onPreviewPresent(() => recordPreviewTiming('raf')) : () => {};
    const play = (playing: boolean) => {
      const st = store.getState();
      const end = timelineDuration(st.timeline);
      if (playing && end <= 1) {
        st.setPlaying(false);
        return;
      }
      playPreviewSurface({
        playing,
        from: st.playhead,
        fps: timelineFps(st.timeline),
        rate: st.playbackRate,
        end,
        seq: nextPlaySeq(),
      })
        .then(() => {
          // Paused somewhere the loop did not draw (a click on the position
          // bar mid-play): show it.
          if (!playing) {
            const at = paused();
            if (at !== null) queue.want(at);
          }
        })
        .catch((e: unknown) => {
          if (live) setError(String(e));
        });
    };
    const unsubscribePlay = store.subscribe((s, prev) => {
      const restarted = s.playing && (s.playbackRate !== prev.playbackRate || s.seekEpoch !== prev.seekEpoch);
      if (s.playing !== prev.playing || restarted) play(s.playing);
    });

    queue.want(store.getState().playhead);
    lifecycle = lifecycle
      .then(() => startPreviewSurface())
      .then(() => {
        started = true;
        if (store.getState().playing) play(true);
      })
      .catch((e: unknown) => {
        if (live) setError(String(e));
      });
    raf = requestAnimationFrame(tick);

    return () => {
      live = false;
      redrawRef.current = () => {};
      cancelAnimationFrame(raf);
      if (settle) clearTimeout(settle);
      unsubscribeStore();
      unsubscribePeek();
      unsubscribePlay();
      unlistenPlayhead();
      unlistenPresent();
      setHole(false);
      lifecycle = lifecycle.then(() => stopPreviewSurface()).catch(() => {});
    };
  }, [surface]);

  return { hasFrame, error, redraw };
}
