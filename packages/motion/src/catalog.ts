/**
 * @chroma/motion — the primitive catalog (D-151).
 *
 * What it is: the browsable inventory of every primitive the motion engine
 * can actually render, plus the schema-valid default manifest fragment to
 * insert when the user picks one. Pure data + pure functions — no JSX, no
 * React, no component state — so it is testable under `vitest`'s `node`
 * environment, the same split `propCatalog.ts` / `manifestEdit.ts` already
 * use.
 *
 * What it does NOT do: it does not insert anything (that is
 * `manifestEdit.ts`'s `addLayer`), it does not render anything (that is
 * `CatalogPanel.tsx`), and it deliberately holds no *editable* field specs —
 * `propCatalog.ts` already owns "what fields does the Inspector show for this
 * `use`," and duplicating that list here would give the tab two answers to
 * one question. This file answers a different question: "what primitives
 * exist, what is each one for, and what is a sensible starting instance of
 * it."
 *
 * The exhaustiveness guarantee: `CATALOG` is typed `Record<Layer['use'],
 * CatalogEntry>`, and `Layer['use']` comes straight off the engine's own zod
 * enum (`schema.ts` L48–59). Adding a primitive to the schema without adding
 * it here is a `tsc` error, not a silently-missing catalog row — the whole
 * reason the audit's "is anything dead code" check had to be done by hand
 * this time (`docs/notes/motion-tab-audit.md`).
 *
 * Placement (`in3d`) is real, not cosmetic: `particleflow`/`labelbox`/
 * `layerstack` are three.js objects that only mean anything inside a
 * `<Scene3D>` (`registry.ts` L103–112 maps them to components from
 * `Scene3D.tsx`), so they belong in `scene.scene3d.children`, never in
 * `scene.layers`. The 2D five go the other way. `addLayer` enforces this.
 */
import type { Layer } from '@chroma/motion-engine/src/engine/schema';

/** the `use` string of a primitive — the engine's own enum, not a re-declaration */
export type PrimitiveUse = Layer['use'];

export interface CatalogEntry {
  /** the manifest `use:` value this entry inserts */
  use: PrimitiveUse;
  /** short display name for the panel row */
  name: string;
  /** one honest line on what it is actually for — transcribed from each
   *  primitive's own header comment, not invented */
  description: string;
  /** true ⇒ a three.js child that must live under `scene.scene3d.children`;
   *  false ⇒ a 2D layer under `scene.layers` */
  in3d: boolean;
}

/**
 * Every primitive, in the order the panel lists them: the 2D five first
 * (what a talking-head explainer overlay reaches for most), then the three
 * 3D children. Descriptions come from each primitive's own doc header —
 * `Text.tsx` L1–11, `Emphasis.tsx` L1–11, `Matrix.tsx` L1–11, `Graph.tsx`
 * L1–18, `Layers.tsx` L1–9, `ParticleFlow.tsx` L1–15, `Scene3D.tsx` L146,
 * L176.
 */
const CATALOG: Record<PrimitiveUse, CatalogEntry> = {
  text: {
    use: 'text',
    name: 'Text',
    description: 'A headline or callout in the house hand-lettered look. Reveals with fade-up, mask-up, typewriter, or stroke-on.',
    in3d: false,
  },
  emphasis: {
    use: 'emphasis',
    name: 'Emphasis',
    description: 'Draws the eye to a region — a hand-drawn scribble ellipse, an expanding ring ping, a pulse or a glow.',
    in3d: false,
  },
  matrix: {
    use: 'matrix',
    name: 'Matrix',
    description: 'A grid of cells with frame-driven fills. Weight matrices, attention maps, embeddings, a KV cache, a heat grid.',
    in3d: false,
  },
  graph: {
    use: 'graph',
    name: 'Graph',
    description: 'Nodes, edges and travelling signal pulses. Neural nets, knowledge graphs, agent memory, RAG, attention.',
    in3d: false,
  },
  layers: {
    use: 'layers',
    name: 'Layer stack (2.5D)',
    description: 'A tilted stack of labelled cards. Model architecture, a caching stack, a request lifecycle, pipeline stages.',
    in3d: false,
  },
  particleflow: {
    use: 'particleflow',
    name: 'Particle flow',
    description: 'A GPU point cloud streaming, converging or dispersing. Tokens flowing, memory being written, assemble/dissolve.',
    in3d: true,
  },
  labelbox: {
    use: 'labelbox',
    name: 'Label box',
    description: 'The workhorse 3D block — a rounded box with an optional emissive glow, for naming a thing in a 3D scene.',
    in3d: true,
  },
  layerstack: {
    use: 'layerstack',
    name: 'Layer stack (3D)',
    description: 'Real 3D planes stacked in depth, one liftable and glowing. The true-perspective version of the 2.5D card stack.',
    in3d: true,
  },
};

