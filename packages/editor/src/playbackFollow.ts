/**
 * Playback view-follow for the timeline (B-326).
 *
 * What it is: the pure geometry for "page the timeline view so the playhead
 * stays visible while playing" — Premiere's Smooth/Page Scrolling and
 * Resolve's auto-scroll. What it does NOT do: touch React, the store or the
 * library; `TimelinePane` calls it from its imperative playhead subscription
 * (D-325: no per-frame re-render) and writes the result with `setScrollLeft`.
 */

/** Gap kept between the viewport's left edge and the playhead after a page. */
export const FOLLOW_PAGE_LEAD_PX = 48;
/** The playhead counts as leaving the view this far before the right edge. */
export const FOLLOW_RIGHT_MARGIN_PX = 24;

export interface FollowInput {
  frame: number;
  fps: number;
  pxPerSec: number;
  scrollLeft: number;
  viewportWidth: number;
  /** content x of time zero (the library's `startLeft`) */
  startLeftPx: number;
}

/** The `scrollLeft` that re-pages the view, or `null` when the playhead is
 *  already comfortably visible (or the viewport is not measured yet). */
export function followScrollLeft(i: FollowInput): number | null {
  if (i.viewportWidth <= 0) return null;
  const x = i.startLeftPx + (i.frame / i.fps) * i.pxPerSec;
  const visible = x >= i.scrollLeft + i.startLeftPx && x <= i.scrollLeft + i.viewportWidth - FOLLOW_RIGHT_MARGIN_PX;
  if (visible) return null;
  return Math.max(0, Math.round(x - i.startLeftPx - FOLLOW_PAGE_LEAD_PX));
}
