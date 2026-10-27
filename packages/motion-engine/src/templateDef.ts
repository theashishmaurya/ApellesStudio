/**
 * templateDef.ts — a scene or group TEMPLATE as data (D-407, Phase 2 of
 * `docs/notes/motion-authoring-mcp.md`).
 *
 * What it is: `MotionTemplate`, a saved design with named SLOTS (headline,
 * logo, brand colour, a number…) and a body — a scene, or a list of layers —
 * whose values may be bound to those slots. Plus the pure pieces that only
 * need the template itself: the zod schema, schema-version migration, the
 * check of a value against its slot (`checkSlotValue`), resolving a caller's
 * values against the slots (`resolveSlotValues`), and filling the body
 * (`fillTemplateBody`).
 *
 * **Bindings, and nothing more.** A value anywhere in the body may be
 * `{"$slot": "<id>"}` (replaced by the slot's value; an unset optional slot
 * removes the key, so the primitive's theme default applies), and a string may
 * interpolate slots as `"{price}/mo"` (`{{` and `}}` write literal braces; a
 * list slot interpolates one item per line).
 * One presence toggle: an object inside an array may carry
 * `"$when": "<slot id>"`, and is kept only when that slot has a value (Figma's
 * boolean property, which only shows or hides a layer). There is deliberately
 * NO expression language: no arithmetic, no comparisons, no code (the note's
 * "sandboxed JS" option was rejected for determinism and safety).
 *
 * What it does NOT do: reflow to a canvas, mint ids, validate the filled body
 * as a manifest, or store anything. `@apelles/motion`'s `templates.ts`
 * instantiates (it owns the reflow, D-347) and `templateLibraryIO.ts` stores.
 *
 * **Copy semantics (D-332, D-399).** An instantiated template is plain layers
 * in the manifest plus provenance (`scene.template`, `schema.ts`'s
 * `templateProvenanceSchema`); a render never reads the library.
 */
import { z } from "zod";
import { themeDefSchema } from "./themeDef";
import { closest, formatPath, type ValidationIssue } from "./engine/validate";
import { checkSlotValue, hasValue, templateSlotSchema } from "./slots";

// D-409 — the slot schema and its checks moved to `slots.ts` (a custom
// component's props are slots too, and the manifest schema checks them);
// re-exported so every importer of this module is unchanged.
export {
  MAX_LIST_ITEMS,
  SLOT_ID_PATTERN,
  SLOT_TYPES,
  checkSlotValue,
  hasValue,
  resolveSlotValues,
  sampleSlotValue,
  slotConstraintsSchema,
  slotsJsonSchema,
  templateSlotSchema,
  type SlotConstraints,
  type SlotType,
  type TemplateSlot,
} from "./slots";

/** The schema version this build writes and reads natively. */
export const TEMPLATE_SCHEMA_VERSION = 1;

/** Template ids are file names (`<id>.json`): lowercase kebab, at most 64. */
export const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** the most slots one template may declare (a form longer than this is a
 *  different tool). */
export const MAX_SLOTS = 32;
const templateObject = z.object({
  schemaVersion: z.literal(TEMPLATE_SCHEMA_VERSION),
  id: z.string().regex(TEMPLATE_ID_PATTERN, "lowercase letters, digits and hyphens, at most 64"),
  name: z.string().min(1).max(80),
  /** bumped every time a template is saved over an existing id */
  version: z.number().int().positive(),
  description: z.string().max(500).optional(),
  tags: z.array(z.string().regex(TAG_PATTERN, "a tag: lowercase letters, digits, hyphens")).max(12).optional(),
  kind: z.enum(["scene", "group"]),
  /** the canvas the body's pixel values were authored on (reflowed from) */
  authoredAt: z.object({
    width: z.number().int().positive(),
    height: z.number().int().positive(),
    fps: z.number().positive(),
  }),
  slots: z.array(templateSlotSchema).max(MAX_SLOTS),
  /** `kind: "scene"` — a scene without `id`; `kind: "group"` — a list of 2D
   *  layers (instantiated as ONE group layer). Checked by `superRefine`. */
  body: z.unknown(),
  /** the look the template was designed in. Never applied silently: the
   *  instantiate op embeds it only when asked (`apply_theme`). */
  themeDef: themeDefSchema.optional(),
});

export type MotionTemplate = z.infer<typeof templateObject>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** `{"$slot": "x"}` → `"x"`; anything else → `null`. */
export function bindingOf(v: unknown): string | null {
  if (!isPlainObject(v)) return null;
  const keys = Object.keys(v);
  return keys.length === 1 && keys[0] === "$slot" && typeof v.$slot === "string" ? v.$slot : null;
}

