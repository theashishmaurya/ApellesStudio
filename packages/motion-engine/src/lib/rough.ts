/**
 * Deterministic hand-drawn strokes via roughjs.
 *
 * roughjs randomises each call — that breaks Remotion's "same frame = same pixels".
 * We pass a fixed `seed` so a given shape always renders identically, then optionally
 * advance the seed by frame for a subtle "redrawn" boil (use sparingly).
 */
import rough from "roughjs";
import { design } from "../design";

type Pt = [number, number];

const svgNS = "http://www.w3.org/2000/svg";

function generator() {
  // rough's generator works without a DOM node
  return rough.generator();
}

const baseOpts = (
  seed: number,
  color: string = design.stroke,
  strokeWidth: number = design.strokeWidth,
) => ({
  stroke: color,
  strokeWidth,
  roughness: design.roughness,
  bowing: design.bowing,
  seed,
});

/** roughjs OpSet[] -> an SVG path `d` string, so we can render it as a plain <path> */
function opsToPath(drawable: ReturnType<ReturnType<typeof generator>["rectangle"]>): string {
  let d = "";
  for (const set of drawable.sets) {
    if (set.type !== "path") continue;
    for (const op of set.ops) {
      const [a, b, c, e, f, g] = op.data;
      if (op.op === "move") d += `M${a} ${b} `;
      else if (op.op === "lineTo") d += `L${a} ${b} `;
      else if (op.op === "bcurveTo") d += `C${a} ${b} ${c} ${e} ${f} ${g} `;
    }
  }
  return d.trim();
}

export function roughRect(
  x: number, y: number, w: number, h: number,
  { seed = 1, color, strokeWidth }: { seed?: number; color?: string; strokeWidth?: number } = {},
): string {
  return opsToPath(generator().rectangle(x, y, w, h, baseOpts(seed, color, strokeWidth)));
}

export function roughLine(
  p1: Pt, p2: Pt,
  { seed = 1, color, strokeWidth }: { seed?: number; color?: string; strokeWidth?: number } = {},
): string {
  return opsToPath(generator().line(p1[0], p1[1], p2[0], p2[1], baseOpts(seed, color, strokeWidth)));
}

export function roughEllipse(
  cx: number, cy: number, w: number, h: number,
  { seed = 1, color, strokeWidth }: { seed?: number; color?: string; strokeWidth?: number } = {},
): string {
  return opsToPath(generator().ellipse(cx, cy, w, h, baseOpts(seed, color, strokeWidth)));
}

export function roughPath(
  d: string,
  { seed = 1, color, strokeWidth }: { seed?: number; color?: string; strokeWidth?: number } = {},
): string {
  return opsToPath(generator().path(d, baseOpts(seed, color, strokeWidth)));
}

export { svgNS };
