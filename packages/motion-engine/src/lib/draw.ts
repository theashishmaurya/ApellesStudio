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

/**
 * subtle always-on drift so nothing sits perfectly still. Deterministic
 * per-seed.
 *
 * B-060 fix (`docs/BUGS.md`) — `fps` is now a required parameter, the
 * composition's REAL frame rate (`useVideoConfig().fps` at each call site),
 * not `design.fps` (a fixed authoring-default TOKEN, `30`). Before this fix
 * both `x`/`y` divided `frame` by `design.fps` regardless of the actual
 * render fps, so the same manifest's drift oscillated at a different
 * perceived wall-clock rate at 60fps (twice as fast) or 24fps (20% slower)
 * than at the 30fps the token happened to match. `design.fps` itself is
 * untouched — it stays the authoring default a NEW manifest gets — this
 * helper simply stops reading it as a runtime constant. Same shape as this
 * file's own neighbour `pop(frame, fps, delay)` below, which already took
 * `fps` as a parameter for the identical reason. */
export const ambientDrift = (frame: number, fps: number, seed = 0) => {
  const a = design.ambientDriftPx;
  return {
    x: a * Math.sin((frame / fps) * 0.7 + seed * 1.3),
    y: a * Math.sin((frame / fps) * 0.5 + seed * 2.1),
  };
};

/** spring preset for entrances */
export const pop = (frame: number, fps: number, delay = 0) =>
  spring({ frame: frame - delay, fps, config: { damping: 14, stiffness: 120, mass: 0.7 } });

export { interpolate };
