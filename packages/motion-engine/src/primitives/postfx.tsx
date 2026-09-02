/**
 * Post-FX overlays — the premium sheen. 2D, layered on top of ANY composition
 * (2D or 3D), fully deterministic (grain is seeded by frame).
 *
 * <FilmGrain /> and <Vignette /> — drop at the end of a composition's tree.
 */
import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { design } from "../design";

/** animated film grain via seeded SVG turbulence — re-randomised each frame */
export const FilmGrain: React.FC<{ opacity?: number; scale?: number }> = ({
  opacity = 0.045,
  scale = 1.4,
}) => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ pointerEvents: "none", mixBlendMode: "overlay", opacity }}>
      <svg width="100%" height="100%">
        <filter id={`grain-${frame % 8}`}>
          <feTurbulence
            type="fractalNoise"
            baseFrequency={0.9 / scale}
            numOctaves={2}
            seed={frame % 97}
            stitchTiles="stitch"
          />
          <feColorMatrix type="saturate" values="0" />
        </filter>
        <rect width="100%" height="100%" filter={`url(#grain-${frame % 8})`} />
      </svg>
    </AbsoluteFill>
  );
};

/** soft vignette — radial darkening at the edges */
export const Vignette: React.FC<{ strength?: number }> = ({ strength = 0.55 }) => (
  <AbsoluteFill
    style={{
      pointerEvents: "none",
      background: `radial-gradient(ellipse at center, transparent 45%, ${design.bgDeep} 130%)`,
      opacity: strength,
    }}
  />
);
