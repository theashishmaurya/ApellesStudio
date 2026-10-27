/**
 * @apelles/motion — instantiating, refilling and capturing Motion TEMPLATES
 * (D-407, Phase 2 of `docs/notes/motion-authoring-mcp.md`).
 *
 * What it is: the pure functions both interfaces share, the way `authoring.ts`
 * is for whole fragments:
 *  - `instantiateTemplate` — fill a template's slots (checked against each
 *    slot's type and constraints, issues under `values.<slot>`), reflow the
 *    body from `authoredAt` to the project canvas (D-347's `reflowManifest`),
 *    give it ids, attach provenance, and validate the result strictly with the
 *    manifest's own scene schema;
 *  - `planInstantiate` / `planRefill` — that, landed in a manifest (a new scene
 *    after an index, or a group into a scene; or a scene re-expanded in place),
 *    checked to still load;
 *  - `templateFromSource` — capture a scene (or some of its layers) as a
 *    template: each slot names a field PATH inside it, which becomes a binding
 *    and whose current value becomes the slot's default;
 *  - `exposableFields` — every field of a scene a person could expose as a
 *    slot, for the Save-as-template dialog.
 *
 * `motionOps.ts`'s `motion_*_template` tools and the GUI dialogs call exactly
 * these, then commit through the one undoable `commit`.
 *
 * **Ids are deterministic, not random.** A body layer keeps the id it was
 * authored with (so an agent can address `headline` in the instance); an
 * id-less or colliding one is minted as `<use>-<n>`; a new scene is named after
 * the template (`stat-counter`, `stat-counter-2`, …). So instantiation is a
 * pure function of (template, values, canvas, what is already taken), and a
 * refill reproduces the same ids for the same structure.
 *
 * What it does NOT do: I/O (`templateLibraryIO.ts`), commit, or parse wire
 * arguments.
 */
import type { Layer, Manifest, Scene, TemplateProvenance } from '@apelles/motion-engine/src/engine/schema';
import {
  formatPath,
  iconIssues,
  validateLayers,
  validateScene,
  type ValidationIssue,
} from '@apelles/motion-engine/src/engine/validate';
import {
  checkSlotValue,
  fillTemplateBody,
  parseTemplate,
  resolveSlotValues,
  sampleSlotValue,
  SLOT_ID_PATTERN,
  TEMPLATE_ID_PATTERN,
  TEMPLATE_SCHEMA_VERSION,
  type MotionTemplate,
  type SlotConstraints,
  type SlotType,
  type TemplateSlot,
} from '@apelles/motion-engine/src/templateDef';
import { reflowManifest } from './manifestReflow';
import { insertLayers, insertScene, replaceScene } from './manifestEdit';
import { fieldsForPrimitive, type FieldSpec } from './propCatalog';
import { fragmentRefusal, refusalFor, type MotionRefusal } from './authoring';

export type { MotionTemplate, TemplateSlot };

type Raw = Record<string, unknown>;
type PathSeg = string | number;

