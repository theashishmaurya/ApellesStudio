/**
 * @apelles/motion — certified custom components as catalog data (D-409): the
 * pure half shared by the MCP ops and the GUI.
 *
 * What it is: functions over the component library and the manifest.
 *  - The library: `sanitizeComponentLibrary` checks what came off disk entry by
 *    entry (a bad entry drops itself with a named error), `listComponents`,
 *    `findComponent`, `latestCertified`.
 *  - The catalog: `parseCustomUse` reads `"custom:<id>"` / `"custom:<id>@<v>"`,
 *    `componentRefFrom` builds the definition a manifest embeds,
 *    `embedComponents` puts definitions into a manifest (copy semantics: the
 *    document renders without the library), `addCustomLayer` places one,
 *    `referencedComponents` / `missingComponents` find what a fragment needs.
 *  - Certification: `proofPlan` turns a definition into the proof manifest —
 *    one scene per variant (declared defaults, the low edge of every
 *    constraint, the high edge) — and the frames to sample.
 *  - The live player: `proxyManifest` turns one custom layer into a one-layer,
 *    transparent manifest the renderer process renders to frames.
 *
 * What it does NOT do: I/O (`customComponentLibraryIO.ts`), run or check code
 * (the backend and `@apelles/motion-engine`'s `custom/`), or commit anything.
 */
import {
  componentMetaSchema,
  componentRefKey,
  componentSpecIssues,
  parseComponentRef,
  type ComponentMeta,
  type ComponentRef,
  type ComponentSpec,
} from '@apelles/motion-engine/src/custom/componentDef';
import { slotsJsonSchema, type TemplateSlot } from '@apelles/motion-engine/src/slots';
import { formatIssues, type ValidationIssue } from '@apelles/motion-engine/src/engine/validate';
import type { Manifest } from '@apelles/motion-engine/src/engine/schema';

/** One version, as the GUI and the ops see it. */
export interface ListedComponent {
  id: string;
  version: number;
  source: 'builtin' | 'library';
  /** the version folder on disk (where `contact.png` is) */
  dir: string;
  meta: ComponentMeta;
}

/** One library folder that could not be used. */
export interface ComponentLoadError {
  path: string;
  error: string;
}

/** What `chroma_motion_load_components` returns. */
export interface RawComponentLibrary {
  entries: { id: string; version: number; source: 'builtin' | 'library'; dir: string; meta: unknown }[];
  errors: ComponentLoadError[];
}

/** Check each entry's `meta.json` against the schema; a bad one becomes a
 *  named error and the rest load. */
export function sanitizeComponentLibrary(raw: RawComponentLibrary): { entries: ListedComponent[]; errors: ComponentLoadError[] } {
  const entries: ListedComponent[] = [];
  const errors: ComponentLoadError[] = [...raw.errors];
  for (const e of raw.entries) {
    const parsed = componentMetaSchema.safeParse(e.meta);
    if (!parsed.success) {
      errors.push({ path: e.dir, error: `meta.json: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}` });
      continue;
    }
    entries.push({ id: e.id, version: e.version, source: e.source, dir: e.dir, meta: parsed.data });
  }
  entries.sort((a, b) => (a.id === b.id ? a.version - b.version : a.id < b.id ? -1 : 1));
  return { entries, errors };
}

export function findComponent(entries: readonly ListedComponent[], id: string, version: number): ListedComponent | undefined {
  return entries.find((e) => e.id === id && e.version === version);
}

/** The newest certified version of `id`, if any. */
export function latestCertified(entries: readonly ListedComponent[], id: string): ListedComponent | undefined {
  return entries.filter((e) => e.id === id && e.meta.status === 'certified').sort((a, b) => b.version - a.version)[0];
}

/** `"custom:burst"` → `{id: "burst"}`; `"custom:burst@2"` → `{id, version: 2}`;
 *  anything else → `null`. */
export function parseCustomUse(use: string): { id: string; version?: number } | null {
  const m = /^custom:([a-z0-9][a-z0-9-]{0,63})(?:@([1-9][0-9]{0,5}))?$/.exec(use);
  if (!m) return null;
  return m[2] ? { id: m[1], version: Number(m[2]) } : { id: m[1] };
}

/** The spec part of a meta (what an author declared). */
export function specOf(meta: ComponentMeta): ComponentSpec {
  return {
    id: meta.id,
    name: meta.name,
    ...(meta.description !== undefined ? { description: meta.description } : {}),
    ...(meta.tags !== undefined ? { tags: meta.tags } : {}),
    props: meta.props,
    size: meta.size,
    duration: meta.duration,
  };
}

