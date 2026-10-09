/**
 * @apelles/motion — reflow a whole manifest onto a new canvas size (D-346).
 *
 * **What it is.** The missing second half of `motion_set_project_settings`
 * (D-345). That tool writes the manifest's `width`/`height` and nothing else,
 * which is correct for what it says it does and a footgun for what a caller
 * usually means: a layer's `x`/`y`/`size` are RAW WORLD PIXELS with no
 * design-space normalisation anywhere between the manifest and the DOM
 * (D-342 established this while rejecting "just double the manifest to get
 * 4K"), so changing the canvas alone leaves every layer sitting at its old
 * coordinates in a differently-shaped frame — content in one corner, dead
 * space everywhere else. This maps the layout onto the new canvas instead.
 *
 * **What it does.** Per axis, everything scales by that axis's own ratio:
 * `sx = newW/oldW` for x-positions and widths, `sy = newH/oldH` for
 * y-positions and heights. Anything that cannot be stretched per-axis without
 * distorting — a font size, a node radius, a square matrix cell, a
 * `deviceframe`'s uniform multiplier — scales by `su = min(sx, sy)`, the
 * factor that fits in both directions.
 *
 * **What it does NOT do.** It is a proportional remap, not a layout engine:
 * it has no idea that text wraps. Reflowing across a CHANGE OF ASPECT RATIO
 * therefore lands the composition in the right places at the right relative
 * sizes and can still leave a caption that used to be one line sitting on
 * three — the author's remaining job is to correct the overflows, not to
 * re-place 80 layers. What it will never do is make that WORSE: a type size
 * scales by `su <= sx` while the `maxWidth` it wraps inside scales by `sx`,
 * so a reflowed text block's line count can only fall or stay the same
 * (D-372, which is why `EXTRA_FIELDS.text.size` is `'u'` and not the `'y'`
 * B-239 proposed). It also does not touch `scene3d` (a three.js child's
 * coordinates are world units in a 3D scene, not canvas pixels — scaling them
 * by a 2D canvas ratio would be meaningless), any timing (`at`, `dur`,
 * `stagger`), or any content value (a `plot`'s `values`/`baseline`, a
 * `graph` edge's `weight`, a `matrix`'s `rows`/`cols`, a `seed`). Those are
 * reported in `skipped` rather than silently left behind.
 *
 * **Which fields are geometry is not re-derived here.** `propCatalog.ts`'s
 * `positionFields(use)` / `sizeFields(use)` are already this package's single
 * source of truth for "which manifest key does a canvas drag/resize write for
 * this primitive" — the canvas overlay (D-155/D-156/D-157) reads exactly
 * these — so a reflow reads them too, and only a short explicit table of
 * fields those two deliberately do not cover (a graph's own node
 * coordinates, a font size, the gaps and radii) is added on top. A primitive
 * added later gets reflowed correctly the moment it is registered there,
 * with no edit to this file.
 */
import type { Manifest, Layer } from '@apelles/motion-engine/src/engine/schema';
import { positionFields, sizeFields } from './propCatalog';

type Raw = Record<string, unknown>;

/** The three ratios a reflow scales by. `su` is deliberately `min`, not an
 *  average: a square thing scaled by anything larger would overflow the axis
 *  that shrank more. */
export interface ReflowFactors {
  sx: number;
  sy: number;
  su: number;
}

export interface ReflowResult {
  manifest: Manifest;
  factors: ReflowFactors;
  /** how many layers had at least one field rewritten. */
  layersMoved: number;
  /** how many individual numeric fields were rewritten. */
  fieldsMoved: number;
  /** things deliberately left alone that a caller might expect to have
   *  moved — today only `scene3d` children, named per scene. */
  skipped: string[];
}

export function reflowFactors(from: { width: number; height: number }, to: { width: number; height: number }): ReflowFactors {
  const sx = to.width / from.width;
  const sy = to.height / from.height;
  return { sx, sy, su: Math.min(sx, sy) };
}

