/**
 * `shape` — a vector design shape: rect, roundrect, ellipse, polygon, star or
 * line, with a solid or gradient fill and a stroke that can draw on (D-405).
 *
 *   {"use":"shape","shape":"roundrect","x":560,"y":380,"w":800,"h":320,"radius":40,
 *    "gradient":{"type":"linear","angle":30,"stops":[{"at":0,"color":"#5b8def"},{"at":1,"color":"#a259ff"}]},
 *    "stroke":"#ffffff","strokeWidth":4,"at":0.2,"enter":"draw"}
 *
 * Geometry comes from `@remotion/shapes` (`makeRect` / `makeEllipse` /
 * `makePolygon` / `makeStar`, all with a real corner radius) and the draw-on
 * from `@remotion/paths`' `evolvePath`, so the outlines are the maintained
 * library's, not hand-written path maths. A `line` runs from (`x`,`y`) to
 * (`x`+`w`, `y`+`h`) — negative `w`/`h` point it left/up. Polygons and stars sit
 * centred in the `w`×`h` box at the largest radius that fits.
 *
 * `strokeProgress` (0..1) is how much of the outline is drawn — keyframe it with
 * an `anim` track for a draw-on at any time; `enter: "draw"` draws it on over
 * the entrance. `fillOpacity` likewise.
 *
 * What it does NOT do: free-form paths (`path`, Phase 3) or icons (`icon`).
 */
import React, { useId } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { makeEllipse, makePolygon, makeRect, makeStar } from "@remotion/shapes";
import { evolvePath } from "@remotion/paths";
import { inAt } from "../lib/draw";
import { enterStyle, type EnterPreset } from "../lib/enter";
import { useTheme } from "../ThemeContext";
import type { ShapeKind } from "./shapeKinds";


export interface GradientStop {
  at: number;
  color: string;
}
export interface Gradient {
  type: "linear" | "radial";
  /** linear only, degrees; 0 = left → right, 90 = top → bottom */
  angle?: number;
  stops: GradientStop[];
}

/** the outline, in the shape's own box coordinates (0,0 top-left). */
function outline(
  shape: ShapeKind,
  w: number,
  h: number,
  radius: number,
  points: number,
  inner: number,
): { d: string; dx: number; dy: number } {
  const aw = Math.abs(w);
  const ah = Math.abs(h);
  switch (shape) {
    case "rect":
      return { d: makeRect({ width: aw, height: ah }).path, dx: 0, dy: 0 };
    case "roundrect":
      return {
        d: makeRect({ width: aw, height: ah, cornerRadius: Math.min(radius, aw / 2, ah / 2) }).path,
        dx: 0,
        dy: 0,
      };
    case "ellipse":
      return { d: makeEllipse({ rx: aw / 2, ry: ah / 2 }).path, dx: 0, dy: 0 };
    case "polygon": {
      const r = Math.min(aw, ah) / 2;
      const info = makePolygon({ points: Math.max(3, Math.round(points)), radius: r, cornerRadius: radius });
      return { d: info.path, dx: (aw - info.width) / 2, dy: (ah - info.height) / 2 };
    }
    case "star": {
      const r = Math.min(aw, ah) / 2;
      const info = makeStar({
        points: Math.max(3, Math.round(points)),
        outerRadius: r,
        innerRadius: r * Math.max(0.05, Math.min(1, inner)),
        cornerRadius: radius,
      });
      return { d: info.path, dx: (aw - info.width) / 2, dy: (ah - info.height) / 2 };
    }
    case "line":
      return { d: `M 0 0 L ${w} ${h}`, dx: 0, dy: 0 };
  }
}

export const Shape: React.FC<{
  shape?: ShapeKind;
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  radius?: number;
  points?: number;
  innerRadius?: number;
  fill?: string;
  fillOpacity?: number;
  gradient?: Gradient;
  stroke?: string;
  strokeWidth?: number;
  strokeProgress?: number;
  enter?: EnterPreset;
  enterDur?: number;
  start?: number;
}> = ({
  shape = "rect",
  x = 0,
  y = 0,
  w = 200,
  h = 200,
  radius = 24,
  points = 5,
  innerRadius = 0.45,
  fill,
  fillOpacity = 1,
  gradient,
  stroke,
  strokeWidth = 0,
  strokeProgress = 1,
  enter = "fade",
  enterDur = 18,
  start = 0,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = useTheme();
  const gradId = `shape-grad-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const { d, dx, dy } = outline(shape, w, h, radius, points, innerRadius);

  const drawP = enter === "draw" ? (frame < start ? 0 : inAt(frame, start, start + Math.max(1, enterDur))) : 1;
  const progress = Math.max(0, Math.min(1, strokeProgress)) * drawP;
  const isLine = shape === "line";
  const strokeColor = stroke ?? (isLine ? theme.stroke : undefined);
  const sw = isLine ? Math.max(strokeWidth, 1) : strokeWidth;
  const evolved = strokeColor && sw > 0 && progress < 1 ? evolvePath(progress, d) : null;
  const fillPaint = isLine ? "none" : gradient ? `url(#${gradId})` : (fill ?? theme.accent);

  const left = isLine ? x + Math.min(0, w) : x;
  const top = isLine ? y + Math.min(0, h) : y;
  const pad = sw;

  return (
    <div
      data-motion-box
      style={{
        position: "absolute",
        left,
        top,
        width: Math.abs(w),
        height: Math.abs(h),
        transformOrigin: "50% 50%",
        ...enterStyle(enter, frame, start, enterDur, fps),
      }}
    >
      <svg
        width={Math.abs(w) + 2 * pad}
        height={Math.abs(h) + 2 * pad}
        viewBox={`${-pad} ${-pad} ${Math.abs(w) + 2 * pad} ${Math.abs(h) + 2 * pad}`}
        style={{ position: "absolute", left: -pad, top: -pad, overflow: "visible" }}
      >
        {gradient && (
          <defs>
            {gradient.type === "radial" ? (
              <radialGradient id={gradId}>
                {gradient.stops.map((s, i) => (
                  <stop key={i} offset={s.at} stopColor={s.color} />
                ))}
              </radialGradient>
            ) : (
              <linearGradient
                id={gradId}
                x1="0"
                y1="0.5"
                x2="1"
                y2="0.5"
                gradientTransform={`rotate(${gradient.angle ?? 0} 0.5 0.5)`}
              >
                {gradient.stops.map((s, i) => (
                  <stop key={i} offset={s.at} stopColor={s.color} />
                ))}
              </linearGradient>
            )}
          </defs>
        )}
        <path
          d={d}
          transform={isLine ? `translate(${-Math.min(0, w)} ${-Math.min(0, h)})` : `translate(${dx} ${dy})`}
          fill={fillPaint}
          fillOpacity={enter === "draw" ? fillOpacity * drawP : fillOpacity}
          stroke={strokeColor ?? "none"}
          strokeWidth={sw}
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeDasharray={evolved?.strokeDasharray}
          strokeDashoffset={evolved?.strokeDashoffset}
        />
      </svg>
    </div>
  );
};
