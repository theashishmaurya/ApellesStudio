/**
 * @chroma/editor — dynamic zoom: the box→keyframe math (D-234, roadmap 27).
 *
 * **What it is.** Two framings — a START and an END — turned into the
 * `position_x`/`position_y`/`scale` keyframes that animate the clip from one
 * to the other across its whole source span. That is the entire feature: a
 * user drags two boxes in the viewer (`DynamicZoomOverlay.tsx`) or an agent
 * names two framings (`editor_set_dynamic_zoom`), and this module writes the
 * keys. Resolve's own pitch for the feature is "you don't have to know
 * anything about animation to use it" — so this is a shortcut ON TOP of the
 * existing keyframe model, not a new one.
 *
 * **What it does NOT do — and this is the load-bearing scope line.** It adds
 * no `Clip` field, no render stage, no second geometry space. Everything it
 * produces is ordinary D-208 per-property keyframes that
 * `chroma::keyframes::interpolate_param` (preview) and
 * `timelineExport.ts`'s `keyframeExprAt` (export) already resolve. A dynamic
 * zoom is therefore, from the moment it is written, indistinguishable from
 * hand-authored keys: the Inspector's diamonds show it, `<`/`>` navigates it,
 * the curve editor (roadmap 27) will re-shape it, undo undoes it, and both
 * renderers already agree about it because there is nothing new for them to
 * agree about. Resolve's own Dynamic Zoom is instead a persistent, separately
 * re-editable transform stage; D-234 records why Chroma deliberately bakes.
 *
 * **Consequence of baking, stated plainly:** the START/END framings and the
 * EASE are not stored anywhere. They are re-derived on the way back in — the
 * framings exactly ([`dynamicZoomFramings`] reads the resolved transform at
 * the span's two ends, which is what the keys hold), the ease not at all (the
 * baked intermediate keys ARE the curve). Re-arming the mode on a clip
 * therefore shows the right two boxes and a default-`linear` ease selector.
 *
 * **Units.** Everything here is composition-fraction space and the clip's own
 * SOURCE frames — the same two units `clipKeyframes.ts` and
 * `transformGeometry.ts` already work in. Nothing in this file knows about
 * screen pixels or timeline frames.
 */

import { mergeClipKeyframeParams, resolveClipBoxTransform, type ClipKeyframe } from './clipKeyframes';
import { DEFAULT_EASE_CURVE, easePresetName, type Clip, type EaseCurve } from './timeline';
import { easeCurveEval } from './easeCurve';

/** The three transform properties a dynamic zoom writes, and the only ones it
 *  touches. Deliberately not `rotation` or the crop insets: a push-in is a
 *  move plus a scale, and silently keying five more properties as a side
 *  effect of dragging a box is the destructive-write shape B-067 was. */
export const DYNAMIC_ZOOM_PARAMS = ['position_x', 'position_y', 'scale'] as const;
export type DynamicZoomParam = (typeof DYNAMIC_ZOOM_PARAMS)[number];

/** One end of a dynamic zoom — exactly the three fields above, resolved. The
 *  same numbers `ResolvedClipBoxTransform` carries, minus the two box-size
 *  override fields (an override is not animated by this gesture; it is
 *  CLEARED by it — see `DynamicZoomOverlay`'s commit and D-193). */
export interface DynamicZoomFraming {
  position_x: number;
  position_y: number;
  scale: number;
}

/** How much the default END box is pushed in relative to the START box when a
 *  clip has no dynamic zoom yet — a gentle 1.2× punch-in, which is what the
 *  feature is for ("gentle push in or pull out animations", Blackmagic's own
 *  description of Dynamic Zoom). Only ever a STARTING POINT for a drag or an
 *  omitted MCP argument; nothing clamps a user's own box to it. */
export const DYNAMIC_ZOOM_DEFAULT_PUSH = 1.2;

/** How many segments a NON-LINEAR ease is baked into.
 *
 *  The Edit tab's keyframe model interpolates strictly linearly between
 *  bracketing keys, on both sides of the wire — so an ease can only be
 *  expressed as a piecewise-linear approximation of the real cubic bezier.
 *  20 segments is the same density `timelineExportAudio.ts` already chose for
 *  the same problem (approximating a `EaseCurve` for ffmpeg), reused rather
 *  than re-tuned so the two approximations in this package agree about how
 *  finely a bezier needs sampling.
 *
 *  A `linear` curve is not sampled at all — it bakes to exactly two keys, so
 *  the overwhelmingly common case leaves a clip with a clean start/end pair a
 *  human can read and re-edit, not 21 keys. */
export const DYNAMIC_ZOOM_EASE_SAMPLES = 20;

