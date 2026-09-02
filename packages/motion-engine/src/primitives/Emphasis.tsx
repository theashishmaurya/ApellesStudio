/**
 * Emphasis — draw the eye to a thing.
 *
 * presets:
 *   pulse    — wraps children, gentle scale bob (loops for `dur`)
 *   glow     — wraps children, accent drop-shadow breathes
 *   ring     — expanding rough circle from a box centre, fades out (a "ping")
 *   scribble — rough ellipse hand-drawn around a box, left on screen
 *
 * ring/scribble need an explicit `box` (world px). pulse/glow wrap `children`
 * and don't need one.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { design } from "../design";
import { inAt, outAt, lifetime } from "../lib/draw";
import { roughEllipse } from "../lib/rough";

export type EmphasisPreset = "pulse" | "glow" | "ring" | "scribble";

export const Emphasis: React.FC<{
  preset?: EmphasisPreset;
  start?: number;
  dur?: number;
  color?: string;
  box?: { x: number; y: number; w: number; h: number };
  children?: React.ReactNode;
  seed?: number;
}> = ({
  preset = "pulse",
  start = 0,
  dur = 24,
  color = design.accentRed,
  box,
  children,
  seed = 3,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const local = frame - start;
  const active = local >= 0 && local <= dur;

  if (preset === "pulse") {
    const s = active ? 1 + 0.06 * Math.sin((local / fps) * Math.PI * 3) : 1;
    return (
      <div style={{ display: "inline-block", transform: `scale(${s})` }}>
        {children}
      </div>
    );
  }

  if (preset === "glow") {
    const g = active
      ? 0.5 + 0.5 * Math.sin((local / fps) * Math.PI * 2)
      : 0;
    return (
      <div
        style={{
          display: "inline-block",
          filter: `drop-shadow(0 0 ${12 + g * 22}px ${color})`,
        }}
      >
        {children}
      </div>
    );
  }

  if (!box) return null;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  if (preset === "ring") {
    const p = inAt(frame, start, start + dur);
    const fade = outAt(frame, start + dur * 0.4, start + dur);
    const r0 = Math.max(box.w, box.h) * 0.55;
    const r = r0 * (0.6 + p * 0.9);
    const d = roughEllipse(cx, cy, r * 2, r * 2, { seed, color, strokeWidth: 5 });
    return (
      <svg
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
        width="100%"
        height="100%"
      >
        <path d={d} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" opacity={fade} />
      </svg>
    );
  }

  // scribble
  const draw = inAt(frame, start, start + Math.min(dur, 20));
  const held = lifetime(frame, start, start + dur, 6);
  const d = roughEllipse(cx, cy, box.w * 1.18, box.h * 1.5, {
    seed,
    color,
    strokeWidth: 5,
  });
  return (
    <svg
      style={{ position: "absolute", inset: 0, overflow: "visible" }}
      width="100%"
      height="100%"
    >
      <path
        d={d}
        fill="none"
        stroke={color}
        strokeWidth={5}
        strokeLinecap="round"
        pathLength={1}
        strokeDasharray={1}
        strokeDashoffset={1 - draw}
        opacity={held}
      />
    </svg>
  );
};
