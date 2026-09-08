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
 * **D-208 — per-property keyframing.** Every function below that takes a
 * `param` operates on ONE named transform field across the clip's whole
 * keyframe list, because a keyframe entry's `params` is a loose
 * `Record<string, unknown>` and different entries may legitimately name
 * different subsets of fields (the Inspector's per-property diamond writes
 * exactly one field per entry). Two consequences worth stating up front:
 *
 * 1. **Writes MERGE, they do not replace.** `mergeClipKeyframeParams`
 *    updates only the named fields inside whatever entry already sits at
 *    that frame. The pre-D-208 `upsertClipKeyframe` replaced the entry's
 *    whole `params` object, which silently discarded every OTHER property's
 *    key at that frame — fine when the only writer bundled all nine fields
 *    every time, destructive the moment they are written independently.
 * 2. **This module now DOES interpolate** (`paramValueAt`) — the one thing
 *    its pre-D-208 doc said it would never do. It has to: with per-property
 *    keyframes the Inspector's number field must show the value that is
 *    actually on screen at the playhead, and editing it must key THAT value,
 *    or the panel reports a static number the preview is not using. It is an
 *    exact mirror of `chroma::keyframes::interpolate_param` (Rust, D-208) —
 *    filter to the keys naming this param, linear between the bracketing
 *    two, hold outside, shortest-arc for `rotation` — and is authoring-side
 *    only; the render path still resolves its own values in Rust.
 *
 * **D-209 (B-093) — this is now the ONE place any Edit-tab surface asks
 * "where is this clip right now?"** The on-canvas transform box
 * (`TransformOverlay.tsx`) and its hit rect (`canvasPick.ts`) used to read
 * the clip's STATIC `position_x`/`position_y`/`scale` and so drew themselves
 * nowhere near an animated clip's picture; both now go through
 * [`resolveClipBoxTransform`] below, which is built on the same
 * [`paramValueAt`] the Inspector already trusts rather than a second
 * interpolator with its own semantics. There is exactly one interpolation
 * implementation in this package, and it mirrors exactly one Rust function.
 *
 * **D-223 — the `param` type widened, nothing else changed.** Every function
 * here now takes a `ClipKeyframeParam` (the transform/crop names plus the two
 * per-clip audio ones, `volume`/`pan`) rather than `ClipTransformParam`. That
 * is a type change only: the interpolation was always generic over the name —
 * `paramTrack` takes a bare `string`, and the Rust function it mirrors
 * (`chroma::keyframes::interpolate_param`) has never known the transform names
 * either — so a keyframed clip volume is the SAME machinery an animated
 * `opacity` uses, not a parallel one. The only name-dependent behaviour in the
 * whole module is `rotation`'s shortest-arc case, which neither audio param
 * can reach.
 *
 * **Cost, since these callers run on the preview's hottest surfaces** (the
 * Inspector re-renders on every playhead tick, and so does the overlay now):
 * every per-param read below goes through [`paramTrackIndex`], which pays the
 * filter+sort ONCE per `chroma_keyframes` array identity and caches it in a
 * `WeakMap`. Before D-209 each of the Inspector's nine properties re-filtered,
 * re-mapped and re-sorted the whole key list three times per render — 27
 * sorts and ~27 throwaway arrays per frame of playback on a 50-key clip. See
 * D-209 for the measurement.
 */

import {
  CLIP_KEYFRAME_DEFAULTS,
  type ClipKeyframe,
  type ClipKeyframeParam,
  type EaseCurve,
  sourceFramesToTimeline,
  timelineFramesToSource,
} from './timeline';
import { easeCurveEval, isIdentityEase } from './easeCurve';

// D-232 — `ClipKeyframe` moved to `timeline.ts` (beside `Clip`, whose field
// holds an array of them) once a third module needed it. Re-exported here so
// every existing importer of `./clipKeyframes` keeps working, and because this
// is still the module that owns what you can DO to one.
export type { ClipKeyframe };

