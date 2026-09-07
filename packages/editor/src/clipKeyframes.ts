/**
 * @chroma/editor — clip transform keyframe CRUD (D-090, Phase 4 of the P0
 * full-NLE effort).
 *
 * `Clip.chroma_keyframes` (D-086/D-088) is the RAW `[{frame, params}]` array
 * itself, not a `parameters.chromaKeyframes`-wrapped object the way
 * `app/src/utils/maskKeyframes.ts`'s mask/relight-light keyframes are — see
 * `chroma_timeline::edit::resolve_clip_transform` (Rust), which wraps the
 * clip's own array into a synthetic `{chromaKeyframes: [...]}` object only at
 * the moment it hands it to the shared `chroma::keyframes::parse_keyframes`.
 * `packages/editor` cannot import `app/src/utils/maskKeyframes.ts` (a
 * different package — the D-039 layer direction runs app -> editor, not the
 * reverse), so this is a small, separate mirror of that file's upsert/
 * remove/clear pattern, scoped to just the CRUD this UI needs.
 *
 * **D-205 — per-property keyframing.** Every function below that takes a
 * `param` operates on ONE named transform field across the clip's whole
 * keyframe list, because a keyframe entry's `params` is a loose
 * `Record<string, unknown>` and different entries may legitimately name
 * different subsets of fields (the Inspector's per-property diamond writes
 * exactly one field per entry). Two consequences worth stating up front:
 *
 * 1. **Writes MERGE, they do not replace.** `mergeClipKeyframeParams`
 *    updates only the named fields inside whatever entry already sits at
 *    that frame. The pre-D-205 `upsertClipKeyframe` replaced the entry's
 *    whole `params` object, which silently discarded every OTHER property's
 *    key at that frame — fine when the only writer bundled all nine fields
 *    every time, destructive the moment they are written independently.
 * 2. **This module now DOES interpolate** (`paramValueAt`) — the one thing
 *    its pre-D-205 doc said it would never do. It has to: with per-property
 *    keyframes the Inspector's number field must show the value that is
 *    actually on screen at the playhead, and editing it must key THAT value,
 *    or the panel reports a static number the preview is not using. It is an
 *    exact mirror of `chroma::keyframes::interpolate_param` (Rust, D-205) —
 *    filter to the keys naming this param, linear between the bracketing
 *    two, hold outside, shortest-arc for `rotation` — and is authoring-side
 *    only; the render path still resolves its own values in Rust.
 */

import { type ClipTransformParam, sourceFramesToTimeline, timelineFramesToSource } from './timeline';

export interface ClipKeyframe {
  frame: number;
  params: Record<string, unknown>;
}

/** Write `params` into the keyframe at `frame`, returning a NEW frame-sorted
 *  array. An existing key at that exact frame keeps every field `params` does
 *  NOT name and has the named ones overwritten; no key there yet means a new
 *  entry holding exactly `params`.
 *
 *  D-205 — this MERGE is the whole difference from the pre-D-205
 *  `upsertClipKeyframe` (which replaced the entry's `params` wholesale, and
 *  which this replaces outright — nothing wants the destructive form). One
 *  property's diamond must never be able to delete another property's key at
 *  the same frame, and "key every property here" is then just this same
 *  function called with all nine names at once. */
export function mergeClipKeyframeParams(
  existing: ClipKeyframe[] | undefined,
  frame: number,
  params: Record<string, number>,
): ClipKeyframe[] {
  const f = Math.max(0, Math.round(frame));
  const kfs = (existing ?? []).map((k) => (k.frame === f ? { frame: f, params: { ...k.params, ...params } } : k));
  if (!kfs.some((k) => k.frame === f)) kfs.push({ frame: f, params: { ...params } });
  kfs.sort((a, b) => a.frame - b.frame);
  return kfs;
}

