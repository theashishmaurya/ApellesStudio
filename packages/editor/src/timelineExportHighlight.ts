/**
 * @apelles/editor — clip highlights compiled to ffmpeg (D-396).
 *
 * What it is: `highlightGeqSteps`, the filtergraph nodes that draw a clip's
 * `highlights` (the highlighter-pen sweeps) onto its decoded picture. One
 * `geq` node per highlight, in list order (a later one over an earlier one),
 * spliced into the per-clip chain by `buildClipFilterChain` AFTER the Colorist
 * `lut3d` and BEFORE `crop`/`scale` — the exact point `chroma::edit::
 * composite_video_frame` calls `apply_highlights_to_rgba`, so the two engines
 * agree on order as well as on maths.
 *
 * What it does NOT do: no drawing outside `geq`, no geometry decisions of its
 * own. The shape is `apelles_timeline::highlight`'s: a rounded box that extends
 * one tip radius left of the hard left edge (masked off there), clamped and
 * half-pixel-offset exactly as `apelles_types::shape::rounded_box_coverage`
 * does. `timelineExportHighlight.ffmpeg.test.ts` measures both engines against
 * one canonical table of real ffmpeg output.
 *
 * **Cost.** `geq` is a per-pixel interpreter. The expression is wrapped so a
 * pixel outside the highlight's rows, or left of its hard edge, takes the
 * cheapest branch (`if` evaluates only the branch it takes), and the sweep
 * progress is evaluated once per covered pixel. A clip with no highlights emits
 * nothing at all.
 */

import { easeCurveEval } from './easeCurve';
import {
  HIGHLIGHT_SWEEP_EASE,
  HIGHLIGHT_TIP_ROUNDING,
  DEFAULT_HIGHLIGHT_OPACITY,
  highlightRgb,
  normalisedHighlightBox,
  type ClipHighlight,
} from './clipHighlights';
import { piecewiseLinearExpr, type ExprPoint } from './ffmpegExpr';

/** Linear pieces approximating the eased sweep. The largest chord error of an
 *  ease-out-cubic at this many pieces is ~0.0007 of the box width: well under
 *  a pixel at any realistic size. */
export const HIGHLIGHT_SWEEP_SAMPLES = 32;

/** The sweep progress `0..1` as an ffmpeg expression in `timeVar` (clip-local
 *  seconds, `geq`'s uppercase `T`). A zero-length sweep is a step. */
export function highlightProgressExpr(
  h: Pick<ClipHighlight, 'at' | 'dur'>,
  sourceStart: number,
  fps: number,
  timeVar: string,
): string {
  const atSec = (h.at - sourceStart) / fps;
  if (h.dur <= 0) {
    // Half a frame early so the frame whose timestamp IS `at` is on the right
    // side of the comparison regardless of float rounding.
    return `gte(${timeVar},${atSec - 0.5 / fps})`;
  }
  const endSec = (h.at + h.dur - sourceStart) / fps;
  const points: ExprPoint[] = [{ t: atSec, value: 0 }];
  for (let s = 1; s < HIGHLIGHT_SWEEP_SAMPLES; s++) {
    const u = s / HIGHLIGHT_SWEEP_SAMPLES;
    points.push({ t: atSec + (endSec - atSec) * u, value: easeCurveEval(HIGHLIGHT_SWEEP_EASE, u) });
  }
  points.push({ t: endSec, value: 1 });
  return piecewiseLinearExpr(points, timeVar);
}

/** One colour channel's `geq` expression for one highlight: the picture's own
 *  value outside the stroke, `c + k·(target − c)` inside it. */
function channelExpr(
  plane: 'r' | 'g' | 'b',
  target: number,
  box: [number, number, number, number],
  progress: string,
  opacity: number,
): string {
  const [x0, y0, x1, y1] = box;
  const c = `${plane}(X,Y)`;
  const left = `(${x0}*W)`;
  const top = `(${y0}*H)`;
  const extH = `((${y1}-${y0})*H)`;
  // Slot 0 holds the progress, evaluated once per covered pixel.
  const right = `(${left}+${x1 - x0}*W*ld(0))`;
  const tip = `(${HIGHLIGHT_TIP_ROUNDING}*${extH})`;
  const extLeft = `(${left}-${tip})`;
  const extW = `(${right}-${extLeft})`;
  const radius = `min(${tip},min(${extW},${extH})/2)`;
  const qx = `(abs(X+0.5-${extLeft}-${extW}/2)-(${extW}/2-${radius}))`;
  const qy = `(abs(Y+0.5-${top}-${extH}/2)-(${extH}/2-${radius}))`;
  const sd = `(hypot(max(${qx},0),max(${qy},0))+min(max(${qx},${qy}),0)-${radius})`;
  const cov = `clip(0.5-${sd},0,1)`;
  const painted = `(${c}+${opacity}*${cov}*(${target}-${c}))`;
  // Cheapest rejections first: left of the hard edge, then outside the rows
  // (one pixel of slack for the antialiased rim), then "pen has not started".
  return (
    `if(gte(X+0.5,${left}),` +
    `if(between(Y,${top}-1,${top}+${extH}+1),` +
    `if(gt(st(0,${progress}),0),${painted},${c}),${c}),${c})`
  );
}

/**
 * The `geq` steps drawing `highlights` onto the stream `src`, ending in a label
 * the caller continues the chain from. Returns the input unchanged (no steps)
 * when there is nothing drawable.
 *
 * `bigTVar` is the clip-relative `T` expression the rest of the chain's
 * keyframes use (`geq` rejects lowercase `t`); `sourceStart` re-bases the
 * highlight's source-frame `at` to the clip's own input, as
 * `rebaseKeyframesToClipInput` does for keyframes.
 */
export function highlightGeqSteps(args: {
  highlights: readonly ClipHighlight[] | undefined;
  src: string;
  label: string;
  sourceStart: number;
  fps: number;
  bigTVar: string;
}): { steps: string[]; src: string } {
  const { highlights, label, sourceStart, fps, bigTVar } = args;
  let src = args.src;
  const steps: string[] = [];
  (highlights ?? []).forEach((h, i) => {
    const box = normalisedHighlightBox(h.box);
    const opacity = typeof h.opacity === 'number' && Number.isFinite(h.opacity)
      ? Math.min(1, Math.max(0, h.opacity))
      : DEFAULT_HIGHLIGHT_OPACITY;
    if (!box || opacity <= 0) return;
    const progress = highlightProgressExpr(h, sourceStart, fps, bigTVar);
    const [r, g, b] = highlightRgb(h.color);
    const out = `hl${label}_${i}`;
    steps.push(
      `${src}format=rgba,geq=` +
        `r='${channelExpr('r', r, box, progress, opacity)}':` +
        `g='${channelExpr('g', g, box, progress, opacity)}':` +
        `b='${channelExpr('b', b, box, progress, opacity)}':` +
        `a='alpha(X,Y)'[${out}]`,
    );
    src = `[${out}]`;
  });
  return { steps, src };
}