// --------------------------------------------------------------------------- //
// The per-param index — D-209
// --------------------------------------------------------------------------- //

/** One param's keys, frame-ascending: the shape every per-param read in this
 *  module wants, and the one place the filter/map/sort is paid for. */
interface ParamTrack {
  /** The param's keys, frame-ascending. `ease` (D-232) is the curve shaping
   *  the segment from THIS key to the next one — already normalised, so a
   *  `null` here really means "linear", and no reader has to re-check whether
   *  a stored curve happens to be the identity. */
  keys: ReadonlyArray<{ frame: number; value: number; ease: EaseCurve | null }>;
  /** Every stored value coerced to a finite number. When false, every read
   *  falls back to the caller's static value rather than propagating `NaN` —
   *  the same all-or-nothing rule `paramValueAt` applied before D-209, hoisted
   *  to index-build time so it is not an O(n) scan on every read. */
  finite: boolean;
}

const EMPTY_TRACK: ParamTrack = { keys: [], finite: true };

/**
 * Every param's own frame-sorted key track, built once per `chroma_keyframes`
 * ARRAY IDENTITY and cached against it.
 *
 * Identity is the right cache key here because nothing ever mutates a stored
 * keyframe array in place: every writer in this module returns a NEW array
 * (`mergeClipKeyframeParams`, `removeClipKeyframeParam`, …), `applyOp` clones
 * the timeline before applying an op, and a reload from the backend produces
 * fresh arrays wholesale. So a cache hit means "the very same array", never
 * "an array that used to look like this". A `WeakMap` keeps the entry alive
 * exactly as long as the array is reachable and no longer.
 */
const paramTrackCache = new WeakMap<ClipKeyframe[], Map<string, ParamTrack>>();

function paramTrackIndex(existing: ClipKeyframe[]): Map<string, ParamTrack> {
  const cached = paramTrackCache.get(existing);
  if (cached) return cached;

  const building = new Map<
    string,
    { keys: Array<{ frame: number; value: number; ease: EaseCurve | null }>; finite: boolean }
  >();
  for (const k of existing) {
    if (!k || typeof k.params !== 'object' || k.params === null) continue;
    // `Object.keys` rather than a `hasOwnProperty` loop: same answer for the
    // JSON-shaped objects this array ever holds (own + enumerable), and it is
    // the read the rest of the module already makes.
    for (const name of Object.keys(k.params)) {
      let track = building.get(name);
      if (!track) {
        track = { keys: [], finite: true };
        building.set(name, track);
      }
      const value = Number(k.params[name]);
      if (!Number.isFinite(value)) track.finite = false;
      // D-232 — normalised at index-build time, so `paramValueAt` never pays
      // the identity check (or a malformed-curve check) per read on the
      // preview's hottest surface. `isIdentityEase` also collapses a stored
      // `linear` to `null`, which is what keeps an explicitly-linear segment
      // exactly as cheap, and exactly as exact, as an un-eased one.
      const stored = k.ease?.[name];
      track.keys.push({ frame: k.frame, value, ease: isIdentityEase(stored) ? null : (stored ?? null) });
    }
  }
  const index = new Map<string, ParamTrack>();
  for (const [name, track] of building) {
    track.keys.sort((a, b) => a.frame - b.frame);
    index.set(name, track);
  }
  paramTrackCache.set(existing, index);
  return index;
}

/** [`ParamTrack`] for one param name. Takes a plain `string` rather than
 *  `ClipTransformParam` because `box_width`/`box_height` are keyframeable in
 *  the Rust resolver too (D-193) without being independently *keyable* from
 *  the Inspector, so they are deliberately not in that union — see
 *  `ClipTransformParam`'s own doc. */
function paramTrack(existing: ClipKeyframe[] | undefined, param: string): ParamTrack {
  if (!existing || existing.length === 0) return EMPTY_TRACK;
  return paramTrackIndex(existing).get(param) ?? EMPTY_TRACK;
}

