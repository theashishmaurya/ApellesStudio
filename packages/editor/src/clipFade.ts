/**
 * @chroma/editor — the pure geometry behind the timeline's on-clip fade
 * handles (D-207).
 *
 * **What it is.** Frames↔pixels for a clip's `fade_in_frames`/
 * `fade_out_frames` at the timeline's current zoom, plus the SVG path strings
 * that draw each ramp at its real `FadeCurve` shape. `ClipFadeOverlay.tsx` is
 * the DOM/pointer wiring around this; everything with a correct answer lives
 * here and is unit-tested in `clipFade.test.ts` — the same split
 * `transformGeometry.ts`/`TransformOverlay.tsx` and `marquee.ts`/
 * `TimelinePane.tsx` already use.
 *
 * **What it does NOT do.** It never evaluates a fade's *gain* — that is
 * `timelineExportAudio.ts`'s `fadeGainAt`, mirroring `chroma_types::fade_gain`,
 * and there is exactly one such evaluator per side of the wire. Drawing a
 * ramp needs the curve's SHAPE, not sampled values, and an SVG cubic segment
 * IS that shape exactly (see [`fadeRampPaths`]), so nothing here approximates
 * anything.
 *
 * **Units.** `fade_in_frames`/`fade_out_frames` are in the clip's OWN SOURCE
 * frames — the same unit as `Clip.duration`, which is what
 * `chroma_timeline::Clip::fade_multiplier_at` compares them against and what
 * `buildAudioSourceChain` divides by the clip's own `clipFps`. The timeline
 * draws in TIMELINE frames, so every conversion here routes through
 * `timeline.ts`'s existing `sourceFramesToTimeline`/`timelineFramesToSource`
 * (B-077/D-186) rather than dividing by `fps` directly — a mixed-native-fps
 * timeline is exactly where a second, direct conversion would silently be
 * wrong.
 */

import {
  sourceFramesToTimeline,
  timelineFramesToSource,
  type Clip,
  type FadeCurve,
} from './timeline';

/** Diameter of the drawn fade handle, in px. Matches `TransformOverlay.tsx`'s
 *  own `HANDLE_SIZE` (10) minus a pixel: this one sits inside a 52px timeline
 *  row rather than over a full-size preview, so it is drawn a touch smaller
 *  while keeping the same visual weight. */
export const FADE_HANDLE_SIZE_PX = 9;

/** The handle's square pointer target, in px — bigger than the drawn handle so
 *  grabbing one never needs pixel accuracy, the same reason
 *  `TransformOverlay.tsx` gives its corners a `HANDLE_HIT_SLOP`.
 *
 *  Deliberately kept SHORT vertically as well as narrow: it is anchored to the
 *  clip's top edge, so on a `ROW_HEIGHT` (52px) row it covers the top ~29% and
 *  leaves the remaining ~37px of each 10px edge zone to the timeline library's
 *  own `.timeline-editor-action-{left,right}-stretch` trim handles. A fade
 *  handle at rest sits exactly ON that trim zone (a zero fade is at the clip's
 *  own corner), so the two gestures are separated by WHERE IN THE ROW the
 *  press lands — which is what Resolve does too — not by z-order alone. See
 *  `ClipFadeOverlay.tsx`'s own doc, and B-013 for why anything painted over a
 *  clip has to think about this at all. */
export const FADE_HANDLE_HIT_PX = 15;

/** Below this on-screen clip width (px) no fade handles are drawn at all. Two
 *  `FADE_HANDLE_HIT_PX` targets plus a gap between them do not fit on a
 *  narrower clip, and a clip that small at the current zoom is one the user is
 *  navigating past, not authoring a fade on. The ramps themselves still draw
 *  (a fade already set stays visible at every zoom) — only the grab targets go
 *  away, which is also what keeps a heavily zoomed-out timeline's clips
 *  trimmable. */
export const FADE_MIN_HANDLE_CLIP_PX = 2 * FADE_HANDLE_HIT_PX + 6;

/** How far below the clip's top edge the "full gain" line is drawn, in px.
 *  Purely a rendering inset so a 1px stroke at unity is fully visible instead
 *  of half-clipped by the clip body's own `overflow-hidden` rounded box — it
 *  is never part of the frames↔px math below, and never affects what is
 *  committed. */
export const FADE_TOP_INSET_PX = 1;

/** A fade duration in the clip's own source frames → its on-screen width in
 *  px at the current zoom. Negative/NaN inputs read as no fade, matching
 *  `fade_gain`'s own "the model stores what the UI wrote, the consumer decides
 *  what it means" posture. */
export function fadeFramesToPx(
  clip: Pick<Clip, 'source_fps'>,
  fadeSourceFrames: number | undefined,
  fps: number,
  pxPerSec: number,
): number {
  const f = Number.isFinite(fadeSourceFrames) ? Math.max(0, fadeSourceFrames as number) : 0;
  if (f <= 0 || fps <= 0) return 0;
  return (sourceFramesToTimeline(clip, f, fps) / fps) * pxPerSec;
}

/** The inverse of [`fadeFramesToPx`] — an on-screen px offset from the clip's
 *  edge → the fade duration in the clip's own source frames, floored at 0 and
 *  rounded to a whole frame (the unit `applyOp`'s `set_clip_fade` stores). */
export function pxToFadeFrames(
  clip: Pick<Clip, 'source_fps'>,
  px: number,
  fps: number,
  pxPerSec: number,
): number {
  if (!Number.isFinite(px) || px <= 0 || fps <= 0 || pxPerSec <= 0) return 0;
  return Math.max(0, timelineFramesToSource(clip, (px / pxPerSec) * fps, fps));
}

