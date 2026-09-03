/**
 * @chroma/motion — the manifest-level prop catalog (D-099, Phase 2 of
 * `docs/notes/global-inspector.md`).
 *
 * The one-time, mechanical schema-extraction pass the scoping doc called
 * for: what fields the Inspector should render for each selectable thing,
 * transcribed directly from each primitive's own inline prop type
 * (`packages/motion-engine/src/primitives/*.tsx`) and `registry.ts`'s
 * adapter (which tells you the MANIFEST-level field name, not the
 * component's internal prop name — e.g. `text:` not `children`, `at`/`dur`
 * in seconds not frames). This file is the single source of truth for "what
 * does the Inspector show," kept separate from `InspectorPanel.tsx` so the
 * shape catalog is testable without rendering anything.
 *
 * A field's `kind` picks the control `InspectorPanel.tsx` renders. `'json'`
 * is the deliberate lighter-touch fallback for genuinely array/nested-shaped
 * props (`Matrix.values`/`highlight`, `Graph.nodes`/`edges`/`pulses`/
 * `highlight`, `Layers.items`) — a real per-item list editor for these is a
 * reasonable future polish pass, not built this round (see D-099's own
 * writeup for why: these are the primitives' actual *content*, not simple
 * transform/timing knobs, and deserve a purpose-built editor rather than a
 * generic one guessed at speed).
 */

export type FieldKind = 'number' | 'string' | 'boolean' | 'color' | 'select' | 'json';

export interface FieldSpec {
  /** the exact manifest JSON key this field reads/writes */
  key: string;
  label: string;
  kind: FieldKind;
  /** for `kind: 'select'` */
  options?: string[];
  /** grouping, purely cosmetic — mirrors the rejected Editor Starter's
   *  section shape as a *reference* per the scoping doc, not copied */
  group: 'source' | 'layout' | 'fill' | 'timing' | 'content';
}

/** every layer (any `use:`) gets these — generic adapter's `at`/`dur`/`active` */
const timingFields: FieldSpec[] = [
  { key: 'at', label: 'Start (s)', kind: 'number', group: 'timing' },
  { key: 'dur', label: 'Duration (s)', kind: 'number', group: 'timing' },
  { key: 'active', label: 'Active (index or schedule)', kind: 'json', group: 'timing' },
];

/** primitive `use:` → its own manifest-level fields (NOT including the
 *  shared timing fields above, added separately so every catalog entry
 *  doesn't repeat them). Verified against each primitive's source + the
 *  registry adapter, 2026-09-04. */
