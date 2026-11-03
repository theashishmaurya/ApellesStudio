/**
 * nativePreview.ts — the Edit preview shown on the native GPU surface instead
 * of the `<img>` (D-451, `docs/notes/preview-gpu-surface.md`).
 *
 * What it is: a small store saying whether the native surface is on (and fed
 * by which prototype source), plus the hook `PreviewPane` runs to keep the
 * native `CAMetalLayer` exactly under the preview: it reads the preview
 * surface's rectangle and the picture's box once per animation frame and
 * sends them to Rust only when they change, so a panel resize, a zoom, a pan,
 * fullscreen or a window move to another display all follow within a frame.
 * While on, `<html data-native-preview>` makes every element marked
 * `data-preview-hole` transparent (the "hole" the layer shows through, the
 * Colorist's B-006 mechanism) and the `<img>` is hidden but keeps its layout,
 * which is what defines the picture's box for the overlays today.
 *
 * What it does NOT do: carry pixels, or touch the overlays — they stay in the
 * DOM on top of the hole and keep the pointer. The geometry is plain functions
 * ({@link placementFromRects}, {@link sameRect}, {@link cssColorToRgba}) so it
 * is unit-tested without a browser.
 *
 * **Debug-only.** Turned on by the debug op `debug_native_preview`; every call
 * site in `PreviewPane` is behind `import.meta.env.APELLES_DEBUG_TOOLS`, and
 * the Rust commands exist only with debug assertions on.
 */

import { useEffect } from 'react';
import { create } from 'zustand';
import {
  placePreviewSurface,
  showPreviewSurfaceFrame,
  startPreviewSurface,
  stopPreviewSurface,
  type PreviewSurfaceColor,
  type PreviewSurfacePlacement,
  type PreviewSurfaceRect,
  type PreviewSurfaceSource,
} from '@apelles/bridge';

import { useEditorTimelineStore } from './timelineStore';

/** Starts and stops in the order the effects asked for them: a source switch
 *  runs the old effect's stop before the new one's start, and the Rust side
 *  must see them in that order too. */
let lifecycle: Promise<unknown> = Promise.resolve();

/** The attribute on `<html>` that opens the hole. */
export const NATIVE_PREVIEW_ATTR = 'data-native-preview';

interface NativePreviewState {
  /** `null` = off: the `<img>` preview, as shipped. */
  source: PreviewSurfaceSource | null;
  color: PreviewSurfaceColor;
  /** The last error the surface reported, for the debug op to return. */
  error: string | null;
  setSource: (source: PreviewSurfaceSource | null, color?: PreviewSurfaceColor) => void;
  setError: (error: string | null) => void;
}

export const useNativePreviewStore = create<NativePreviewState>((set) => ({
  source: null,
  color: 'srgb',
  error: null,
  setSource: (source, color) => set((s) => ({ source, color: color ?? s.color, error: null })),
  setError: (error) => set({ error }),
}));

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

/**
 * The placement for one measurement: the surface's rectangle, the picture's
 * box (the `<img>`'s transformed box, which already includes the zoom and pan)
 * and the letterbox colour. With no picture yet, the picture is the whole view
 * (the source is aspect-fit by the box the engine renders at).
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

/**
 * Keep the native surface under `surface` while the store says it is on.
 * `picture` is the element whose box is the picture's (the hidden `<img>`).
 */
export function useNativePreviewSurface(surface: HTMLElement | null, picture: () => HTMLElement | null): void {
  const source = useNativePreviewStore((s) => s.source);
  const color = useNativePreviewStore((s) => s.color);

  useEffect(() => {
    if (!source || !surface) return;
    const { setError } = useNativePreviewStore.getState();
    let live = true;
    let started = false;
    // The first placement sizes the drawable; nothing can be shown before it.
    let placed = false;
    let inFlight = false;
    let sent: PreviewSurfacePlacement | null = null;
    let raf = 0;
    // The letterbox is the colour the surface's container paints today, read
    // before the hole makes it transparent.
    const background = cssColorToRgba(getComputedStyle(surface.parentElement ?? surface).backgroundColor);
    const root = document.documentElement;
    root.setAttribute(NATIVE_PREVIEW_ATTR, '');
    const img = picture();
    if (img) img.style.visibility = 'hidden';

    const tick = () => {
      if (!live) return;
      raf = requestAnimationFrame(tick);
      if (!started || inFlight) return;
      const view = rectOf(surface.getBoundingClientRect());
      const pic = picture();
      const next = placementFromRects(
        view,
        pic ? rectOf(pic.getBoundingClientRect()) : null,
        background,
        !document.hidden,
      );
      if (
        sent &&
        sent.visible === next.visible &&
        sameRect(sent.view, next.view) &&
        sameRect(sent.picture, next.picture)
      ) {
        return;
      }
      sent = next;
      inFlight = true;
      placePreviewSurface(next)
        .catch((e: unknown) => setError(String(e)))
        .then(() => {
          if (!placed) {
            placed = true;
            showLatest();
          }
        })
        .finally(() => {
          inFlight = false;
        });
    };

    // A scrub or a paused seek: show the playhead's frame on the surface,
    // latest-wins (one request in flight, the newest position next).
    let showing = false;
    let wanted: number | null = null;
    const showLatest = () => {
      if (!placed || showing || wanted === null) return;
      const position = wanted;
      wanted = null;
      showing = true;
      showPreviewSurfaceFrame(position)
        .catch((e: unknown) => setError(String(e)))
        .finally(() => {
          showing = false;
          showLatest();
        });
    };
    const unsubscribe = useEditorTimelineStore.subscribe((s, prev) => {
      if (s.playhead === prev.playhead || s.playing) return;
      wanted = s.playhead;
      showLatest();
    });

    wanted = useEditorTimelineStore.getState().playhead;
    lifecycle = lifecycle
      .then(() => startPreviewSurface(source, color))
      .then(() => {
        started = true;
      })
      .catch((e: unknown) => setError(String(e)));
    raf = requestAnimationFrame(tick);

    return () => {
      live = false;
      unsubscribe();
      cancelAnimationFrame(raf);
      root.removeAttribute(NATIVE_PREVIEW_ATTR);
      const el = picture();
      if (el) el.style.visibility = '';
      lifecycle = lifecycle.then(() => stopPreviewSurface()).catch((e: unknown) => setError(String(e)));
    };
  }, [source, color, surface, picture]);
}

/** The hook `PreviewPane` calls: the real one in a debug-tools build, a no-op
 *  (folded and tree-shaken) in production. Chosen once at module load, so
 *  every render calls the same hook. */
export const useNativePreview: (surface: HTMLElement | null, picture: () => HTMLElement | null) => void =
  import.meta.env.APELLES_DEBUG_TOOLS === 'true' ? useNativePreviewSurface : () => {};
