/**
 * The scene manifest — what a model emits (one small JSON doc per video), and
 * what `build.ts` compiles into a Remotion composition. Keep it terse: the model's
 * job is the manifest (~150 tokens/scene), not React. All times are in SECONDS.
 *
 * {
 *   "title": "Prompt caching, explained",
 *   "grain": true,
 *   "scenes": [
 *     { "id": "hook", "dur": 4,
 *       "camera": [{"at":0,"zoom":1},{"at":0.3,"x":1200,"y":540,"zoom":1.6}],
 *       "layers": [
 *         {"use":"text","text":"EVERY call re-sends the prompt","preset":"stroke-on","at":0.2,"x":200,"y":300},
 *         {"use":"emphasis","preset":"scribble","at":1.5,"dur":2,"box":[900,380,420,220]}
 *       ]},
 *     { "id": "stack", "dur": 6, "layers": [
 *         {"use":"layers","at":0.3,"items":["tools","system","context","your question"],
 *          "active":[{"at":2,"i":2}],"callout":"re-sent every call"} ]},
 *     { "id": "space", "dur": 5, "scene3d": {
 *         "camera":[{"at":0,"pos":[0,0,12]},{"at":5,"pos":[3,2,9]}],
 *         "children":[{"use":"particleflow","preset":"stream","from":[-6,0,0],"to":[6,0,0]}] }}
 *   ]
 * }
 */
import { z } from "zod";

const vec3 = z.tuple([z.number(), z.number(), z.number()]);
const timed = z.object({ at: z.number(), i: z.number() });
/** `active`: a fixed index, or a step schedule [{at, i}] */
const activeSchema = z.union([z.number(), z.array(timed)]);

/** a bezier easing curve, `Easing.bezier(x1,y1,x2,y2)`'s own four control
 *  points — the SAME shape `design.ease.*`'s presets already are. Shared by
 *  `cam2dKey`, `cam3dKey`, and `transformKey` below (all three interpolate
 *  through `motion-engine/src/lib/interpolateKeys.ts`'s one shared
 *  `interpolateKeys`, D-159/B-059).
 *
 * B-062 fix (`docs/BUGS.md`) — `remotion`'s own `Easing.bezier(mX1,mY1,mX2,
 * mY2)` (`node_modules/remotion/dist/cjs/bezier.js`) THROWS
 * `'bezier x values must be in [0, 1] range'` unless `0 <= mX1,mX2 <= 1`;
 * `y1`/`y2` carry no such constraint (`design.ease.anticipate` legitimately
 * overshoots to `y1:-0.55`/`y2:1.55` for its anticipation curve). Before this
 * fix the tuple's shape was declared (four numbers) but not this one real
 * semantic constraint the consuming function enforces at its own call
 * boundary, so an out-of-range `x1`/`x2` (only reachable by hand-editing the
 * manifest text or an external tool — the Inspector's own curve widget,
 * D-164's `pixelToCurve`, clamps `x` to `[0,1]` by construction) validated
 * fine and only threw later, at whatever frame the render/playback actually
 * reached that key — a late, confusing failure that looked like an engine
 * crash rather than a data problem. The `.refine()` below makes it a clear,
 * parse-time rejection instead, at the one place already responsible for
 * this field's shape. */
const easeCurve = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(
    ([x1, , x2]) => x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1,
    'ease x1/x2 must be within [0,1]',
  );

/**
 * B-059 fix (`docs/BUGS.md`) — `ease` was genuinely supported by `Camera.tsx`
 * (`CameraKey.ease`, read at `k.ease ?? design.ease.inOut`) but this object
 * was a plain `z.object`, and zod strips unknown keys by default, so an
 * authored `ease` was silently dropped before `Video.tsx` (which already
 * spreads the key through verbatim, `{ ...k, at: … }`) ever saw it — every
 * camera move in every manifest was stuck on `design.ease.inOut` with no way
 * to say otherwise. Declaring `ease` explicitly (rather than reaching for
 * `.passthrough()`, which would also silently accept a typo'd field name —
 * exactly what the strict object was buying in the first place) fixes it:
 * the field is now real, typed, and round-trips through `manifestSchema`.
 */
const cam2dKey = z.object({
  at: z.number(),
  x: z.number().optional(),
  y: z.number().optional(),
  zoom: z.number().optional(),
  ease: easeCurve.optional(),
});

