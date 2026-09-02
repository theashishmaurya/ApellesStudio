/**
 * Camera — a 2D "camera" over a full-canvas layer.
 *
 * Children are positioned in canvas/"world" coordinates (px, top-left origin).
 * `keys` are keyframes: at frame `at`, the world point (x,y) sits at screen centre,
 * scaled by `zoom` about that point. Between keys we ease (house inOut by default).
 *
 * Same mental model as Palmier keyframes: pick a target point + a zoom, set a frame.
 * Helpers `push` / `pan` / `pullBack` build common key sequences.
 */
import React from "react";
import {
  AbsoluteFill,
  useCurrentFrame,
  useVideoConfig,
  interpolate,
  Easing,
} from "remotion";
import { design } from "../design";

export type CameraKey = {
  at: number; // frame
  x?: number; // world point to centre on (px). default: canvas centre
  y?: number;
  zoom?: number; // scale factor. default 1
  ease?: readonly [number, number, number, number];
};

const cb = (c: readonly [number, number, number, number]) =>
  Easing.bezier(c[0], c[1], c[2], c[3]);

export const Camera: React.FC<{
  keys: CameraKey[];
  children: React.ReactNode;
  /** subtle always-on handheld drift on top of the keyframed move */
  drift?: boolean;
}> = ({ keys, children, drift = true }) => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();
  const cx = width / 2;
  const cy = height / 2;

  const resolve = (k: CameraKey) => ({
    at: k.at,
    x: k.x ?? cx,
    y: k.y ?? cy,
    zoom: k.zoom ?? 1,
    ease: k.ease ?? design.ease.inOut,
  });

  const sorted = [...keys].sort((a, b) => a.at - b.at).map(resolve);
  const first = sorted[0] ?? resolve({ at: 0 });

  let a = first;
  let b = first;
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].at <= frame) {
      a = sorted[i];
      b = sorted[i + 1] ?? sorted[i];
    }
  }
  if (frame <= first.at) {
    a = first;
    b = first;
  }

  const t =
    a.at === b.at
      ? 1
      : interpolate(frame, [a.at, b.at], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: cb(b.ease),
        });

  const x = interpolate(t, [0, 1], [a.x, b.x]);
  const y = interpolate(t, [0, 1], [a.y, b.y]);
  const zoom = interpolate(t, [0, 1], [a.zoom, b.zoom]);

  const dx = drift
    ? design.ambientDriftPx * 2 * Math.sin((frame / design.fps) * 0.6)
    : 0;
  const dy = drift
    ? design.ambientDriftPx * 2 * Math.sin((frame / design.fps) * 0.43 + 1.7)
    : 0;

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      <AbsoluteFill
        style={{
          transformOrigin: "0 0",
          transform: `translate(${cx - x * zoom + dx}px, ${cy - y * zoom + dy}px) scale(${zoom})`,
        }}
      >
        {children}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

/** hold at neutral, then push in on a target point */
export const push = (
  target: { x: number; y: number; zoom?: number },
  { at = 0, hold = 6, ramp = 24 }: { at?: number; hold?: number; ramp?: number } = {},
): CameraKey[] => [
  { at, zoom: 1 },
  { at: at + hold, zoom: 1 },
  { at: at + hold + ramp, x: target.x, y: target.y, zoom: target.zoom ?? 1.6 },
];

/** pan from one point to another at a constant zoom */
export const pan = (
  from: { x: number; y: number },
  to: { x: number; y: number },
  { at = 0, ramp = 30, zoom = 1.2 }: { at?: number; ramp?: number; zoom?: number } = {},
): CameraKey[] => [
  { at, x: from.x, y: from.y, zoom },
  { at: at + ramp, x: to.x, y: to.y, zoom },
];

/** ease back out to the full neutral frame */
export const pullBack = (
  from: { x: number; y: number; zoom: number },
  { at = 0, ramp = 30 }: { at?: number; ramp?: number } = {},
): CameraKey[] => [
  { at, x: from.x, y: from.y, zoom: from.zoom },
  { at: at + ramp, zoom: 1 },
];
