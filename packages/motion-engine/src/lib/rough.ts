/**
 * Deterministic hand-drawn strokes via roughjs.
 *
 * roughjs randomises each call — that breaks Remotion's "same frame = same pixels".
 * We pass a fixed `seed` so a given shape always renders identically, then optionally
 * advance the seed by frame for a subtle "redrawn" boil (use sparingly).
 *
 * D-339 — these are pure functions with no React in them, so they cannot read
 * the active theme themselves: `roughness`/`bowing`/`color`/`strokeWidth` are
 * now explicit options every caller passes from `useTheme()`, alongside the
 * `seed` it already passed. They fall back to the DEFAULT theme's stroke feel
 * when omitted, which is what they always used, so a caller that does not care
 * (a standalone demo, a test) is unchanged.
 *
 * A theme is free to ask for `roughness: 0` / `bowing: 0` — roughjs then emits
 * exact geometry (a straight line, a true ellipse) rather than a hand-drawn
 * approximation of it, which is how `apelles-studio` gets a clean editorial
 * look out of this same path instead of needing a second, non-roughjs one.
 */
import rough from "roughjs";
import { DEFAULT_THEME } from "../design";

type Pt = [number, number];

const svgNS = "http://www.w3.org/2000/svg";

/** the stroke-feel half of a `Theme`, which is all these helpers need */
export interface RoughOpts {
  seed?: number;
  color?: string;
  strokeWidth?: number;
  roughness?: number;
  bowing?: number;
}

function generator() {
  // rough's generator works without a DOM node
  return rough.generator();
}

const baseOpts = ({
  seed = 1,
  color = DEFAULT_THEME.stroke,
  strokeWidth = DEFAULT_THEME.strokeWidth,
  roughness = DEFAULT_THEME.roughness,
  bowing = DEFAULT_THEME.bowing,
}: RoughOpts) => ({
  stroke: color,
  strokeWidth,
  roughness,
  bowing,
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
  opts: RoughOpts = {},
): string {
  return opsToPath(generator().rectangle(x, y, w, h, baseOpts(opts)));
}

export function roughLine(p1: Pt, p2: Pt, opts: RoughOpts = {}): string {
  return opsToPath(generator().line(p1[0], p1[1], p2[0], p2[1], baseOpts(opts)));
}

export function roughEllipse(
  cx: number, cy: number, w: number, h: number,
  opts: RoughOpts = {},
): string {
  return opsToPath(generator().ellipse(cx, cy, w, h, baseOpts(opts)));
}

export function roughPath(d: string, opts: RoughOpts = {}): string {
  return opsToPath(generator().path(d, baseOpts(opts)));
}

export { svgNS };
