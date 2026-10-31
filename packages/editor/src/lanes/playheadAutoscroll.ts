/**
 * @apelles/editor — edge autoscroll for a playhead scrub (D-437 S3b).
 *
 * What it is: the speed curve that scrolls the timeline sideways while the
 * playhead is dragged near (or past) an edge of the viewport — the behaviour
 * `@xzdarcy/react-timeline-editor`'s `autoScroll` gave the cursor, which D-437
 * reproduces because the library is going away.
 *
 * What it does NOT do: scroll anything. `Playhead` runs the animation-frame
 * loop and applies the returned px; this module is the pure curve, so it can be
 * unit-tested without a DOM.
 */

/** Distance from either viewport edge, px, inside which autoscroll starts. */
export const AUTOSCROLL_EDGE_PX = 24;
/** Scroll speed, px per animation frame, at an overshoot of 1 (the pointer on the edge). */
export const AUTOSCROLL_MAX_PX_PER_FRAME = 20;
/** The overshoot is capped here, so dragging far outside the window does not run away. */
export const AUTOSCROLL_MAX_OVERSHOOT = 2;

/**
 * Signed px to scroll this frame for a pointer at `pointerX`, with the viewport
 * spanning `[left, right]` (client coordinates). Negative scrolls left. Zero in
 * the middle; ramps linearly from 0 at `AUTOSCROLL_EDGE_PX` inside an edge to
 * `AUTOSCROLL_MAX_PX_PER_FRAME` on the edge, and on up to
 * `AUTOSCROLL_MAX_OVERSHOOT` times that once the pointer is outside it.
 */
export function edgeScrollSpeed(pointerX: number, left: number, right: number): number {
  if (!(right > left)) return 0;
  // A viewport too narrow for two edge zones splits them down the middle.
  const edge = Math.min(AUTOSCROLL_EDGE_PX, (right - left) / 2);
  const overshootAt = (distanceToEdge: number) =>
    Math.min(AUTOSCROLL_MAX_OVERSHOOT, Math.max(0, (edge - distanceToEdge) / edge));
  const fromLeft = overshootAt(pointerX - left);
  if (fromLeft > 0) return -fromLeft * AUTOSCROLL_MAX_PX_PER_FRAME;
  const fromRight = overshootAt(right - pointerX);
  if (fromRight > 0) return fromRight * AUTOSCROLL_MAX_PX_PER_FRAME;
  return 0;
}