/** every catalog entry, in panel display order (object insertion order —
 *  string keys, so this is deterministic per the JS spec, not incidental). */
export const catalogEntries: CatalogEntry[] = Object.values(CATALOG);

export function catalogEntry(use: PrimitiveUse): CatalogEntry {
  return CATALOG[use];
}

/** the default 3D camera used when a primitive needs a `scene3d` container
 *  and the target scene has none. `cam3dKey` requires `pos` and the array
 *  requires `.min(1)` (`schema.ts` L75–78), so an empty container would not
 *  validate — this is the minimum real camera, matching `sample.ts`'s own. */
export const DEFAULT_SCENE3D_CAMERA = (): { at: number; pos: [number, number, number]; look: [number, number, number] }[] => [
  { at: 0, pos: [0, 0, 12], look: [0, 0, 0] },
];

/**
 * A fresh, schema-valid manifest fragment for one primitive, with defaults
 * chosen so the inserted layer *renders something visible immediately* —
 * the whole point of "get it on our current thing." That is a stronger bar
 * than "passes validation," and it is why several entries carry more than
 * the required minimum:
 *
 * - `matrix` needs `rows`/`cols` (no component default — `Matrix.tsx` L22–23).
 * - `graph` needs `nodes`/`edges` (no component default — `Graph.tsx` L48–49);
 *   an empty graph renders nothing at all, so a real 3-node chain ships.
 * - `layers` needs `items` (no component default — `Layers.tsx` L20).
 * - `emphasis` defaults to the `scribble` preset, which requires an explicit
 *   `box` (`Emphasis.tsx` L10: "ring/scribble need an explicit box").
 *
 * Times are in SECONDS at manifest level (the registry's `f()` converts to
 * frames — `registry.ts` L16). Positions are world px against the
 * manifest's own `width`/`height` for 2D, three.js world units for 3D.
 *
 * Every call builds its literals fresh, so two inserts never share a mutable
 * array/object — a shared `from: [-6,0,0]` between two particleflow layers
 * would make an Inspector edit to one silently change the other.
 */
export function defaultLayerFor(use: PrimitiveUse): Record<string, unknown> {
  switch (use) {
    case 'text':
      return { use: 'text', text: 'New text', preset: 'fade-up', at: 0, x: 180, y: 300, size: 64 };
    case 'emphasis':
      return { use: 'emphasis', preset: 'scribble', at: 0, dur: 2, box: [760, 440, 400, 200] };
    case 'matrix':
      return { use: 'matrix', preset: 'ripple', at: 0, dur: 2, rows: 4, cols: 6 };
    case 'graph':
      return {
        use: 'graph',
        at: 0,
        nodes: [
          { id: 'a', label: 'input' },
          { id: 'b', label: 'model' },
          { id: 'c', label: 'output' },
        ],
        edges: [
          { from: 'a', to: 'b', directed: true },
          { from: 'b', to: 'c', directed: true },
        ],
        enter: { at: 0, stagger: 0.2 },
      };
    case 'layers':
      return { use: 'layers', at: 0, items: ['first', 'second', 'third'] };
    case 'particleflow':
      return { use: 'particleflow', preset: 'stream', from: [-6, 0, 0], to: [6, 0, 0] };
    case 'labelbox':
      return { use: 'labelbox', position: [0, 0, 0], size: [2, 1.2, 0.4], emissiveIntensity: 0.6 };
    case 'layerstack':
      return { use: 'layerstack', count: 5, position: [0, 0, 0] };
  }
}