/** Write `params` into the keyframe at `frame`, returning a NEW frame-sorted
 *  array. An existing key at that exact frame keeps every field `params` does
 *  NOT name and has the named ones overwritten; no key there yet means a new
 *  entry holding exactly `params`.
 *
 *  D-208 — this MERGE is the whole difference from the pre-D-208
 *  `upsertClipKeyframe` (which replaced the entry's `params` wholesale, and
 *  which this replaces outright — nothing wants the destructive form). One
 *  property's diamond must never be able to delete another property's key at
 *  the same frame, and "key every property here" is then just this same
 *  function called with all nine names at once.
 *
 *  D-232 — an existing key's `ease` map is carried through untouched, for the
 *  same reason its unnamed `params` are: adding a `scale` key at a frame that
 *  already eases `opacity` must not silently straighten the opacity curve.
 *  A newly-created entry has no `ease` at all (linear), which is the right
 *  default — the segment it just split had a shape, but the two halves of a
 *  split segment are not that shape, and inventing one would be a worse lie
 *  than the honest straight line every NLE gives a fresh key. */
export function mergeClipKeyframeParams(
  existing: ClipKeyframe[] | undefined,
  frame: number,
  params: Record<string, number>,
): ClipKeyframe[] {
  const f = Math.max(0, Math.round(frame));
  const kfs = (existing ?? []).map((k) =>
    k.frame === f ? { ...k, frame: f, params: { ...k.params, ...params } } : k,
  );
  if (!kfs.some((k) => k.frame === f)) kfs.push({ frame: f, params: { ...params } });
  kfs.sort((a, b) => a.frame - b.frame);
  return kfs;
}

/** Does ANY keyframe entry define `param`? — i.e. is this one property
 *  animated (D-208's filled/hollow diamond). Mirrors `keyframeExprAt`'s and
 *  `chroma::keyframes::interpolate_param`'s own `hasOwnProperty` test, so the
 *  diamond can never claim a property is animated that the renderers do not
 *  actually animate. */
export function hasParamKeyframes(existing: ClipKeyframe[] | undefined, param: ClipKeyframeParam): boolean {
  return paramTrack(existing, param).keys.length > 0;
}

/**
 * Every keyframeable property this clip actually animates, in
 * [`CLIP_KEYFRAME_DEFAULTS`]' own declaration order (D-232).
 *
 * Declaration order rather than "order first encountered in the array": the
 * curve editor's clip button opens the FIRST of these, and which property that
 * is must not depend on which one the user happened to key first — a clip that
 * animates opacity and scale should offer the same default lane whichever
 * order they were authored in.
 *
 * Only names in `CLIP_KEYFRAME_DEFAULTS` are reported. A keyframe array can
 * legitimately carry others (`box_width`/`box_height` are keyframeable in the
 * Rust resolver without being independently keyable — D-193), and MCP can
 * write anything at all; neither has an Inspector row or a curve lane, so
 * neither belongs in a list whose whole purpose is "what can the user open".
 */
export function animatedParams(existing: ClipKeyframe[] | undefined): ClipKeyframeParam[] {
  if (!existing || existing.length === 0) return [];
  const index = paramTrackIndex(existing);
  return (Object.keys(CLIP_KEYFRAME_DEFAULTS) as ClipKeyframeParam[]).filter(
    (p) => (index.get(p)?.keys.length ?? 0) > 0,
  );
}

/** Every frame at which `param` itself is keyed, ascending. */
export function paramKeyframeFrames(existing: ClipKeyframe[] | undefined, param: ClipKeyframeParam): number[] {
  return paramTrack(existing, param).keys.map((k) => k.frame);
}

/** The nearest frame strictly before (`dir === -1`) or after (`dir === 1`)
 *  `frame` at which `param` is keyed, or `null` when there is none in that
 *  direction — the `<` / `>` playhead nav (D-208). Strict so repeated presses
 *  really walk the list instead of sticking on the key under the playhead. */
