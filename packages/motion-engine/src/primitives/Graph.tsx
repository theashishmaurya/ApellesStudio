/**
 * Graph — nodes + edges + signal propagation.
 * Neural nets, knowledge graphs, agent memory, ontology, RAG, attention.
 *
 * 2D SVG (hand-drawn via roughjs), fully deterministic:
 *  - layout runs ONCE (d3-force, seeded) then freezes — no per-frame jitter
 *  - `useCurrentFrame()` drives node entrances, edge draw-on, travelling pulses,
 *    and node activation glow — all on schedules from props
 *
 * A 3D version belongs in Scene3D later; this covers the flat-diagram case.
 *
 * Props:
 *   nodes     [{ id, label?, x?, y? }]         — give x/y to pin, else force-laid
 *   edges     [{ from, to, directed? }]
 *   pulses    [{ from, to, at, dur?, color? }] — a dot travels from→to over dur frames
 *   highlight [{ id, at, dur? }]               — node glows/rings on its schedule
 *   enter     { at, stagger }                  — node pop-in schedule (edges follow)
 */
import React, { useMemo } from "react";
import { useCurrentFrame, useVideoConfig } from "remotion";
import {
  forceSimulation,
  forceLink,
  forceManyBody,
  forceCenter,
  forceCollide,
  type SimulationNodeDatum,
} from "d3-force";
import { design } from "../design";
import { inAt, ambientDrift, pop } from "../lib/draw";
import { mulberry32 } from "../lib/rng";
import { roughEllipse, roughLine } from "../lib/rough";

export type GraphNode = { id: string; label?: string; x?: number; y?: number };
export type GraphEdge = { from: string; to: string; directed?: boolean };
export type GraphPulse = {
  from: string;
  to: string;
  at: number;
  dur?: number;
  color?: string;
};
export type GraphHighlight = { id: string; at: number; dur?: number };

type Sim = SimulationNodeDatum & { id: string; label?: string };