/** Does ANY keyframe entry define `param`? — i.e. is this one property
 *  animated (D-205's filled/hollow diamond). Mirrors `keyframeExprAt`'s and
 *  `chroma::keyframes::interpolate_param`'s own `hasOwnProperty` test, so the
 *  diamond can never claim a property is animated that the renderers do not
 *  actually animate. */
export function hasParamKeyframes(existing: ClipKeyframe[] | undefined, param: ClipTransformParam): boolean {
  return (existing ?? []).some((k) => Object.prototype.hasOwnProperty.call(k.params, param));
}

/** Every frame at which `param` itself is keyed, ascending. */
export function paramKeyframeFrames(existing: ClipKeyframe[] | undefined, param: ClipTransformParam): number[] {
  return (existing ?? [])
    .filter((k) => Object.prototype.hasOwnProperty.call(k.params, param))
    .map((k) => k.frame)
    .sort((a, b) => a - b);
}

/** The nearest frame strictly before (`dir === -1`) or after (`dir === 1`)
 *  `frame` at which `param` is keyed, or `null` when there is none in that
 *  direction — the `<` / `>` playhead nav (D-205). Strict so repeated presses
 *  really walk the list instead of sticking on the key under the playhead. */
export function adjacentParamKeyframeFrame(
  existing: ClipKeyframe[] | undefined,
  param: ClipTransformParam,
  frame: number,
  dir: -1 | 1,
): number | null {
  const frames = paramKeyframeFrames(existing, param);
  const hits = dir < 0 ? frames.filter((f) => f < frame) : frames.filter((f) => f > frame);
  if (hits.length === 0) return null;
  return dir < 0 ? hits[hits.length - 1] : hits[0];
}

/** Remove `param` from EVERY keyframe entry, dropping any entry left with no
 *  params at all; `undefined` when nothing survives (the clip goes fully
 *  static, same convention as [`removeClipKeyframe`]).
 *
 *  D-205 — this is After Effects' stopwatch-off: turning a property's
 *  animation off deletes that property's keys and leaves every OTHER
 *  property's keys exactly where they were. The caller is responsible for
 *  writing the property's static field to the value it had at the playhead
 *  first, so the picture does not jump — see `EditorInspectorPanel`. */
export function removeClipKeyframeParam(
  existing: ClipKeyframe[] | undefined,
  param: ClipTransformParam,
): ClipKeyframe[] | undefined {
  const kfs = (existing ?? [])
    .map((k) => {
      if (!Object.prototype.hasOwnProperty.call(k.params, param)) return k;
      const params = { ...k.params };
      delete params[param];
      return { frame: k.frame, params };
    })
    .filter((k) => Object.keys(k.params).length > 0);
  return kfs.length === 0 ? undefined : kfs;
}

/** `param`'s real value at `frame` — what the preview is actually showing —
 *  or `staticValue` when no key defines it.
 *
 *  An exact mirror of `chroma::keyframes::interpolate_param` (Rust, D-205):
 *  only the keys that name `param` take part, it is linear between the two
 *  bracketing ones, held flat outside them, and `rotation` takes the shortest
 *  signed arc (350° → 10° passes through 0°, not 180°) exactly as
 *  `lerp_value` does. A non-finite/non-numeric stored value falls back to
 *  `staticValue` rather than propagating `NaN` into the Inspector's field. */
export function paramValueAt(
  existing: ClipKeyframe[] | undefined,
  param: ClipTransformParam,
  frame: number,
  staticValue: number,
): number {
  const keyed = (existing ?? [])
    .filter((k) => Object.prototype.hasOwnProperty.call(k.params, param))
    .map((k) => ({ frame: k.frame, value: Number(k.params[param]) }))
    .sort((a, b) => a.frame - b.frame);
  if (keyed.length === 0 || keyed.some((k) => !Number.isFinite(k.value))) return staticValue;

  const f = Math.round(frame);
  if (f <= keyed[0].frame) return keyed[0].value;
  const hi = keyed.findIndex((k) => k.frame > f);
  if (hi < 0) return keyed[keyed.length - 1].value;

  const lo = keyed[hi - 1];
  const span = keyed[hi].frame - lo.frame;
  const t = span > 0 ? Math.min(Math.max((f - lo.frame) / span, 0), 1) : 0;
  if (param === 'rotation') {
    let d = (keyed[hi].value - lo.value) % 360;
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    return round6(lo.value + d * t);
  }
  return round6(lo.value + (keyed[hi].value - lo.value) * t);
}