/** The clip's own SOURCE-frame span, i.e. the two frames a dynamic zoom
 *  animates between: its first visible source frame and its last.
 *
 *  `source_start`/`duration` are both in the clip's own source frames (see
 *  `Clip`'s doc), and `interpolate_param` brackets against exactly those, so
 *  no fps conversion belongs anywhere in this module. `last` is inclusive —
 *  `source_start + duration` is the first frame PAST the clip, and keying the
 *  end there would put the end framing one frame beyond anything that renders.
 *
 *  A degenerate (zero/one-frame) clip yields `first === last`; [`dynamicZoomKeyframes`]
 *  handles that rather than dividing by zero. */
export function dynamicZoomSpan(clip: Pick<Clip, 'source_start' | 'duration'>): { first: number; last: number } {
  const first = Math.max(0, Math.round(clip.source_start));
  const frames = Math.max(0, Math.round(clip.duration));
  return { first, last: first + Math.max(0, frames - 1) };
}

/** The framing a clip actually has at one of its own source frames — the
 *  resolved (keyframe-aware) transform, projected onto the three fields a
 *  dynamic zoom owns. Built on `resolveClipBoxTransform`, i.e. the SAME
 *  interpolation the on-canvas box and the Inspector already read (D-209), so
 *  re-arming the mode can never show a box somewhere the picture is not. */
export function dynamicZoomFramingAt(
  clip: Parameters<typeof resolveClipBoxTransform>[0],
  sourceFrame: number,
): DynamicZoomFraming {
  const r = resolveClipBoxTransform(clip, sourceFrame);
  return { position_x: r.position_x, position_y: r.position_y, scale: r.scale };
}

/** The two boxes to DRAW for a clip: its resolved framing at the first and
 *  last frames of its own span. On a static clip both are the same framing
 *  (the boxes sit exactly on top of each other, which is the correct "no
 *  zoom authored yet" state — arming the mode must write nothing). */
export function dynamicZoomFramings(
  clip: Parameters<typeof resolveClipBoxTransform>[0] & Pick<Clip, 'source_start' | 'duration'>,
): { start: DynamicZoomFraming; end: DynamicZoomFraming } {
  const span = dynamicZoomSpan(clip);
  return { start: dynamicZoomFramingAt(clip, span.first), end: dynamicZoomFramingAt(clip, span.last) };
}

/** `framing` pushed in by [`DYNAMIC_ZOOM_DEFAULT_PUSH`] about its own centre —
 *  the default END box for a clip that has no zoom yet, and what an omitted
 *  `end` argument means to `editor_set_dynamic_zoom`.
 *
 *  Position is unchanged, deliberately: `scale` in this model always grows the
 *  box about the point `0.5 + position`, whatever its size (see
 *  `transformGeometry.ts`'s `clipBoxFraction` — `left + width/2` does not
 *  depend on `width`), so a pure scale change IS a centred push-in and moving
 *  `position` too would drift the framing off the subject. */
export function defaultDynamicZoomEnd(framing: DynamicZoomFraming): DynamicZoomFraming {
  return { ...framing, scale: framing.scale * DYNAMIC_ZOOM_DEFAULT_PUSH };
}

/** Are these two framings the same to the model — i.e. would baking them
 *  produce an animation that never moves? Used to keep an inert arm/disarm
 *  from writing keys, and by the MCP tool to report honestly that it wrote a
 *  hold rather than a zoom. Exact comparison: both sides come from the same
 *  stored numbers or from a drag that produced a real delta, so a tolerance
 *  would invent a second notion of "the same framing". */
export function dynamicZoomIsStatic(a: DynamicZoomFraming, b: DynamicZoomFraming): boolean {
  return a.position_x === b.position_x && a.position_y === b.position_y && a.scale === b.scale;
}

/** Six decimal places — the same rounding `chroma::keyframes::round6` applies
 *  on the Rust side and that `clipKeyframes.ts` mirrors, so a baked key holds
 *  the number the renderer would have resolved rather than one differing in
 *  float dust. */
function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

function lerpFraming(a: DynamicZoomFraming, b: DynamicZoomFraming, t: number): DynamicZoomFraming {
  return {
    position_x: round6(a.position_x + (b.position_x - a.position_x) * t),
    position_y: round6(a.position_y + (b.position_y - a.position_y) * t),
    scale: round6(a.scale + (b.scale - a.scale) * t),
  };
}

