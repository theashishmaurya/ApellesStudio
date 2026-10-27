/**
 * Per-primitive prop schemas — what each `use` accepts at MANIFEST level
 * (D-403, Phase 0 of `docs/notes/motion-authoring-mcp.md`).
 *
 * What it is: one zod shape per primitive, transcribed from each primitive's
 * own prop type (`../primitives/*.tsx`) through `registry.ts`'s adapter, which
 * is what turns the manifest's names into the component's (`text:` becomes
 * `children`, `at`/`dur` seconds become frames). `schema.ts` joins these with
 * the fields every layer carries (`id`, `at`, `dur`, `active`, `transform`)
 * into the layer schema: a discriminated union on `use`, replacing the
 * `.passthrough()` object that validated nothing (a wrong prop used to render
 * silently or throw mid-render).
 *
 * Every object here is a LOOSE object, on purpose. The manifest's parse
 * output is what the app commits and saves (`@apelles/motion`'s
 * `useMotionManifest`), and a strict or stripping object would refuse or
 * silently delete a key some existing project file carries. Unknown keys are
 * instead reported by `validate.ts`'s unknown-key pass, which every AUTHORING
 * path (`motion_validate`, `motion_insert_layers`, `motion_set_scene`,
 * `motion_add_layer` with props) runs and refuses on. Types of KNOWN keys are
 * enforced everywhere, loading included.
 *
 * Required props are the ones the component has no default for and cannot
 * render without (`text.text`, `matrix.rows/cols`, `graph.nodes/edges`,
 * `layers.items`, `plot.values`, `particleflow.preset`) — the same list
 * `@apelles/motion`'s `catalog.ts` `defaultLayerFor` already had to satisfy.
 *
 * What it does NOT do: render anything, or know the Inspector's labels and
 * controls (`@apelles/motion`'s `propCatalog.ts`, which is tested against these
 * shapes so the two cannot drift).
 */
import { z } from "zod";
import { colorSchema, seconds, vec2, vec3, vec4 } from "./schemaAtoms";

/** D-395's graph-node icon vocabulary, by ROLE. `Graph.tsx`'s `GRAPH_ICONS`
 *  map is typed against this list, so a name here without a glyph there (or
 *  the reverse) is a `tsc` error. */
export const GRAPH_ICON_NAMES = [
  "client",
  "desktop",
  "phone",
  "user",
  "browser",
  "attacker",
  "server",
  "database",
  "cloud",
  "cdn",
  "gateway",
  "reverse-proxy",
  "load-balancer",
  "firewall",
  "queue",
  "container",
  "api",
  "cache",
  "terminal",
  "code",
  "key",
  "password",
  "lock",
  "email",
  "bot",
  "bug",
] as const;
export type GraphIconName = (typeof GRAPH_ICON_NAMES)[number];

export const DEVICE_MODELS = ["iphone-15-pro", "iphone-15-pro-max", "iphone-se", "pixel-8", "generic"] as const;
export const NOTCH_STYLES = ["dynamic-island", "notch", "punch-hole", "none"] as const;
export const CHAT_TOOL_ICONS = ["drive", "search", "web", "code", "doc", "none"] as const;

const o = z.looseObject;
const num = () => z.number().optional();
const str = () => z.string().optional();
const bool = () => z.boolean().optional();
const color = () => colorSchema().optional();

const chatMessage = o({
  kind: z.enum(["text", "tool", "task", "doc"]).optional(),
  from: z.enum(["user", "assistant"]).optional(),
  text: str(),
  sender: str(),
  label: str(),
  title: str(),
  subtitle: str(),
  meta: str(),
  icon: z.enum(CHAT_TOOL_ICONS).optional(),
  at: seconds().optional(),
});

/**
 * `use` → its manifest-level props (NOT the shared layer fields). Insertion
 * order is the catalogue's display order; the 3D children come last.
 */