export function adjacentParamKeyframeFrame(
  existing: ClipKeyframe[] | undefined,
  param: ClipKeyframeParam,
  frame: number,
  dir: -1 | 1,
): number | null {
  // Scans the already-sorted track (D-209) and stops at the first hit — no
  // intermediate array, since this runs 18 times per Inspector render.
  const keys = paramTrack(existing, param).keys;
  if (dir < 0) {
    for (let i = keys.length - 1; i >= 0; i--) if (keys[i].frame < frame) return keys[i].frame;
    return null;
  }
  for (let i = 0; i < keys.length; i++) if (keys[i].frame > frame) return keys[i].frame;
  return null;
}

/** Remove `param` from EVERY keyframe entry, dropping any entry left with no
 *  params at all; `undefined` when nothing survives (the clip goes fully
 *  static, same convention as [`removeClipKeyframe`]).
 *
 *  D-208 — this is After Effects' stopwatch-off: turning a property's
 *  animation off deletes that property's keys and leaves every OTHER
 *  property's keys exactly where they were. The caller is responsible for
 *  writing the property's static field to the value it had at the playhead
 *  first, so the picture does not jump — see `EditorInspectorPanel`.
 *
 *  D-232 — the param's `ease` entries go with its keys. An ease map naming a
 *  param that no key animates any more is unreachable data that would
 *  resurrect the moment the property was re-animated, which is exactly the
 *  "stopwatch off then on gives you your old curves back, surprisingly" bug
 *  every other keyframe writer here is careful not to have. Other params'
 *  ease entries at the same key are untouched. */
export function removeClipKeyframeParam(
  existing: ClipKeyframe[] | undefined,
  param: ClipKeyframeParam,
): ClipKeyframe[] | undefined {
  const kfs = (existing ?? [])
    .map((k) => {
      const hasParam = Object.prototype.hasOwnProperty.call(k.params, param);
      const hasEase = !!k.ease && Object.prototype.hasOwnProperty.call(k.ease, param);
      if (!hasParam && !hasEase) return k;
      const params = { ...k.params };
      delete params[param];
      const next: ClipKeyframe = { frame: k.frame, params };
      if (k.ease) {
        const ease = { ...k.ease };
        delete ease[param];
        if (Object.keys(ease).length > 0) next.ease = ease;
      }
      return next;
    })
    .filter((k) => Object.keys(k.params).length > 0);
  return kfs.length === 0 ? undefined : kfs;
}

/**
 * Set (or clear, with `curve === null`) the [`EaseCurve`] shaping `param`'s
 * segment that STARTS at the key on `frame` — D-232's one write.
 *
 * Returns a NEW array, like every writer here. A `frame` where `param` is not
 * actually keyed returns the input array **unchanged and reference-equal**:
 * an ease with no segment to shape is unreachable data (see
 * [`removeClipKeyframeParam`]), and returning the same reference means a
 * no-op write never pushes an undo entry — the same "a drag that ends where
 * it began commits nothing" discipline D-207's fade handles established.
 *
 * Clearing writes no `ease: {}` husk: the key loses the map entirely once its
 * last curve goes, so a fully un-eased timeline serialises exactly as it did
 * before D-232 and a round trip through the backend cannot reintroduce a
 * difference.
 *
 * The curve is stored verbatim, unclamped — `easeCurveEval` clamps `x1`/`x2`
 * at the point of use and `y` overshoot is deliberately legal (see its doc).
 * What the author dragged is what is stored.
 */
export function setClipKeyframeEase(
  existing: ClipKeyframe[] | undefined,
  frame: number,
  param: ClipKeyframeParam,
  curve: EaseCurve | null,
): ClipKeyframe[] | undefined {
  if (!existing || existing.length === 0) return existing;
  const f = Math.round(frame);
  const target = existing.find((k) => k.frame === f);
  if (!target || !Object.prototype.hasOwnProperty.call(target.params, param)) return existing;

  const hadEase = !!target.ease && Object.prototype.hasOwnProperty.call(target.ease, param);
  if (curve === null && !hadEase) return existing;

  return existing.map((k) => {
    if (k.frame !== f) return k;
    const ease: Record<string, EaseCurve> = { ...k.ease };
    if (curve === null) delete ease[param];
    else ease[param] = curve;
    const next: ClipKeyframe = { frame: k.frame, params: k.params };
    if (Object.keys(ease).length > 0) next.ease = ease;
    return next;
  });
}