function isPlainObject(v: unknown): v is Raw {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** `base`, or `base-2`, `base-3`, … — the first not in `taken`. */
export function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** Give every layer in `layers` (and every group child, recursively, within
 *  its own group) an id: its own when free, else `<use>-<n>`. In place. */
function assignLayerIds(layers: Raw[], taken: Set<string>): void {
  for (const layer of layers) {
    const own = layer.id;
    const use = typeof layer.use === 'string' ? layer.use : 'layer';
    const id = typeof own === 'string' && own.length > 0 && !taken.has(own) ? own : uniqueId(`${use}-1`, taken);
    taken.add(id);
    layer.id = id;
    if (use === 'group' && Array.isArray(layer.children)) {
      assignLayerIds(layer.children.filter(isPlainObject), new Set<string>());
    }
  }
}

export interface InstantiateOptions {
  /** the installed Phosphor names (`authoring.ts`'s `iconNamesFor`); without
   *  them icon names are checked for shape only. */
  iconNames?: ReadonlySet<string>;
  /** scene ids already in the document (a new scene is named around them). */
  takenSceneIds?: Iterable<string>;
  /** name the new scene outright (the caller has validated it). */
  sceneId?: string;
  /** top-level layer ids already in the target scene (group kind). */
  takenLayerIds?: Iterable<string>;
}

export interface Instantiated {
  kind: 'scene' | 'group';
  /** kind scene: the new scene. */
  scene?: Scene;
  /** kind group: the one group layer. */
  layer?: Layer;
  /** the slot values used (caller's over defaults) — what provenance records. */
  values: Record<string, unknown>;
  provenance: TemplateProvenance;
  /** reflow ratios when the canvas differed from `authoredAt`, else null. */
  reflowed: { sx: number; sy: number; su: number } | null;
}

export type InstantiateResult = ({ ok: true } & Instantiated) | ({ ok: false } & MotionRefusal);

/**
 * Expand `template` with `values` for a `canvas`-sized document. Pure.
 *
 * Refuses (nothing partial) when a value fails its slot (issues under
 * `values.<slot>`), or when the filled body is not a valid scene / layer list
 * (issues under `scene…` / `layers…`, the strict pass: unknown keys refused).
 */
export function instantiateTemplate(
  template: MotionTemplate,
  values: unknown,
  canvas: { width: number; height: number },
  opts: InstantiateOptions = {},
): InstantiateResult {
  const resolved = resolveSlotValues(template, values, opts.iconNames);
  if (resolved.issues.length > 0) return { ok: false, ...fragmentRefusal('values', resolved.issues) };

  const filled = fillTemplateBody(template.body, resolved.values);
  // Both kinds are reflowed as one scene of a manifest at the authored size:
  // `reflowManifest` is the one place geometry is remapped (D-347).
  const groupLayer: Raw | null =
    template.kind === 'group' ? { use: 'group', children: Array.isArray(filled) ? filled : [] } : null;
  const scene: Raw = template.kind === 'scene' ? { ...(filled as Raw) } : { dur: 1, layers: [groupLayer] };
  const { width, height, fps } = template.authoredAt;
  const sameCanvas = canvas.width === width && canvas.height === height;
  let reflowed: Instantiated['reflowed'] = null;
  if (!sameCanvas) {
    const doc = { title: '', width, height, fps, scenes: [scene] } as unknown as Manifest;
    reflowed = reflowManifest(doc, canvas).factors;
  }

  const provenance: TemplateProvenance = { id: template.id, version: template.version, values: resolved.values };

  if (template.kind === 'scene') {
    const layers = Array.isArray(scene.layers) ? scene.layers.filter(isPlainObject) : [];
    assignLayerIds(layers, new Set<string>());
    if (isPlainObject(scene.scene3d) && Array.isArray(scene.scene3d.children)) {
      assignLayerIds(scene.scene3d.children.filter(isPlainObject), new Set<string>(layers.map((l) => String(l.id))));
    }
    const id = opts.sceneId ?? uniqueId(template.id, new Set(opts.takenSceneIds ?? []));
    const out = { id, ...scene, template: provenance };
    const checked = validateScene(out);
    const issues = [...checked.issues, ...(opts.iconNames ? iconIssues(out, opts.iconNames, ['scene']) : [])];
    if (issues.length > 0) return { ok: false, ...fragmentRefusal(`the expanded template "${template.id}"`, issues) };
    return { ok: true, kind: 'scene', scene: out as unknown as Scene, values: resolved.values, provenance, reflowed };
  }

  const group = groupLayer as Raw;
  group.id = uniqueId(template.id, new Set(opts.takenLayerIds ?? []));
  assignLayerIds(Array.isArray(group.children) ? group.children.filter(isPlainObject) : [], new Set<string>());
  group.template = provenance;
  const checked = validateLayers([group]);
  const issues = [...checked.issues, ...(opts.iconNames ? iconIssues([group], opts.iconNames, ['layers']) : [])];
  if (issues.length > 0) return { ok: false, ...fragmentRefusal(`the expanded template "${template.id}"`, issues) };
  return { ok: true, kind: 'group', layer: group as unknown as Layer, values: resolved.values, provenance, reflowed };
}

/** Where an instance lands. */
export type InstantiateTarget = { afterSceneIndex?: number } | { intoSceneIndex: number };

export type TemplatePlan = ({ ok: true; manifest: Manifest; sceneIndex: number; instance: Instantiated }) | ({ ok: false } & MotionRefusal);

/**
 * Instantiate into `manifest`: a scene template becomes a new scene right after
 * `afterSceneIndex` (default: at the end); a group template becomes one group
 * layer on top of scene `intoSceneIndex`. The result must load.
 */
export function planInstantiate(
  manifest: Manifest,
  template: MotionTemplate,
  values: unknown,
  target: InstantiateTarget,
  opts: Pick<InstantiateOptions, 'iconNames' | 'sceneId'> = {},
): TemplatePlan {
  const canvas = { width: manifest.width, height: manifest.height };
  if (template.kind === 'scene') {
    if ('intoSceneIndex' in target) {
      return { ok: false, error: `"${template.id}" is a scene template: it becomes a new scene (pass after_scene_index), not layers in one`, issues: [] };
    }
    const after = target.afterSceneIndex;
    if (after !== undefined && !manifest.scenes[after]) {
      return { ok: false, error: `no scene at index ${after} (0..${manifest.scenes.length - 1})`, issues: [] };
    }
    const result = instantiateTemplate(template, values, canvas, {
      ...opts,
      takenSceneIds: manifest.scenes.map((s) => s.id),
    });
    if (!result.ok) return result;
    const { manifest: next, sceneIndex } = insertScene(manifest, result.scene as Scene, after);
    const refused = refusalFor(next);
    if (refused) return { ok: false, ...refused };
    return { ok: true, manifest: next, sceneIndex, instance: result };
  }

  if (!('intoSceneIndex' in target)) {
    return { ok: false, error: `"${template.id}" is a group template: pass into_scene_index (the scene it is added to)`, issues: [] };
  }
  const sceneIndex = target.intoSceneIndex;
  const scene = manifest.scenes[sceneIndex];
  if (!scene) return { ok: false, error: `no scene at index ${sceneIndex} (0..${manifest.scenes.length - 1})`, issues: [] };
  const result = instantiateTemplate(template, values, canvas, {
    iconNames: opts.iconNames,
    takenLayerIds: [...(scene.layers ?? []), ...(scene.scene3d?.children ?? [])]
      .map((l) => l.id)
      .filter((id): id is string => typeof id === 'string'),
  });
  if (!result.ok) return result;
  const { manifest: next } = insertLayers(manifest, sceneIndex, [result.layer as unknown as Raw]);
  const refused = refusalFor(next);
  if (refused) return { ok: false, ...refused };
  return { ok: true, manifest: next, sceneIndex, instance: result };
}

/** `existing` provenance values with `patch` laid over (a `null` clears). */
export function mergeRefillValues(existing: Readonly<Record<string, unknown>>, patch: unknown): Record<string, unknown> | null {
  if (patch !== undefined && patch !== null && !isPlainObject(patch)) return null;
  return { ...existing, ...((patch ?? {}) as Raw) };
}

/** Where an instance is in a manifest: a scene, or a group layer in one. */
export type InstanceRef = { sceneIndex: number; layerId?: string };

/** The provenance at `ref`, or why there is none. */
export function provenanceAt(manifest: Manifest, ref: InstanceRef): { provenance: TemplateProvenance; layerIndex?: number } | { error: string } {
  const scene = manifest.scenes[ref.sceneIndex];
  if (!scene) return { error: `no scene at index ${ref.sceneIndex} (0..${manifest.scenes.length - 1})` };
  if (ref.layerId === undefined) {
    if (!scene.template) return { error: `scene "${scene.id}" was not made from a template (it has no template provenance)` };
    return { provenance: scene.template };
  }
  const layerIndex = (scene.layers ?? []).findIndex((l) => l.id === ref.layerId);
  if (layerIndex < 0) return { error: `no layer with id "${ref.layerId}" in scene "${scene.id}"` };
  const layer = (scene.layers ?? [])[layerIndex] as unknown as Raw;
  const prov = layer.template;
  if (!isPlainObject(prov)) return { error: `layer "${ref.layerId}" was not made from a template` };
  return { provenance: prov as unknown as TemplateProvenance, layerIndex };
}

/**
 * Re-expand an instance with new values (merged over the ones it was made
 * with). The scene keeps its id and place; a group keeps its id, place and
 * start time. Everything the template did not produce — hand edits made since
 * — is replaced: copy semantics have no merge, and the tools say so.
 */
export function planRefill(
  manifest: Manifest,
  ref: InstanceRef,
  template: MotionTemplate,
  patch: unknown,
  opts: Pick<InstantiateOptions, 'iconNames'> = {},
): TemplatePlan {
  const found = provenanceAt(manifest, ref);
  if ('error' in found) return { ok: false, error: found.error, issues: [] };
  const merged = mergeRefillValues(found.provenance.values, patch);
  if (!merged) return { ok: false, error: 'values must be an object of {slotId: value}', issues: [] };
  const scene = manifest.scenes[ref.sceneIndex];

  if (found.layerIndex === undefined) {
    if (template.kind !== 'scene') return { ok: false, error: `"${template.id}" is now a group template; a scene instance cannot be refilled from it`, issues: [] };
    const result = instantiateTemplate(template, merged, { width: manifest.width, height: manifest.height }, {
      iconNames: opts.iconNames,
      sceneId: scene.id,
    });
    if (!result.ok) return result;
    const { manifest: next } = replaceScene(manifest, ref.sceneIndex, result.scene as unknown as Raw);
    const refused = refusalFor(next);
    if (refused) return { ok: false, ...refused };
    return { ok: true, manifest: next, sceneIndex: ref.sceneIndex, instance: result };
  }

  if (template.kind !== 'group') return { ok: false, error: `"${template.id}" is now a scene template; a group instance cannot be refilled from it`, issues: [] };
  const old = (scene.layers ?? [])[found.layerIndex] as unknown as Raw;
  const result = instantiateTemplate(template, merged, { width: manifest.width, height: manifest.height }, {
    iconNames: opts.iconNames,
  });
  if (!result.ok) return result;
  const layer: Raw = { ...(result.layer as unknown as Raw), id: old.id };
  if (old.at !== undefined) layer.at = old.at;
  if (old.transform !== undefined) layer.transform = old.transform;
  const next = structuredClone(manifest);
  (next.scenes[ref.sceneIndex].layers as unknown as Raw[])[found.layerIndex] = layer;
  const refused = refusalFor(next);
  if (refused) return { ok: false, ...refused };
  return { ok: true, manifest: next, sceneIndex: ref.sceneIndex, instance: { ...result, layer: layer as unknown as Layer } };
}

// --------------------------------------------------------------------------
// capturing a template from a scene
// --------------------------------------------------------------------------

/** `layers[2].text`, `layers[headline].children[0].fill`, `[0].text` → segments.
 *  A bracket that is not a number names an element by its `id`. */
export function parseFieldPath(path: string): PathSeg[] | null {
  const out: PathSeg[] = [];
  const re = /\[([^\]]+)\]|\.?([A-Za-z_$][A-Za-z0-9_$]*)/gy;
  let m: RegExpExecArray | null;
  let at = 0;
  while (at < path.length) {
    re.lastIndex = at;
    m = re.exec(path);
    if (!m) return null;
    if (m[1] !== undefined) out.push(/^\d+$/.test(m[1]) ? Number(m[1]) : `#${m[1]}`);
    else out.push(m[2]);
    at = re.lastIndex;
  }
  return out.length > 0 ? out : null;
}

