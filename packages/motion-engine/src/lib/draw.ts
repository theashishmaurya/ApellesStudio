/**
 * Shared frame helpers used by every primitive.
 */
import { interpolate, spring, Easing } from "remotion";
import { design } from "../design";

const cb = (c: readonly [number, number, number, number]) =>
  Easing.bezier(c[0], c[1], c[2], c[3]);

/** 0→1 over [from,to] frames with the house "settle" ease, clamped. */
export const inAt = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: cb(design.ease.out),
  });

/** 1→0 over [from,to] frames, clamped. */
export const outAt = (frame: number, from: number, to: number) =>
  interpolate(frame, [from, to], [1, 0], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: cb(design.ease.inOut),
  });

/** a value that eases in, holds, eases out — for a whole element's lifetime */
export const lifetime = (
  frame: number,
  start: number,
  end: number,
  fade = 8,
) => Math.min(inAt(frame, start, start + fade), outAt(frame, end - fade, end));

/** subtle always-on drift so nothing sits perfectly still. Deterministic per-seed. */
export const ambientDrift = (frame: number, seed = 0) => {
  const a = design.ambientDriftPx;
  return {
    x: a * Math.sin((frame / design.fps) * 0.7 + seed * 1.3),
    y: a * Math.sin((frame / design.fps) * 0.5 + seed * 2.1),
  };
};

/** spring preset for entrances */
export const pop = (frame: number, fps: number, delay = 0) =>
  spring({ frame: frame - delay, fps, config: { damping: 14, stiffness: 120, mass: 0.7 } });

export { interpolate };
