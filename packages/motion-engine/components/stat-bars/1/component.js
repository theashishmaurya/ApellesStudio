"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = StatBars;
const jsx_runtime_1 = require("react/jsx-runtime");
const remotion_1 = require("remotion");
const d3_scale_1 = require("d3-scale");
const d3_shape_1 = require("d3-shape");
const d3_array_1 = require("d3-array");
const d3_interpolate_1 = require("d3-interpolate");
const d3_format_1 = require("d3-format");
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };
/** d3-format specifiers for each value format. */
const SPECIFIER = { number: ",.0f", compact: ".2~s", percent: ",.0f" };
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
function StatBars({ props, theme, width, height }) {
    const frame = (0, remotion_1.useCurrentFrame)();
    const { fps } = (0, remotion_1.useVideoConfig)();
    const values = props.values.length > 0 ? props.values : [0];
    const n = values.length;
    const peak = (0, d3_array_1.max)(values) ?? 0;
    const barInk = props.barColor ?? theme.accent;
    const highlightInk = props.highlightColor ?? theme.accentSignal;
    const fmt = (0, d3_format_1.format)(SPECIFIER[props.format]);
    const show = (v) => (props.format === "percent" ? `${fmt(v)}%` : fmt(v));
    const pad = { left: width * 0.17, right: width * 0.08, top: height * 0.2, bottom: height * 0.08 };
    const y = (0, d3_scale_1.scaleBand)()
        .domain(values.map((_, i) => i))
        .range([pad.top, height - pad.bottom])
        .paddingInner(0.32);
    const rowH = y.bandwidth();
    const labelSize = Math.round(Math.min(height * 0.045, rowH * 0.5));
    // Keep the longest value label inside the frame: the bars stop short of it.
    const reserve = Math.max(pad.right, (show(peak).length + 1) * labelSize * VALUE_GLYPH_WIDTH);
    const x = (0, d3_scale_1.scaleLinear)()
        .domain([0, peak > 0 ? peak : 1])
        .range([0, width - pad.left - reserve])
        .nice();
    const titleSize = Math.round(height * 0.07);
    const grid = (0, remotion_1.interpolate)(frame, [0, 12], [0, 1], clamp);
    const gridLine = (0, d3_shape_1.line)();
    const winner = values.indexOf(peak);
    return ((0, jsx_runtime_1.jsxs)(remotion_1.AbsoluteFill, { children: [(0, jsx_runtime_1.jsx)("div", { style: {
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
                }, children: props.title }), (0, jsx_runtime_1.jsxs)("svg", { width: width, height: height, style: { position: "absolute", inset: 0 }, children: [x.ticks(4).map((t) => ((0, jsx_runtime_1.jsx)("path", { d: gridLine([[pad.left + x(t), pad.top - rowH * 0.2], [pad.left + x(t), height - pad.bottom]]) ?? "", fill: "none", stroke: theme.strokeSoft, strokeOpacity: 0.5 * grid, strokeWidth: t === 0 ? 2 : 1 }, t))), values.map((v, i) => {
                        const grow = (0, remotion_1.spring)({ frame: frame - 6 - i * STAGGER, fps, config: { damping: 18, stiffness: 100 } });
                        const w = Math.max(0, x(v) * grow);
                        return ((0, jsx_runtime_1.jsx)("rect", { x: pad.left, y: y(i) ?? 0, width: w, height: rowH, rx: Math.min(rowH * 0.2, w / 2), fill: i === winner ? highlightInk : barInk }, i));
                    })] }), values.map((v, i) => {
                const grow = Math.min(1, Math.max(0, (0, remotion_1.spring)({ frame: frame - 6 - i * STAGGER, fps, config: { damping: 18, stiffness: 100 } })));
                const rowY = y(i) ?? 0;
                return ((0, jsx_runtime_1.jsxs)("div", { children: [(0, jsx_runtime_1.jsx)("div", { style: {
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
                            }, children: props.labels[i] ?? "" }), (0, jsx_runtime_1.jsx)("div", { style: {
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
                            }, children: show((0, d3_interpolate_1.interpolateNumber)(0, v)(grow)) })] }, i));
            })] }));
}