/** Walk `root` down `segs` to the container of the last segment. `#id`
 *  segments pick the array element whose `id` is that. Returns the parent
 *  and the concrete key, or `null` when the path does not exist (the last key
 *  itself may be absent: an unset field can still become a slot). */
function locate(root: unknown, segs: PathSeg[]): { parent: Raw | unknown[]; key: string | number; concrete: PathSeg[] } | null {
  let cur: unknown = root;
  const concrete: PathSeg[] = [];
  for (let i = 0; i < segs.length; i++) {
    let seg = segs[i];
    if (typeof seg === 'string' && seg.startsWith('#')) {
      if (!Array.isArray(cur)) return null;
      const idx = cur.findIndex((el) => isPlainObject(el) && el.id === (seg as string).slice(1));
      if (idx < 0) return null;
      seg = idx;
    }
    concrete.push(seg);
    const last = i === segs.length - 1;
    if (last) {
      if (typeof seg === 'number' ? !Array.isArray(cur) || seg >= cur.length : !isPlainObject(cur)) return null;
      return { parent: cur as Raw | unknown[], key: seg, concrete };
    }
    if (typeof seg === 'number') {
      if (!Array.isArray(cur)) return null;
      cur = cur[seg];
    } else {
      if (!isPlainObject(cur)) return null;
      cur = cur[seg];
    }
  }
  return null;
}