export const PRIMITIVE_PROPS = {
  text: {
    text: z.string(),
    preset: z.enum(["fade-up", "mask-up", "type", "stroke-on"]).optional(),
    size: num(),
    color: color(),
    weight: num(),
    font: str(),
    align: z.enum(["left", "center", "right"]).optional(),
    /** CSS letter-spacing; a bare number is px, as CSS reads it. */
    letterSpacing: z.union([z.string(), z.number()]).optional(),
    x: num(),
    y: num(),
    maxWidth: num(),
    caret: bool(),
  },
  emphasis: {
    preset: z.enum(["pulse", "glow", "ring", "scribble"]).optional(),
    color: color(),
    /** `[x, y, w, h]` in world px; ring/scribble/pulse draw nothing without it. */
    box: vec4.optional(),
    seed: num(),
  },
  matrix: {
    rows: z.number().int().positive(),
    cols: z.number().int().positive(),
    cell: num(),
    gap: num(),
    preset: z.enum(["heatmap", "ripple", "fill-in", "highlight"]).optional(),
    values: z.array(z.array(z.number())).optional(),
    highlight: z.array(o({ r: z.number(), c: z.number(), at: seconds(), dur: seconds().optional() })).optional(),
    fillDir: z.enum(["row", "col"]).optional(),
    accent: color(),
    x: num(),
    y: num(),
  },
  graph: {
    nodes: z.array(
      o({ id: z.string(), label: str(), x: num(), y: num(), icon: z.enum(GRAPH_ICON_NAMES).optional() }),
    ),
    edges: z.array(o({ from: z.string(), to: z.string(), directed: bool(), weight: num() })),
    pulses: z
      .array(
        o({
          from: z.string(),
          to: z.string(),
          at: seconds(),
          dur: seconds().optional(),
          color: color(),
          label: str(),
          keep: bool(),
          dy: num(),
        }),
      )
      .optional(),
    highlight: z.array(o({ id: z.string(), at: seconds(), dur: seconds().optional() })).optional(),
    enter: o({ at: seconds().optional(), stagger: seconds().optional() }).optional(),
    nodeR: num(),
    seed: num(),
    width: num(),
    height: num(),
    edgeWidth: num(),
    edgeTone: z.enum(["soft", "ink"]).optional(),
  },
  layers: {
    items: z.array(z.union([z.string(), o({ label: z.string(), sublabel: str(), dx: num(), dy: num() })])),
    stagger: num(),
    callout: str(),
    x: num(),
    y: num(),
    cardW: num(),
    cardH: num(),
    gap: num(),
    tilt: num(),
  },
  deviceframe: {
    model: z.enum(DEVICE_MODELS).optional(),
    x: num(),
    y: num(),
    scale: num(),
    bodyColor: color(),
    rimColor: color(),
    screenColor: color(),
    notch: z.enum(NOTCH_STYLES).optional(),
    notchColor: color(),
    homeIndicator: bool(),
    shadow: num(),
    buttons: bool(),
  },
  claudechat: {
    conversations: z
      .array(o({ model: str(), title: str(), welcome: str(), messages: z.array(chatMessage) }))
      .optional(),
    messages: z.array(chatMessage).optional(),
    title: str(),
    model: str(),
    welcome: str(),
    placeholder: str(),
    reveal: z.enum(["fade", "slide", "pop", "type"]).optional(),
    stagger: seconds().optional(),
    revealDur: seconds().optional(),
    switchDur: seconds().optional(),
    typing: bool(),
    typingDur: seconds().optional(),
    x: num(),
    y: num(),
    width: num(),
    height: num(),
    radius: num(),
    header: bool(),
    statusBar: bool(),
    inputBar: bool(),
    researchActive: bool(),
    bg: color(),
    ink: color(),
    muted: color(),
    accent: color(),
    bubbleBg: color(),
    cardBg: color(),
    border: color(),
    inputBg: color(),
    fontSerif: str(),
    fontSans: str(),
  },
  plot: {
    values: z.array(z.number()),
    xLabels: z.array(z.string()).optional(),
    title: str(),
    xTitle: str(),
    yTitle: str(),
    yMin: num(),
    yMax: num(),
    baseline: num(),
    baselineLabel: str(),
    annotate: z.array(o({ i: z.number(), text: z.string(), dy: num() })).optional(),
    markers: bool(),
    color: color(),
    baselineColor: color(),
    seed: num(),
    x: num(),
    y: num(),
    width: num(),
    height: num(),
  },
  particleflow: {
    preset: z.enum(["stream", "converge", "disperse"]),
    count: num(),
    from: vec3.optional(),
    to: vec3.optional(),
    shape: z.enum(["sphere", "ring", "grid"]).optional(),
    shapeSize: num(),
    center: vec3.optional(),
    scatter: num(),
    color: color(),
    size: num(),
    seed: num(),
  },
  labelbox: {
    position: vec3.optional(),
    size: vec3.optional(),
    color: color(),
    emissive: color(),
    emissiveIntensity: num(),
  },
  layerstack: {
    count: num(),
    gap: num(),
    size: vec2.optional(),
    position: vec3.optional(),
    lift: num(),
  },
} as const;

export type PrimitiveUse = keyof typeof PRIMITIVE_PROPS;

/** every primitive's `use`, in catalogue order. */
export const PRIMITIVE_USES = Object.keys(PRIMITIVE_PROPS) as PrimitiveUse[];
