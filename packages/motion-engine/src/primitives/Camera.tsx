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
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { design } from "../design";
import { interpolateKeys } from "../lib/interpolateKeys";

export type CameraKey = {
  at: number; // frame
  x?: number; // world point to centre on (px). default: canvas centre
  y?: number;
  zoom?: number; // scale factor. default 1
  ease?: readonly [number, number, number, number];
};

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

  // D-159: sort/clamp/ease/interpolate is now `interpolateKeys` (`../lib/
  // interpolateKeys.ts`), extracted verbatim from this component's own
  // pre-D-159 inline logic so `Video.tsx`'s new per-layer transform keys can
  // reuse the identical mechanics rather than a second copy of it — see that
  // file's own doc comment and D-159's decision entry for the byte-for-byte
  // verification that this refactor changed nothing about the camera itself.
  const { x, y, zoom } = interpolateKeys(
    keys,
    frame,
    ["x", "y", "zoom"] as const,
    { x: cx, y: cy, zoom: 1 },
    design.ease.inOut,
  );

  const dx = drift
    ? design.ambientDriftPx * 2 * Math.sin((frame / design.fps) * 0.6)
    : 0;
  const dy = drift
    ? design.ambientDriftPx * 2 * Math.sin((frame / design.fps) * 0.43 + 1.7)
    : 0;

  return (
    <AbsoluteFill style={{ overflow: "hidden" }}>
      {/* `data-motion-world` (D-155, `docs/notes/motion-visual-builder-research.md`
       *  §3a/§4 Phase 0a) — the ONE stable DOM hook a screen↔world coordinate
       *  map needs: `getBoundingClientRect()` here already composes the
       *  player's own fit-scale, this transform's zoom/translate, AND the
       *  drift below, with no need for `@chroma/motion` to re-read `keys`,
       *  re-sort them, or re-run this easing. A pure attribute add — zero
       *  pixel/visual change. See the engine README's "DOM contract" section. */}
      <AbsoluteFill
        data-motion-world
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