/** One slot of a save request: a slot definition plus where it binds. */
export interface SlotSource {
  id: string;
  type: SlotType;
  /** one field path, or several (a brand colour used by three layers) */
  path: string | string[];
  label?: string;
  description?: string;
  required?: boolean;
  constraints?: SlotConstraints;
  /** overrides the default taken from the field's current value */
  default?: unknown;
}

export interface TemplateSpec {
  id?: string;
  name: string;
  description?: string;
  tags?: string[];
  slots: SlotSource[];
}

/** a name → a template id (`"Stat counter (blue)"` → `stat-counter-blue`). */
export function slugifyTemplateId(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
    .replace(/-+$/, '');
  return slug.length > 0 ? slug : 'template';
}

/** What a template is captured from: a whole scene, or some of its layers
 *  (by id or index), which become a group template. */
export type TemplateSource = { sceneIndex: number; layers?: (string | number)[] };

/**
 * Capture `source` as a template. Each slot's `path` (relative to the scene,
 * or to the selected-layer list for a group: `[0].text`) becomes
 * `{"$slot": id}`; the field's current value becomes the slot's default
 * unless one is given. The result is checked as a template
 * AND instantiated once with its defaults, so a template that cannot be used
 * is never saved.
 */
export function templateFromSource(
  manifest: Manifest,
  source: TemplateSource,
  spec: TemplateSpec,
  iconNames?: ReadonlySet<string>,
): { template: MotionTemplate } | { issues: ValidationIssue[] } {
  const scene = manifest.scenes[source.sceneIndex];
  if (!scene) return { issues: [{ path: 'scene_index', code: 'invalid_value', message: `no scene at index ${source.sceneIndex}` }] };
  const kind: MotionTemplate['kind'] = source.layers && source.layers.length > 0 ? 'group' : 'scene';
  let body: unknown;
  if (kind === 'scene') {
    const copy = structuredClone(scene) as unknown as Raw;
    delete copy.id;
    delete copy.template;
    body = copy;
  } else {
    const all = scene.layers ?? [];
    const picked: Raw[] = [];
    for (const [i, key] of (source.layers ?? []).entries()) {
      const layer = typeof key === 'number' ? all[key] : all.find((l) => l.id === key);
      if (!layer) {
        return { issues: [{ path: `layers[${i}]`, code: 'invalid_value', message: `no layer ${JSON.stringify(key)} in scene "${scene.id}"` }] };
      }
      const copy = structuredClone(layer) as unknown as Raw;
      delete copy.template;
      picked.push(copy);
    }
    body = picked;
  }

  const issues: ValidationIssue[] = [];
  const slots: TemplateSlot[] = [];
  spec.slots.forEach((s, i) => {
    const paths = Array.isArray(s.path) ? s.path : [s.path];
    if (paths.length === 0) issues.push({ path: `slots[${i}].path`, code: 'missing_field', message: 'a slot needs a field path' });
    let current: unknown;
    for (const [j, p] of paths.entries()) {
      const where = Array.isArray(s.path) ? `slots[${i}].path[${j}]` : `slots[${i}].path`;
      const segs = typeof p === 'string' ? parseFieldPath(p) : null;
      const found = segs ? locate(body, segs) : null;
      if (!found) {
        issues.push({
          path: where,
          code: 'invalid_value',
          message: `${JSON.stringify(p)} is not a field of this ${kind === 'scene' ? 'scene' : 'layer selection'}`,
          hint: kind === 'scene' ? 'paths look like layers[2].text or layers[headline].text' : 'paths look like [0].text or [headline].text',
        });
        continue;
      }
      const binding = { $slot: s.id };
      let value: unknown;
      if (Array.isArray(found.parent)) {
        value = found.parent[Number(found.key)];
        found.parent[Number(found.key)] = binding;
      } else {
        value = found.parent[String(found.key)];
        found.parent[String(found.key)] = binding;
      }
      if (current === undefined) current = value;
    }
    const slot: TemplateSlot = {
      id: s.id,
      type: s.type,
      label: s.label ?? s.id,
      ...(s.description ? { description: s.description } : {}),
      ...(s.required ? { required: true } : {}),
      ...(s.constraints ? { constraints: s.constraints } : {}),
    };
    const def = s.default !== undefined ? s.default : current;
    if (def !== undefined) slot.default = def;
    if (!SLOT_ID_PATTERN.test(s.id)) {
      issues.push({ path: `slots[${i}].id`, code: 'invalid_value', message: 'a slot id: a letter, then letters, digits or _' });
    } else if (def !== undefined) {
      issues.push(...checkSlotValue(slot, def, ['slots', i, 'default']));
    }
    slots.push(slot);
  });
  if (issues.length > 0) return { issues };

  const id = spec.id ?? slugifyTemplateId(spec.name);
  const raw = {
    schemaVersion: TEMPLATE_SCHEMA_VERSION,
    id,
    name: spec.name,
    // A re-save under an existing id is bumped by `versionForSave`
    // (`templateLibrary.ts`), the one place versions are decided.
    version: 1,
    ...(spec.description ? { description: spec.description } : {}),
    ...(spec.tags && spec.tags.length > 0 ? { tags: spec.tags } : {}),
    kind,
    authoredAt: { width: manifest.width, height: manifest.height, fps: manifest.fps },
    slots,
    body,
    ...(manifest.themeDef ? { themeDef: manifest.themeDef } : {}),
  };
  return checkTemplateUsable(raw, iconNames);
}