/** Six decimal places — the same rounding `chroma::keyframes::round6` applies
 *  on the Rust side, so the number this panel shows is the number the
 *  renderer resolved rather than one that differs in float dust. */
function round6(v: number): number {
  return Math.round(v * 1_000_000) / 1_000_000;
}

/** Remove the keyframe at `frame`. Returns `undefined` when none remain (so
 *  the clip goes back to fully static — `set_clip_keyframes` normalizes `[]`
 *  the same way, this just saves a round trip through that). */
export function removeClipKeyframe(existing: ClipKeyframe[] | undefined, frame: number): ClipKeyframe[] | undefined {
  const f = Math.round(frame);
  const kfs = (existing ?? []).filter((k) => k.frame !== f);
  return kfs.length === 0 ? undefined : kfs;
}

/** Remove every keyframe. */
export function clearClipKeyframes(): ClipKeyframe[] | undefined {
  return undefined;
}

/** The clip's own SOURCE frame at the given timeline `playhead` frame —
 *  keyframes are interpolated against this (mirrors `Track::clip_at`'s
 *  `source_start + timeline_frames_to_source(...)`, the same value
 *  `resolve_clip_transform` receives as `source_frame`), NOT the absolute
 *  timeline position. Clamped to the clip's own source window since the
 *  playhead may sit outside the clip when nothing is actually selected there.
 *
 *  **B-079 — now fps-corrected, in the SAME change as `Track::clip_at`'s own
 *  Rust fix**, per that bug's own entry in `docs/BUGS.md` (fixing this TS
 *  half alone, before Rust's, would have desynced authoring from playback —
 *  see the entry for why). `fps` is the project's own `timelineFps(tl)`;
 *  `timelineFramesToSource` (B-077) converts the TIMELINE-frame offset
 *  `playhead - clip.start_frame` into the clip's own SOURCE frames via
 *  `clip.source_fps` (falling back to `fps` — a 1:1 ratio — when absent),
 *  exactly mirroring `Track::clip_at`'s now-fixed formula. Identical to the
 *  pre-fix plain subtraction whenever `source_fps` is absent or equals
 *  `fps` — every same-native-fps clip computes the same source frame either
 *  way. */
export function clipSourceFrame(
  clip: { source_start: number; start_frame: number; source_len: number; source_fps?: number },
  playhead: number,
  fps: number,
): number {
  const raw = clip.source_start + timelineFramesToSource(clip, playhead - clip.start_frame, fps);
  return Math.max(0, Math.min(clip.source_len - 1, raw));
}

/** The exact inverse of [`clipSourceFrame`]: the TIMELINE frame to park the
 *  playhead on so that this clip resolves to `sourceFrame` (D-205 — the
 *  `<` / `>` per-property keyframe nav, which knows a key's source frame and
 *  needs the playhead position that lands on it).
 *
 *  Deliberately NOT clamped to the clip's own on-timeline window: the store's
 *  own `setPlayhead` already clamps to the timeline's real duration, and a
 *  key sitting outside the clip's current trim (perfectly legal — trimming
 *  never deletes keys) should still be reachable rather than silently
 *  snapping to the clip's edge. `sourceFramesToTimeline` is the same
 *  `source_fps` conversion [`clipSourceFrame`] uses, run the other way. */
export function clipTimelineFrame(
  clip: { source_start: number; start_frame: number; source_fps?: number },
  sourceFrame: number,
  fps: number,
): number {
  return clip.start_frame + sourceFramesToTimeline(clip, sourceFrame - clip.source_start, fps);
}