/** The slot ids a string interpolates (`"{price}/mo"` → `["price"]`). */
export function interpolatedSlots(s: string): string[] {
  const out: string[] = [];
  const re = /\{\{|\}\}|\{([A-Za-z][A-Za-z0-9_]*)\}/g;
  for (let m = re.exec(s); m !== null; m = re.exec(s)) if (m[1]) out.push(m[1]);
  return out;
}

type PathSeg = string | number;

/** Every slot reference in `body` (bindings, interpolations, `$when`), with
 *  where it is, for the definition-time check. */
function slotReferences(body: unknown): { id: string; path: PathSeg[]; how: string }[] {
  const out: { id: string; path: PathSeg[]; how: string }[] = [];
  const walk = (v: unknown, path: PathSeg[]) => {
    const bound = bindingOf(v);
    if (bound !== null) {
      out.push({ id: bound, path, how: "$slot" });
      return;
    }
    if (typeof v === "string") {
      for (const id of interpolatedSlots(v)) out.push({ id, path, how: "{…}" });
      return;
    }
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, [...path, i]));
      return;
    }
    if (!isPlainObject(v)) return;
    for (const [k, child] of Object.entries(v)) {
      if (k === "$when") {
        if (typeof child === "string") out.push({ id: child, path: [...path, k], how: "$when" });
        continue;
      }
      if (k === "$slot") continue;
      walk(child, [...path, k]);
    }
  };
  walk(body, ["body"]);
  return out;
}

/** `$slot` objects that are not exactly `{"$slot": id}` and `$when` outside
 *  an array element — authoring mistakes that would otherwise render as a
 *  literal key. */
function malformedMarkers(body: unknown): { path: PathSeg[]; message: string }[] {
  const out: { path: PathSeg[]; message: string }[] = [];
  const walk = (v: unknown, path: PathSeg[], inArray: boolean) => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, [...path, i], true));
      return;
    }
    if (!isPlainObject(v)) return;
    if ("$slot" in v && bindingOf(v) === null) {
      out.push({ path, message: 'a binding is exactly {"$slot": "<slot id>"}, with no other keys' });
    }
    if ("$when" in v) {
      if (!inArray) out.push({ path: [...path, "$when"], message: "$when only works on an object inside an array (a layer, a list item)" });
      else if (typeof v.$when !== "string") out.push({ path: [...path, "$when"], message: "$when names a slot id" });
    }
    for (const [k, child] of Object.entries(v)) if (k !== "$when" && k !== "$slot") walk(child, [...path, k], false);
  };
  walk(body, ["body"], false);
  return out;
}

export const templateSchema = templateObject.superRefine((t, ctx) => {
  const ids = new Set<string>();
  t.slots.forEach((slot, i) => {
    if (ids.has(slot.id)) ctx.addIssue({ code: "custom", path: ["slots", i, "id"], message: `duplicate slot id "${slot.id}"` });
    ids.add(slot.id);
    if (slot.type === "enum" && !slot.constraints?.options) {
      ctx.addIssue({ code: "custom", path: ["slots", i, "constraints", "options"], message: "an enum slot needs constraints.options" });
    }
    if (slot.default !== undefined) {
      for (const issue of checkSlotValue(slot, slot.default, ["slots", i, "default"])) {
        ctx.addIssue({ code: "custom", path: ["slots", i, "default"], message: issue.message });
      }
    }
  });

  if (t.kind === "scene") {
    if (!isPlainObject(t.body)) {
      ctx.addIssue({ code: "custom", path: ["body"], message: "a scene template's body is a scene object ({dur, layers, …})" });
    } else if ("id" in t.body) {
      ctx.addIssue({ code: "custom", path: ["body", "id"], message: "a scene template's body has no id (each instance gets its own)" });
    } else if ("template" in t.body) {
      ctx.addIssue({ code: "custom", path: ["body", "template"], message: "provenance is written by instantiation, not stored in a body" });
    }
  } else if (!Array.isArray(t.body) || t.body.length === 0 || !t.body.every(isPlainObject)) {
    ctx.addIssue({ code: "custom", path: ["body"], message: "a group template's body is a non-empty list of layer objects" });
  }

  for (const ref of slotReferences(t.body)) {
    if (!ids.has(ref.id)) {
      const near = closest(ref.id, [...ids]);
      ctx.addIssue({
        code: "custom",
        path: ref.path,
        message: `${ref.how} names "${ref.id}", which is not a declared slot${near ? ` (did you mean "${near}"?)` : ""}`,
      });
    }
  }
  for (const bad of malformedMarkers(t.body)) ctx.addIssue({ code: "custom", path: bad.path, message: bad.message });
});

