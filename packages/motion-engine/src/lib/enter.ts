/**
 * The entrance the D-405 brand primitives (`image`, `icon`, `shape`, `counter`)
 * share: invisible before `start`, then one of a few house reveals over
 * `dur` frames. One function so the four enter identically and an `enter`
 * value means the same thing on each.
 *
 * What it does NOT do: animate anything after the entrance (that is `anim`
 * property tracks and the transform keys), or the `shape`-only `draw` reveal
 * (a stroke draw-on, which `Shape.tsx` does itself and which is a plain
 * appear as far as this function is concerned).
 */
import type React from "react";
import { inAt, pop } from "./draw";

export const ENTER_PRESETS = ["none", "fade", "pop", "rise", "draw"] as const;
export type EnterPreset = (typeof ENTER_PRESETS)[number];

/** how far `rise` travels, px. */
const RISE_PX = 40;

/** opacity + transform for an element entering at `start` (frames). */
export function enterStyle(
  preset: EnterPreset,
  frame: number,
  start: number,
  dur: number,
  fps: number,
): Pick<React.CSSProperties, "opacity" | "transform"> {
  if (frame < start) return { opacity: 0 };
  const p = inAt(frame, start, start + Math.max(1, dur));
  switch (preset) {
    case "fade":
      return { opacity: p };
    case "rise":
      return { opacity: p, transform: `translateY(${(1 - p) * RISE_PX}px)` };
    case "pop": {
      const s = pop(frame, fps, start);
      return { opacity: Math.min(1, p * 2), transform: `scale(${s})` };
    }
    case "none":
    case "draw":
      return {};
  }
}
