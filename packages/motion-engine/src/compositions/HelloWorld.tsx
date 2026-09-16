import React from "react";
import { AbsoluteFill, useCurrentFrame, useVideoConfig } from "remotion";
import { useTheme } from "../ThemeContext";
import { inAt, ambientDrift } from "../lib/draw";
import { roughLine } from "../lib/rough";

/**
 * Smoke test for whichever theme is active (D-339; the engine default — the
 * dark-Excalidraw look — when rendered standalone): the ground, a title in the
 * display face, an accent underline that draws itself on, and the theme's own
 * ambient drift. No 3D, no primitives — this just proves tokens + font +
 * roughjs + frame helpers all render.
 */
export const HelloWorld: React.FC = () => {
  const frame = useCurrentFrame();
  const { width, height, fps } = useVideoConfig();
  const theme = useTheme();

  const titleIn = inAt(frame, 4, 22);
  const underlineDraw = inAt(frame, 20, 40); // 0→1, used as strokeDashoffset progress
  const drift = ambientDrift(frame, fps, 1, theme.ambientDriftPx);

  const underlineLen = width * 0.34;
  const underlineD = roughLine([0, 0], [underlineLen, 0], {
    seed: 7,
    color: theme.accent,
    strokeWidth: 6,
    roughness: theme.roughness,
    bowing: theme.bowing,
  });

  return (
    <AbsoluteFill style={{ backgroundColor: theme.bg }}>
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
            fontFamily: theme.fontDisplay,
            fontSize: height * 0.14,
            fontWeight: 700,
            color: theme.text,
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
            stroke={theme.accent}
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
