/**
 * @apelles/editor — lane geometry (D-437 S1).
 *
 * What it is: the pure arithmetic of the timeline lane renderer — how wide the
 * scrollable content is, where a clip's box sits in it, which frame a content
 * x-coordinate is, and which slice of a clip is on screen. Content pixels are
 * measured from the left edge of the scroller's content: `x = startLeftPx +
 * seconds × pxPerSec`, the same convention every overlay in `TimelinePane`
 * already uses (`START_LEFT_PX`).
 *
 * What it does NOT do: touch the DOM, React or the store; decide WHICH clips
 * are rendered (that is `laneWindow.ts`); or read scroll state.
 *
 * `contentWidth` reproduces the width `@xzdarcy/react-timeline-editor` gave its
 * scroll area (`startLeft + max(20, ceil(maxEnd / scale) + 5) × scaleWidth`, with
 * `scale = tickSeconds` and `scaleWidth = tickSeconds × pxPerSec`), so a frame just
 * past the last clip, and a drop past the end, land exactly where they did.
 */
import { endFrame, type Clip } from '../timeline';

/** The library's `minScaleCount` — the content is never shorter than this many ticks. */
export const LANE_MIN_TICKS = 20;
/** The library's tail: ticks of empty room after the last clip's end. */
export const LANE_TAIL_TICKS = 5;

/** D-432 §4.4 — a clip's own edge-trim zone, px inside each edge: 8 px, or a third of
 *  a narrow clip so its body stays grabbable. (Same values as `TimelinePane`'s own
 *  constants until D-437 S4 deletes those.) */
export const TRIM_ZONE_PX = 8;
export const TRIM_ZONE_MAX_FRACTION = 1 / 3;

/** Width of the scrollable content, px. `endSeconds` is the end of the last clip on
 *  any track (0 for an empty timeline); `tickSeconds` is the ruler's tick interval. */
export function contentWidth(
  endSeconds: number,
  tickSeconds: number,
  pxPerSec: number,
  startLeftPx: number,
): number {
  const ticks = Math.max(LANE_MIN_TICKS, Math.ceil(endSeconds / tickSeconds) + LANE_TAIL_TICKS);
  return startLeftPx + ticks * tickSeconds * pxPerSec;
}

/** Left edge of a clip's box in content px. */
export function clipLeftPx(startFrame: number, fps: number, pxPerSec: number, startLeftPx: number): number {
  return startLeftPx + (startFrame / fps) * pxPerSec;
}

/** Width of a clip's box in px — its timeline span (`endFrame`, which honours speed ramps). */
export function clipWidthPx(clip: Clip, fps: number, pxPerSec: number): number {
  return ((endFrame(clip, fps) - clip.start_frame) / fps) * pxPerSec;
}

/** The (fractional) timeline frame at a content x-coordinate. Inverse of `clipLeftPx`. */
export function frameAtContentX(x: number, fps: number, pxPerSec: number, startLeftPx: number): number {
  return ((x - startLeftPx) / pxPerSec) * fps;
}

/** The slice of a clip that is on screen, in px from the clip's own left edge. */
export interface VisibleSlice {
  start: number;
  end: number;
}

/**
 * The part of a clip box `[clipLeft, clipLeft + widthPx)` inside the viewport
 * `[viewStartPx, viewEndPx)` (both content px), clamped to `[0, widthPx]` and rounded
 * outward to `bucketPx`. Clamping is the point: a clip wholly inside the viewport
 * always gets `{0, widthPx}`, and a clip wholly outside gets an empty slice parked at
 * the nearest edge, so scrolling changes the slice only for clips that straddle a
 * viewport edge and a memoised clip does not re-render per scrolled pixel.
 */
export function visibleSlice(
  clipLeft: number,
  widthPx: number,
  viewStartPx: number,
  viewEndPx: number,
  bucketPx: number,
): VisibleSlice {
  const relStart = viewStartPx - clipLeft;
  const relEnd = viewEndPx - clipLeft;
  if (relEnd <= 0) return { start: 0, end: 0 };
  if (relStart >= widthPx) return { start: widthPx, end: widthPx };
  const b = bucketPx > 0 ? bucketPx : 1;
  const start = Math.min(widthPx, Math.max(0, Math.floor(relStart / b) * b));
  const end = Math.min(widthPx, Math.max(0, Math.ceil(relEnd / b) * b));
  return { start, end };
}