const PRIMITIVE_FIELDS: Record<string, FieldSpec[]> = {
  text: [
    { key: 'text', label: 'Text', kind: 'string', group: 'content' },
    { key: 'preset', label: 'Preset', kind: 'select', options: ['fade-up', 'mask-up', 'type', 'stroke-on'], group: 'source' },
    { key: 'size', label: 'Size', kind: 'number', group: 'fill' },
    { key: 'color', label: 'Color', kind: 'color', group: 'fill' },
    { key: 'weight', label: 'Weight', kind: 'number', group: 'fill' },
    { key: 'font', label: 'Font', kind: 'string', group: 'fill' },
    { key: 'align', label: 'Align', kind: 'select', options: ['left', 'center', 'right'], group: 'layout' },
    { key: 'letterSpacing', label: 'Letter spacing', kind: 'string', group: 'fill' },
    { key: 'x', label: 'X', kind: 'number', group: 'layout' },
    { key: 'y', label: 'Y', kind: 'number', group: 'layout' },
    { key: 'maxWidth', label: 'Max width', kind: 'number', group: 'layout' },
    { key: 'caret', label: 'Caret', kind: 'boolean', group: 'source' },
  ],
  emphasis: [
    { key: 'preset', label: 'Preset', kind: 'select', options: ['pulse', 'glow', 'ring', 'scribble'], group: 'source' },
    { key: 'color', label: 'Color', kind: 'color', group: 'fill' },
    // manifest tuple [x,y,w,h] — registry.ts's own adapter unpacks it into
    // {x,y,w,h} for the component, but the manifest itself stores the tuple.
    { key: 'box', label: 'Box [x,y,w,h]', kind: 'json', group: 'layout' },
    { key: 'seed', label: 'Seed', kind: 'number', group: 'source' },
  ],
  matrix: [
    { key: 'rows', label: 'Rows', kind: 'number', group: 'source' },
    { key: 'cols', label: 'Cols', kind: 'number', group: 'source' },
    { key: 'cell', label: 'Cell size', kind: 'number', group: 'layout' },
    { key: 'gap', label: 'Gap', kind: 'number', group: 'layout' },
    { key: 'preset', label: 'Preset', kind: 'select', options: ['heatmap', 'ripple', 'fill-in', 'highlight'], group: 'source' },
    { key: 'values', label: 'Values', kind: 'json', group: 'content' },
    { key: 'highlight', label: 'Highlight', kind: 'json', group: 'content' },
    { key: 'fillDir', label: 'Fill direction', kind: 'select', options: ['row', 'col'], group: 'source' },
    { key: 'accent', label: 'Accent color', kind: 'color', group: 'fill' },
    { key: 'x', label: 'X', kind: 'number', group: 'layout' },
    { key: 'y', label: 'Y', kind: 'number', group: 'layout' },
  ],
  graph: [
    { key: 'nodes', label: 'Nodes', kind: 'json', group: 'content' },
    { key: 'edges', label: 'Edges', kind: 'json', group: 'content' },
    { key: 'pulses', label: 'Pulses', kind: 'json', group: 'content' },
    { key: 'highlight', label: 'Highlight', kind: 'json', group: 'content' },
    { key: 'enter', label: 'Enter schedule', kind: 'json', group: 'timing' },
    { key: 'nodeR', label: 'Node radius', kind: 'number', group: 'layout' },
    { key: 'seed', label: 'Seed', kind: 'number', group: 'source' },
    { key: 'width', label: 'Layout width', kind: 'number', group: 'layout' },
    { key: 'height', label: 'Layout height', kind: 'number', group: 'layout' },
  ],
  layers: [
    { key: 'items', label: 'Items', kind: 'json', group: 'content' },
    { key: 'stagger', label: 'Stagger', kind: 'number', group: 'timing' },
    { key: 'active', label: 'Active index', kind: 'number', group: 'source' },
    { key: 'callout', label: 'Callout', kind: 'string', group: 'content' },
    { key: 'x', label: 'X', kind: 'number', group: 'layout' },
    { key: 'y', label: 'Y', kind: 'number', group: 'layout' },
    { key: 'cardW', label: 'Card width', kind: 'number', group: 'layout' },
    { key: 'cardH', label: 'Card height', kind: 'number', group: 'layout' },
    { key: 'gap', label: 'Gap', kind: 'number', group: 'layout' },
    { key: 'tilt', label: 'Tilt', kind: 'number', group: 'layout' },
  ],
  particleflow: [
    { key: 'preset', label: 'Preset', kind: 'select', options: ['stream', 'converge', 'disperse'], group: 'source' },
    { key: 'count', label: 'Count', kind: 'number', group: 'source' },
    { key: 'from', label: 'From [x,y,z]', kind: 'json', group: 'layout' },
    { key: 'to', label: 'To [x,y,z]', kind: 'json', group: 'layout' },
    { key: 'shape', label: 'Shape', kind: 'select', options: ['sphere', 'ring', 'grid'], group: 'source' },
    { key: 'shapeSize', label: 'Shape size', kind: 'number', group: 'layout' },
    { key: 'center', label: 'Center [x,y,z]', kind: 'json', group: 'layout' },
    { key: 'scatter', label: 'Scatter', kind: 'number', group: 'source' },
    { key: 'color', label: 'Color', kind: 'color', group: 'fill' },
    { key: 'size', label: 'Particle size', kind: 'number', group: 'fill' },
    { key: 'seed', label: 'Seed', kind: 'number', group: 'source' },
  ],
  labelbox: [
    { key: 'position', label: 'Position [x,y,z]', kind: 'json', group: 'layout' },
    { key: 'size', label: 'Size [w,h,d]', kind: 'json', group: 'layout' },
    { key: 'color', label: 'Color', kind: 'color', group: 'fill' },
    { key: 'emissive', label: 'Emissive color', kind: 'color', group: 'fill' },
    { key: 'emissiveIntensity', label: 'Emissive intensity', kind: 'number', group: 'fill' },
  ],
  layerstack: [
    { key: 'count', label: 'Count', kind: 'number', group: 'source' },
    { key: 'gap', label: 'Gap', kind: 'number', group: 'layout' },
    { key: 'size', label: 'Size [w,h]', kind: 'json', group: 'layout' },
    { key: 'position', label: 'Position [x,y,z]', kind: 'json', group: 'layout' },
    { key: 'active', label: 'Active index', kind: 'number', group: 'source' },
    { key: 'lift', label: 'Lift', kind: 'number', group: 'layout' },
  ],
};

/** returns the fields to render for a layer's `use:` value, timing fields
 *  first (every layer has them) then the primitive's own. `undefined` for
 *  an unrecognized `use` (a manifest written by a future primitive this
 *  Inspector build doesn't know about yet) — callers must degrade
 *  gracefully, not throw, per the backward-compat requirement. */
export function fieldsForPrimitive(use: string): FieldSpec[] | undefined {
  const own = PRIMITIVE_FIELDS[use];
  if (!own) return undefined;
  return [...timingFields, ...own];
}

/** scene-level fields (selection target `{kind:'scene'}`) — NOT `id`
 *  (used as the scene's identity/React key and by anything that
 *  cross-references it by id; editable but out of scope for a first pass —
 *  a rename here needs to be a deliberate, separate operation, not a
 *  side effect of a generic field editor). */
export const SCENE_FIELDS: FieldSpec[] = [
  { key: 'dur', label: 'Duration (s)', kind: 'number', group: 'timing' },
  { key: 'bg', label: 'Background', kind: 'color', group: 'fill' },
  { key: 'grain', label: 'Grain', kind: 'boolean', group: 'fill' },
  { key: 'vignette', label: 'Vignette', kind: 'json', group: 'fill' },
  { key: 'transition', label: 'Transition in (s)', kind: 'number', group: 'timing' },
];

/** a 2D camera keyframe's own fields (`cam2dKey` in `schema.ts`) — used by
 *  the Camera/3D-Camera keyframe-list editor, not the generic field form. */
export const CAM2D_KEY_FIELDS: FieldSpec[] = [
  { key: 'at', label: 'At (frame)', kind: 'number', group: 'timing' },
  { key: 'x', label: 'X', kind: 'number', group: 'layout' },
  { key: 'y', label: 'Y', kind: 'number', group: 'layout' },
  { key: 'zoom', label: 'Zoom', kind: 'number', group: 'layout' },
];

export const CAM3D_KEY_FIELDS: FieldSpec[] = [
  { key: 'at', label: 'At (frame)', kind: 'number', group: 'timing' },
  { key: 'pos', label: 'Position [x,y,z]', kind: 'json', group: 'layout' },
  { key: 'look', label: 'Look at [x,y,z]', kind: 'json', group: 'layout' },
];