/**
 * Same gap as `cam2dKey` above, found while fixing B-059 (the bug's own
 * write-up in `docs/BUGS.md` assumed this one was "harmless... since
 * Scene3D has no ease concept" — reading `Scene3D.tsx`'s `CameraRig` this
 * pass shows that's wrong: `CamKey.ease` exists there too and is read the
 * identical way, `cb(b.ease ?? design.ease.inOut)`. `Video.tsx`'s `ThreeD`
 * already spreads a 3D camera key through verbatim (`{ ...k, at: … }`, the
 * same as the 2D case), so declaring `ease` here is the whole fix — no
 * `Scene3D.tsx`/`Video.tsx` change needed on top.
 */
const cam3dKey = z.object({
  at: z.number(),
  pos: vec3,
  look: vec3.optional(),
  ease: easeCurve.optional(),
});

/**
 * D-159, Phase 4 of `docs/notes/motion-visual-builder-research.md` ("the
 * animation model: per-layer keyframes") — one keyframe on the D-157 layer
 * transform wrapper's `keys` array (below). `at` is in SECONDS, matching
 * `cam2dKey`'s own convention exactly (`Video.tsx` converts via
 * `Math.round(at * fps)` the same way it already does for the camera).
 *
 * Every numeric field here is a DELTA added on top of the STATIC
 * `layerTransform` field of the same name, not a replacement for it — see
 * `layerTransform`'s own updated doc comment below for the full reasoning
 * and the "why additive, uniformly across all five fields" design call.
 * Interpolated through the SAME shared `interpolateKeys` `Camera.tsx` uses
 * (`motion-engine/src/lib/interpolateKeys.ts`) — "reuse the camera's own key
 * mechanics, don't invent a second interpolator," per the research doc.
 */
const transformKey = z.object({
  at: z.number(),
  x: z.number().optional(),
  y: z.number().optional(),
  scale: z.number().optional(),
  rot: z.number().optional(),
  opacity: z.number().optional(),
  ease: easeCurve.optional(),
});

/**
 * D-157, Phase 2 of `docs/notes/motion-visual-builder-research.md` ("the
 * enabling structural change for Phase 4"): a generic post-hoc transform
 * every 2D layer can optionally carry, applied ON TOP of the primitive's own
 * positioning (`motion-engine/src/engine/Video.tsx`'s `renderLayers`), never
 * replacing it. Purely additive — `.optional()` on the field itself (§ below)
 * means absent ⇒ identity ⇒ every manifest written before this pass renders
 * byte-identically (verified by real `remotion still` renders, not just
 * reasoning about the schema — see D-157's own decision entry).
 *
 * `clipWidth`/`clipHeight` are the research doc's own "crop, honestly"
 * scoping call (§4 Phase 2): NOT the Edit tab's four-inset crop model — most
 * Motion primitives have nothing analogous to a decoded video rectangle to
 * inset — but the one real, small equivalent named in the doc: clip the
 * layer to an explicit `clipWidth`×`clipHeight` box via `overflow: hidden`
 * on this SAME wrapper. Both absent (the common case) ⇒ no clipping at all,
 * today's full-bleed behaviour.
 *
 * `keys` (D-159, Phase 4 — "the animation model: per-layer keyframes") is
 * the one authored spatial/opacity animation channel a LAYER can carry
 * (the camera was previously the only one, §1a of the research doc).
 * Optional, absent by default: `Video.tsx`'s `renderLayers` only calls the
 * shared interpolator when `keys` is a non-empty array, so an existing
 * manifest (no `keys` field at all) renders byte-identically to before this
 * pass (verified by real `remotion still` renders, not just reasoning about
 * the schema — see D-159's own decision entry).
 *
 * **Every `transformKey` field is a DELTA added on top of the STATIC field
 * of the same name here, uniformly across all five — a real design call,
 * not the only option, made and documented rather than left implicit.** The
 * research doc's own framing only spells this out for `x`/`y` ("Keys drive
 * the Phase 2 wrapper, as a delta on top of the static x/y, not a
 * replacement for them"); extending the SAME additive convention to
 * `scale`/`rot`/`opacity` (rather than, say, making `scale` a multiplicative
 * delta, which would read more naturally for a scale factor in isolation)
 * keeps one rule for all five fields instead of a special case per field,
 * and — the load-bearing reason — makes "absent `keys`" and "a `keys` array
 * whose one entry leaves every field unset" behave IDENTICALLY by
 * construction: an unset delta field defaults to `0` (never `1`), so
 * `appliedScale = staticScale (default 1) + keyDeltaScale (default 0) =
 * staticScale` either way, with no per-field default table for callers to
 * get wrong. The tradeoff accepted knowingly: authoring a scale ANIMATION
 * means writing deltas off the static scale (`keys:[{at:0,scale:0},
 * {at:1,scale:0.5}]` to grow from the static scale to static+0.5), not
 * absolute scale factors at each key — a real per-field UI/authoring
 * consideration, not a hidden footgun, and consistent with how the static
 * `layerTransform` fields already relate to the primitive's own positioning
 * (additive offsets on top of something else, never the whole story alone).
 */
