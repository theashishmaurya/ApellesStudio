/**
 * Plot — an animated line plot with a labelled reference baseline.
 *
 * What it is for: the class of explainer graphic where the SHAPE of a curve is
 * the argument — a retrieval-accuracy dip, a loss curve, a scaling trend — and
 * where the point only lands once the curve is read against a reference line
 * ("…and this is the score with no documents at all").
 *
 * What it does NOT do: it is not a general charting library. No bars, no
 * stacked series, no legend (labels attach directly to the curve, per the
 * newsroom convention that a legend is an admission the layout failed), no
 * multi-series. One series, one optional baseline, direct annotations.
 *
 * Why it exists (D-333): the catalog had no way to draw a plotted curve.
 * `graph` is a d3-force node-link diagram, `matrix` is a grid of cells, and
 * `layers` is a card stack — drawing a U-shaped accuracy curve out of any of
 * them would be a force-fit. The concept that needed it is "lost in the
 * middle" (Liu et al. 2023), whose own Figure 1 is the reference this is
 * modelled on: a non-zero-based y axis, ordinal x ticks, and a dashed
 * closed-book baseline that the curve visibly sinks onto.
 *
 * Assembly grammar (researched house style, `scratch/mgfx-reference/`): the
 * graphic builds piece by piece in narration order rather than appearing
 * finished — axes, hold, baseline, hold, curve drawing left to right, then the
 * direct labels. `dur` is the whole assembly; the phase fractions below encode
 * the researched 300ms element beat / 450ms hold / 900ms structure beat.
 *
 * Determinism: frame-driven only (`useCurrentFrame`), roughjs seeded, and the
 * curve's draw-on uses SVG `pathLength` normalisation rather than a DOM
 * `getTotalLength()` measurement, so it never touches layout.
 *
 * `data-motion-box` marks the outer `<svg>`, which is already sized to the
 * plot's real footprint (`width`/`height`), so it is the tight box.
 *
 * Type: every size this draws is a named base times `plotTypeScale` below
 * (B-239), so the chart's own labels stay proportional to the chart when its
 * box changes — a canvas reflow, or simply a plot authored smaller.
 */
import React, { useMemo } from "react";
import { useCurrentFrame } from "remotion";
import { useTheme } from "../ThemeContext";
import { inAt } from "../lib/draw";
import { roughLine } from "../lib/rough";

/**
 * Phase boundaries as fractions of `dur`. Derived from the house style's
 * 300ms element beat, 450ms hold and 900ms structure beat over a 2700ms
 * default assembly, so one `dur` knob rescales the whole build in proportion.
 */
const PHASE = {
  axesEnd: 0.12,
  baselineStart: 0.28,
  baselineEnd: 0.4,
  curveStart: 0.56,
  curveEnd: 0.9,
} as const;

/** Fraction of the plot's height left clear under the curve for x tick labels. */
const MARGIN = { left: 96, right: 32, top: 28, bottom: 76, titleTop: 72 } as const;

/** Marker radius in px at 1080p. */
const MARKER_R = 7;

/** The box this primitive's lengths were authored against — its own default
 *  `width`/`height`. `plotTypeScale` is exactly 1 here, so a plot drawn at
 *  the default box renders byte-for-byte as it did before B-239. */
export const PLOT_BASE_WIDTH = 820;
export const PLOT_BASE_HEIGHT = 520;

/** The five type roles this primitive draws, at the base box. Named because
 *  they are a deliberate hierarchy — kicker above annotation above the
 *  scaffolding — not five incidental literals, and B-239 was partly a bug of
 *  not being able to see that hierarchy at all. */
export const PLOT_TITLE_FONT_SIZE = 28;
export const PLOT_ANNOTATION_FONT_SIZE = 26;
export const PLOT_BASELINE_LABEL_FONT_SIZE = 26;
export const PLOT_AXIS_TITLE_FONT_SIZE = 24;
export const PLOT_TICK_FONT_SIZE = 24;