/** The definition a manifest embeds, from a certified meta and where its
 *  module and source landed in the project. */
export function componentRefFrom(meta: ComponentMeta, installed: { code: string; source: string }): ComponentRef {
  return {
    ...specOf(meta),
    version: meta.version,
    sourceHash: meta.sourceHash,
    codeHash: meta.codeHash,
    code: installed.code,
    source: installed.source,
  };
}

/** The same definition as the proof renders it: the module is staged under
 *  its own hash, so the ids follow from the hashes. */
export function proofRefFrom(meta: ComponentMeta): ComponentRef {
  return componentRefFrom(meta, { code: `sha256:${meta.codeHash}.js`, source: `sha256:${meta.sourceHash}.tsx` });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Every `component` pin used by a custom layer anywhere in `value` (a layer,
 *  a list of layers, a scene, a manifest), groups followed. */
export function referencedComponents(value: unknown): Set<string> {
  const out = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (!isPlainObject(v)) return;
    if (v.use === 'custom' && typeof v.component === 'string') out.add(v.component);
    for (const [k, child] of Object.entries(v)) if (k !== 'components') walk(child);
  };
  walk(value);
  return out;
}

/** The pins `value` uses that `manifest` does not embed yet. */
export function missingComponents(manifest: Pick<Manifest, 'components'>, value: unknown): string[] {
  const have = manifest.components ?? {};
  return [...referencedComponents(value)].filter((ref) => !(ref in have)).sort();
}

/** `manifest` with `refs` embedded (each under its `<id>@<version>`). */
export function embedComponents(manifest: Manifest, refs: readonly ComponentRef[]): Manifest {
  if (refs.length === 0) return manifest;
  const components = { ...(manifest.components ?? {}) };
  for (const r of refs) components[componentRefKey(r.id, r.version)] = r;
  return { ...manifest, components };
}

/** A layer id not yet used in `manifest`: `<base>`, `<base>-2`, … —
 *  deterministic, like template instantiation's ids (D-407). */