/** Clamp a px offset produced by an in-flight handle drag to the clip's own
 *  on-screen extent.
 *
 *  **This is a DRAG clamp, not a model clamp** — `applyOp`'s `set_clip_fade`
 *  deliberately does not clamp a fade to the clip's `duration` (a fade longer
 *  than the clip is a legitimate authoring choice: the two windows overlap and
 *  their multipliers multiply — see that op's own doc and `fade_gain`'s). What
 *  this bounds is only how far a HANDLE can travel, and the clip's far edge is
 *  where it runs out of timeline to travel along. Longer-than-clip fades stay
 *  fully authorable from the Inspector's numeric field and from MCP's
 *  `set_clip_fade`, and [`fadeRampPaths`] draws one honestly (a ramp that
 *  never reaches unity before the clip ends). */
export function clampFadeDragPx(px: number, clipWidthPx: number): number {
  if (!Number.isFinite(px)) return 0;
  return Math.min(Math.max(px, 0), Math.max(clipWidthPx, 0));
}

/** Which end of the clip a ramp belongs to. */
export type FadeSide = 'in' | 'out';

/** The two SVG path strings for one ramp: `line` is the rubber-band itself
 *  (stroked), `area` is the same curve closed against the clip's top edge
 *  (filled, to wash out the attenuated part of the clip). */
export interface FadeRampPaths {
  line: string;
  area: string;
}

function fmt(n: number): string {
  // 3dp is well below one screen pixel at every zoom this pane allows, and
  // keeps the emitted path (and this module's own tests) readable.
  return (Math.round(n * 1000) / 1000).toString();
}

/**
 * The ramp for `side`, as SVG paths in the clip body's own px coordinate
 * space (origin top-left, `width` × `height`).
 *
 * **The curve is drawn EXACTLY, not approximated or simplified to a straight
 * line.** A `FadeCurve` is `cubic-bezier(x1,y1,x2,y2)` with `P0=(0,0)` and
 * `P3=(1,1)` implicit; an SVG `C` segment is the same parametric cubic with
 * the same four control points, so mapping the curve's own unit square onto
 * (ramp width × clip height) traces the identical geometry. The Newton/
 * bisection solve `fadeCurveEval` needs exists only to answer "gain at a given
 * *x*", which drawing never asks.
 *
 * `x` in the curve's own space is progress through the fade WINDOW and `y` is
 * the multiplier — and, per `chroma_timeline::Clip::fade_out_curve`'s own doc,
 * a fade-out's window is measured from the clip's OUT-point, so `x = 0` there
 * is the clip's very last frame. That is why the fade-out path is built
 * right-to-left rather than mirrored: an `ease-in` fade-out must be slow near
 * silence, exactly as an `ease-in` fade-in is.
 */
export function fadeRampPaths(
  side: FadeSide,
  width: number,
  height: number,
  rampPx: number,
  curve: FadeCurve,
): FadeRampPaths | null {
  if (!(rampPx > 0) || !(height > 0)) return null;
  const top = Math.min(FADE_TOP_INSET_PX, height / 2);
  // y for a multiplier of `g`: 0 → the clip's bottom (silence/transparent),
  // 1 → `top` (unity).
  const y = (g: number) => height - g * (height - top);
  const { x1, y1, x2, y2 } = curve;

  // `dir` is +1 for a fade-in (the window runs left-to-right from the clip's
  // in-point) and -1 for a fade-out (it runs right-to-left from the
  // out-point) — the ONE difference between the two, per the note above.
  const dir = side === 'in' ? 1 : -1;
  const originX = side === 'in' ? 0 : width;
  const px = (t: number) => originX + dir * t * rampPx;

  const line =
    `M ${fmt(px(0))} ${fmt(y(0))} ` +
    `C ${fmt(px(x1))} ${fmt(y(y1))}, ${fmt(px(x2))} ${fmt(y(y2))}, ${fmt(px(1))} ${fmt(y(1))}`;
  // Closed back along the clip's top edge to the ramp's own origin corner, so
  // the fill covers exactly the part of the clip the fade attenuates.
  const area = `${line} L ${fmt(px(0))} ${fmt(y(1))} Z`;
  return { line, area };
}

/** The flat "unity" segment between the two ramps, or `null` when they meet or
 *  overlap (a clip that is entirely one dip — legitimate, see
 *  [`clampFadeDragPx`]). Drawn so the rubber-band reads as one continuous
 *  envelope across the clip rather than two disconnected diagonals. */
export function fadeUnityLinePath(
  width: number,
  height: number,
  fadeInPx: number,
  fadeOutPx: number,
): string | null {
  const top = Math.min(FADE_TOP_INSET_PX, height / 2);
  const from = Math.max(0, fadeInPx);
  const to = width - Math.max(0, fadeOutPx);
  if (!(to > from)) return null;
  return `M ${fmt(from)} ${fmt(top)} L ${fmt(to)} ${fmt(top)}`;
}

/** Where a side's handle is drawn, in px from the clip's LEFT edge — the point
 *  the ramp meets unity, parked at the opposite edge when the fade is longer
 *  than the clip so the handle stays reachable (and so dragging it back is
 *  possible without the Inspector). */
export function fadeHandleX(side: FadeSide, width: number, rampPx: number): number {
  const r = Math.min(Math.max(rampPx, 0), Math.max(width, 0));
  return side === 'in' ? r : width - r;
}