/**
 * Parse a template AND prove it can be used: instantiated once at its own
 * canvas with its defaults (and a sample value of the right type for any
 * required slot without one), the expansion must validate. The definition-time
 * check `motion_define_template` and the save paths share.
 */
export function checkTemplateUsable(
  raw: unknown,
  iconNames?: ReadonlySet<string>,
): { template: MotionTemplate } | { issues: ValidationIssue[] } {
  const parsed = parseTemplate(raw);
  if ('issues' in parsed) return parsed;
  const t = parsed.template;
  const sample: Record<string, unknown> = {};
  for (const s of t.slots) sample[s.id] = s.default !== undefined ? s.default : sampleSlotValue(s);
  const tried = instantiateTemplate(t, sample, { width: t.authoredAt.width, height: t.authoredAt.height }, { iconNames });
  if (!tried.ok) {
    return { issues: tried.issues.map((i) => ({ ...i, message: `${i.message} (the body, filled with defaults)` })) };
  }
  return parsed;
}

/** `TEMPLATE_ID_PATTERN`, for callers that name a template. */
export function isTemplateId(id: unknown): id is string {
  return typeof id === 'string' && TEMPLATE_ID_PATTERN.test(id);
}

// --------------------------------------------------------------------------
// the Save-as-template dialog's field list
// --------------------------------------------------------------------------