/** Below this a label stops being readable at all, so shrinking further only
 *  trades one unreadable result for another — the same legibility floor, and
 *  the same reasoning, as `Graph.tsx`'s `GRAPH_LABEL_MIN_FONT_SIZE`. */
export const PLOT_TYPE_MIN_FONT_SIZE = 14;
/** Expressed against the SMALLEST role, so the floor bites on the first
 *  thing that would become illegible rather than on an average. */
const PLOT_TYPE_MIN_SCALE = PLOT_TYPE_MIN_FONT_SIZE / PLOT_TICK_FONT_SIZE;

/**
 * B-239 — the multiplier every type size in this primitive is drawn at,
 * derived from the plot's OWN box.
 *
 * **The bug.** All five sizes above were bare literals in the JSX. D-347's
 * canvas reflow scales a `plot`'s `width` by `sx` and its `height` by `sy`
 * (`propCatalog.ts`'s `sizeFields('plot')`) and scales an authored `text`
 * layer's `size` too (`manifestReflow.ts`'s `EXTRA_FIELDS`), but it has no
 * way to reach type baked inside a primitive's render. So on c038's
 * 1920×1080 → 1252×1016 reshape the chart lost 35% of its width while its
 * own axis labels stayed at 24 px and the authored captions around it
 * reflowed down to 22–23 px — the type hierarchy inverted, supporting
 * captions rendering SMALLER than the chart's scaffolding, and nothing
 * overflowed or errored to flag it.
 *
 * **Why the plot's own box and not the canvas.** The question this type has
 * to answer is "does it fit in, and read against, THIS chart" — a plot
 * hand-authored small on a full-size canvas has exactly the same problem as
 * a reflowed one, and solving it from the box solves both with nothing to
 * keep in sync. It is also the same call `Graph.tsx` made for B-225: a
 * rendering-time derivation from the layout that actually happened, not a
 * new persisted manifest field (so no `propCatalog.ts` entry and no MCP
 * parameter is owed here — there is no new authored value).
 *
 * **Why `min` of the two ratios.** Type cannot be stretched per axis, and it
 * has to fit a box that moved on both: the tick row is constrained by width,
 * the title by the top margin's height. `min` is the factor that clears
 * both — the same reasoning `manifestReflow.ts` gives for its own `su`.
 * (That is a different question from B-239's other half, where an AUTHORED
 * caption floating on the canvas tracks height, `sy`, rather than whichever
 * axis happened to change most.)
 *
 * **What it does NOT scale.** `MARGIN`, `MARKER_R` and `LABEL_LIFT`/
 * `TROUGH_LABEL_LIFT` are still fixed. Those are layout geometry, not type;
 * leaving them is conservative (a shrunk label inside an unshrunk margin has
 * more air, never less) and keeps `plotLabelY`'s contract — and its existing
 * tests — untouched.
 *
 * **It is not a no-op for an already-non-default box.** A plot authored at,
 * say, 1000×640 now draws its type ~1.23× — which is the fix doing its job,
 * not a regression: that chart's type was never proportional to it.
 */
export function plotTypeScale(width: number, height: number): number {
  if (!Number.isFinite(width) || !Number.isFinite(height)) return 1;
  if (width <= 0 || height <= 0) return 1;
  return Math.max(
    PLOT_TYPE_MIN_SCALE,
    Math.min(width / PLOT_BASE_WIDTH, height / PLOT_BASE_HEIGHT),
  );
}

