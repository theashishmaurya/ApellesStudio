/**
 * Emphasis — draw the eye to a thing.
 *
 * presets:
 *   pulse    — rough ellipse around a box, gentle scale bob (loops for `dur`)
 *   glow     — rough ellipse around a box, accent drop-shadow breathes
 *   ring     — expanding rough circle from a box centre, fades out (a "ping")
 *   scribble — rough ellipse hand-drawn around a box, left on screen
 *
 * All four presets are self-drawn from an explicit `box` (world px) — none of
 * them take `children` (B-212, `docs/BUGS.md`: `pulse`/`glow` used to be
 * children-only wrappers, which drew nothing at all from a manifest layer,
 * since `Video.tsx` renders every primitive `<C {...props} />` self-closing —
 * a manifest has no way to give a primitive `children`. `ring`/`scribble`
 * never had this problem because they already derived their shape from `box`;
 * `pulse`/`glow` now follow the same pattern instead of a different one).
 *
 * `data-motion-box` (D-155, §3b of `docs/notes/motion-visual-builder-
 * research.md`) marks the drawn `<path>` for every preset — the whole `<svg>`
 * is `inset:0` (the full canvas, not a usable selection rect), but the path
 * itself IS the drawn shape's tight bounding box.
 */
import React from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import { useTheme } from "../ThemeContext";
import { inAt, outAt, lifetime } from "../lib/draw";
import { roughEllipse } from "../lib/rough";

export type EmphasisPreset = "pulse" | "glow" | "ring" | "scribble";

export const Emphasis: React.FC<{
  preset?: EmphasisPreset;
  start?: number;
  dur?: number;
  color?: string;
  box?: { x: number; y: number; w: number; h: number };
  seed?: number;
}> = ({
  preset = "pulse",
  start = 0,
  dur = 24,
  // D-339 — resolved in the body, not the parameter list: a default parameter
  // cannot call `useTheme()`. An explicit `color` prop still wins.
  color: colorProp,
  box,
  seed = 3,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const theme = useTheme();
  const color = colorProp ?? theme.accent;
  const local = frame - start;
  const active = local >= 0 && local <= dur;

  if (!box) return null;
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;

  if (preset === "pulse") {
    // B-212 fix: self-drawn, box-driven, like `ring`/`scribble` below — was a
    // children-only `<div style={{transform: scale(...)}}>{children}</div>`,
    // which drew nothing from a manifest layer (no `children` to scale). The
    // scale bob (`s`) now sizes a rough ellipse around `box` instead of
    // scaling a wrapped child; only visible during this layer's own
    // `[start, start+dur]` window, same gating every other preset here uses.
    if (!active) return null;
    const s = 1 + 0.06 * Math.sin((local / fps) * Math.PI * 3);
    const d = roughEllipse(cx, cy, box.w * s, box.h * s, {
      seed,
      color,
      strokeWidth: 5,
      roughness: theme.roughness,
      bowing: theme.bowing,
    });
    return (
      <svg
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
        width="100%"
        height="100%"
      >
        <path data-motion-box d={d} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" />
      </svg>
    );
  }

  if (preset === "glow") {
    // B-212 fix: same shape as before was a bare accent `drop-shadow` filter
    // wrapping `children` (again nothing, from a manifest layer). The exact
    // same breathing formula (`12 + g * 22`px blur) now drives a drop-shadow
    // filter on a real rough ellipse drawn around `box`, so there is a shape
    // for the glow to actually surround.
    if (!active) return null;
    const g = 0.5 + 0.5 * Math.sin((local / fps) * Math.PI * 2);
    const d = roughEllipse(cx, cy, box.w, box.h, {
      seed,
      color,
      strokeWidth: 6,
      roughness: theme.roughness,
      bowing: theme.bowing,
    });
    return (
      <svg
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
        width="100%"
        height="100%"
      >
        <path
          data-motion-box
          d={d}
          fill="none"
          stroke={color}
          strokeWidth={6}
          strokeLinecap="round"
          style={{ filter: `drop-shadow(0 0 ${12 + g * 22}px ${color})` }}
        />
      </svg>
    );
  }

  if (preset === "ring") {
    // B-214 — draw NOTHING outside this layer's own [at, at+dur] window.
    // `fade` below is `outAt(...)`, which clamps to 1 to the LEFT of its
    // range, so before `start` this branch used to emit a fully opaque ring
    // at 60% radius — parked on screen from frame 0 of the scene, pointing at
    // something that had not appeared yet. (After `start + dur` it emitted an
    // invisible `opacity: 0` path instead, so only the "before" half was ever
    // visible.) `scribble` below already gates itself correctly via
    // `lifetime()`; this makes `ring` agree with it and with its own
    // documented `at`/`dur`. `active` is computed above and is exactly this
    // window, so every in-window pixel is unchanged.
    if (!active) return null;
    const p = inAt(frame, start, start + dur);
    const fade = outAt(frame, start + dur * 0.4, start + dur);
    const r0 = Math.max(box.w, box.h) * 0.55;
    const r = r0 * (0.6 + p * 0.9);
    const d = roughEllipse(cx, cy, r * 2, r * 2, {
      seed,
      color,
      strokeWidth: 5,
      roughness: theme.roughness,
      bowing: theme.bowing,
    });
    return (
      <svg
        style={{ position: "absolute", inset: 0, overflow: "visible" }}
        width="100%"
        height="100%"
      >
        <path data-motion-box d={d} fill="none" stroke={color} strokeWidth={5} strokeLinecap="round" opacity={fade} />
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
    roughness: theme.roughness,
    bowing: theme.bowing,
  });
  return (
    <svg
      style={{ position: "absolute", inset: 0, overflow: "visible" }}
      width="100%"
      height="100%"
    >
      <path
        data-motion-box
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
