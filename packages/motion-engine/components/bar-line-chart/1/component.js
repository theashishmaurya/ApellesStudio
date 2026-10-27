"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = BarLineChart;
const jsx_runtime_1 = require("react/jsx-runtime");
const remotion_1 = require("remotion");
const paths_1 = require("@remotion/paths");
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };
/**
 * An animated bar chart with a trend line drawn over it: gridlines fade in,
 * each bar springs up in turn with its value counting beside it, then the line
 * through the bar tops draws on. All geometry is derived from the props and
 * the frame; colours and fonts come from the theme unless a colour is set.
 */
function BarLineChart({ props, theme, width, height }) {
    const frame = (0, remotion_1.useCurrentFrame)();
    const { fps } = (0, remotion_1.useVideoConfig)();
    const values = props.values.length > 0 ? props.values : [0];
    const n = values.length;
    const max = Math.max(1, ...values);
    const barInk = props.barColor ?? theme.accent;
    const lineInk = props.lineColor ?? theme.accentSignal;
    const pad = { left: width * 0.08, right: width * 0.04, top: height * 0.16, bottom: height * 0.14 };
    const plotW = width - pad.left - pad.right;
    const plotH = height - pad.top - pad.bottom;
    const slot = plotW / n;
    const barW = slot * 0.58;
    const titleSize = Math.round(height * 0.06);
    const labelSize = Math.round(Math.min(height * 0.035, slot * 0.28));
    const grid = (0, remotion_1.interpolate)(frame, [0, 12], [0, 1], clamp);
    const heights = values.map((v, i) => (0, remotion_1.spring)({ frame: frame - 6 - i * 4, fps, config: { damping: 15, stiffness: 110 } }) * (v / max));
    const tops = heights.map((h, i) => ({ x: pad.left + slot * i + slot / 2, y: pad.top + plotH * (1 - h) }));
    const finalTops = values.map((v, i) => ({ x: pad.left + slot * i + slot / 2, y: pad.top + plotH * (1 - v / max) }));
    const d = finalTops.map((p, i) => `${i === 0 ? "M" : "L"} ${p.x.toFixed(2)} ${p.y.toFixed(2)}`).join(" ");
    const drawStart = 6 + n * 4 + 6;
    const draw = (0, remotion_1.interpolate)(frame, [drawStart, drawStart + 24], [0, 1], clamp);
    const evolved = n > 1 ? (0, paths_1.evolvePath)(draw, d) : null;
    return ((0, jsx_runtime_1.jsxs)(remotion_1.AbsoluteFill, { children: [(0, jsx_runtime_1.jsx)("div", { style: {
                    position: "absolute",
                    left: pad.left,
                    top: height * 0.04,
                    fontFamily: theme.fontDisplay,
                    fontSize: titleSize,
                    color: theme.text,
                    opacity: grid,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    maxWidth: plotW,
                }, children: props.title }), (0, jsx_runtime_1.jsxs)("svg", { width: width, height: height, style: { position: "absolute", inset: 0 }, children: [[0, 0.25, 0.5, 0.75, 1].map((g) => ((0, jsx_runtime_1.jsx)("line", { x1: pad.left, x2: pad.left + plotW, y1: pad.top + plotH * (1 - g), y2: pad.top + plotH * (1 - g), stroke: theme.strokeSoft, strokeOpacity: 0.5 * grid, strokeWidth: g === 0 ? 2 : 1 }, g))), heights.map((h, i) => ((0, jsx_runtime_1.jsx)("rect", { x: tops[i].x - barW / 2, y: tops[i].y, width: barW, height: Math.max(0, plotH * h), rx: barW * 0.12, fill: barInk }, i))), props.line === "on" && evolved && ((0, jsx_runtime_1.jsx)("path", { d: d, fill: "none", stroke: lineInk, strokeWidth: Math.max(2, height * 0.006), strokeLinejoin: "round", strokeDasharray: evolved.strokeDasharray, strokeDashoffset: evolved.strokeDashoffset })), props.line === "on" &&
                        finalTops.map((p, i) => ((0, jsx_runtime_1.jsx)("circle", { cx: p.x, cy: p.y, r: Math.max(3, height * 0.008), fill: lineInk, opacity: draw >= (i + 1) / n ? 1 : 0 }, i)))] }), values.map((v, i) => ((0, jsx_runtime_1.jsx)("div", { style: {
                    position: "absolute",
                    left: tops[i].x - slot / 2,
                    width: slot,
                    top: tops[i].y - labelSize * 1.6,
                    textAlign: "center",
                    fontFamily: theme.fontMono,
                    fontSize: labelSize,
                    color: theme.text,
                    opacity: heights[i] > 0.02 ? 1 : 0,
                }, children: Math.min(v, Math.round(heights[i] * max)) }, i))), values.map((_, i) => ((0, jsx_runtime_1.jsx)("div", { style: {
                    position: "absolute",
                    left: pad.left + slot * i,
                    width: slot,
                    top: pad.top + plotH + labelSize * 0.6,
                    textAlign: "center",
                    fontFamily: theme.fontUi,
                    fontSize: labelSize,
                    color: theme.textDim,
                    opacity: grid,
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                }, children: props.labels[i] ?? "" }, `l${i}`)))] }));
}