/**
 * One direct label. `dy` (D-341) nudges it vertically off the automatic
 * placement below, in px at 1080p, negative = further from the curve.
 *
 * The automatic placement is a two-case heuristic and cannot be right for
 * every curve: it assumes a trough's bend is tall enough to hold the label
 * inside it, which a SHALLOW, WIDE trough is not — there the 82px lift lands
 * the text on the arms it was meant to clear, and the label crosses the line.
 * Dropping it below instead is not available on such a curve either: a shallow
 * trough sits right on the baseline and the x axis by construction (that is
 * the whole point of the graphic). So the escape hatch is an author-supplied
 * offset rather than a smarter rule — the layout that actually reads depends
 * on the label's own length and the curve's own shape, which only the author
 * can see together.
 */
export type PlotPoint = { i: number; text: string; dy?: number };

/**
 * How far a direct label sits above its own data point, in px at 1080p.
 *
 * A trough gets the LARGER lift so the text sits in the open space inside the
 * bend, clear of both arms. Nudging it downward instead would drop it onto the
 * baseline and the x axis, which sit immediately under a trough by
 * construction.
 */
const LABEL_LIFT = 26;
const TROUGH_LABEL_LIFT = 82;

/**
 * A direct label's `y`, from its data point's own `y`. Exported as a pure
 * function so the placement is directly unit-testable (`@apelles/motion`'s
 * `plotLabel.test.ts` — this package has no test runner of its own), the same
 * split `Graph.tsx`'s `graphEdgeStroke` and `Camera.tsx`'s `cameraDrift`
 * already use.
 *
 * `dy` (D-341) is the author's own nudge on top of the automatic placement,
 * negative = further from the curve. `undefined` must return exactly the
 * pre-D-341 placement — that is the whole no-regression guarantee for every
 * manifest already using `annotate`.
 */
export const plotLabelY = (
  pointY: number,
  isTrough: boolean,
  dy?: number,
): number => {
  // `annotate` reaches this through a `.passthrough()` layer and is never
  // validated item by item, so a hand-authored `"dy": "-60"` really does
  // arrive as a non-number. Fall back to no offset rather than propagating
  // `NaN` into the `y` attribute, where it would silently drop the whole
  // label — the same guard `graphEdgeStroke` needs for `weight` (D-340), for
  // exactly the same reason.
  const d = Number.isFinite(dy) ? (dy as number) : 0;
  return pointY - (isTrough ? TROUGH_LABEL_LIFT : LABEL_LIFT) + d;
};

/**
 * Catmull-Rom through the points, emitted as cubic beziers. ~20 lines of pure
 * maths with no state and no dependency — deliberately not a charting library.
 */
function smoothPath(pts: { x: number; y: number }[]): string {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M${pts[0].x} ${pts[0].y}`;
  let d = `M${pts[0].x} ${pts[0].y}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] ?? pts[i];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[i + 2] ?? p2;
    const c1x = p1.x + (p2.x - p0.x) / 6;
    const c1y = p1.y + (p2.y - p0.y) / 6;
    const c2x = p2.x - (p3.x - p1.x) / 6;
    const c2y = p2.y - (p3.y - p1.y) / 6;
    d += ` C${c1x} ${c1y} ${c2x} ${c2y} ${p2.x} ${p2.y}`;
  }
  return d;
}