/** One drawable/editable stretch of a property's animation: the two keys it
 *  runs between and the curve shaping it (D-232). */
export interface ParamSegment {
  /** The key this segment starts at — the one that OWNS its `ease`, and the
   *  `frame` [`setClipKeyframeEase`] is called with. Source frames. */
  fromFrame: number;
  /** The key it ends at. Always `> fromFrame` (zero-length segments are
   *  dropped: they have no shape and nothing to drag). */
  toFrame: number;
  fromValue: number;
  toValue: number;
  /** `null` for a linear segment — already normalised through
   *  `isIdentityEase`, so a stored `linear` and an absent curve are the same
   *  answer here, exactly as they are to both renderers. */
  ease: EaseCurve | null;
}

/**
 * Every segment of `param`'s own animation, in frame order — what the curve
 * editor draws, and what its keyboard/preset controls address.
 *
 * Empty for a static property, and empty for one with a single key (one key
 * holds flat; there is no segment, which is why the curve editor shows that
 * property as a flat line with nothing to grab rather than an empty panel).
 *
 * Built from the same cached [`paramTrackIndex`] every other read here uses,
 * so opening the editor on a 50-key clip costs a walk, not a re-sort.
 */
export function paramSegments(existing: ClipKeyframe[] | undefined, param: ClipKeyframeParam): ParamSegment[] {
  const track = paramTrack(existing, param);
  if (!track.finite) return [];
  const out: ParamSegment[] = [];
  for (let i = 0; i + 1 < track.keys.length; i++) {
    const a = track.keys[i];
    const b = track.keys[i + 1];
    if (b.frame <= a.frame) continue;
    out.push({ fromFrame: a.frame, toFrame: b.frame, fromValue: a.value, toValue: b.value, ease: a.ease });
  }
  return out;
}

/** `param`'s real value at `frame` — what the preview is actually showing —
 *  or `staticValue` when no key defines it.
 *
 *  An exact mirror of `chroma::keyframes::interpolate_param` (Rust, D-208):
 *  only the keys that name `param` take part, it is linear between the two
 *  bracketing ones, held flat outside them, and `rotation` takes the shortest
 *  signed arc (350° → 10° passes through 0°, not 180°) exactly as
 *  `lerp_value` does. A non-finite/non-numeric stored value falls back to
 *  `staticValue` rather than propagating `NaN` into the Inspector's field. */
export function paramValueAt(
  existing: ClipKeyframe[] | undefined,
  param: ClipKeyframeParam,
  frame: number,
  staticValue: number,
): number {
  return namedParamValueAt(existing, param, frame, staticValue);
}

/** [`paramValueAt`] for any param NAME, including the two
 *  (`box_width`/`box_height`) that the Rust resolver interpolates but that
 *  are deliberately outside `ClipTransformParam` — see [`paramTrack`]. */
