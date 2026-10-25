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
 *   nodes     [{ id, label?, x?, y?, icon? }]           — give x/y to pin, else force-laid;
 *                                                          `icon` names a GRAPH_ICONS entry (D-395)
 *   edges     [{ from, to, directed?, weight? }]        — `weight` 0..1, default 1 (D-340)
 *   pulses    [{ from, to, at, dur?, color?, label?, keep?, dy? }]
 *                                                        — a dot travels from→to over dur frames;
 *                                                          `label` rides it, `keep` leaves it at
 *                                                          the destination (offset `dy`) — D-395
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
import {
  ArrowsLeftRight,
  ArrowsSplit,
  Browser,
  Bug,
  Cloud,
  Code,
  Cube,
  Database,
  Desktop,
  Detective,
  DeviceMobile,
  Envelope,
  GlobeHemisphereWest,
  HardDrives,
  Key,
  Laptop,
  Lightning,
  LockSimple,
  Password,
  Plugs,
  Queue,
  Robot,
  ShieldCheck,
  Terminal,
  User,
  Wall,
  type Icon,
} from "@phosphor-icons/react";

/**
 * D-395 — the infrastructure vocabulary a `graph` node can draw as an icon, each one a
 * real Phosphor Icons component (the repo's one icon library — never a hand-drawn
 * path). Keys are the ROLE an explainer names ("reverse-proxy"), not the glyph, so a
 * manifest reads as architecture and the glyph can be swapped here in one place.
 */
export const GRAPH_ICONS = {
  client: Laptop,
  desktop: Desktop,
  phone: DeviceMobile,
  user: User,
  browser: Browser,
  attacker: Detective,
  server: HardDrives,
  database: Database,
  cloud: Cloud,
  cdn: GlobeHemisphereWest,
  gateway: ShieldCheck,
  "reverse-proxy": ArrowsLeftRight,
  "load-balancer": ArrowsSplit,
  firewall: Wall,
  queue: Queue,
  container: Cube,
  api: Plugs,
  cache: Lightning,
  terminal: Terminal,
  code: Code,
  key: Key,
  password: Password,
  lock: LockSimple,
  email: Envelope,
  bot: Robot,
  bug: Bug,
} as const satisfies Record<string, Icon>;

export type GraphIconName = keyof typeof GRAPH_ICONS;

/** B-266 — a graph whose EVERY node carries x/y is laid out by its author: those are
 *  the drawn positions, verbatim. `null` means "not fully pinned — run the force layout". */
export function pinnedPositions(nodes: GraphNode[]): Record<string, { x: number; y: number }> | null {
  if (nodes.length === 0 || !nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))) return null;
  const pos: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) pos[n.id] = { x: n.x as number, y: n.y as number };
  return pos;
}

/** An icon node's tile corner radius, as a fraction of `nodeR`. */
export const GRAPH_ICON_TILE_RADIUS = 0.32;
/** The glyph's size inside its tile, as a fraction of the tile's side (2·nodeR). */
export const GRAPH_ICON_GLYPH_SCALE = 0.58;
/** A pulse label's type size, px, and how far above the travelling dot it rides. */
export const GRAPH_PULSE_LABEL_SIZE = 28;
export const GRAPH_PULSE_LABEL_LIFT = 30;

export type GraphNode = { id: string; label?: string; x?: number; y?: number; icon?: GraphIconName };

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
  /** D-395 — text that rides the dot ("GET /", "password"). */
  label?: string;
  /** D-395 — once the dot arrives, leave `label` at the destination, below its node. */
  keep?: boolean;
  /** D-395 — extra vertical offset for a kept label, px, so several can stack. */
  dy?: number;
};
export type GraphHighlight = { id: string; at: number; dur?: number };

type Sim = SimulationNodeDatum & { id: string; label?: string };

/** The primitive's own pre-B-225 constant — every existing manifest with
 *  comfortable clearance renders identically to before. */
export const GRAPH_LABEL_BASE_FONT_SIZE = 30;

/** B-261 — clear space between a node's ring and the TOP of its label, px.
 *  The label used to sit on a baseline `nodeR + 34`, which at 30 px type left
 *  ~10 px between the ring and the glyphs — and the ring's glow covered that. */
export const GRAPH_LABEL_GAP = 24;
/** Below this, a genuine collision is a content problem (the label is too
 *  long for ANY reasonable spacing, e.g. a full sentence used as a node
 *  name) rather than something a bigger shrink should paper over — so the
 *  floor is a legibility limit, not a promise of zero overlap in every case. */
