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
 *
 * `'vec'` (D-154) is the other tuple case, and is NOT the same as `'json'`:
 * a fixed-length numeric position/size tuple (`emphasis.box`'s `[x,y,w,h]`,
 * `particleflow.from/to/center`'s `[x,y,z]`, `labelbox`/`layerstack`'s
 * `position`/`size`) renders as one labeled number input per element
 * (`components: ['X','Y','W','H']`, etc.) instead of a raw JSON textarea —
 * these ARE simple transform/layout knobs, just multi-number ones, and the
 * owner asked for exactly this directly: "we should be able to have all
 * this as x: y: h: w: separate."
 */

export type FieldKind = 'number' | 'string' | 'boolean' | 'color' | 'select' | 'json' | 'vec';

export interface FieldSpec {
  /** the exact manifest JSON key this field reads/writes */
  key: string;
  label: string;
  kind: FieldKind;
  /** for `kind: 'select'` */
  options?: string[];
  /** for `kind: 'vec'` — one short label per tuple element, e.g. `['X','Y','W','H']`
   *  for a `[x,y,w,h]` box. Length fixes the tuple's length: a commit always
   *  writes back an array of exactly `components.length` numbers. */
  components?: string[];
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
    // D-154: separate X/Y/W/H number fields, not one raw JSON tuple — this
    // is the exact field the owner pointed at ("i know the highlight is
    // off, i can move it to right place directly... x:y:h:w separate").
    { key: 'box', label: 'Box', kind: 'vec', components: ['X', 'Y', 'W', 'H'], group: 'layout' },
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
    { key: 'from', label: 'From', kind: 'vec', components: ['X', 'Y', 'Z'], group: 'layout' },
    { key: 'to', label: 'To', kind: 'vec', components: ['X', 'Y', 'Z'], group: 'layout' },
    { key: 'shape', label: 'Shape', kind: 'select', options: ['sphere', 'ring', 'grid'], group: 'source' },
    { key: 'shapeSize', label: 'Shape size', kind: 'number', group: 'layout' },
    { key: 'center', label: 'Center', kind: 'vec', components: ['X', 'Y', 'Z'], group: 'layout' },
    { key: 'scatter', label: 'Scatter', kind: 'number', group: 'source' },
    { key: 'color', label: 'Color', kind: 'color', group: 'fill' },
    { key: 'size', label: 'Particle size', kind: 'number', group: 'fill' },
    { key: 'seed', label: 'Seed', kind: 'number', group: 'source' },
  ],
  labelbox: [
    { key: 'position', label: 'Position', kind: 'vec', components: ['X', 'Y', 'Z'], group: 'layout' },
    { key: 'size', label: 'Size', kind: 'vec', components: ['W', 'H', 'D'], group: 'layout' },
    { key: 'color', label: 'Color', kind: 'color', group: 'fill' },
    { key: 'emissive', label: 'Emissive color', kind: 'color', group: 'fill' },
    { key: 'emissiveIntensity', label: 'Emissive intensity', kind: 'number', group: 'fill' },
  ],
  layerstack: [
    { key: 'count', label: 'Count', kind: 'number', group: 'source' },
    { key: 'gap', label: 'Gap', kind: 'number', group: 'layout' },
    { key: 'size', label: 'Size', kind: 'vec', components: ['W', 'H'], group: 'layout' },
    { key: 'position', label: 'Position', kind: 'vec', components: ['X', 'Y', 'Z'], group: 'layout' },
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
 *  the Camera/3D-Camera keyframe-list editor, not the generic field form.
 *  `at` is labelled "(frame)" here even though the manifest stores SECONDS
 *  (B-061, `docs/BUGS.md` — open, NOT fixed by this pass; out of this
 *  phase's own scope, which is B-059 specifically) — left as-is deliberately
 *  rather than smuggling in an unrelated one-word fix under a different
 *  D-number. `ease` (D-159/B-059 — the field is now real and typed in
 *  `schema.ts`, no longer silently stripped by the zod schema) is new: a raw
 *  `[x1,y1,x2,y2]` JSON tuple, the same lighter-touch editor `pos`/`look`
 *  below already use for a fixed-shape-but-not-a-simple-scalar field, rather
 *  than a bespoke 4-handle bezier-curve widget — completing B-059's own
 *  proposed fix ("expose it as a real control in the Inspector's existing
 *  camera keyframe editor"). */
export const CAM2D_KEY_FIELDS: FieldSpec[] = [
  { key: 'at', label: 'At (frame)', kind: 'number', group: 'timing' },
  { key: 'x', label: 'X', kind: 'number', group: 'layout' },
  { key: 'y', label: 'Y', kind: 'number', group: 'layout' },
  { key: 'zoom', label: 'Zoom', kind: 'number', group: 'layout' },
  { key: 'ease', label: 'Ease [x1,y1,x2,y2]', kind: 'json', group: 'timing' },
];

export const CAM3D_KEY_FIELDS: FieldSpec[] = [
  { key: 'at', label: 'At (frame)', kind: 'number', group: 'timing' },
  { key: 'pos', label: 'Position [x,y,z]', kind: 'json', group: 'layout' },
  { key: 'look', label: 'Look at [x,y,z]', kind: 'json', group: 'layout' },
  { key: 'ease', label: 'Ease [x1,y1,x2,y2]', kind: 'json', group: 'timing' },
];

/** Which manifest field(s) a canvas DRAG writes for a primitive's `use:`
 *  (D-155/D-156, Phase 0d/Phase 1 of `docs/notes/motion-visual-builder-
 *  research.md` — that doc names this file as "the natural home for a
 *  `positionFields(use)` map"). Two shapes cover every 2D primitive with a
 *  real, single world-space anchor point:
 *   - `'xy'`     — the primitive's own `x`/`y` fields (`text`, `matrix`,
 *                  `layers` — the same three fields `PRIMITIVE_FIELDS`
 *                  already exposes as separate Inspector X/Y number inputs).
 *   - `'box-xy'` — the first two elements of a `[x,y,w,h]` tuple
 *                  (`emphasis.box` — D-154's own `vec` field, `w`/`h`
 *                  untouched by a position-only drag).
 *  `undefined` means "no draggable anchor": `graph` lays its nodes out with
 *  d3-force and has no single x/y to move (its `width`/`height` are a
 *  layout BOX, not a position); the three `in3d` primitives never appear in
 *  a 2D `renderLayers` pass at all — `data-motion-layer` (`motion-engine`'s
 *  `Video.tsx`) is only ever written for `scene.layers`, never
 *  `scene.scene3d.children` — so a click on the canvas can't select one to
 *  begin with (3D is out of scope for every phase this pass touches, per
 *  the research doc §3b/§4). */
export type PositionKind = 'xy' | 'box-xy';

export function positionFields(use: string): PositionKind | undefined {
  if (use === 'text' || use === 'matrix' || use === 'layers') return 'xy';
  if (use === 'emphasis') return 'box-xy';
  return undefined;
}

/** Which manifest field(s) a canvas RESIZE handle writes for a primitive's
 *  `use:` (D-157, Phase 2 of the research doc — "resize handles for the
 *  primitives that have a real rectangle... per-primitive named fields, not
 *  a generic `scale`"). Four shapes, one per primitive this phase gives
 *  handles to:
 *   - `'wh'`      — two independent fields, `w`/`h` (`layers.cardW`/`cardH`,
 *                   `graph.width`/`height`).
 *   - `'box-wh'`  — the last two elements of `emphasis.box`'s `[x,y,w,h]`
 *                   tuple (`x`/`y`, the first two, untouched by a
 *                   resize-only drag — same split `positionFields`'
 *                   `'box-xy'` already makes the other way).
 *   - `'scalar'`  — a SINGLE field drives both dimensions (`matrix.cell`:
 *                   `w = cols*(cell+gap)-gap`, `h = rows*(cell+gap)-gap`,
 *                   `Matrix.tsx`) — a real, honest 1-degree-of-freedom case,
 *                   not two independent numbers; `manifestEdit.ts`'s
 *                   `setLayerSize` documents how a 2-number resize target
 *                   collapses back onto it.
 *   - `'w-only'`  — `text.maxWidth` (a wrap width; `Text.tsx` has no
 *                   comparable height knob — text height is intrinsic to
 *                   its content and font size, not a stored field).
 *  `undefined` — no resizable field at all (every `in3d` primitive, and any
 *  future/unrecognized `use`). */
export type SizeKind =
  | { kind: 'wh'; w: string; h: string }
  | { kind: 'box-wh' }
  | { kind: 'scalar'; key: string }
  | { kind: 'w-only'; key: string };

export function sizeFields(use: string): SizeKind | undefined {
  if (use === 'layers') return { kind: 'wh', w: 'cardW', h: 'cardH' };
  if (use === 'graph') return { kind: 'wh', w: 'width', h: 'height' };
  if (use === 'emphasis') return { kind: 'box-wh' };
  if (use === 'matrix') return { kind: 'scalar', key: 'cell' };
  if (use === 'text') return { kind: 'w-only', key: 'maxWidth' };
  return undefined;
}

/** D-157, Phase 2's layer-transform wrapper (`schema.ts`'s `layerTransform`,
 *  applied by `motion-engine`'s `Video.tsx`) — a generic field group EVERY
 *  2D layer gets regardless of `use`, the same "shared, not per-primitive"
 *  shape `timingFields` above already is. `InspectorPanel.tsx` renders these
 *  through their OWN small sub-editor (`TransformFieldGroup`), not through
 *  `fieldsForPrimitive`'s flat list, because they read/write a NESTED
 *  `layer.transform.<key>` rather than a top-level layer field — see
 *  `manifestEdit.ts`'s `setLayerTransformField`. */
export const LAYER_TRANSFORM_FIELDS: FieldSpec[] = [
  { key: 'x', label: 'Transform X', kind: 'number', group: 'layout' },
  { key: 'y', label: 'Transform Y', kind: 'number', group: 'layout' },
  { key: 'scale', label: 'Scale', kind: 'number', group: 'layout' },
  { key: 'rot', label: 'Rotation (deg)', kind: 'number', group: 'layout' },
  { key: 'opacity', label: 'Opacity', kind: 'number', group: 'fill' },
  { key: 'clipWidth', label: 'Clip width', kind: 'number', group: 'layout' },
  { key: 'clipHeight', label: 'Clip height', kind: 'number', group: 'layout' },
];

/** D-159, Phase 4's per-layer transform keyframes (`schema.ts`'s
 *  `transformKey`, on `layer.transform.keys`) — one keyframe row's own
 *  fields, the layer-transform counterpart to `CAM2D_KEY_FIELDS` above.
 *  `InspectorPanel.tsx` renders these through the SAME generalized
 *  `KeyframeList` component the camera keyframe editor already uses (add/
 *  remove/edit rows for a small flat shape), not a third bespoke editor —
 *  see that file's own doc comment. Labelled "At (s)" (not "(frame)",
 *  unlike `CAM2D_KEY_FIELDS` — B-061 is a pre-existing, separately-tracked
 *  mislabel on the camera fields this pass deliberately doesn't touch; this
 *  is a NEW field group and gets the correct unit label from the start).
 *  Every numeric field here is a DELTA on top of the static
 *  `LAYER_TRANSFORM_FIELDS` field of the same name (see `schema.ts`'s
 *  `layerTransform` doc comment for the full "why additive, uniformly
 *  across all five fields" reasoning) — labelled "delta" so that relation
 *  is visible in the Inspector, not just in a code comment. */
export const LAYER_TRANSFORM_KEY_FIELDS: FieldSpec[] = [
  { key: 'at', label: 'At (s)', kind: 'number', group: 'timing' },
  { key: 'x', label: 'X delta', kind: 'number', group: 'layout' },
  { key: 'y', label: 'Y delta', kind: 'number', group: 'layout' },
  { key: 'scale', label: 'Scale delta', kind: 'number', group: 'layout' },
  { key: 'rot', label: 'Rotation delta (deg)', kind: 'number', group: 'layout' },
  { key: 'opacity', label: 'Opacity delta', kind: 'number', group: 'fill' },
  { key: 'ease', label: 'Ease [x1,y1,x2,y2]', kind: 'json', group: 'timing' },
];