/** A whole-pixel manifest value. Every geometry field in a manifest is a CSS
 *  pixel, and a fractional one buys nothing but noise in a hand-edited
 *  document — except a genuine ratio, which keeps its precision (see
 *  [`ratio`]).
 *
 *  A value that was POSITIVE never rounds below 1, so a hard shrink cannot
 *  collapse a real extent to zero and make a primitive vanish. A value that
 *  was zero or negative is left to round freely: a position can legitimately
 *  be either (a `transform` key's `y: -60` is a 60-px lift), and clamping one
 *  to 1 would turn an animation upside down. */
function px(value: number): number {
  const scaled = Math.round(value);
  return value > 0 && scaled < 1 ? 1 : scaled;
}

/** A unitless multiplier (`deviceframe.scale`) — three decimals, never
 *  rounded to a whole number, and never floored at 1. */
function ratio(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Scale `raw[key]` in place when it is a finite number; returns whether it
 *  actually wrote. Anything else (absent, a string, a `null` a hand-edit left
 *  behind) is left exactly as it is rather than coerced. */
function scaleField(raw: Raw, key: string, factor: number, round: (n: number) => number = px): boolean {
  const value = raw[key];
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  raw[key] = round(value * factor);
  return true;
}

/** Scale one element of a fixed-length numeric tuple in place (`emphasis.box`'s
 *  `[x, y, w, h]`). */
function scaleTuple(raw: Raw, key: string, index: number, factor: number): boolean {
  const tuple = raw[key];
  if (!Array.isArray(tuple)) return false;
  const value = tuple[index];
  if (typeof value !== 'number' || !Number.isFinite(value)) return false;
  tuple[index] = px(value * factor);
  return true;
}

/** Fields no `positionFields`/`sizeFields` entry names, because they are
 *  neither a drag anchor nor a resize handle — but which are still world
 *  pixels and must move with the canvas. Keyed by `use`, plus a `*` group
 *  every layer gets. Each entry names the axis ratio it scales by. */
const EXTRA_FIELDS: Record<string, Array<{ key: string; axis: 'x' | 'y' | 'u' }>> = {
  // A font size, a gap, a radius: all lengths, none of them stretchable per
  // axis. Transcribed from `PRIMITIVE_FIELDS` in `propCatalog.ts` — anything
  // there that is a unitless number (`text.weight`, `layers.tilt` degrees,
  // `matrix.rows`/`cols`, every `seed`, a `plot`'s `values`/`baseline`/
  // `yMin`/`yMax` data range) is deliberately absent and must stay absent.
  //
  // `text.size` is `'u'` DELIBERATELY, not incidentally — B-239 proposed
  // `'y'` ("type tracks height") and **D-372 rejected it**. `su` is
  // `min(sx, sy)`, so it already IS the height ratio whenever height is the
  // axis that shrank more; where it is not — a canvas that lost relatively
  // more WIDTH — following height would scale glyphs up against a `maxWidth`
  // that scaled by `sx`, re-wrapping a block this module cannot measure (see
  // "What it does NOT do" above). `su` is the LARGEST factor that cannot
  // worsen any text block's wrapping, because `su <= sx` always and
  // `maxWidth` scales by `sx`. Pinned in `manifestReflow.test.ts`'s
  // "D-372 — a type size tracks the binding axis" block.
  text: [{ key: 'size', axis: 'u' }],
  matrix: [{ key: 'gap', axis: 'u' }],
  layers: [{ key: 'gap', axis: 'u' }],
  graph: [{ key: 'nodeR', axis: 'u' }],
  claudechat: [{ key: 'radius', axis: 'u' }],
};

function factorFor(axis: 'x' | 'y' | 'u', f: ReflowFactors): number {
  return axis === 'x' ? f.sx : axis === 'y' ? f.sy : f.su;
}

/** One layer, rewritten in place. Returns how many fields were touched. */
function reflowLayer(layer: Layer, f: ReflowFactors): number {
  const raw = layer as unknown as Raw;
  const use = typeof raw.use === 'string' ? raw.use : '';
  let moved = 0;

  const pos = positionFields(use);
  if (pos === 'xy') {
    if (scaleField(raw, 'x', f.sx)) moved++;
    if (scaleField(raw, 'y', f.sy)) moved++;
  } else if (pos === 'box-xy') {
    if (scaleTuple(raw, 'box', 0, f.sx)) moved++;
    if (scaleTuple(raw, 'box', 1, f.sy)) moved++;
  }

  const size = sizeFields(use);
  if (size?.kind === 'wh') {
    if (scaleField(raw, size.w, f.sx)) moved++;
    if (scaleField(raw, size.h, f.sy)) moved++;
  } else if (size?.kind === 'box-wh') {
    if (scaleTuple(raw, 'box', 2, f.sx)) moved++;
    if (scaleTuple(raw, 'box', 3, f.sy)) moved++;
  } else if (size?.kind === 'scalar') {
    if (scaleField(raw, size.key, f.su)) moved++;
  } else if (size?.kind === 'w-only') {
    if (scaleField(raw, size.key, f.sx)) moved++;
  } else if (size?.kind === 'scale') {
    if (scaleField(raw, size.key, f.su, ratio)) moved++;
  }

  for (const extra of EXTRA_FIELDS[use] ?? []) {
    if (scaleField(raw, extra.key, factorFor(extra.axis, f))) moved++;
  }

  // A `graph` lays its own nodes out inside its `width`/`height` box, in that
  // box's coordinates — so they ride the same two ratios the box just did.
  if (Array.isArray(raw.nodes)) {
    for (const node of raw.nodes as Raw[]) {
      if (node && typeof node === 'object') {
        if (scaleField(node, 'x', f.sx)) moved++;
        if (scaleField(node, 'y', f.sy)) moved++;
      }
    }
  }

  // A `plot` annotation's `dx`/`dy` are pixel OFFSETS from the point they
  // label, so they scale per axis like any other position.
  if (Array.isArray(raw.annotate)) {
    for (const note of raw.annotate as Raw[]) {
      if (note && typeof note === 'object') {
        if (scaleField(note, 'dx', f.sx)) moved++;
        if (scaleField(note, 'dy', f.sy)) moved++;
      }
    }
  }

  // The layer-transform wrapper's `x`/`y` are pixel offsets applied on top of
  // the layer's own position (`schema.ts`'s `layerTransform`), static or
  // keyframed — both are world pixels and both move. `scale`, `rot` and
  // `opacity` are unitless and must NOT.
  const transform = raw.transform as Raw | undefined;
  if (transform && typeof transform === 'object') {
    if (scaleField(transform, 'x', f.sx)) moved++;
    if (scaleField(transform, 'y', f.sy)) moved++;
    if (Array.isArray(transform.keys)) {
      for (const key of transform.keys as Raw[]) {
        if (key && typeof key === 'object') {
          if (scaleField(key, 'x', f.sx)) moved++;
          if (scaleField(key, 'y', f.sy)) moved++;
        }
      }
    }
  }

  return moved;
}

/**
 * Remap every 2D layer in `manifest` from its current canvas onto
 * `to.width` × `to.height`. Pure: `manifest` is not mutated — pass a clone in
 * (every caller in `manifestEdit.ts` already works that way) or take the
 * returned one.
 *
 * The manifest's own `width`/`height` are NOT written here; the caller that
 * owns validating them (`setProjectSettings`) does that, so there is exactly
 * one place a canvas dimension is checked against what Remotion accepts.
 */
export function reflowManifest(manifest: Manifest, to: { width: number; height: number }): ReflowResult {
  const factors = reflowFactors({ width: manifest.width, height: manifest.height }, to);
  const skipped: string[] = [];
  let layersMoved = 0;
  let fieldsMoved = 0;

  for (const scene of manifest.scenes) {
    for (const layer of scene.layers ?? []) {
      const moved = reflowLayer(layer, factors);
      if (moved > 0) {
        layersMoved++;
        fieldsMoved += moved;
      }
    }
    const children = scene.scene3d?.children?.length ?? 0;
    if (children > 0) {
      skipped.push(`scene "${scene.id}": ${children} scene3d child${children === 1 ? '' : 'ren'} (3D world units, not canvas pixels)`);
    }
  }

  return { manifest, factors, layersMoved, fieldsMoved, skipped };
}
