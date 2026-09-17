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
 *   nodes     [{ id, label?, x?, y? }]                  — give x/y to pin, else force-laid
 *   edges     [{ from, to, directed?, weight? }]        — `weight` 0..1, default 1 (D-340)
 *   pulses    [{ from, to, at, dur?, color? }]          — a dot travels from→to over dur frames
 *   highlight [{ id, at, dur? }]                        — node glows/rings on its schedule
 *   enter     { at, stagger }                           — node pop-in schedule (edges follow)
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
import { useTheme } from "../ThemeContext";
import { inAt, ambientDrift, pop } from "../lib/draw";
import { mulberry32 } from "../lib/rng";
import { roughEllipse, roughLine } from "../lib/rough";

export type GraphNode = { id: string; label?: string; x?: number; y?: number };

/**
 * D-340 — `weight` is how STRONG this connection is, `0..1`, default `1`.
 *
 * Without it every edge in a mesh renders identically no matter how much the
 * two nodes actually relate, which defeats the point of drawing the mesh (the
 * self-attention case this was added for: a full mesh over the words of a
 * sentence, where the whole message is WHICH pairs matter).
 *
 * It scales BOTH opacity and stroke width, between the floors below and the
 * primitive's own pre-existing full-strength values — not opacity alone
 * (a merely faint line reads as "further away", not "weaker") and not width
 * alone (a hairline at these widths is nearly invisible against the ground).
 *
 * Absent ⇒ `1` ⇒ exactly the stroke this primitive always drew, so every
 * manifest already using `graph` is unaffected.
 */
export type GraphEdge = {
  from: string;
  to: string;
  directed?: boolean;
  /** 0..1, default 1. Clamped. */
  weight?: number;
};

/** The weight-1 stroke width — this primitive's own pre-D-340 constant. */
const EDGE_STROKE_FULL = 2.5;
/**
 * The weight-0 floor, deliberately NOT zero: "these two barely relate" is a
 * fact worth seeing, and an edge that vanishes entirely is indistinguishable
 * from one the author forgot to write.
 */
const EDGE_STROKE_MIN = 0.9;
const EDGE_OPACITY_MIN = 0.12;

/**
 * `weight` → the stroke this edge draws with. Exported as a pure function so
 * the mapping is directly unit-testable (`@apelles/motion`'s `graphEdge.test.ts`
 * — this package has no test runner of its own), the same split
 * `Camera.tsx`'s `cameraDrift` already uses.
 *
 * `undefined` and `1` must return the identical result, and that result must
 * be the primitive's own pre-D-340 stroke — that is the whole no-regression
 * guarantee for every manifest already using `graph`.
 */
export const graphEdgeStroke = (
  weight: number | undefined,
): { strokeWidth: number; opacity: number } => {
  // A `graph` layer is `.passthrough()` in the manifest schema, so `edges` is
  // never validated item by item — a hand-authored `"weight": "0.4"` really
  // does arrive here as a non-number. A non-finite value falls back to the
  // full-strength default rather than propagating `NaN` into an SVG attribute,
  // where it would silently drop the whole stroke.
  const w = Number.isFinite(weight) ? Math.max(0, Math.min(1, weight as number)) : 1;
  return {
    strokeWidth: EDGE_STROKE_MIN + (EDGE_STROKE_FULL - EDGE_STROKE_MIN) * w,
    opacity: EDGE_OPACITY_MIN + (1 - EDGE_OPACITY_MIN) * w,
  };
};

/**
 * The edges d3-force may safely be handed — those whose BOTH endpoints exist
 * in `nodes` (B-211, second root cause).
 *
 * d3-force's `forceLink.initialize` throws outright (`node not found: <id>`,
 * `d3-force/src/link.js`) on a link naming an id the node list does not carry,
 * and it does so inside `Graph`'s layout `useMemo` — i.e. before any of the
 * render-side `at()` null-guards can help. A manifest reaches that state
 * routinely and legitimately mid-edit: writing `nodes` and `edges` is two
 * separate ops, so for one render pass between them the old edges name node ids
 * that no longer exist.
 *
 * Exported as a pure function so the guard is directly unit-testable
 * (`@apelles/motion`'s `graphEdge.test.ts` — this package has no test runner of
 * its own), the same split `graphEdgeStroke` above already uses. The first half
 * of B-211's fix shipped with no test, which is exactly why this second root
 * cause went unnoticed until it wedged the preview again.
 */
