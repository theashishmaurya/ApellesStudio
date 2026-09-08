/**
 * @chroma/editor — pure math for the Edit-tab preview's VIEWPORT zoom + pan
 * (D-218, roadmap item 25's "No canvas/preview zoom control").
 *
 * **What this is.** A display-only magnification of the composited picture:
 * how big the whole frame looks on screen, and which part of it the viewport
 * is looking at. Nothing here is project data — it is not persisted, not
 * undoable, and never reaches `grade.json`/`project.json`.
 *
 * **What this is emphatically NOT.** It is not `Clip.scale` /
 * `Clip.position_x` / `Clip.position_y`, and not the composition size. Those
 * are the CLIP's own transform inside the frame — a real, persisted, exported
 * property of the edit. A viewport zoom changes nothing about the picture the
 * renderer produces; it changes only how many screen pixels that picture is
 * drawn across. The two are deliberately kept in different units so they can
 * never be confused: a clip's geometry is COMPOSITION fractions
 * (`transformGeometry.ts`), a view's pan is FIT-BOX fractions (below).
 *
 * **Units — pan is a fraction of the FIT box, not screen pixels (D-218).**
 * `zoom` is a multiplier on the picture's fit size, so `1` is exactly the
 * letterboxed "fill the viewport" layout the preview has always had, `2` is
 * twice that on each axis. `panX`/`panY` are the picture's centre offset from
 * the fit box's centre, measured in fit-box widths/heights. Two real
 * consequences, both the reason for the choice:
 *
 *   1. **Clamping is pure.** The picture can be panned until its own edge
 *      reaches the fit box's edge and no further, which in these units is
 *      exactly `|pan| <= (zoom - 1) / 2` — no container measurement, no DOM,
 *      no layout read. That is what lets every function here be unit-tested
 *      in this package's `node`-only vitest, the same reason
 *      `transformGeometry.ts` is split out of `TransformOverlay.tsx`.
 *   2. **It survives a resize.** A pan stored in screen pixels would slide
 *      the picture the moment the panel was dragged wider or the window
 *      resized; a fraction of the fit box means "one third of a frame left of
 *      centre" stays one third of a frame left of centre at any panel size.
 *
 * **How it composes with the existing coordinate contract.**
 * `@chroma/player`'s `useContentBox` still measures exactly what it always
 * measured — the `object-contain` FIT rect of the picture inside its
 * container — and its own documented assumption (the container fills the
 * space the picture is centred within) stays true, because zoom is applied
 * strictly AFTER it, by [`zoomedContentBox`]. `TransformOverlay`,
 * `CanvasBoundary` and `useCanvasClipPick` then consume that zoomed box
 * through `usePreviewContentBox` and need no other change: every one of them
 * already speaks "composition fraction ↔ this content box", and a zoomed box
 * is still a content box. See D-218 for the option that was rejected (CSS
 * `overflow: auto` + a real scroll offset), and `docs/notes/
 * on-canvas-transform.md` for the coordinate contract itself.
 */

import type { ContentBoxLike } from './transformGeometry';

/** The zoom factor at which the picture exactly fits its viewport — the
 *  preview's default and its "reset" target. Deliberately `1`, i.e. the
 *  percentage readout's `100%` means "fit", exactly as `TimelinePane`'s own
 *  `zoomPct` means "the default `pxPerSec`" rather than any absolute unit.
 *  See D-218 for why this is NOT Resolve/Premiere's "100% = one output pixel
 *  per screen pixel": the preview is a resolution-capped proxy
 *  (`PREVIEW_LONG_EDGE`), so a 1:1 claim would be a claim about pixels that
 *  are not there. */
export const FIT_ZOOM = 1;

/** Zoom bounds. Preview-scoped on purpose — NOT shared with `ruler.ts`'s
 *  `MIN_PX_PER_SEC`/`MAX_PX_PER_SEC`, which are the timeline's own
 *  seconds-per-pixel bounds and are load-bearing for the filmstrip's
 *  level-of-detail ladder (see that module's doc). "Zoom" names two unrelated
 *  dimensions in this tab and the two must be able to move independently.
 *
 *  `0.25` is far enough out to see a magnified clip's whole overhang against
 *  the canvas boundary; `8` is far enough in to inspect an edge or a colour
 *  boundary on the preview proxy without magnifying past the point where
 *  there is any real detail left to see. */