const layerTransform = z.object({
  x: z.number().optional(),
  y: z.number().optional(),
  scale: z.number().optional(),
  rot: z.number().optional(),
  opacity: z.number().optional(),
  clipWidth: z.number().optional(),
  clipHeight: z.number().optional(),
  keys: z.array(transformKey).optional(),
});

/** one primitive placement. `use` picks the primitive; the rest are its props.
 *  passthrough so per-primitive props don't all need re-declaring here. */
const layer = z
  .object({
    use: z.enum([
      "text",
      "emphasis",
      "matrix",
      "graph",
      "layers",
      // D-258 — the device/app-UI pair. Two entries, not one, because the
      // phone chrome and the app content are deliberately separate
      // primitives: `deviceframe` frames anything, `claudechat` renders
      // full-bleed or inside a frame, and neither requires the other.
      "deviceframe",
      "claudechat",
      // scene3d children:
      "particleflow",
      "labelbox",
      "layerstack",
    ]),
    /**
     * D-158, Phase 3 of `docs/notes/motion-visual-builder-research.md`
     * ("stable layer identity" — §1g's own finding: "identity is
     * positional... it breaks the moment the builder can reorder, insert, or
     * delete layers with a selection live"). Purely additive and optional:
     * `@chroma/motion`'s `addLayer` (D-151) generates one for every layer it
     * creates from here on; a hand-written or pre-existing manifest simply
     * has no `id`, and every consumer (`@chroma/motion`'s
     * `resolveSelection`) falls back to the array index exactly as before
     * this field existed. Not used by the renderer at all — `Video.tsx`
     * never reads it — so its presence or absence has zero effect on a
     * rendered frame (verified byte-for-byte via `remotion still`, D-158's
     * own decision entry).
     */
    id: z.string().optional(),
    at: z.number().optional(),
    dur: z.number().optional(),
    active: activeSchema.optional(),
    /** D-157 — see `layerTransform`'s own doc comment above. Declared
     *  explicitly (not left to `.passthrough()`) so it validates against a
     *  real shape rather than arriving as an untyped blob; every OTHER
     *  per-primitive prop still passes through unchanged below. */
    transform: layerTransform.optional(),
  })
  .passthrough();

const scene = z.object({
  id: z.string(),
  dur: z.number().positive(),
  bg: z.string().optional(),
  grain: z.boolean().optional(),
  vignette: z.union([z.boolean(), z.number()]).optional(),
  camera: z.array(cam2dKey).optional(),
  layers: z.array(layer).optional(),
  scene3d: z
    .object({
      camera: z.array(cam3dKey).min(1),
      children: z.array(layer),
    })
    .optional(),
  /** cross-fade into this scene, in seconds (default hard cut) */
  transition: z.number().optional(),
});

export const manifestSchema = z.object({
  title: z.string(),
  width: z.number().default(1920),
  height: z.number().default(1080),
  fps: z.number().default(30),
  grain: z.boolean().optional(),
  vignette: z.union([z.boolean(), z.number()]).optional(),
  /** render with no background paint — for a ProRes4444 overlay to composite in Palmier */
  transparent: z.boolean().optional(),
  scenes: z.array(scene).min(1),
});

export type Manifest = z.infer<typeof manifestSchema>;
export type Scene = z.infer<typeof scene>;
export type Layer = z.infer<typeof layer>;
export type LayerTransform = z.infer<typeof layerTransform>;
export type TransformKey = z.infer<typeof transformKey>;
export type Cam2dKey = z.infer<typeof cam2dKey>;
export type Cam3dKey = z.infer<typeof cam3dKey>;
export type EaseCurve = z.infer<typeof easeCurve>;
export type Active = z.infer<typeof activeSchema>;
