import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { loadFont } from "@remotion/google-fonts/Kalam";
import { design } from "../design";
import { Scene3D, LayerStack, LabelBox, Text, FilmGrain, Vignette } from "../primitives";

loadFont();

/** which layer is "active" as the camera flies down the stack */
const activeLayer = (frame: number) => {
  if (frame < 60) return -1;
  if (frame < 110) return 4;
  if (frame < 160) return 2;
  return 0;
};

export const Scene3DDemo: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: design.bg }}>
      <Scene3D
        camera={[
          { at: 0, pos: [0, 0.5, 13], look: [0, 0, 0] },
          { at: 60, pos: [4.5, 3.5, 10], look: [0, 1.2, 0] },
          { at: 120, pos: [-4, 1.5, 10], look: [0, 0, 0] },
          { at: 180, pos: [0, -3, 11], look: [0, -1.2, 0] },
        ]}
      >
        <LayerStack count={5} active={activeLayer(frame)} />
        <LabelBox
          position={[0, 2.6, 0]}
          size={[2.6, 0.7, 0.3]}
          emissive={design.accentBlue}
          emissiveIntensity={0.6}
        />
      </Scene3D>

      <Text preset="fade-up" start={6} size={46} x={960} y={90} align="center">
        Scene3D · fly the stack
      </Text>

      <Vignette strength={0.4} />
      <FilmGrain />
    </AbsoluteFill>
  );
};