export const Graph: React.FC<{
  nodes: GraphNode[];
  edges: GraphEdge[];
  pulses?: GraphPulse[];
  highlight?: GraphHighlight[];
  enter?: { at: number; stagger: number };
  nodeR?: number;
  seed?: number;
  /** layout box; defaults to the canvas */
  width?: number;
  height?: number;
}> = ({
  nodes,
  edges,
  pulses = [],
  highlight = [],
  enter = { at: 0, stagger: 4 },
  nodeR = 46,
  seed = 1,
  width,
  height,
}) => {
  const frame = useCurrentFrame();
  const { width: cw, height: ch, fps } = useVideoConfig();
  const W = width ?? cw;
  const H = height ?? ch;

  // ---- layout: once, frozen ----
  const layout = useMemo(() => {
    const sim: Sim[] = nodes.map((n) => ({
      id: n.id,
      label: n.label,
      ...(n.x !== undefined ? { fx: n.x } : {}),
      ...(n.y !== undefined ? { fy: n.y } : {}),
    }));
    const links = edges.map((e) => ({ source: e.from, target: e.to }));
    const s = forceSimulation(sim)
      .randomSource(mulberry32(seed))
      .force("charge", forceManyBody().strength(-2600))
      .force(
        "link",
        forceLink(links)
          .id((d: SimulationNodeDatum & { id?: string }) => d.id as string)
          .distance(260)
          .strength(0.5),
      )
      .force("center", forceCenter(W / 2, H / 2))
      .force("collide", forceCollide(nodeR * 2.2))
      .stop();
    for (let i = 0; i < 320; i++) s.tick();

    // fit the frozen layout into a margin box (uniform scale, centred) so it
    // fills the frame regardless of the force constants
    const raw = sim.map((n) => ({ id: n.id, x: n.x ?? W / 2, y: n.y ?? H / 2 }));
    const minX = Math.min(...raw.map((r) => r.x));
    const maxX = Math.max(...raw.map((r) => r.x));
    const minY = Math.min(...raw.map((r) => r.y));
    const maxY = Math.max(...raw.map((r) => r.y));
    const mL = 220, mR = 220, mT = 275, mB = 190;
    const spanX = maxX - minX || 1;
    const spanY = maxY - minY || 1;
    const scale = Math.min((W - mL - mR) / spanX, (H - mT - mB) / spanY, 1.6);
    const cxLayout = (minX + maxX) / 2;
    const cyLayout = (minY + maxY) / 2;
    const pos: Record<string, { x: number; y: number }> = {};
    for (const r of raw) {
      pos[r.id] = {
        x: W / 2 + (r.x - cxLayout) * scale,
        y: (mT + (H - mB)) / 2 + (r.y - cyLayout) * scale,
      };
    }
    return pos;
  }, [nodes, edges, seed, W, H, nodeR]);

  const nodeIndex: Record<string, number> = {};
  nodes.forEach((n, i) => (nodeIndex[n.id] = i));

  const at = (id: string, drift = true) => {
    const p = layout[id];
    const d = drift ? ambientDrift(frame, fps, nodeIndex[id] + 1) : { x: 0, y: 0 };
    return { x: p.x + d.x, y: p.y + d.y };
  };

  const nodeAppear = (id: string) =>
    inAt(
      frame,
      enter.at + nodeIndex[id] * enter.stagger,
      enter.at + nodeIndex[id] * enter.stagger + 12,
    );

  const glowFor = (id: string) => {
    let g = 0;
    for (const h of highlight) {
      if (h.id !== id) continue;
      const d = h.dur ?? 24;
      g = Math.max(
        g,
        Math.min(inAt(frame, h.at, h.at + d * 0.3), 1 - inAt(frame, h.at + d * 0.7, h.at + d)),
      );
    }
    return g;
  };

  return (
    <svg
      style={{ position: "absolute", inset: 0, overflow: "visible" }}
      width={W}
      height={H}
    >
      {/* edges */}
      {edges.map((e, i) => {
        const a = at(e.from);
        const b = at(e.to);
        const drawStart =
          enter.at +
          Math.max(nodeIndex[e.from], nodeIndex[e.to]) * enter.stagger +
          6;
        const draw = inAt(frame, drawStart, drawStart + 14);
        const d = roughLine([a.x, a.y], [b.x, b.y], {
          seed: 100 + i,
          color: design.strokeSoft,
          strokeWidth: 2.5,
        });
        return (
          <path
            key={`e${i}`}
            d={d}
            fill="none"
            stroke={design.strokeSoft}
            strokeWidth={2.5}
            strokeLinecap="round"
            pathLength={1}
            strokeDasharray={1}
            strokeDashoffset={1 - draw}
          />
        );
      })}

      {/* pulses */}
      {pulses.map((p, i) => {
        const dur = p.dur ?? 20;
        const t = inAt(frame, p.at, p.at + dur);
        if (t <= 0 || t >= 1) return null;
        const a = at(p.from);
        const b = at(p.to);
        const col = p.color ?? design.accentBlue;
        return (
          <circle
            key={`p${i}`}
            cx={a.x + (b.x - a.x) * t}
            cy={a.y + (b.y - a.y) * t}
            r={13}
            fill={col}
            opacity={Math.sin(t * Math.PI)}
            style={{ filter: `drop-shadow(0 0 12px ${col})` }}
          />
        );
      })}

      {/* nodes */}
      {nodes.map((n) => {
        const c = at(n.id);
        const appear = nodeAppear(n.id);
        const s = pop(frame, fps, enter.at + nodeIndex[n.id] * enter.stagger) * appear;
        const g = glowFor(n.id);
        const ring = roughEllipse(0, 0, nodeR * 2, nodeR * 2, {
          seed: 200 + nodeIndex[n.id],
          color: g > 0.02 ? design.accentBlue : design.stroke,
          strokeWidth: 3,
        });
        return (
          <g
            key={n.id}
            transform={`translate(${c.x} ${c.y}) scale(${s})`}
            opacity={appear}
            style={{ filter: g > 0.02 ? `drop-shadow(0 0 ${10 + g * 26}px ${design.accentBlue})` : undefined }}
          >
            <circle r={nodeR} fill={design.bgDeep} />
            <path d={ring} fill="none" stroke={g > 0.02 ? design.accentBlue : design.stroke} strokeWidth={3} />
            {n.label && (
              <text
                y={nodeR + 34}
                textAnchor="middle"
                fill={design.textDim}
                fontFamily={design.fontHand}
                fontSize={30}
              >
                {n.label}
              </text>
            )}
          </g>
        );
      })}
    </svg>
  );
};
