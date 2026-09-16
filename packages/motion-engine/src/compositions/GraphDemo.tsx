import React from "react";
import { AbsoluteFill } from "remotion";
import { useTheme } from "../ThemeContext";
import { Graph, Text } from "../primitives";

const nodes = [
  { id: "q", label: "your question" },
  { id: "r", label: "retriever" },
  { id: "d1", label: "doc 1" },
  { id: "d2", label: "doc 2" },
  { id: "d3", label: "doc 3" },
  { id: "llm", label: "LLM" },
  { id: "a", label: "answer" },
];

const edges = [
  { from: "q", to: "r" },
  { from: "r", to: "d1" },
  { from: "r", to: "d2" },
  { from: "r", to: "d3" },
  { from: "d1", to: "llm" },
  { from: "d2", to: "llm" },
  { from: "d3", to: "llm" },
  { from: "llm", to: "a" },
];

// D-339 — the demos read the ACTIVE theme (`useTheme()`), not a module
// constant. Rendered on their own, with no `<ThemeProvider>` above them, that
// is the engine default — i.e. exactly the look they always had — but wrapping
// one in a provider now re-skins it, which is what makes them living
// references for the registry rather than for one hardcoded palette.
export const GraphDemo: React.FC = () => {
  const theme = useTheme();
  return (
  <AbsoluteFill style={{ backgroundColor: theme.bg, fontFamily: theme.fontUi }}>
    <Text preset="fade-up" start={4} size={44} x={960} y={80} align="center">
      Graph · signal propagation
    </Text>
    <Graph
      nodes={nodes}
      edges={edges}
      enter={{ at: 10, stagger: 6 }}
      pulses={[
        { from: "q", to: "r", at: 70 },
        { from: "r", to: "d1", at: 92 },
        { from: "r", to: "d2", at: 92 },
        { from: "r", to: "d3", at: 92 },
        { from: "d1", to: "llm", at: 120 },
        { from: "d2", to: "llm", at: 120 },
        { from: "d3", to: "llm", at: 120 },
        { from: "llm", to: "a", at: 150, color: theme.accent },
      ]}
      highlight={[
        { id: "r", at: 66, dur: 30 },
        { id: "llm", at: 116, dur: 34 },
        { id: "a", at: 150, dur: 40 },
      ]}
      seed={7}
    />
  </AbsoluteFill>
  );
};