export function freshLayerId(manifest: Manifest, base: string): string {
  const used = new Set<string>();
  const walk = (layers: readonly unknown[] | undefined) => {
    for (const l of layers ?? []) {
      if (!isPlainObject(l)) continue;
      if (typeof l.id === 'string') used.add(l.id);
      if (Array.isArray(l.children)) walk(l.children);
    }
  };
  for (const s of manifest.scenes) {
    walk(s.layers);
    walk(s.scene3d?.children);
  }
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

/** A custom layer for `ref`, centred on the canvas at its own size, with
 *  `props` (only the ones given; the rest are the declared defaults). */
export function customLayerFor(
  ref: ComponentRef,
  canvas: { width: number; height: number },
  id: string,
  props?: Record<string, unknown>,
): Record<string, unknown> {
  return {
    use: 'custom',
    id,
    component: componentRefKey(ref.id, ref.version),
    x: Math.round((canvas.width - ref.size.w) / 2),
    y: Math.round((canvas.height - ref.size.h) / 2),
    w: ref.size.w,
    h: ref.size.h,
    ...(props && Object.keys(props).length > 0 ? { props: structuredClone(props) } : {}),
  };
}

/** `manifest` with `ref` embedded and one layer of it on top of scene
 *  `sceneIndex`; the new layer's id. `null` for a scene that is not there. */
export function addCustomLayer(
  manifest: Manifest,
  sceneIndex: number,
  ref: ComponentRef,
  props?: Record<string, unknown>,
): { manifest: Manifest; layerIndex: number; id: string } | null {
  if (!manifest.scenes[sceneIndex]) return null;
  const id = freshLayerId(manifest, ref.id);
  const layer = customLayerFor(ref, { width: manifest.width, height: manifest.height }, id, props);
  const next = embedComponents(manifest, [ref]);
  const scenes = next.scenes.map((s, i) => (i === sceneIndex ? { ...s, layers: [...(s.layers ?? []), layer as never] } : s));
  return { manifest: { ...next, scenes }, layerIndex: (scenes[sceneIndex].layers?.length ?? 1) - 1, id };
}

/** The definition's props as the JSON Schema of a whole layer of it, for an
 *  agent (`motion_list_primitives`, `motion_list_components`). */
export function customLayerJsonSchema(ref: Pick<ComponentRef, 'id' | 'version' | 'props' | 'size'>): Record<string, unknown> {
  const num = { type: 'number' };
  return {
    type: 'object',
    properties: {
      use: { const: 'custom' },
      component: { const: componentRefKey(ref.id, ref.version) },
      id: { type: 'string' },
      at: { ...num, description: 'start, seconds within the scene' },
      dur: { ...num, description: 'how long it plays, seconds (default: the component\'s duration)' },
      x: { ...num, description: 'box top-left, world px' },
      y: num,
      w: { ...num, default: ref.size.w },
      h: { ...num, default: ref.size.h },
      props: slotsJsonSchema(ref.props),
      anim: {
        type: 'object',
        description: 'property tracks: x, y, w, h, or props.<id> of a number or colour prop -> [{at, v, ease?}]',
      },
      transform: { type: 'object' },
    },
    required: ['use', 'component'],
    additionalProperties: false,
  };
}

/** Check a spec (the declaration beside the code) before anything is sent to
 *  the backend; issues carry paths like `props[2].default`. */
export function checkSpec(spec: unknown): ValidationIssue[] {
  return componentSpecIssues(spec);
}

// --------------------------------------------------------------------------
// certification: the proof manifest
// --------------------------------------------------------------------------

/** The fps a proof renders at. */
export const PROOF_FPS = 30;
/** Frames sampled per variant (start, a third, two thirds, end). */
export const PROOF_SAMPLES_PER_VARIANT = 4;
/** The width a contact-sheet tile aims for, px. */
const PROOF_TILE_WIDTH = 480;
/** List lengths a proof uses when a list prop sets no bounds. */
const PROOF_LIST_MIN = 1;
const PROOF_LIST_MAX = 12;
/** The colour the high-edge variant sets on every colour prop (proving the
 *  explicit value path; the other two variants prove the theme fallback). */
const PROOF_COLOUR = '#22d3ee';

type Edge = 'min' | 'max';

function edgeNumber(slot: TemplateSlot, edge: Edge): number {
  const c = slot.constraints;
  const fallback = typeof slot.default === 'number' ? slot.default : 0;
  const v = edge === 'min' ? c?.min ?? fallback : c?.max ?? fallback;
  return c?.integer ? Math.round(v) : v;
}

function edgeText(slot: TemplateSlot, edge: Edge): string {
  const c = slot.constraints;
  if (edge === 'min') return 'A'.repeat(Math.max(1, c?.minLen ?? 1));
  return 'W'.repeat(Math.min(c?.maxLen ?? 48, 200));
}

/** A prop's value at one edge of what it accepts; `undefined` = leave unset. */
function edgeValue(slot: TemplateSlot, edge: Edge): unknown {
  const c = slot.constraints;
  switch (slot.type) {
    case 'number':
      return edgeNumber(slot, edge);
    case 'text':
      return edgeText(slot, edge);
    case 'enum': {
      const options = c?.options ?? [];
      return edge === 'min' ? options[0] : options[options.length - 1];
    }
    case 'list': {
      const n = edge === 'min' ? Math.max(PROOF_LIST_MIN, c?.minItems ?? PROOF_LIST_MIN) : Math.max(1, c?.maxItems ?? PROOF_LIST_MAX);
      return Array.from({ length: n }, (_, i) =>
        c?.itemType === 'number' ? (edge === 'min' ? c?.min ?? 0 : (c?.max ?? 100) - i) : edgeText(slot, edge),
      );
    }
    case 'color':
      return edge === 'max' ? PROOF_COLOUR : undefined;
    default:
      return undefined;
  }
}

/** The props of one proof variant. */
export function proofVariantProps(ref: Pick<ComponentRef, 'props'>, variant: 'defaults' | Edge): Record<string, unknown> {
  if (variant === 'defaults') return {};
  const out: Record<string, unknown> = {};
  for (const slot of ref.props) {
    const v = edgeValue(slot, variant);
    if (v !== undefined) out[slot.id] = v;
  }
  return out;
}

/** The frames a variant samples, scene-relative: start, ⅓, ⅔, end. */
export function proofSampleFrames(sceneFrames: number): number[] {
  const last = Math.max(0, sceneFrames - 1);
  const picks = Array.from({ length: PROOF_SAMPLES_PER_VARIANT }, (_, i) =>
    Math.round((last * i) / (PROOF_SAMPLES_PER_VARIANT - 1)),
  );
  return [...new Set(picks)];
}

/** What the backend's `prove` takes (`apelles_motion::components::ProofPlan`). */
export interface ProofPlan {
  manifest: Manifest;
  variants: { name: string; frames: number[] }[];
  scale: number;
}

/**
 * The proof manifest for `ref`: a canvas the size of its box, one scene per
 * variant (`defaults`, `min`, `max`), each one custom layer playing for the
 * component's declared duration, in the default theme; and the absolute
 * frames to sample in each. The backend renders these three ways and requires
 * identical pixels (`apelles_motion::components::prove`).
 */
export function proofPlan(ref: ComponentRef): ProofPlan {
  const key = componentRefKey(ref.id, ref.version);
  const sceneFrames = Math.max(1, Math.round(ref.duration * PROOF_FPS));
  const names = ['defaults', 'min', 'max'] as const;
  const scenes = names.map((name) => {
    const props = proofVariantProps(ref, name);
    return {
      id: `proof-${name}`,
      dur: sceneFrames / PROOF_FPS,
      layers: [
        {
          use: 'custom' as const,
          id: 'component',
          component: key,
          x: 0,
          y: 0,
          ...(Object.keys(props).length > 0 ? { props } : {}),
        },
      ],
    };
  });
  const manifest = {
    title: `certification proof: ${key}`,
    width: ref.size.w,
    height: ref.size.h,
    fps: PROOF_FPS,
    // Explicit: Remotion merges a render's props over the Animation
    // composition's defaultProps (the engine sample, which turns grain and a
    // vignette on), so an absent key is NOT off in a render (B-281). The
    // proof renders the component alone.
    grain: false,
    vignette: false,
    components: { [key]: ref },
    scenes,
  } as unknown as Manifest;
  const local = proofSampleFrames(sceneFrames);
  return {
    manifest,
    variants: names.map((name, i) => ({ name, frames: local.map((f) => i * sceneFrames + f) })),
    scale: Math.min(1, Math.max(0.1, PROOF_TILE_WIDTH / ref.size.w)),
  };
}

// --------------------------------------------------------------------------
// the live player: proxy manifests
// --------------------------------------------------------------------------

/** The scale proxy frames are rendered at: the player is smaller than the
 *  canvas, and a proxy is a preview, not the export. */
export const PROXY_SCALE = 0.5;

/**
 * One custom layer as a one-layer manifest for the renderer process: a
 * transparent canvas the size of its box, the layer at (0, 0) starting at 0,
 * its props and its `props.*` tracks shifted to the layer's own time, the
 * document's theme. Frame `n` of its render is frame `n` of the layer's local
 * time, which is what `useCurrentFrame()` reads inside the layer in the
 * player. Box tracks (`x`, `y`, `w`, `h`), the transform and the timing are
 * the player's own job and are left out. `playFrames` is how long to render.
 */
export function proxyManifest(
  doc: Pick<Manifest, 'fps' | 'theme' | 'themeDef'>,
  def: ComponentRef,
  raw: Readonly<Record<string, unknown>>,
  playFrames: number,
): Manifest {
  const fps = doc.fps;
  const at = typeof raw.at === 'number' ? raw.at : 0;
  const w = typeof raw.w === 'number' ? raw.w : def.size.w;
  const h = typeof raw.h === 'number' ? raw.h : def.size.h;
  const anim: Record<string, unknown> = {};
  if (isPlainObject(raw.anim)) {
    for (const [track, keys] of Object.entries(raw.anim)) {
      if (!track.startsWith('props.') || !Array.isArray(keys)) continue;
      anim[track] = keys.map((k) => (isPlainObject(k) && typeof k.at === 'number' ? { ...k, at: k.at - at } : k));
    }
  }
  const key = componentRefKey(def.id, def.version);
  return {
    title: `proxy ${key}`,
    width: Math.max(1, Math.round(w)),
    height: Math.max(1, Math.round(h)),
    fps,
    transparent: true,
    // A clean overlay: no grain or vignette of its own (B-281; the player draws
    // the document's post-FX once, over everything).
    grain: false,
    vignette: false,
    ...(doc.theme !== undefined ? { theme: doc.theme } : {}),
    ...(doc.themeDef !== undefined ? { themeDef: doc.themeDef } : {}),
    components: { [key]: def },
    scenes: [
      {
        id: 'proxy',
        dur: Math.max(1, playFrames) / fps,
        layers: [
          {
            use: 'custom',
            id: 'proxy',
            component: key,
            x: 0,
            y: 0,
            w,
            h,
            ...(typeof raw.dur === 'number' ? { dur: raw.dur } : {}),
            ...(isPlainObject(raw.props) ? { props: raw.props } : {}),
            ...(Object.keys(anim).length > 0 ? { anim } : {}),
          },
        ],
      },
    ],
  } as unknown as Manifest;
}

/** A spec problem list as one readable line, for a refusal. */
export function specRefusal(issues: readonly ValidationIssue[]): string {
  return `the component's declaration has ${issues.length === 1 ? 'a problem' : `${issues.length} problems`}:\n${formatIssues(issues)}`;
}

/** `parseComponentRef`, re-exported for the ops' convenience. */
export { parseComponentRef };
