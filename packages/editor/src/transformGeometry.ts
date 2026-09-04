/**
 * @chroma/editor — pure geometry for `TransformOverlay.tsx` (D-136, Phase 1
 * of `docs/notes/on-canvas-transform.md`).
 *
 * Kept apart from the component on purpose: this package's vitest config
 * runs in a bare `node` environment (no DOM, no pointer events) — the same
 * reason `ruler.ts`/`clipKeyframes.ts` are split from the components that
 * consume them. The pointer-event wiring in `TransformOverlay.tsx` is not
 * unit-tested; this math, which is where an off-by-one would actually hide,
 * is.
 *
 * Every fraction below is COMPOSITION space (D-136): `0,0` the project
 * composition's top-left, `1,1` its bottom-right, independent of preview
 * resolution — exactly the unit `Clip.position_x`/`position_y`/`scale`
 * already use post-migration, and the unit `chroma_timeline_clip_geometry`'s
 * `naturalWidth`/`naturalHeight` report a clip's own source footprint in
 * (see that command's Rust-side doc, `chroma::edit::ClipGeometry`). A
 * `ContentBox` (`@chroma/player`'s `useContentBox`) then maps that fraction
 * space onto real screen pixels — see `boxToScreenRect`.
 */

export interface ContentBoxLike {
  offsetX: number;
  offsetY: number;
  width: number;
  height: number;
}

/** A clip's placement box in COMPOSITION-FRACTION space — mirrors exactly
 *  what `chroma::edit::composite_layer_onto` computes in canvas pixels
 *  (`x = cw/2 - ww/2 + position_x*cw`, `y` likewise), just undivided by the
 *  canvas size.
 *
 *  Crop is deliberately not accounted for here: `composite_layer_onto` crops
 *  a layer's PIXELS in place, without shrinking its footprint (D-132's own
 *  documented reasoning — the remaining picture must not re-centre as an
 *  edge is cropped in), so the bounding box a transform overlay draws is the
 *  same size whether or not the clip is cropped. Phase 1 doesn't build crop
 *  handles at all (see the note's own phasing), so this never needs to know
 *  the four insets exist. */
export interface FractionBox {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** The smallest scale a corner drag is allowed to produce. Not `0` (or
 *  anything close): a box shrunk to a handful of screen pixels is one no
 *  pointer can grab a handle on to grow back — this is a usability floor on
 *  the DRAG, not a value-correctness one (the compositor itself already
 *  floors a layer at 1 raw pixel via `.max(1.0)`, `edit.rs`'s
 *  `composite_layer_onto`; the numeric Inspector field is free to go lower
 *  by typing). */
export const MIN_DRAG_SCALE = 0.02;

/** The clip's bounding box, in composition fractions, at its current
 *  `position`/`scale` and (unscaled) `natural` footprint. */
export function clipBoxFraction(
  natural: { width: number; height: number },
  position: { x: number; y: number },
  scale: number,
): FractionBox {
  const width = natural.width * scale;
  const height = natural.height * scale;
  return {
    left: 0.5 - width / 2 + position.x,
    top: 0.5 - height / 2 + position.y,
    width,
    height,
  };
}

/** `box` (composition fractions) placed onto real screen pixels, relative to
 *  the same container `contentBox` was measured against — what an
 *  `absolute` overlay child's CSS `left`/`top`/`width`/`height` should be
 *  set to. */
export function boxToScreenRect(box: FractionBox, contentBox: ContentBoxLike) {
  return {
    left: contentBox.offsetX + box.left * contentBox.width,
    top: contentBox.offsetY + box.top * contentBox.height,
    width: box.width * contentBox.width,
    height: box.height * contentBox.height,
  };
}

/** The inverse of `boxToScreenRect`'s position half — a point in the SAME
 *  local container coordinates that function's output lives in (i.e.
 *  already `clientX - container.getBoundingClientRect().left`, etc.) mapped
 *  back to composition-fraction space. What a drag's pointer position is
 *  converted through on every move. */
export function screenToFraction(point: { x: number; y: number }, contentBox: ContentBoxLike): { x: number; y: number } {
  return {
    x: contentBox.width > 0 ? (point.x - contentBox.offsetX) / contentBox.width : 0,
    y: contentBox.height > 0 ? (point.y - contentBox.offsetY) / contentBox.height : 0,
  };
}

/** Body drag: the pointer moved from `startPoint` to `currentPoint` (both
 *  already `screenToFraction`-converted) — the new `position_x`/
 *  `position_y` is `startPosition` shifted by exactly that delta. A delta,
 *  not "position = pointer", so grabbing anywhere on the box doesn't snap
 *  its centre to the cursor. */
export function dragReposition(
  startPoint: { x: number; y: number },
  currentPoint: { x: number; y: number },
  startPosition: { x: number; y: number },
): { x: number; y: number } {
  return {
    x: startPosition.x + (currentPoint.x - startPoint.x),
    y: startPosition.y + (currentPoint.y - startPoint.y),
  };
}

/** Corner drag: uniform scale about the BOX'S OWN centre (`center`, in
 *  composition fractions — `0.5 + position.x`, `0.5 + position.y`, exactly
 *  where `clipBoxFraction` centres it, for any `scale`). That centre is the
 *  only pivot a single `scale` field can express: there is no anchor point
 *  yet (Phase 2), and the compositor itself always scales a layer's
 *  footprint about that same point regardless of `position_*` — see
 *  `clipBoxFraction`'s own doc: `left = 0.5 - width/2 + position.x`, so
 *  `left + width/2` (the centre) never depends on `width`, i.e. never on
 *  `scale`.
 *
 *  The new scale is the ratio of the pointer's current distance from
 *  `center` to its distance when the drag started — corner-distance-from-
 *  pivot grows/shrinks the box, the same relationship Premiere's and
 *  Resolve's own corner-scale handles use (see the note's "Real references
 *  checked" section). Floored at `MIN_DRAG_SCALE`. */
export function dragCornerScale(
  center: { x: number; y: number },
  startPoint: { x: number; y: number },
  currentPoint: { x: number; y: number },
  startScale: number,
): number {
  const startDist = Math.hypot(startPoint.x - center.x, startPoint.y - center.y);
  if (startDist <= 0) return startScale;
  const currentDist = Math.hypot(currentPoint.x - center.x, currentPoint.y - center.y);
  return Math.max(MIN_DRAG_SCALE, startScale * (currentDist / startDist));
}