function namedParamValueAt(
  existing: ClipKeyframe[] | undefined,
  param: string,
  frame: number,
  staticValue: number,
): number {
  const track = paramTrack(existing, param);
  const keyed = track.keys;
  if (keyed.length === 0 || !track.finite) return staticValue;

  const f = Math.round(frame);
  if (f <= keyed[0].frame) return keyed[0].value;
  const hi = keyed.findIndex((k) => k.frame > f);
  if (hi < 0) return keyed[keyed.length - 1].value;

  const lo = keyed[hi - 1];
  const span = keyed[hi].frame - lo.frame;
  const linearT = span > 0 ? Math.min(Math.max((f - lo.frame) / span, 0), 1) : 0;
  // D-232 — the segment's own ease, owned by the key it starts at, warping
  // `t` and nothing else. `easeCurveEval` pins both endpoints, so this can
  // never move a keyframe; `null` (the normalised "linear") is the untouched
  // pre-D-232 arithmetic, bit-for-bit.
  const t = lo.ease ? easeCurveEval(lo.ease, linearT) : linearT;
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

// --------------------------------------------------------------------------- //
// The on-canvas box's transform — D-209 / B-093
// --------------------------------------------------------------------------- //

/** Exactly the fields a clip's on-canvas BOUNDING BOX is a function of, all
 *  resolved — no `undefined` left for a caller to guess a default for.
 *
 *  Deliberately five fields and not the resolver's full eleven: nothing that
 *  draws or hit-tests this box reads the other six. `opacity` does not move a
 *  box (a fully faded clip still has one and is still selectable, exactly as
 *  in the timeline); the four crop insets do not either — `composite_layer_
 *  onto` crops a layer's pixels IN PLACE and keeps its footprint (D-132), which
 *  is why `canvasPick.ts`'s own doc already records crop as correctly ignored;
 *  and `rotation` has no on-canvas affordance at all (Phase 2, unbuilt) and
 *  would need an oriented box rather than this axis-aligned one. Resolving
 *  them anyway would be six interpolations per render, on the preview's
 *  hottest surface, for values nobody reads. */
export interface ResolvedClipBoxTransform {
  position_x: number;
  position_y: number;
  scale: number;
  box_width: number | null;
  box_height: number | null;
}

/**
 * Where `clip`'s picture actually IS at its own `sourceFrame` (NOT a timeline
 * frame — use [`clipSourceFrame`] to convert) — the frontend's mirror of
 * `chroma::edit::resolve_clip_transform`'s geometry fields, for the surfaces
 * that have to draw or hit-test the clip's box.
 *
 * **This is the fix for B-093.** `TransformOverlay` and `canvasPick` used to
 * read `clip.position_x`/`position_y`/`scale` — the STATIC base — while the
 * compositor resolves those same fields through the keyframes first. On any
 * animated clip that is not where the picture is (on the owner's own
 * 50-keyframe clip, two thirds of the canvas away), so the box was drawn, and
 * the click was tested, somewhere the picture is not.
 *
 * Each field goes through [`paramValueAt`]'s own per-property interpolation —
 * the same call the Inspector's number fields make, and the exact mirror of
 * `interpolate_param` the Rust resolver uses per field (D-208/B-094). One
 * interpolator in this package, not a second one for the canvas.
 *
 * `box_width`/`box_height` stay `null` for a clip with no STATIC override,
 * whatever the keyframes say, exactly as Rust does (`base.box_width.map(...)`,
 * D-193): there is nothing to interpolate from, and inventing a value would
 * silently turn an un-overridden clip into an overridden one.
 */
export function resolveClipBoxTransform(
  clip: {
    position_x?: number;
    position_y?: number;
    scale?: number;
    box_width?: number | null;
    box_height?: number | null;
    chroma_keyframes?: ClipKeyframe[];
  },
  sourceFrame: number,
): ResolvedClipBoxTransform {
  const kfs = clip.chroma_keyframes;
  const staticBoxWidth = clip.box_width ?? null;
  const staticBoxHeight = clip.box_height ?? null;
  return {
    position_x: namedParamValueAt(kfs, 'position_x', sourceFrame, clip.position_x ?? 0),
    position_y: namedParamValueAt(kfs, 'position_y', sourceFrame, clip.position_y ?? 0),
    scale: namedParamValueAt(kfs, 'scale', sourceFrame, clip.scale ?? 1),
    box_width: staticBoxWidth === null ? null : namedParamValueAt(kfs, 'box_width', sourceFrame, staticBoxWidth),
    box_height: staticBoxHeight === null ? null : namedParamValueAt(kfs, 'box_height', sourceFrame, staticBoxHeight),
  };
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
 *  playhead on so that this clip resolves to `sourceFrame` (D-208 — the
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
