/**
 * @apelles/editor — which slice of a clip's waveform a canvas actually backs
 * (B-274).
 *
 * **What it is.** A pure function from a clip's pixel width and the slice of it
 * the viewport shows to the span `[start, end)` (px from the clip's own left
 * edge) that the waveform `<canvas>` is allocated for.
 *
 * **Why.** `Waveform` used to size its canvas to the WHOLE clip: `width ×
 * devicePixelRatio`. A canvas is a real backing store (4 bytes a pixel, set
 * again each time `width` is assigned), and an 803 s music bed at the timeline's
 * default 100 px/s is 80,300 css px, 160,600 device px: ~67 MB for ONE clip,
 * more as the owner zooms in, with seven such lanes and a redraw on every
 * edit. That is the allocation the Black October session grew to ~18 GB on
 * before macOS killed the web content process. The canvas now covers only the
 * visible span plus a margin, quantised so scrolling does not reallocate on
 * every pixel, and never wider than {@link MAX_WAVEFORM_CANVAS_PX}.
 *
 * **What it does NOT do.** Fetch peaks (the whole-clip peak list stays cached
 * as before, `Waveform.getPeaks`) or draw.
 */

/** Hard ceiling on a waveform canvas, in css px. Wider than any viewport the
 *  app is shown in, small enough that the backing store (x2 DPR, 52 px rows)
 *  stays under ~2 MB. */
export const MAX_WAVEFORM_CANVAS_PX = 4096;

/** Extra px drawn beyond each edge of the viewport, so a short scroll shows
 *  waveform instead of a blank until the next redraw. */
const MARGIN_PX = 256;

/** The span a scroll must leave before the canvas moves: starts are rounded
 *  down to a multiple of this, so a continuous scroll redraws a few times a
 *  second, not once per pixel. */
const STEP_PX = 256;

export interface WaveformSpan {
  /** px from the clip's left edge to the canvas's left edge. */
  start: number;
  /** px from the clip's left edge to the canvas's right edge. */
  end: number;
}

/** The canvas span for a clip `width` px wide whose visible slice is
 *  `[visibleStartPx, visibleEndPx)` (either `undefined` = the whole clip, as
 *  far as the ceiling allows). `null` when there is nothing to draw. */
export function waveformSpan(
  width: number,
  visibleStartPx: number | undefined,
  visibleEndPx: number | undefined,
): WaveformSpan | null {
  if (!(width > 0)) return null;
  const visStart = Math.max(0, Math.min(width, visibleStartPx ?? 0));
  const visEnd = Math.max(0, Math.min(width, visibleEndPx ?? width));
  if (visEnd <= visStart) return null;
  const start = Math.max(0, Math.floor((visStart - MARGIN_PX) / STEP_PX) * STEP_PX);
  const wanted = Math.min(width, visEnd + MARGIN_PX);
  const end = Math.min(wanted, start + MAX_WAVEFORM_CANVAS_PX, width);
  return end > start ? { start, end } : null;
}
