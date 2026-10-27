"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.default = ParticleLogoBurst;
const jsx_runtime_1 = require("react/jsx-runtime");
const remotion_1 = require("remotion");
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" };
/**
 * A logo word punches in while a seeded burst of particles flies out from
 * behind it, arcs down a little and settles into a faint halo. Every particle's
 * angle, distance, size and delay comes from Remotion's seeded random(), so the
 * same props draw the same burst on every frame of every render.
 */
function ParticleLogoBurst({ props, theme, width, height, durationInFrames }) {
    const frame = (0, remotion_1.useCurrentFrame)();
    const { fps } = (0, remotion_1.useVideoConfig)();
    const cx = width / 2;
    const cy = height / 2;
    const ink = props.color ?? theme.accent;
    const spark = theme.accentSignal;
    const textInk = props.textColor ?? theme.text;
    const burst = (0, remotion_1.interpolate)(frame, [0, durationInFrames * 0.6], [0, 1], { ...clamp, easing: remotion_1.Easing.out(remotion_1.Easing.cubic) });
    const settle = (0, remotion_1.interpolate)(frame, [durationInFrames * 0.45, durationInFrames], [1, 0.25], clamp);
    const logo = (0, remotion_1.spring)({ frame: frame - 4, fps, config: { damping: 13, stiffness: 140 } });
    const glow = (0, remotion_1.interpolate)(frame, [0, 10, durationInFrames * 0.5], [0, 1, 0.35], clamp);
    const count = Math.max(0, Math.round(props.count));
    const particles = Array.from({ length: count }, (_, i) => {
        const key = `${props.seed}-${i}`;
        const angle = (0, remotion_1.random)(`angle-${key}`) * Math.PI * 2;
        const reach = (0.2 + 0.8 * (0, remotion_1.random)(`reach-${key}`)) * props.spread;
        const size = 2.5 + (0, remotion_1.random)(`size-${key}`) * 7;
        const delay = (0, remotion_1.random)(`delay-${key}`) * 0.3;
        const p = Math.max(0, Math.min(1, (burst - delay) / (1 - delay)));
        const x = cx + Math.cos(angle) * reach * p;
        const y = cy + Math.sin(angle) * reach * p * 0.72 + 60 * p * p;
        const opacity = p === 0 ? 0 : settle * (0.45 + 0.55 * (0, remotion_1.random)(`alpha-${key}`));
        return { x, y, r: size * (1.2 - 0.5 * p), opacity, hot: (0, remotion_1.random)(`hot-${key}`) > 0.82 };
    });
    const fontSize = Math.min(height * 0.26, (width * 0.8) / Math.max(1, props.text.length * 0.8));
    return ((0, jsx_runtime_1.jsxs)(remotion_1.AbsoluteFill, { children: [(0, jsx_runtime_1.jsxs)("svg", { width: width, height: height, style: { position: "absolute", inset: 0 }, children: [(0, jsx_runtime_1.jsx)("circle", { cx: cx, cy: cy, r: Math.max(1, props.spread * 0.55 * burst), fill: "none", stroke: ink, strokeOpacity: 0.35 * glow, strokeWidth: 3 }), particles.map((pt, i) => ((0, jsx_runtime_1.jsx)("circle", { cx: pt.x, cy: pt.y, r: pt.r, fill: pt.hot ? spark : ink, opacity: pt.opacity }, i)))] }), (0, jsx_runtime_1.jsx)(remotion_1.AbsoluteFill, { style: { alignItems: "center", justifyContent: "center" }, children: (0, jsx_runtime_1.jsx)("span", { style: {
                        fontFamily: theme.fontDisplay,
                        fontSize,
                        fontWeight: 800,
                        letterSpacing: fontSize * 0.04,
                        color: textInk,
                        transform: `scale(${0.6 + 0.4 * logo})`,
                        opacity: Math.min(1, logo * 1.4),
                        textShadow: `0 0 ${Math.round(fontSize * 0.35 * glow)}px ${ink}`,
                        whiteSpace: "nowrap",
                    }, children: props.text }) })] }));
}
