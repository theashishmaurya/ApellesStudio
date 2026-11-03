/**
 * Playback view-follow for the timeline (B-326), and the paused-seek follow
 * (B-359 item 6: a programmatic jump outside the view centres it).
 *
 * What it is: the pure geometry for "page the timeline view so the playhead
 * stays visible while playing" — Premiere's Smooth/Page Scrolling and
 * Resolve's auto-scroll. What it does NOT do: touch React, the store or the
 * library; `TimelinePane` calls it from its imperative playhead subscription
 * (D-325: no per-frame re-render) and writes the result to the lanes' scroller.
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

/**
 * B-359 item 6 — the `scrollLeft` that brings a playhead JUMP into view while
 * paused (an `editor_set_playhead`, a marker in the Index panel, ↑/↓ to an
 * edit point, a transcript line): `null` when the playhead is already
 * visible (same test as `followScrollLeft`), otherwise the scroll that
 * CENTRES it. Centred rather than paged: a jump is a "show me this place"
 * request that wants context on both sides, where playback wants the run-way
 * ahead. The scroller clamps the value to its own range, so the start and the
 * end of the timeline need no case of their own.
 */
export function seekFollowScrollLeft(i: FollowInput): number | null {
  if (i.viewportWidth <= 0) return null;
  const x = i.startLeftPx + (i.frame / i.fps) * i.pxPerSec;
  const visible = x >= i.scrollLeft + i.startLeftPx && x <= i.scrollLeft + i.viewportWidth - FOLLOW_RIGHT_MARGIN_PX;
  if (visible) return null;
  return Math.max(0, Math.round(x - i.viewportWidth / 2));
}