export const MIN_PREVIEW_ZOOM = 0.25;
export const MAX_PREVIEW_ZOOM = 8;

/** One click of zoom in / zoom out, as a multiplier. Deliberately the same
 *  `1.2` `TimelinePane.tsx`'s own `ZOOM_STEP` uses — the two controls sit in
 *  the same tab and a user's muscle memory should transfer — but its own
 *  constant, not an import, for the same reason the bounds above are: these
 *  are two unrelated axes that happen to agree on a comfortable step today. */
export const PREVIEW_ZOOM_STEP = 1.2;

/** The preview viewport's whole view state. See this module's doc for the
 *  units; `FIT_VIEW` is the default and the reset target. */
export interface PreviewView {
  /** Multiplier on the picture's fit size. `1` = fit. */
  zoom: number;
  /** Picture centre offset from the fit box's centre, in fit-box widths. */
  panX: number;
  /** Picture centre offset from the fit box's centre, in fit-box heights. */
  panY: number;
}

export const FIT_VIEW: PreviewView = { zoom: FIT_ZOOM, panX: 0, panY: 0 };

/** A point in fit-box-relative space: `0,0` is the fit box's centre, `±0.5`
 *  its edges. What a pointer position becomes before it can anchor a zoom. */
export interface FitPoint {
  x: number;
  y: number;
}

/** `+ 0` normalises `-0` to `0`. Not cosmetic: a `PreviewView` is compared
 *  with `===` (`isFitView`) and serialised straight out over MCP
 *  (`editor_get_state`'s `previewZoom`), and `-0` would read back as `-0` in
 *  JSON-ish output for a value that is exactly centred. */
function clamp(v: number, lo: number, hi: number): number {
  return (v < lo ? lo : v > hi ? hi : v) + 0;
}

/** `zoom` forced into `[MIN_PREVIEW_ZOOM, MAX_PREVIEW_ZOOM]`. A non-finite
 *  input — `NaN` from a bad division, `Infinity`, or whatever `Number(...)`
 *  made of a malformed MCP argument — resolves to FIT rather than
 *  propagating or silently pinning to a bound: "we could not read that" and
 *  "you asked to zoom all the way in" are different requests, and only one of
 *  them should move the picture. */
export function clampPreviewZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return FIT_ZOOM;
  return clamp(zoom, MIN_PREVIEW_ZOOM, MAX_PREVIEW_ZOOM);
}

/** How far the picture may be panned off centre at `zoom`, in fit-box
 *  fractions — the picture's own edge may reach the fit box's edge and no
 *  further, so at fit (or zoomed OUT, where the picture is smaller than the
 *  fit box) the only legal pan is none at all.
 *
 *  Clamping against the FIT box rather than the container is deliberate and
 *  slightly conservative: the fit box is always fully inside the container, so
 *  every part of the picture is still reachable into view, and the rule needs
 *  no knowledge of the container's own size — i.e. no DOM. */
export function panLimit(zoom: number): number {
  return Math.max(0, (clampPreviewZoom(zoom) - 1) / 2);
}

/** `view` with its zoom clamped to the bounds and its pan clamped to what
 *  that zoom actually allows. Every constructor below funnels through this,
 *  so no `PreviewView` that escapes this module can be out of range. */
export function clampPreviewView(view: PreviewView): PreviewView {
  const zoom = clampPreviewZoom(view.zoom);
  const limit = panLimit(zoom);
  const panX = Number.isFinite(view.panX) ? clamp(view.panX, -limit, limit) : 0;
  const panY = Number.isFinite(view.panY) ? clamp(view.panY, -limit, limit) : 0;
  return { zoom, panX, panY };
}

/** Whether `view` is exactly the default fit view — what the reset control
 *  reports as its own disabled/no-op state. */
export function isFitView(view: PreviewView): boolean {
  return view.zoom === FIT_ZOOM && view.panX === 0 && view.panY === 0;
}

/** The percentage a zoom is shown as, matching `TimelinePane`'s own
 *  `zoomPct` (`Math.round(pxPerSec / DEFAULT_PX_PER_SEC * 100)`) exactly in
 *  shape: a whole number, relative to the default view. */
export function previewZoomPct(zoom: number): number {
  return Math.round(clampPreviewZoom(zoom) * 100);
}