/**
 * The keyframes that animate `start` → `end` across `[first, last]` (the
 * clip's own source frames) with easing `curve`.
 *
 * **Linear (the default) bakes to exactly two keys** — one at each end. That
 * is not an optimisation, it is the honest representation: the model's own
 * interpolation between two keys already IS the linear ramp, so anything more
 * would be redundant keys a human then has to edit around.
 *
 * **Any other curve is baked into [`DYNAMIC_ZOOM_EASE_SAMPLES`] segments**,
 * because the Edit tab's keyframe model has no per-key easing on either side
 * of the wire — `interpolate_param` (Rust) and `keyframeExprAt` (ffmpeg) are
 * both strictly linear between bracketing keys. Sampling the real bezier and
 * letting that linear interpolation join the samples is the only way to get an
 * ease that PREVIEW AND EXPORT BOTH REPRODUCE, and it is the same trade
 * `timelineExportAudio.ts` already makes for a fade's own curve. The endpoints
 * are written exactly (not through the curve), so a bake always begins and
 * ends on the framings the user actually dragged.
 *
 * Frames are rounded and de-duplicated: on a clip shorter than the sample
 * count several samples land on one frame, and two keys at the same frame
 * would be a malformed list. The last writer for a frame wins, which keeps the
 * two endpoints exact.
 *
 * A degenerate span (`last <= first`, i.e. a one-frame clip) yields a single
 * key at `first` holding `end` — a one-frame clip cannot animate, and holding
 * the end framing is what the user asked to see.
 */
export function dynamicZoomKeyframes(
  start: DynamicZoomFraming,
  end: DynamicZoomFraming,
  first: number,
  last: number,
  curve: EaseCurve = DEFAULT_EASE_CURVE,
): ClipKeyframe[] {
  const f0 = Math.max(0, Math.round(first));
  const f1 = Math.max(f0, Math.round(last));
  const paramsOf = (fr: DynamicZoomFraming): Record<string, number> => ({
    position_x: fr.position_x,
    position_y: fr.position_y,
    scale: fr.scale,
  });

  if (f1 <= f0) return [{ frame: f0, params: paramsOf(end) }];

  // `easePresetName` is the same exact-match the Inspector's own curve
  // `<select>` uses, so "the user left it on linear" is decided identically in
  // both places rather than by a second, drifting comparison.
  const segments = easePresetName(curve) === 'linear' ? 1 : DYNAMIC_ZOOM_EASE_SAMPLES;

  const byFrame = new Map<number, Record<string, number>>();
  for (let i = 0; i <= segments; i++) {
    const x = i / segments;
    const frame = Math.round(f0 + (f1 - f0) * x);
    // The endpoints are the dragged framings verbatim; only the interior is
    // sampled through the curve.
    const framing = i === 0 ? start : i === segments ? end : lerpFraming(start, end, easeCurveEval(curve, x));
    byFrame.set(frame, paramsOf(framing));
  }
  return [...byFrame.entries()].sort((a, b) => a[0] - b[0]).map(([frame, params]) => ({ frame, params }));
}

/**
 * `existing` with this clip's dynamic zoom (re)written — the whole op payload
 * a commit hands `set_clip_keyframes`.
 *
 * **Replaces, per property, not appends.** Every pre-existing
 * `position_x`/`position_y`/`scale` key is dropped first, because a dynamic
 * zoom spans the clip's ENTIRE source window: leaving old keys in place would
 * interleave two animations of the same three properties and produce a motion
 * neither the user nor the agent asked for. **Every OTHER property's keys
 * survive untouched** (`opacity`, `rotation`, the four crop insets, `volume`,
 * `pan`) — that is what makes this safe to run on an already-animated clip,
 * and it falls straight out of the per-property model D-208 built. Callers
 * warn before doing it (the Inspector section) and one `applyOp` makes the
 * whole thing a single undo step.
 */
export function applyDynamicZoom(
  existing: ClipKeyframe[] | undefined,
  start: DynamicZoomFraming,
  end: DynamicZoomFraming,
  first: number,
  last: number,
  curve: EaseCurve = DEFAULT_EASE_CURVE,
): ClipKeyframe[] {
  // Strip the three params this gesture owns from every entry, dropping any
  // entry left with nothing — the same shape `removeClipKeyframeParam` uses,
  // done once for all three rather than three times over.
  const kept = (existing ?? [])
    .map((k) => {
      const params = { ...k.params };
      for (const p of DYNAMIC_ZOOM_PARAMS) delete params[p];
      return { frame: k.frame, params };
    })
    .filter((k) => Object.keys(k.params).length > 0);

  let out = kept;
  for (const kf of dynamicZoomKeyframes(start, end, first, last, curve)) {
    out = mergeClipKeyframeParams(out, kf.frame, kf.params as Record<string, number>);
  }
  return out;
}

/** Does this clip already have keys on any of the three properties a dynamic
 *  zoom would overwrite? What the Inspector's warning line asks before
 *  offering the gesture, so "this will replace your existing position/scale
 *  animation" is stated rather than discovered. */
export function dynamicZoomWouldReplace(existing: ClipKeyframe[] | undefined): boolean {
  return (existing ?? []).some((k) =>
    DYNAMIC_ZOOM_PARAMS.some((p) => Object.prototype.hasOwnProperty.call(k.params ?? {}, p)),
  );
}