export const GRAPH_LABEL_MIN_FONT_SIZE = 14;
/** Rough average glyph-width-to-font-size ratio for `theme.fontUi` — real
 *  text metrics vary per character, but this only has to keep two labels
 *  from visibly overlapping, not lay them out to the pixel, so an
 *  approximation is the right amount of precision here. */
const GRAPH_LABEL_CHAR_WIDTH_RATIO = 0.42;
/** Leaves a visible gap between two labels at the computed size rather than
 *  letting them land exactly edge-to-edge, since the ratio above is already
 *  an approximation. */
const GRAPH_LABEL_SAFETY_MARGIN = 0.85;

/**
 * B-225 — the font size a `graph` layer's node labels render at, derived
 * from the ACTUAL on-screen clearance between node centres, not the fixed
 * `GRAPH_LABEL_BASE_FONT_SIZE` this primitive used unconditionally before.
 *
 * D-347's canvas reflow moves node CENTRES (via `propCatalog.ts`'s `graph`
 * `sizeFields`/`positionFields` entries and `manifestReflow.ts`'s own
 * `nodes[].x`/`y` handling) and even scales `nodeR` (`manifestReflow.ts`'s
 * `EXTRA_FIELDS`) — but a node's LABEL FONT SIZE was never a manifest field
 * in either registry, because it was never a manifest field anywhere: this
 * primitive drew every label at the same hardcoded size regardless of node
 * spacing. Shrinking the canvas moves nodes closer together without
 * shrinking their labels, so a comfortable gap can become a collision.
 *
 * Deliberately NOT a new `propCatalog.ts` manifest field (see B-225's own
 * writeup): this is a rendering-time approximation of available space, not
 * a persisted document value, computed fresh from whatever the frozen
 * layout actually produced — so it self-corrects for reflow, a hand-authored
 * tight layout, or anything else that moves nodes, with nothing new to keep
 * in sync.
 *
 * Exported as a pure function so it is directly unit-testable, the same
 * shape `graphEdgeStroke`/`resolvableEdges` above already use — tested in
 * this package's own colocated `Graph.test.ts` (this package gained a real
 * test runner with B-212, after those two were already established in
 * `@apelles/motion`'s `graphEdge.test.ts` via cross-package import; not
 * moved here, out of scope for this fix).
 */