export const resolvableEdges = <T extends { from: string; to: string }>(
  nodes: { id: string }[],
  edges: T[],
): T[] => {
  const ids = new Set(nodes.map((n) => n.id));
  return edges.filter((e) => ids.has(e.from) && ids.has(e.to));
};

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
  const theme = useTheme();
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
    // B-211 (second root cause, found 2026-09-17) — d3-force's own
    // `forceLink.initialize` THROWS (`node not found: <id>`, d3-force/src/link.js)
    // on any link naming an id `nodes` does not carry. That throw happens here,
    // inside this memo, BEFORE the render-side `at()` guards below ever run —
    // so guarding those alone (the first half of B-211's fix) did not stop a
    // transient dangling reference from crashing the frame and wedging the
    // Motion tab's still-preview. Hit again live while rebuilding
    // `c040-selfattn`: setting `nodes` to a new id set leaves the previous
    // `edges` dangling for exactly one render pass, which is enough.
    //
    // Dropping the unresolvable links is the right answer rather than
    // substituting a placeholder node: the edge is skipped at draw time anyway
    // (see `edges.map` below), and an invented node would move the real ones by
    // joining the force simulation.
    const links = resolvableEdges(nodes, edges).map((e) => ({
      source: e.from,
      target: e.to,
    }));
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

  // B-211 — `edges`/`pulses` reference node ids by string, and a manifest can
  // (even transiently, mid-edit) name one that `nodes` doesn't carry. Before
  // this fix that threw (`p.x` of `undefined`) and wedged every future still
  // render of the whole Motion tab, not just this layer — so this returns
  // `null` and every caller below skips drawing that one edge/pulse rather
  // than crash the frame. `nodes.map` never hits this branch: it only ever
  // asks `at()` for an id it just took from `nodes` itself.
  const at = (id: string, drift = true) => {
    const p = layout[id];
    if (!p) return null;
    const d = drift
      ? ambientDrift(frame, fps, nodeIndex[id] + 1, theme.ambientDriftPx)
      : { x: 0, y: 0 };
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
        if (!a || !b) return null; // B-211 — dangling `from`/`to`, skip this edge
        const drawStart =
          enter.at +
          Math.max(nodeIndex[e.from], nodeIndex[e.to]) * enter.stagger +
          6;
        const draw = inAt(frame, drawStart, drawStart + 14);
        // D-340 — see `GraphEdge.weight`. `w === 1` (the default) reproduces
        // the exact `2.5` / full-opacity stroke this primitive always drew.
        const { strokeWidth, opacity } = graphEdgeStroke(e.weight);
        const d = roughLine([a.x, a.y], [b.x, b.y], {
          seed: 100 + i,
          color: theme.strokeSoft,
          strokeWidth,
          roughness: theme.roughness,
          bowing: theme.bowing,
        });
        return (
          <path
            key={`e${i}`}
            d={d}
            fill="none"
            stroke={theme.strokeSoft}
            strokeWidth={strokeWidth}
            strokeOpacity={opacity}
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
        if (!a || !b) return null; // B-211 — dangling `from`/`to`, skip this pulse
        const col = p.color ?? theme.accentSignal;
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
        // Always safe — `n.id` came from `nodes`, which is exactly what
        // `layout` was built from above — but `at()`'s return type is now
        // nullable (B-211), so this satisfies that without changing behavior.
        const c = at(n.id) ?? { x: W / 2, y: H / 2 };
        const appear = nodeAppear(n.id);
        const s = pop(frame, fps, enter.at + nodeIndex[n.id] * enter.stagger) * appear;
        const g = glowFor(n.id);
        const ring = roughEllipse(0, 0, nodeR * 2, nodeR * 2, {
          seed: 200 + nodeIndex[n.id],
          color: g > 0.02 ? theme.accentSignal : theme.stroke,
          strokeWidth: 3,
          roughness: theme.roughness,
          bowing: theme.bowing,
        });
        return (
          <g
            key={n.id}
            transform={`translate(${c.x} ${c.y}) scale(${s})`}
            opacity={appear}
            style={{ filter: g > 0.02 ? `drop-shadow(0 0 ${10 + g * 26}px ${theme.accentSignal})` : undefined }}
          >
            <circle r={nodeR} fill={theme.bgDeep} />
            <path d={ring} fill="none" stroke={g > 0.02 ? theme.accentSignal : theme.stroke} strokeWidth={3} />
            {n.label && (
              <text
                y={nodeR + 34}
                textAnchor="middle"
                fill={theme.textDim}
                fontFamily={theme.fontUi}
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