export const Plot: React.FC<{
  /** the series — one y value per x position. */
  values: number[];
  /** ordinal tick labels, one per value; omit for 1-based indices. */
  xLabels?: string[];
  /**
   * y range. Omit for a padded fit to `values` — deliberately NOT zero-based,
   * because in this class of graphic the effect lives in a narrow band.
   */
  yMin?: number;
  yMax?: number;
  /** condition/context line above the plot, set ALL CAPS as a kicker. */
  title?: string;
  xTitle?: string;
  yTitle?: string;
  /** the reference line the curve is read against. */
  baseline?: number;
  baselineLabel?: string;
  /** direct labels on individual points — no legend. */
  annotate?: PlotPoint[];
  color?: string;
  baselineColor?: string;
  markers?: boolean;
  start?: number;
  dur?: number;
  seed?: number;
  /** top-left in world px. */
  x?: number;
  y?: number;
  width?: number;
  height?: number;
}> = ({
  values,
  xLabels,
  yMin,
  yMax,
  title,
  xTitle,
  yTitle,
  baseline,
  baselineLabel,
  annotate = [],
  // D-339 — the theme-sourced defaults resolve INSIDE the body (a default
  // parameter cannot call `useTheme()`); explicit props still win.
  color: colorProp,
  baselineColor: baselineColorProp,
  markers = true,
  start = 0,
  dur = 81,
  seed = 1,
  x = 0,
  y = 0,
  width = PLOT_BASE_WIDTH,
  height = PLOT_BASE_HEIGHT,
}) => {
  const frame = useCurrentFrame();
  const theme = useTheme();
  const color = colorProp ?? theme.accentSignal;
  const baselineColor = baselineColorProp ?? theme.accent;

  // B-239 — every fontSize below is this multiplier times its named base.
  const typeScale = plotTypeScale(width, height);

  const top = title ? MARGIN.titleTop : MARGIN.top;
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - top - MARGIN.bottom;

  // y range: pad the observed span (and the baseline, which must be visible)
  const span = useMemo(() => {
    const pool = baseline == null ? values : [...values, baseline];
    const lo = yMin ?? Math.min(...pool);
    const hi = yMax ?? Math.max(...pool);
    const pad = (hi - lo) * 0.18 || 1;
    return { lo: yMin ?? lo - pad, hi: yMax ?? hi + pad };
  }, [values, baseline, yMin, yMax]);

  const px = (i: number) =>
    MARGIN.left + (values.length <= 1 ? plotW / 2 : (i / (values.length - 1)) * plotW);
  const py = (v: number) =>
    top + plotH - ((v - span.lo) / (span.hi - span.lo || 1)) * plotH;

  const pts = values.map((v, i) => ({ x: px(i), y: py(v) }));

  // hand-drawn scaffolding never changes → build once
  const axes = useMemo(
    () => ({
      xAxis: roughLine([MARGIN.left, top + plotH], [MARGIN.left + plotW, top + plotH], {
        seed,
        color: theme.strokeSoft,
        strokeWidth: 2,
        roughness: theme.roughness,
        bowing: theme.bowing,
      }),
      yAxis: roughLine([MARGIN.left, top], [MARGIN.left, top + plotH], {
        seed: seed + 1,
        color: theme.strokeSoft,
        strokeWidth: 2,
        roughness: theme.roughness,
        bowing: theme.bowing,
      }),
    }),
    // D-339 — the axes' colour and stroke feel now come from the theme, so a
    // theme change must rebuild this memo (a manifest's theme is fixed for a
    // render, so in practice it never re-runs mid-composition).
    [seed, top, plotW, plotH, theme.strokeSoft, theme.roughness, theme.bowing],
  );

  const at = (a: number, b: number) => inAt(frame, start + dur * a, start + dur * b);

  const axesP = at(0, PHASE.axesEnd);
  const baseP = baseline == null ? 0 : at(PHASE.baselineStart, PHASE.baselineEnd);
  const curveP = at(PHASE.curveStart, PHASE.curveEnd);
  const labelP = at(PHASE.curveEnd, 1);

  const curveD = smoothPath(pts);
  const baselineY = baseline == null ? 0 : py(baseline);

  return (
    <svg
      data-motion-box
      style={{ position: "absolute", left: x, top: y, overflow: "visible" }}
      width={width}
      height={height}
    >
      {title ? (
        <text
          x={MARGIN.left}
          y={36}
          fill={theme.textDim}
          opacity={axesP}
          fontFamily={theme.fontUi}
          fontSize={PLOT_TITLE_FONT_SIZE * typeScale}
          letterSpacing="0.06em"
        >
          {title.toUpperCase()}
        </text>
      ) : null}

      {/* scaffolding: thin and bright, never thick and dim */}
      <path d={axes.yAxis} fill="none" stroke={theme.strokeSoft} strokeWidth={2} opacity={axesP} />
      <path d={axes.xAxis} fill="none" stroke={theme.strokeSoft} strokeWidth={2} opacity={axesP} />

      {yTitle ? (
        <text
          x={-(top + plotH / 2)}
          y={30}
          transform="rotate(-90)"
          textAnchor="middle"
          fill={theme.textDim}
          opacity={axesP}
          fontFamily={theme.fontUi}
          fontSize={PLOT_AXIS_TITLE_FONT_SIZE * typeScale}
          letterSpacing="0.06em"
        >
          {yTitle.toUpperCase()}
        </text>
      ) : null}

      {xTitle ? (
        <text
          x={MARGIN.left + plotW / 2}
          y={height - 16}
          textAnchor="middle"
          fill={theme.textDim}
          opacity={axesP}
          fontFamily={theme.fontUi}
          fontSize={PLOT_AXIS_TITLE_FONT_SIZE * typeScale}
          letterSpacing="0.06em"
        >
          {xTitle.toUpperCase()}
        </text>
      ) : null}

      {/* x ticks */}
      {values.map((_, i) => (
        <text
          key={`xt-${i}`}
          x={px(i)}
          y={top + plotH + 34}
          textAnchor="middle"
          fill={theme.textDim}
          opacity={axesP}
          fontFamily={theme.fontUi}
          fontSize={PLOT_TICK_FONT_SIZE * typeScale}
        >
          {xLabels?.[i] ?? String(i + 1)}
        </text>
      ))}

      {/* the reference line lands BEFORE the curve, so the curve visibly sinks onto it */}
      {baseline != null ? (
        <>
          <line
            x1={MARGIN.left}
            y1={baselineY}
            x2={MARGIN.left + plotW}
            y2={baselineY}
            stroke={baselineColor}
            strokeWidth={3}
            strokeDasharray="12 10"
            pathLength={1}
            strokeDashoffset={0}
            opacity={baseP}
          />
          {baselineLabel ? (
            // anchored at the START and BELOW the line: the curve is at its
            // highest on the left, so this is the one reliably clear corner.
            // Labelling the right end collides with the curve rising back up.
            <text
              x={MARGIN.left + 12}
              y={baselineY + 32}
              textAnchor="start"
              fill={baselineColor}
              opacity={baseP}
              fontFamily={theme.fontUi}
              fontSize={PLOT_BASELINE_LABEL_FONT_SIZE * typeScale}
            >
              {baselineLabel}
            </text>
          ) : null}
        </>
      ) : null}

      {/* the series, drawn on left to right via pathLength normalisation */}
      <path
        d={curveD}
        fill="none"
        stroke={color}
        strokeWidth={theme.strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - curveP}
      />

      {markers
        ? pts.map((p, i) => {
            // a marker appears as the curve reaches it
            const reach = values.length <= 1 ? 1 : i / (values.length - 1);
            const m = curveP >= reach ? 1 : 0;
            return (
              <circle
                key={`m-${i}`}
                cx={p.x}
                cy={p.y}
                r={MARKER_R}
                fill={color}
                opacity={m}
              />
            );
          })
        : null}

      {/* direct labels — no legend */}
      {annotate.map((a) => {
        const p = pts[a.i];
        if (!p) return null;
        const lo = values[a.i - 1] ?? values[a.i];
        const hi = values[a.i + 1] ?? values[a.i];
        const isTrough = values[a.i] <= lo && values[a.i] <= hi;
        return (
          <text
            key={`a-${a.i}`}
            x={p.x}
            y={plotLabelY(p.y, isTrough, a.dy)}
            textAnchor="middle"
            fill={theme.text}
            opacity={labelP}
            fontFamily={theme.fontUi}
            fontSize={PLOT_ANNOTATION_FONT_SIZE * typeScale}
          >
            {a.text}
          </text>
        );
      })}
    </svg>
  );
};