export function graphLabelFontSize(
  nodes: Array<{ label?: string; x: number; y: number }>,
): number {
  let size = GRAPH_LABEL_BASE_FONT_SIZE;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    const la = a.label?.length ?? 0;
    if (la === 0) continue;
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      const lb = b.label?.length ?? 0;
      if (lb === 0) continue;
      const dist = Math.hypot(a.x - b.x, a.y - b.y);
      if (dist <= 0) continue;
      const maxForPair =
        (dist * GRAPH_LABEL_SAFETY_MARGIN) / ((la + lb) * GRAPH_LABEL_CHAR_WIDTH_RATIO);
      size = Math.min(size, maxForPair);
    }
  }
  return Math.max(GRAPH_LABEL_MIN_FONT_SIZE, Math.min(GRAPH_LABEL_BASE_FONT_SIZE, size));
}

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
  /** D-395 — an edge's stroke at full `weight`, px. Default 2.5 (unchanged). */
  edgeWidth?: number;
  /** D-395 — `"soft"` (the theme's hairline ink, the default) or `"ink"` (its dim-text
   *  ink) — the latter reads clearly on a light ground. */
  edgeTone?: "soft" | "ink";
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
  edgeWidth = EDGE_STROKE_FULL,
  edgeTone = "soft",
}) => {
  const frame = useCurrentFrame();
  const { width: cw, height: ch, fps } = useVideoConfig();
  const theme = useTheme();
  const W = width ?? cw;
  const H = height ?? ch;

  // ---- layout: once, frozen ----
  const layout = useMemo(() => {
    // B-266 — every node pinned ⇒ the author has laid the diagram out; draw it exactly
    // there. The force pass and the fit-to-margin rescale below exist for UNPINNED
    // layouts, and used to move pinned nodes too (a pinned x = 960 landed near 1440).
    const pinned = pinnedPositions(nodes);
    if (pinned) {
      const labelFontSize = graphLabelFontSize(nodes.map((n) => ({ label: n.label, ...pinned[n.id] })));
      return { pos: pinned, labelFontSize };
    }
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
    // B-225 — computed from the FROZEN, post-scale positions (the ones
    // actually drawn), not the pre-fit `raw` ones, since it's the on-screen
    // clearance that determines whether two labels collide.
    const labelFontSize = graphLabelFontSize(
      nodes.map((n) => ({ label: n.label, x: pos[n.id].x, y: pos[n.id].y })),
    );
    return { pos, labelFontSize };
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
    const p = layout.pos[id];
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
        const base = graphEdgeStroke(e.weight);
        const strokeWidth = base.strokeWidth * (edgeWidth / EDGE_STROKE_FULL);
        const opacity = base.opacity;
        const edgeInk = edgeTone === "ink" ? theme.textDim : theme.strokeSoft;
        const d = roughLine([a.x, a.y], [b.x, b.y], {
          seed: 100 + i,
          color: edgeInk,
          strokeWidth,
          roughness: theme.roughness,
          bowing: theme.bowing,
        });
        return (
          <path
            key={`e${i}`}
            d={d}
            fill="none"
            stroke={edgeInk}
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
        const a = at(p.from);
        const b = at(p.to);
        if (!a || !b) return null; // B-211 — dangling `from`/`to`, skip this pulse
        const col = p.color ?? theme.accentSignal;
        const labelStyle = {
          fontFamily: theme.fontMono,
          fontSize: GRAPH_PULSE_LABEL_SIZE,
          fill: theme.accent,
          stroke: theme.bg,
          strokeWidth: 8,
          paintOrder: "stroke" as const,
        };
        // D-395 — a kept label settles under the destination node once the dot lands.
        if (t >= 1) {
          if (!p.keep || !p.label) return null;
          const settle = inAt(frame, p.at + dur, p.at + dur + 8);
          return (
            <text
              key={`p${i}`}
              x={b.x}
              y={b.y + nodeR + GRAPH_LABEL_GAP + layout.labelFontSize + 22 + (p.dy ?? 0)}
              textAnchor="middle"
              dominantBaseline="hanging"
              opacity={settle}
              style={labelStyle}
            >
              {p.label}
            </text>
          );
        }
        if (t <= 0) return null;
        const x = a.x + (b.x - a.x) * t;
        const y = a.y + (b.y - a.y) * t;
        return (
          <g key={`p${i}`}>
            <circle cx={x} cy={y} r={13} fill={col} opacity={Math.sin(t * Math.PI)} />
            {p.label && (
              <text x={x} y={y - GRAPH_PULSE_LABEL_LIFT} textAnchor="middle" style={labelStyle}>
                {p.label}
              </text>
            )}
          </g>
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
            {n.icon && GRAPH_ICONS[n.icon] ? (
              <GraphIconTile name={n.icon} nodeR={nodeR} glow={g} />
            ) : (
              <>
                <circle r={nodeR} fill={theme.bgDeep} />
                {/* D-395 — a lit node fills with the theme's primary (accent) colour,
                    fading in with the highlight, rather than only glowing at its rim */}
                {g > 0.02 && <circle r={nodeR} fill={theme.accent} opacity={Math.min(1, g)} />}
                <path d={ring} fill="none" stroke={g > 0.02 ? theme.accent : theme.stroke} strokeWidth={3} />
              </>
            )}
            {n.label && (
              <text
                y={nodeR + GRAPH_LABEL_GAP}
                dominantBaseline="hanging"
                textAnchor="middle"
                fill={theme.textDim}
                fontFamily={theme.fontUi}
                fontSize={layout.labelFontSize}
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

/** D-395 — an icon node: a rounded tile in the theme's panel fill with a real Phosphor
 *  glyph centred in it. Lit, the tile fills with the theme's primary (accent) colour as
 *  the highlight fades in, and the glyph flips to the ground colour so it stays legible. */
const GraphIconTile: React.FC<{ name: GraphIconName; nodeR: number; glow: number }> = ({ name, nodeR, glow }) => {
  const theme = useTheme();
  const Glyph = GRAPH_ICONS[name];
  const side = nodeR * 2;
  const glyph = side * GRAPH_ICON_GLYPH_SCALE;
  const lit = glow > 0.02;
  const r = nodeR * GRAPH_ICON_TILE_RADIUS;
  return (
    <>
      <rect x={-nodeR} y={-nodeR} width={side} height={side} rx={r} fill={theme.bgDeep} />
      {lit && <rect x={-nodeR} y={-nodeR} width={side} height={side} rx={r} fill={theme.accent} opacity={Math.min(1, glow)} />}
      <rect x={-nodeR} y={-nodeR} width={side} height={side} rx={r} fill="none" stroke={lit ? theme.accent : theme.stroke} strokeWidth={3} />
      <Glyph x={-glyph / 2} y={-glyph / 2} size={glyph} color={glow > 0.5 ? theme.bg : theme.stroke} weight="regular" />
    </>
  );
};
