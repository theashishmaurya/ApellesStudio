/**
 * @apelles/editor — where a highlight's box sits in the viewer (D-396).
 *
 * What it is: the pure mapping between a highlight's box (fractions of the
 * clip's SOURCE image) and the clip's placement box on the composition
 * (`FractionBox`, from `transformGeometry`), through the clip's crop. The
 * highlight is painted on the picture BEFORE the crop, so a box inside the kept
 * region lands at `(u - cropLeft) / keptWidth` of the placement box, and one
 * outside it is cropped away.
 *
 * What it does NOT do: rotation. A rotated clip's picture is not axis-aligned
 * with its placement box, so the overlay stands aside for it (the Inspector
 * rows still edit the numbers). Pure, no React.
 */

import type { CropInsets, FractionBox } from './transformGeometry';

const kept = (near: number | null | undefined, far: number | null | undefined): number =>
  Math.max(0, 1 - Math.min(Math.max(near ?? 0, 0), 1) - Math.min(Math.max(far ?? 0, 0), 1));

interface Mapping {
  /** Source-image fraction at the placement box's left/top edge. */
  u0: number;
  v0: number;
  /** Source-image span the placement box shows. */
  du: number;
  dv: number;
}

function mappingOf(crop: CropInsets | undefined): Mapping | null {
  const du = kept(crop?.left, crop?.right);
  const dv = kept(crop?.top, crop?.bottom);
  if (du <= 0 || dv <= 0) return null;
  return {
    u0: Math.min(Math.max(crop?.left ?? 0, 0), 1),
    v0: Math.min(Math.max(crop?.top ?? 0, 0), 1),
    du,
    dv,
  };
}

/** A highlight box (source-image fractions) as a composition-fraction box, or
 *  `null` when the crop leaves no picture. Not clipped to the placement box: a
 *  box partly cropped away is drawn where it would be, which is what a person
 *  dragging it expects to see. */
export function highlightToComposition(
  box: readonly [number, number, number, number],
  placement: FractionBox,
  crop?: CropInsets,
): FractionBox | null {
  const m = mappingOf(crop);
  if (!m) return null;
  return {
    left: placement.left + ((box[0] - m.u0) / m.du) * placement.width,
    top: placement.top + ((box[1] - m.v0) / m.dv) * placement.height,
    width: ((box[2] - box[0]) / m.du) * placement.width,
    height: ((box[3] - box[1]) / m.dv) * placement.height,
  };
}

/** The inverse: a composition-fraction box back to source-image fractions,
 *  clamped to the image. */
export function compositionToHighlight(
  box: FractionBox,
  placement: FractionBox,
  crop?: CropInsets,
): [number, number, number, number] | null {
  const m = mappingOf(crop);
  if (!m || placement.width <= 0 || placement.height <= 0) return null;
  const c = (v: number) => Math.min(1, Math.max(0, v));
  const u = (x: number) => c(m.u0 + ((x - placement.left) / placement.width) * m.du);
  const v = (y: number) => c(m.v0 + ((y - placement.top) / placement.height) * m.dv);
  return [u(box.left), v(box.top), u(box.left + box.width), v(box.top + box.height)];
}
