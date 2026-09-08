/**
 * @chroma/editor — anchored timeline zoom (B-115).
 *
 * **What it is.** The two pure functions that make a timeline zoom keep
 * something still: `frameAtViewportX` (what timeline frame is currently under
 * a given x inside the edit-area viewport) and `scrollLeftForAnchor` (the
 * `scrollLeft` that puts a given frame back at a given x, at a NEW
 * `pxPerSec`). Together they are the whole of "zoom around a point".
 *
 * **Why it exists.** `TimelinePane`'s zoom had no anchor at all. Ctrl/pinch
 * wheel-zoom (D-051, pan/zoom split D-072) read `e.deltaY`, multiplied
 * `pxPerSec` and stopped — `e.clientX`, the actual cursor position, was on the
 * event and never read — and the toolbar's own +/- buttons did the same with
 * no anchor available at all. Since `scrollLeft` is untouched by a zoom, every
 * frame except the one at the viewport's left edge slides sideways by an
 * amount proportional to how far it is from that edge, so zooming in on a clip
 * in the middle of a long timeline pushes it off screen. The owner reported it
 * live, in exactly those terms: "when zooming calculate the position of my
 * mouse in timeline and zoom there not like random."
 *
 * **What it does NOT do.** It owns no state, reads no DOM and does not clamp
 * the zoom itself — `TimelinePane` still owns `pxPerSec`, its
 * `clampPxPerSec`, and the imperative scroll (`TimelineState.setScrollLeft`).
 * These are the arithmetic only, which is what makes the invariant this
 * feature is actually about ("the anchored frame does not move") a real unit
 * test rather than something only a browser could check.
 *
 * The x/px conversion mirrors `TimelinePane`'s own `xToFrame` exactly
 * (`startLeft + frame/fps*pxPerSec - scrollLeft`, the arithmetic every
 * overlay, the ruler and the playhead in that file already share) — this is a
 * rearrangement of that one equation for its two other unknowns, not a second
 * coordinate model.
 */

/**
 * The timeline frame currently under `viewportX` — px measured from the edit
 * area's own left edge (i.e. `clientX - editArea.getBoundingClientRect().left`).
 *
 * Deliberately NOT rounded: it is an anchor for a reversible calculation, and
 * rounding it to a whole frame here would quantise the anchor to
 * `pxPerSec / fps` px, which at a zoomed-out `pxPerSec` is several pixels of
 * visible drift per zoom step — the very thing this module exists to remove.
 */
export function frameAtViewportX(
  viewportX: number,
  fps: number,
  pxPerSec: number,
  scrollLeft: number,
  startLeftPx: number,
): number {
  return ((viewportX + scrollLeft - startLeftPx) / pxPerSec) * fps;
}

/**
 * The `scrollLeft` that puts `frame` at `viewportX` when the zoom is
 * `pxPerSec`. Never negative: the timeline starts at `scrollLeft = 0` and a
 * negative scroll is not a position the container can be in, so an anchor near
 * frame 0 pins to the start instead (which is what the user sees anyway — the
 * left edge of the timeline holds still, and nothing can slide in from before
 * it).
 */
export function scrollLeftForAnchor(
  frame: number,
  viewportX: number,
  fps: number,
  pxPerSec: number,
  startLeftPx: number,
): number {
  return Math.max(0, startLeftPx + (frame / fps) * pxPerSec - viewportX);
}

/**
 * Where a button-driven zoom (the toolbar's +/-, which has no cursor position
 * to anchor to) should hold still: the PLAYHEAD when it is actually on screen,
 * else the middle of the viewport.
 *
 * **The playhead, not the viewport centre, and not the timeline start.** A
 * button zoom is a "look closer at what I am working on" gesture, and in this
 * model position is truth (D-054) — the playhead is the timeline's own "you
 * are here", it is what the preview is showing, and it is the point every
 * playhead-scoped action in the toolbar beside these buttons (Split, Marker,
 * Title, Adjust) already acts on. Anchoring the zoom anywhere else would mean
 * the frame you are looking at in the preview is not the frame the zoom keeps.
 * Premiere behaves this way for its own keyboard zoom, and Resolve's Edit-page
 * copy likewise never describes zoom as a viewport-relative operation. The
 * viewport centre is the fallback rather than the rule because it is only the
 * right answer when the playhead genuinely is not in view, in which case
 * holding it still would scroll the user somewhere they are not looking.
 *
 * Returns the anchor as a viewport x, so the caller feeds it straight into
 * `frameAtViewportX` — one anchor concept for both zoom entry points, which is
 * what stops the wheel and the buttons from drifting apart.
 */
export function buttonZoomAnchorX(
  playheadFrame: number,
  fps: number,
  pxPerSec: number,
  scrollLeft: number,
  startLeftPx: number,
  viewportWidth: number,
): number {
  const playheadX = startLeftPx + (playheadFrame / fps) * pxPerSec - scrollLeft;
  if (playheadX >= 0 && playheadX <= viewportWidth) return playheadX;
  return viewportWidth / 2;
}
