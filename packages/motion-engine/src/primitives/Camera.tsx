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

/**
 * The camera's own ambient-drift offset, pulled out of the component as a
 * pure function so it is directly unit-testable (B-060, `docs/BUGS.md`) —
 * mirrors `../lib/draw.ts`'s `ambientDrift`, which is the same idea for the
 * 2D primitives, kept separate rather than unified because the two have
 * always used different amplitudes/phase constants (this one's `* 2`,
 * different `0.6`/`0.43` rates and `1.7` phase offset) and B-060 did not ask
 * to change that, only the fps source both read from.
 *
 * `fps` must be the COMPOSITION'S real frame rate (`useVideoConfig().fps`),
 * not `design.fps` (a fixed authoring-default token, `30`) — before this fix
 * `Camera` divided `frame` by `design.fps` regardless of the actual render
 * fps, so the same manifest's camera drift ran at a different perceived
 * wall-clock rate at 60fps (twice as fast) vs 24fps (20% slower) than at the
 * 30fps the token happened to match. `design.fps` itself is untouched — it
 * stays the authoring default a NEW manifest gets.
 */
export function cameraDrift(frame: number, fps: number): { dx: number; dy: number } {
  return {
    dx: design.ambientDriftPx * 2 * Math.sin((frame / fps) * 0.6),
    dy: design.ambientDriftPx * 2 * Math.sin((frame / fps) * 0.43 + 1.7),
  };
}

export const Camera: React.FC<{
  keys: CameraKey[];
  children: React.ReactNode;
  /** subtle always-on handheld drift on top of the keyframed move */
  drift?: boolean;
}> = ({ keys, children, drift = true }) => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
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

  const { dx, dy } = drift ? cameraDrift(frame, fps) : { dx: 0, dy: 0 };

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
