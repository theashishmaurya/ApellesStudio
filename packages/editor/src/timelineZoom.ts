/**
 * @apelles/editor — anchored timeline zoom (B-116).
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

/**
 * Pinch / ctrl-wheel zoom, proportional to the gesture (B-375).
 *
 * The handler used to apply a fixed 1.2x per wheel event whatever its
 * `deltaY`, so a slow pinch and a fast one zoomed the same amount per event
 * and a trackpad's many small events overshot. The factor is now exponential
 * in the delta, `exp(-deltaY * PINCH_ZOOM_K)`: deltas add up as exponents, so
 * N small events zoom exactly as much as one event of their summed delta, and
 * zooming in then out by the same delta returns to the same zoom.
 */
export const PINCH_ZOOM_K = 0.01;
/** One event never zooms by more than `exp(0.3)` (about 1.35x), so a mouse
 *  wheel notch (deltaY of 100 or more) is a step, not a jump. */
export const PINCH_MAX_DELTA_PX = 30;
/** `deltaY` of a `DOM_DELTA_LINE` event is in lines; this is one line in px. */
export const PINCH_LINE_PX = 16;

/** The zoom factor one ctrl-wheel event applies. `deltaMode` is the DOM's
 *  (0 pixel, 1 line, 2 page); a page is treated as 100 lines' worth, clamped. */
export function pinchZoomFactor(deltaY: number, deltaMode = 0): number {
  const px = deltaMode === 1 ? deltaY * PINCH_LINE_PX : deltaMode === 2 ? deltaY * 100 : deltaY;
  const clamped = Math.max(-PINCH_MAX_DELTA_PX, Math.min(PINCH_MAX_DELTA_PX, px));
  return Math.exp(-clamped * PINCH_ZOOM_K);
}

/**
 * WebKit's proprietary trackpad-pinch event (`gesturestart` / `gesturechange` /
 * `gestureend`), which the DOM lib types do not declare (B-387). `scale` is
 * CUMULATIVE since the gesture began — 1 at `gesturestart` — not a per-event
 * delta, so a step's own factor is the ratio to the previous event's scale.
 */
export interface WebKitGestureEvent extends UIEvent {
  readonly scale: number;
  readonly clientX: number;
  readonly clientY: number;
}

/**
 * B-387 — the zoom factor one `gesturechange` represents, given the scale the
 * previous event of the same gesture reported, or `null` when the pair says
 * nothing usable (a non-finite or non-positive scale, which would otherwise
 * drive `pxPerSec` to zero, `NaN` or a negative). The caller stores the new
 * scale and pushes the factor through the same coalescer as a Ctrl+wheel zoom.
 */
export function gestureZoomFactor(scale: number, prevScale: number): number | null {
  if (!Number.isFinite(scale) || !Number.isFinite(prevScale)) return null;
  if (scale <= 0 || prevScale <= 0) return null;
  return scale / prevScale;
}

/**
 * Coalesces zoom events to one flush per animation frame (D-437 S8): the
 * factors multiply, the latest pointer x is the anchor. `flush` receives the
 * accumulated factor and anchor, and is not called when they cancel to ~1.
 * `raf`/`caf` are injectable so the batching is testable without a browser.
 */
export function createZoomCoalescer(
  flush: (factor: number, anchorClientX: number) => void,
  raf: (cb: () => void) => number = (cb) => requestAnimationFrame(cb),
  caf: (id: number) => void = (id) => cancelAnimationFrame(id),
) {
  let factor = 1;
  let clientX = 0;
  let handle = 0;
  const run = () => {
    handle = 0;
    const f = factor;
    factor = 1;
    if (Math.abs(f - 1) > 1e-9) flush(f, clientX);
  };
  return {
    push(eventFactor: number, anchorClientX: number) {
      factor *= eventFactor;
      clientX = anchorClientX;
      if (handle === 0) handle = raf(run);
    },
    cancel() {
      if (handle !== 0) caf(handle);
      handle = 0;
      factor = 1;
    },
  };
}