// --------------------------------------------------------------------------
// migration
// --------------------------------------------------------------------------

/**
 * Upgrades from an older `schemaVersion` to the next, keyed by the version they
 * upgrade FROM. Empty: version 1 is the first. A future change to the shape
 * adds `1: (t) => ({...t, schemaVersion: 2, …})` here and bumps
 * `TEMPLATE_SCHEMA_VERSION`; nothing else reads old shapes.
 */
const MIGRATIONS: Readonly<Record<number, (raw: Record<string, unknown>) => Record<string, unknown>>> = {};

/** Bring a raw template up to `TEMPLATE_SCHEMA_VERSION`, or say why not. */
export function migrateTemplate(raw: unknown): { raw: Record<string, unknown> } | { error: string } {
  if (!isPlainObject(raw)) return { error: "a template is a JSON object" };
  let cur: Record<string, unknown> = raw;
  const declared = cur.schemaVersion;
  if (typeof declared !== "number" || !Number.isInteger(declared) || declared < 1) {
    return { error: "schemaVersion: missing or not a positive integer" };
  }
  let v: number = declared;
  if (v > TEMPLATE_SCHEMA_VERSION) {
    return { error: `schemaVersion ${v} is newer than this app understands (${TEMPLATE_SCHEMA_VERSION}); update Apelles` };
  }
  while (v < TEMPLATE_SCHEMA_VERSION) {
    const step = MIGRATIONS[v];
    if (!step) return { error: `no migration from schemaVersion ${v}` };
    cur = step(cur);
    v = cur.schemaVersion as number;
  }
  return { raw: cur };
}

/** Migrate + validate untrusted JSON into a template, with every problem as a
 *  path-precise issue (`slots[2].default: …`). */
export function parseTemplate(raw: unknown): { template: MotionTemplate } | { issues: ValidationIssue[] } {
  const migrated = migrateTemplate(raw);
  if ("error" in migrated) {
    return { issues: [{ path: "schemaVersion", code: "invalid_value", message: migrated.error }] };
  }
  const parsed = templateSchema.safeParse(migrated.raw);
  if (parsed.success) return { template: parsed.data };
  return {
    issues: parsed.error.issues.map((i) => ({
      path: formatPath(i.path.filter((p): p is PathSeg => typeof p === "string" || typeof p === "number")),
      code: i.code === "custom" ? "invalid_template" : i.code,
      message: i.message,
    })),
  };
}

// --------------------------------------------------------------------------
// values
// --------------------------------------------------------------------------

/** `"{price}/mo"` with `{price: 49}` → `"49/mo"`; `{{`/`}}` → literal braces;
 *  an unset slot interpolates as nothing; a list interpolates one item per
 *  line (the `text` primitive keeps newlines, so `"{features}"` is a list). */
export function interpolate(s: string, values: Readonly<Record<string, unknown>>): string {
  return s.replace(/\{\{|\}\}|\{([A-Za-z][A-Za-z0-9_]*)\}/g, (m, id: string | undefined) => {
    if (m === "{{") return "{";
    if (m === "}}") return "}";
    const v = id === undefined ? undefined : values[id];
    return v === undefined || v === null ? "" : Array.isArray(v) ? v.join("\n") : String(v);
  });
}

/**
 * Fill `body` with resolved `values`: bindings replaced (an unset one removes
 * its key, or its element from an array), strings interpolated, `$when`
 * elements kept only when their slot has a value (the marker itself removed).
 * Pure: returns a new value and never shares an object with `body` or
 * `values`.
 */
export function fillTemplateBody(body: unknown, values: Readonly<Record<string, unknown>>): unknown {
  const fill = (v: unknown): unknown => {
    const bound = bindingOf(v);
    if (bound !== null) {
      const value = values[bound];
      return value === undefined ? undefined : structuredClone(value);
    }
    if (typeof v === "string") return interpolate(v, values);
    if (Array.isArray(v)) {
      const out: unknown[] = [];
      for (const item of v) {
        if (isPlainObject(item) && typeof item.$when === "string" && !hasValue(values[item.$when])) continue;
        const filled = fill(item);
        if (filled !== undefined) out.push(filled);
      }
      return out;
    }
    if (isPlainObject(v)) {
      const out: Record<string, unknown> = {};
      for (const [k, child] of Object.entries(v)) {
        if (k === "$when") continue;
        const filled = fill(child);
        if (filled !== undefined) out[k] = filled;
      }
      return out;
    }
    return v;
  };
  return fill(body);
}

