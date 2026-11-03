/**
 * The default render scale of a Motion video (D-342, amended by B-300).
 *
 * What it is: the one rule `render.mts` applies when a caller passes no
 * `--scale`. D-342 renders a scene at 2x its authored size so a 1920x1080
 * manifest comes out native 3840x2160. Applied blindly that doubled an
 * already-4K manifest to 7680x4320 (B-300).
 *
 * The rule: render at 2x only while the result stays within UHD (3840 px on
 * the long edge, the Edit canvas's size); a manifest that already reaches UHD
 * renders at 1x, i.e. exactly its own size. The scale stays a whole number so
 * the output is always an exact multiple of the manifest (even-sized for h264
 * whenever the manifest is).
 *
 * What it does NOT do: read the manifest file, or override an explicit
 * `--scale` (the preview stills pass one). Its own module because `render.mts`
 * parses its arguments at import time, so a test cannot import it.
 */

/** `Config.setScale(2)` (D-342): the most a video is ever scaled. */
export const MAX_VIDEO_SCALE = 2;
/** The long edge, in pixels, a default-scaled render never exceeds (UHD). */
export const MAX_OUTPUT_LONG_EDGE = 3840;

/** The scale for a manifest of `width` x `height` when the caller gave none. */
export function defaultVideoScale(width: number, height: number): number {
  const longEdge = Math.max(width, height);
  return longEdge * MAX_VIDEO_SCALE <= MAX_OUTPUT_LONG_EDGE ? MAX_VIDEO_SCALE : 1;
}