/**
 * The picture's real on-screen rect after `view` is applied — the SAME
 * container-local pixel space `useContentBox` reports its fit box in, so this
 * is a drop-in replacement for that box everywhere a consumer maps
 * composition fractions onto the screen (`boxToScreenRect`) or a pointer back
 * off it (`screenToFraction`).
 *
 * The picture scales about the fit box's centre and is then displaced by the
 * pan — exactly what the `<img>`'s own `transform: translate(...) scale(...)`
 * (with the default centre transform-origin) does to it in `PreviewPane`, so
 * the overlays and the picture cannot disagree by construction.
 */
export function zoomedContentBox(fit: ContentBoxLike, view: PreviewView): ContentBoxLike {
  const { zoom, panX, panY } = view;
  const width = fit.width * zoom;
  const height = fit.height * zoom;
  return {
    width,
    height,
    offsetX: fit.offsetX + (fit.width - width) / 2 + panX * fit.width,
    offsetY: fit.offsetY + (fit.height - height) / 2 + panY * fit.height,
  };
}

/**
 * A container-local pixel point expressed in fit-box-relative space (`0,0` =
 * the fit box's centre) — the conversion a pointer position needs before it
 * can anchor a zoom. Reads the FIT box, not the zoomed one: the anchor is a
 * position on the viewport, not on the picture.
 */
export function fitPointAt(point: { x: number; y: number }, fit: ContentBoxLike): FitPoint {
  return {
    x: fit.width > 0 ? (point.x - fit.offsetX) / fit.width - 0.5 : 0,
    y: fit.height > 0 ? (point.y - fit.offsetY) / fit.height - 0.5 : 0,
  };
}

/**
 * Zoom to `nextZoom` while keeping whatever part of the picture sits under
 * `anchor` under `anchor` — the standard "zoom towards the pointer" every
 * canvas app does, and the only behaviour that makes a wheel zoom feel like
 * it is magnifying the thing you are pointing at rather than teleporting.
 *
 * Pass `{x: 0, y: 0}` (the fit box's centre) for a zoom that has no pointer
 * to anchor to — what the toolbar's +/- buttons use.
 *
 * The arithmetic: the picture point currently under the anchor is `p =
 * (anchor - pan) / zoom` in fit units from the picture's centre; keeping it
 * there at the new zoom means `pan' = anchor - p * zoom'`. Clamped on the way
 * out, so zooming back out always walks the pan back to centre rather than
 * leaving the picture stranded off to one side.
 */
export function zoomAbout(view: PreviewView, anchor: FitPoint, nextZoom: number): PreviewView {
  const zoom = clampPreviewZoom(nextZoom);
  const current = clampPreviewZoom(view.zoom);
  if (current <= 0) return clampPreviewView({ zoom, panX: 0, panY: 0 });
  const ratio = zoom / current;
  return clampPreviewView({
    zoom,
    panX: anchor.x - (anchor.x - view.panX) * ratio,
    panY: anchor.y - (anchor.y - view.panY) * ratio,
  });
}

/** One step in / out about `anchor`. The two toolbar buttons and a
 *  ctrl-wheel tick are the same operation with a different anchor. */
export function steppedZoom(view: PreviewView, anchor: FitPoint, direction: 'in' | 'out'): PreviewView {
  const factor = direction === 'in' ? PREVIEW_ZOOM_STEP : 1 / PREVIEW_ZOOM_STEP;
  return zoomAbout(view, anchor, view.zoom * factor);
}

/**
 * Pan by a SCREEN-pixel delta — what a plain (non-ctrl) wheel gesture
 * produces. `fit` converts it into this module's fit-box fractions; the sign
 * is inverted because a wheel's `deltaY` is how far the CONTENT should move
 * up, i.e. how far the picture's centre moves in the negative direction.
 *
 * A no-op at fit, since [`clampPreviewView`] pins the pan to zero there —
 * which is deliberate: at fit there is nothing off-screen to pan to, and a
 * preview that drifted under an ordinary two-finger scroll would be a defect,
 * not a feature.
 */
export function pannedByPixels(view: PreviewView, fit: ContentBoxLike, dx: number, dy: number): PreviewView {
  const w = fit.width > 0 ? fit.width : 1;
  const h = fit.height > 0 ? fit.height : 1;
  return clampPreviewView({
    zoom: view.zoom,
    panX: view.panX - dx / w,
    panY: view.panY - dy / h,
  });
}
