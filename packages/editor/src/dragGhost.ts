/**
 * @apelles/editor — where a clip-drag's cursor-follow ghost sits, and which
 * slice of the clip it shows (B-137 / D-279).
 *
 * **What it is.** One pure function. `@dnd-kit/core`'s `DragOverlay` always
 * anchors itself to the dragged node's own measured rect — `PositionedOverlay`
 * writes `left: rect.left; top: rect.top` and then applies the drag transform
 * (read in its bundled source, not assumed). For a node the overlay renders at
 * full size that is exactly right: the ghost starts out exactly on top of the
 * thing you grabbed. `TimelinePane`'s clip ghost is NOT full size — D-119 caps
 * it at [`MAX_DRAG_GHOST_PX`] so an hour-long clip dragged at 100% zoom does
 * not produce an off-screen-sized DOM node — so for any clip wider than the cap
 * the ghost is a short stub pinned to the clip's LEFT EDGE while the pointer is
 * wherever in the clip's body it actually pressed. That is B-137: at the
 * default 90 px/s zoom the cap is reached by every clip longer than ~3.5s, and
 * grabbing one two-thirds of the way along leaves the ghost hundreds of pixels
 * behind the cursor, reading as a preview "stuck at the clip's original
 * position."
 *
 * This function answers the two questions that fixes it: how wide the ghost is,
 * and **how far into the clip its window starts** — the ghost shows the slice of
 * the clip around the grab point instead of always the clip's head, and is
 * shifted right by that same offset so the pixel under the cursor is the pixel
 * the cursor is holding.
 *
 * **What it does NOT do.** No DOM, no React, no dnd-kit types, no unit
 * conversion — every quantity is on-screen pixels of the clip as it is really
 * laid out, so a clip with a speed change needs no special case here (the
 * caller maps the window back to source seconds using the clip's own
 * width-to-duration ratio). It does not decide whether a ghost should be shown
 * at all; that is `TimelinePane`'s `activeDrag`.
 */

/** D-119's cap on the cursor-follow ghost's width, in px. A ghost is a
 *  *preview*, not a literal render of the clip at full timeline zoom. */
export const MAX_DRAG_GHOST_PX = 320;

/** The floor D-119 also set: a ghost narrower than this is unreadable (no room
 *  for the clip's name, no legible filmstrip), so a very short clip's ghost is
 *  deliberately wider than the clip itself. */
export const MIN_DRAG_GHOST_PX = 60;

export interface DragGhostWindow {
  /** The ghost's on-screen width, in px. */
  widthPx: number;
  /** How far into the clip (px from its left edge) the ghost's window starts.
   *  `0` whenever the whole clip fits inside the cap — which is what keeps
   *  short clips behaving exactly as they did before B-137. */
  startPx: number;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/**
 * The slice of a clip its drag ghost shows.
 *
 * @param clipWidthPx  the clip's real on-screen width (dnd-kit's own measured
 *   rect for the dragged body, so it is already the laid-out width — not a
 *   frames-times-zoom recomputation that could disagree with it).
 * @param grabOffsetPx how far into that width the pointer pressed.
 * @param maxPx        the width cap; defaults to [`MAX_DRAG_GHOST_PX`].
 *
 * The window is CENTRED on the grab point and clamped to the clip, rather than
 * started at it: a grab near the clip's tail would otherwise produce a window
 * running off its end, and a centred one shows what is on both sides of the
 * pointer, which is what the eye needs to judge a landing.
 */
export function dragGhostWindow(clipWidthPx: number, grabOffsetPx: number, maxPx = MAX_DRAG_GHOST_PX): DragGhostWindow {
  // An unmeasurable clip (a pane laid out to nothing) has no window to take a
  // slice of — answer with the floor and no offset rather than a NaN.
  if (!Number.isFinite(clipWidthPx) || clipWidthPx <= 0) return { widthPx: MIN_DRAG_GHOST_PX, startPx: 0 };
  const widthPx = Math.max(MIN_DRAG_GHOST_PX, Math.min(maxPx, clipWidthPx));
  // The whole clip fits (including the short-clip case, where the ghost is
  // wider than the clip): there is nothing to slice, and the ghost stays
  // anchored at the clip's head exactly as it always has.
  if (widthPx >= clipWidthPx) return { widthPx, startPx: 0 };
  const offset = Number.isFinite(grabOffsetPx) ? grabOffsetPx : 0;
  const startPx = clamp(offset - widthPx / 2, 0, clipWidthPx - widthPx);
  return { widthPx, startPx };
}