/** One field a person could expose as a slot. */
export interface ExposableField {
  /** the save request's `path` (`layers[2].text`, `layers[1].children[0].fill`) */
  path: string;
  /** the layer it belongs to, for display (`text: "Ship faster"`) */
  layer: string;
  /** the Inspector's own label for the field */
  label: string;
  type: SlotType;
  /** enum options (a select field) */
  options?: string[];
  /** the field's current value (undefined = unset, the theme default) */
  value: unknown;
  /** the Inspector's spec, so the dialog can reuse its control */
  spec: FieldSpec;
}

const KIND_TO_SLOT: Partial<Record<FieldSpec['kind'], SlotType>> = {
  string: 'text',
  number: 'number',
  color: 'color',
  asset: 'image',
  icon: 'icon',
  select: 'enum',
};

/** the field groups that hold content and look (not layout or timing, which
 *  a template fixes). */
const EXPOSABLE_GROUPS: ReadonlySet<FieldSpec['group']> = new Set(['content', 'source', 'fill']);

/**
 * Every content/look field of `layers` (group children included) that maps
 * onto a slot type, with its path relative to `root` — the Inspector's own
 * field list (`propCatalog.ts`), so a field a person can edit in the Inspector
 * is exactly a field they can expose.
 */
export function exposableFields(layers: readonly Layer[], root: PathSeg[] = ['layers'], describe?: (l: Layer) => string): ExposableField[] {
  const out: ExposableField[] = [];
  layers.forEach((layer, i) => {
    const raw = layer as unknown as Raw;
    const here = [...root, i];
    const name = describe ? describe(layer) : layer.use;
    for (const spec of fieldsForPrimitive(layer.use) ?? []) {
      const type = KIND_TO_SLOT[spec.kind];
      if (!type || !EXPOSABLE_GROUPS.has(spec.group)) continue;
      out.push({
        path: formatPath([...here, spec.key]),
        layer: name,
        label: spec.label,
        type,
        ...(spec.options ? { options: spec.options } : {}),
        value: raw[spec.key],
        spec,
      });
    }
    if (layer.use === 'group' && Array.isArray(raw.children)) {
      out.push(...exposableFields(raw.children as Layer[], [...here, 'children'], describe));
    }
  });
  return out;
}

/** a slot id from a field label (`"Fill"` → `fill`, then `fill_2`…). */
export function slotIdFor(label: string, taken: ReadonlySet<string>): string {
  const words = label
    .replace(/\(.*?\)/g, '')
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean);
  const base = words.length === 0 ? 'slot' : words.map((w, i) => (i === 0 ? w.toLowerCase() : w[0].toUpperCase() + w.slice(1).toLowerCase())).join('');
  const safe = /^[A-Za-z]/.test(base) ? base : `s${base}`;
  if (!taken.has(safe)) return safe;
  for (let n = 2; ; n++) if (!taken.has(`${safe}_${n}`)) return `${safe}_${n}`;
}
