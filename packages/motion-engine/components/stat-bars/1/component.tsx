import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from "remotion";
import { scaleBand, scaleLinear } from "d3-scale";
import { line } from "d3-shape";
import { max } from "d3-array";
import { interpolateNumber } from "d3-interpolate";
import { format } from "d3-format";
import type { ComponentProps } from "@apelles/component";

type Props = {
  title: string;
  values: number[];
  labels: string[];
  format: "number" | "compact" | "percent";
  barColor?: string;
  highlightColor?: string;
};

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

/** d3-format specifiers for each value format. */
const SPECIFIER = { number: ",.0f", compact: ".2~s", percent: ",.0f" } as const;

/** Average glyph width of the monospace value labels, as a share of the font size. */
const VALUE_GLYPH_WIDTH = 0.62;

/** Frames between one bar starting and the next. */
const STAGGER = 5;

/**
 * Animated horizontal stat bars laid out with d3 scales: a band scale places
 * the rows, a linear scale (with `nice()` ticks drawn as d3-shape lines)
 * sizes the bars, and d3-interpolate counts each value up as its bar grows.
 * The largest bar takes the highlight colour. Colours and fonts come from the
 * theme unless a colour is set.
 */
export default function StatBars({ props, theme, width, height }: ComponentProps<Props>) {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const values = props.values.length > 0 ? props.values : [0];
  const n = values.length;
  const peak = max(values) ?? 0;
  const barInk = props.barColor ?? theme.accent;
  const highlightInk = props.highlightColor ?? theme.accentSignal;
  const fmt = format(SPECIFIER[props.format]);
  const show = (v: number) => (props.format === "percent" ? `${fmt(v)}%` : fmt(v));

  const pad = { left: width * 0.17, right: width * 0.08, top: height * 0.2, bottom: height * 0.08 };
  const y = scaleBand<number>()
    .domain(values.map((_, i) => i))
    .range([pad.top, height - pad.bottom])
    .paddingInner(0.32);
  const rowH = y.bandwidth();
  const labelSize = Math.round(Math.min(height * 0.045, rowH * 0.5));
  // Keep the longest value label inside the frame: the bars stop short of it.
  const reserve = Math.max(pad.right, (show(peak).length + 1) * labelSize * VALUE_GLYPH_WIDTH);
  const x = scaleLinear()
    .domain([0, peak > 0 ? peak : 1])
    .range([0, width - pad.left - reserve])
    .nice();
  const titleSize = Math.round(height * 0.07);
  const grid = interpolate(frame, [0, 12], [0, 1], clamp);
  const gridLine = line<[number, number]>();
  const winner = values.indexOf(peak);

  return (
    <AbsoluteFill>
      <div
        style={{
          position: "absolute",
          left: pad.left,
          top: height * 0.05,
          maxWidth: width - pad.left - pad.right,
          fontFamily: theme.fontDisplay,
          fontSize: titleSize,
          color: theme.text,
          opacity: grid,
          whiteSpace: "nowrap",
          overflow: "hidden",
        }}
      >
        {props.title}
      </div>
      <svg width={width} height={height} style={{ position: "absolute", inset: 0 }}>
        {x.ticks(4).map((t) => (
          <path
            key={t}
            d={gridLine([[pad.left + x(t), pad.top - rowH * 0.2], [pad.left + x(t), height - pad.bottom]]) ?? ""}
            fill="none"
            stroke={theme.strokeSoft}
            strokeOpacity={0.5 * grid}
            strokeWidth={t === 0 ? 2 : 1}
          />
        ))}
        {values.map((v, i) => {
          const grow = spring({ frame: frame - 6 - i * STAGGER, fps, config: { damping: 18, stiffness: 100 } });
          const w = Math.max(0, x(v) * grow);
          return (
            <rect
              key={i}
              x={pad.left}
              y={y(i) ?? 0}
              width={w}
              height={rowH}
              rx={Math.min(rowH * 0.2, w / 2)}
              fill={i === winner ? highlightInk : barInk}
            />
          );
        })}
      </svg>
      {values.map((v, i) => {
        const grow = Math.min(1, Math.max(0, spring({ frame: frame - 6 - i * STAGGER, fps, config: { damping: 18, stiffness: 100 } })));
        const rowY = y(i) ?? 0;
        return (
          <div key={i}>
            <div
              style={{
                position: "absolute",
                left: 0,
                width: pad.left - labelSize * 0.6,
                top: rowY,
                height: rowH,
                display: "flex",
                alignItems: "center",
                justifyContent: "flex-end",
                fontFamily: theme.fontUi,
                fontSize: labelSize,
                color: theme.textDim,
                opacity: grid,
                whiteSpace: "nowrap",
                overflow: "hidden",
              }}
            >
              {props.labels[i] ?? ""}
            </div>
            <div
              style={{
                position: "absolute",
                left: pad.left + x(v) * grow + labelSize * 0.5,
                top: rowY,
                height: rowH,
                display: "flex",
                alignItems: "center",
                fontFamily: theme.fontMono,
                fontSize: labelSize,
                color: i === winner ? highlightInk : theme.text,
                opacity: grow > 0.02 ? 1 : 0,
                whiteSpace: "nowrap",
              }}
            >
              {show(interpolateNumber(0, v)(grow))}
            </div>
          </div>
        );
      })}
    </AbsoluteFill>
  );
}
