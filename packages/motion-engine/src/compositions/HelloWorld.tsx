import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { loadFont } from "@remotion/google-fonts/Kalam";
import { design } from "../design";
import { inAt, ambientDrift } from "../lib/draw";
import { roughLine } from "../lib/rough";

const { fontFamily } = loadFont();

/**
 * Smoke test for the dark-Excalidraw look: slate ground, hand-lettered title,
 * a red underline that draws itself on, subtle ambient drift. No 3D, no primitives yet —
 * this just proves the tokens + font + roughjs + frame helpers all render.
 */
export const HelloWorld: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height } = useVideoConfig();

  const titleIn = inAt(frame, 4, 22);
  const underlineDraw = inAt(frame, 20, 40); // 0→1, used as strokeDashoffset progress
  const drift = ambientDrift(frame, 1);

  const underlineLen = width * 0.34;
  const underlineD = roughLine([0, 0], [underlineLen, 0], {
    seed: 7,
    color: design.accentRed,
    strokeWidth: 6,
  });

  return (
    <AbsoluteFill style={{ backgroundColor: design.bg }}>
      <AbsoluteFill
        style={{
          justifyContent: "center",
          alignItems: "flex-start",
          paddingLeft: width * 0.1,
          transform: `translate(${drift.x}px, ${drift.y}px)`,
        }}
      >
        <div
          style={{
            fontFamily,
            fontSize: height * 0.14,
            fontWeight: 700,
            color: design.text,
            letterSpacing: "0.02em",
            opacity: titleIn,
            transform: `translateY(${(1 - titleIn) * 24}px)`,
          }}
        >
          EVERY CALL
        </div>

        <svg
          width={underlineLen + 20}
          height={40}
          style={{ marginTop: height * 0.02, overflow: "visible" }}
        >
          <path
            d={underlineD}
            fill="none"
            stroke={design.accentRed}
            strokeWidth={6}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - underlineDraw}
          />
        </svg>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
