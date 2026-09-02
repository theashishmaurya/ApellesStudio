import React from "react";
import { AbsoluteFill, Sequence, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Kalam";
import { design } from "../design";
import { Camera, push, Text, Emphasis, Matrix } from "../primitives";

const { fontFamily } = loadFont();

/**
 * Exercises the cheap-4 primitives end to end (Text / Camera / Emphasis / Matrix).
 * Not a real video — a checkpoint render for /video-review.
 */
export const PrimitivesDemo: React.FC = () => {
  const { width, height } = useVideoConfig();

  return (
    <AbsoluteFill style={{ backgroundColor: design.bg, fontFamily }}>
      {/* 0–90: text presets */}
      <Sequence durationInFrames={90}>
        <AbsoluteFill style={{ padding: 120, gap: 40, justifyContent: "center" }}>
          <Text preset="fade-up" start={4} size={72}>
            fade-up reveal
          </Text>
          <Text preset="mask-up" start={16} size={72} color={design.accentBlue}>
            mask-up reveal
          </Text>
          <Text preset="type" start={28} size={64} caret color={design.textDim}>
            typewriter with a caret…
          </Text>
          <Text preset="stroke-on" start={44} size={80}>
            HAND-LETTERED
          </Text>
        </AbsoluteFill>
      </Sequence>

      {/* 90–200: camera push onto an emphasised box */}
      <Sequence from={90} durationInFrames={110}>
        <Camera keys={push({ x: width * 0.62, y: height * 0.5, zoom: 1.7 }, { at: 0, hold: 10, ramp: 34 })}>
          <Text preset="fade-up" start={4} size={64} x={width * 0.1} y={height * 0.28}>
            EVERY CALL re-sends the prompt
          </Text>
          <div
            style={{
              position: "absolute",
              left: width * 0.52,
              top: height * 0.4,
              width: width * 0.2,
              height: height * 0.2,
              border: `4px solid ${design.stroke}`,
              borderRadius: 12,
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              color: design.text,
              fontSize: 44,
            }}
          >
            $$$
          </div>
          <Emphasis
            preset="scribble"
            start={40}
            dur={70}
            box={{ x: width * 0.52, y: height * 0.4, w: width * 0.2, h: height * 0.2 }}
          />
        </Camera>
      </Sequence>

      {/* 200–320: matrix presets */}
      <Sequence from={200} durationInFrames={120}>
        <Matrix
          rows={6}
          cols={8}
          cell={96}
          preset="ripple"
          start={0}
          dur={45}
          accent={design.accentRed}
        />
        <Text preset="fade-up" start={6} size={48} x={width / 2} y={height * 0.12} align="center">
          Matrix · ripple
        </Text>
      </Sequence>
    </AbsoluteFill>
  );
};
