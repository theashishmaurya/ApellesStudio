import React from "react";
import { AbsoluteFill, useCurrentFrame } from "remotion";
import { loadFont } from "@remotion/google-fonts/Kalam";
import { design } from "../design";
import { Layers, Text, Vignette } from "../primitives";

loadFont();

const activeItem = (f: number) => {
  if (f < 70) return -1;
  if (f < 110) return 3;
  if (f < 150) return 2;
  return 0;
};

export const LayersDemo: React.FC = () => {
  const frame = useCurrentFrame();
  return (
    <AbsoluteFill style={{ backgroundColor: design.bg }}>
      <Text preset="fade-up" start={4} size={44} x={960} y={90} align="center">
        Layers · the prompt stack
      </Text>
      <Layers
        items={[
          { label: "tools", sublabel: "12 defs" },
          { label: "system prompt" },
          { label: "retrieved context" },
          { label: "your question" },
        ]}
        start={12}
        active={activeItem(frame)}
        callout="re-sent on every call"
        y={560}
      />
      <Vignette strength={0.35} />
    </AbsoluteFill>
  );
};
