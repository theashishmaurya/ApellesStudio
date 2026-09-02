import React from "react";
import { AbsoluteFill } from "remotion";
import { loadFont } from "@remotion/google-fonts/Kalam";
import { design } from "../design";
import { Scene3D, ParticleFlow, Text, FilmGrain, Vignette } from "../primitives";

loadFont();

export const ParticleDemo: React.FC = () => (
  <AbsoluteFill style={{ backgroundColor: design.bg }}>
    <Scene3D
      camera={[
        { at: 0, pos: [0, 0, 12], look: [0, 0, 0] },
        { at: 90, pos: [3, 2, 10], look: [0, 0, 0] },
        { at: 180, pos: [-2, -1, 9], look: [0, 0, 0] },
      ]}
    >
      <ParticleFlow preset="stream" from={[-6, 0, 0]} to={[6, 0, 0]} count={1400} color={design.accentBlue} />
      <ParticleFlow
        preset="converge"
        shape="sphere"
        shapeSize={2.4}
        center={[0, 0, 0]}
        start={60}
        dur={70}
        count={1600}
        color={design.accentRed}
        seed={4}
      />
    </Scene3D>
    <Text preset="fade-up" start={6} size={44} x={960} y={90} align="center">
      ParticleFlow · stream + converge
    </Text>
    <Vignette strength={0.4} />
    <FilmGrain />
  </AbsoluteFill>
);
