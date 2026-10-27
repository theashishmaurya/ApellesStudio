/**
 * The `shape` primitive's outline kinds (D-405), in their own module so the
 * manifest schema can name them without importing the React component.
 */
export const SHAPE_KINDS = ["rect", "roundrect", "ellipse", "polygon", "star", "line"] as const;
export type ShapeKind = (typeof SHAPE_KINDS)[number];
