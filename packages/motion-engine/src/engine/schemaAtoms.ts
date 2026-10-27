/**
 * The small zod building blocks the manifest schema and the per-primitive
 * prop schemas share (D-403).
 *
 * What it is: the leaf types several schemas need — a CSS colour, a seconds
 * value, a 3-vector, the bezier ease tuple, the `active` step schedule — in
 * one module, so `schema.ts` (the manifest) and `primitiveProps.ts` (what each
 * primitive accepts) build from the same pieces instead of two copies.
 *
 * What it does NOT do: it validates SHAPE, not meaning. Whether an icon name
 * exists in the icon library, or whether an asset id names a file the project
 * actually holds, is `validate.ts`'s semantic pass, because neither can be
 * answered by a synchronous schema.
 */
import { z } from "zod";
import { ASSET_ID_PATTERN, AUDIO_ASSET_ID_PATTERN } from "../lib/assetId";

/** The marker `colorSchema` registers under, read back by `isColorSchema` (and
 *  published to agents as JSON Schema `format: "color"`). */
export const COLOR_FORMAT = "color";

/**
 * A CSS colour string: `#rrggbb`, `#rgb`, `rgba(...)`, a named colour,
 * `transparent`. Deliberately not narrowed to hex: every existing primitive
 * passes its colour props straight to CSS/SVG/three.js, and manifests in the
 * wild use `transparent` (`deviceframe.screenColor`'s default) and `rgba()`.
 * Each call registers a fresh schema carrying `format: "color"`, which is how
 * the `anim` validator (and the Inspector) can tell a colour prop from any
 * other string.
 */
export const colorSchema = () =>
  z.string().min(1).meta({ format: COLOR_FORMAT, description: "a CSS colour (#rrggbb, rgba(), a named colour)" });

/** `true` when `schema` (optional-unwrapped by the caller) is a `colorSchema()`. */
export function isColorSchema(schema: z.ZodType): boolean {
  const meta = z.globalRegistry.get(schema);
  return meta?.format === COLOR_FORMAT;
}

/** A time in SECONDS within the scene (or within the enclosing group). */
export const seconds = () => z.number();

export const vec2 = z.tuple([z.number(), z.number()]);
export const vec3 = z.tuple([z.number(), z.number(), z.number()]);
export const vec4 = z.tuple([z.number(), z.number(), z.number(), z.number()]);

const timed = z.object({ at: z.number(), i: z.number() });
/** `active`: a fixed index, or a step schedule [{at, i}] */
export const activeSchema = z.union([z.number(), z.array(timed)]);

/** a bezier easing curve, `Easing.bezier(x1,y1,x2,y2)`'s own four control
 *  points — the SAME shape `motion.ease.*`'s presets already are. Shared by
 *  `cam2dKey`, `cam3dKey`, and `transformKey` (all three interpolate
 *  through `motion-engine/src/lib/interpolateKeys.ts`'s one shared
 *  `interpolateKeys`, D-159/B-059).
 *
 * B-062 fix (`docs/BUGS.md`) — `remotion`'s own `Easing.bezier(mX1,mY1,mX2,
 * mY2)` (`node_modules/remotion/dist/cjs/bezier.js`) THROWS
 * `'bezier x values must be in [0, 1] range'` unless `0 <= mX1,mX2 <= 1`;
 * `y1`/`y2` carry no such constraint (`motion.ease.anticipate` legitimately
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
 * this field's shape. (Moved here from `schema.ts` by D-403, unchanged.) */
export const easeCurve = z
  .tuple([z.number(), z.number(), z.number(), z.number()])
  .refine(
    ([x1, , x2]) => x1 >= 0 && x1 <= 1 && x2 >= 0 && x2 <= 1,
    'ease x1/x2 must be within [0,1]',
  );

/** D-404 — a project asset by content hash: `sha256:<64 hex>.<ext>`. */
export const assetIdSchema = z
  .string()
  .regex(ASSET_ID_PATTERN, "an asset id from motion_import_asset: sha256:<64 hex>.<png|jpg|jpeg|webp|gif|svg>");

/** D-413 — an AUDIO asset by content hash (a soundtrack). */
export const audioAssetIdSchema = z
  .string()
  .regex(AUDIO_ASSET_ID_PATTERN, "an audio asset id from motion_set_soundtrack / motion_import_asset: sha256:<64 hex>.<mp3|wav|m4a|aac|flac|ogg>");
