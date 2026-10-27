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
import { ICON_NAME_PATTERN } from "./engine/primitiveProps";
import { ASSET_ID_PATTERN } from "./lib/assetId";

/** The schema version this build writes and reads natively. */
export const TEMPLATE_SCHEMA_VERSION = 1;

export const SLOT_TYPES = ["text", "number", "color", "image", "icon", "enum", "list"] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

/** Template ids are file names (`<id>.json`): lowercase kebab, at most 64. */
export const TEMPLATE_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** Slot ids are identifiers (no hyphen), so `{price}` in text is unambiguous. */
export const SLOT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** the most slots one template may declare (a form longer than this is a
 *  different tool). */
export const MAX_SLOTS = 32;
/** the longest a list slot may be. */
export const MAX_LIST_ITEMS = 64;

/** A colour a slot accepts: `#rgb`, `#rrggbb` or `#rrggbbaa` (the forms a
 *  colour picker writes). Narrower than the manifest's colour on purpose: a
 *  slot is a form field, and a named colour typed into it is almost always a
 *  mistake. */
const SLOT_COLOR_PATTERN = /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

export const slotConstraintsSchema = z.object({
  /** text / list items (text): longest string */
  maxLen: z.number().int().positive().optional(),
  minLen: z.number().int().nonnegative().optional(),
  /** number / list items (number) */
  min: z.number().optional(),
  max: z.number().optional(),
  integer: z.boolean().optional(),
  /** enum: the legal values */
  options: z.array(z.string().min(1).max(80)).min(1).max(64).optional(),
  /** list */
  minItems: z.number().int().nonnegative().optional(),
  maxItems: z.number().int().positive().max(MAX_LIST_ITEMS).optional(),
  /** list: what each item is (default text) */
  itemType: z.enum(["text", "number"]).optional(),
});
export type SlotConstraints = z.infer<typeof slotConstraintsSchema>;

export const templateSlotSchema = z.object({
  id: z.string().regex(SLOT_ID_PATTERN, "a slot id: a letter, then letters, digits or _ (at most 48)"),
  type: z.enum(SLOT_TYPES),
  label: z.string().min(1).max(80),
  description: z.string().max(240).optional(),
  default: z.unknown().optional(),
  /** a value must be supplied (or defaulted); absent ⇒ optional */
  required: z.boolean().optional(),
  constraints: slotConstraintsSchema.optional(),
});
export type TemplateSlot = z.infer<typeof templateSlotSchema>;

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

/** Does a resolved value count as "set" (for `$when` and `required`)? An
 *  empty string or list is unset: a blank form field means "none". */
export function hasValue(v: unknown): boolean {
  if (v === undefined || v === null) return false;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

function issue(path: PathSeg[], code: string, message: string, extra: Partial<ValidationIssue> = {}): ValidationIssue {
  return { path: formatPath(path), code, message, ...extra };
}

function checkText(s: unknown, c: SlotConstraints | undefined, path: PathSeg[]): ValidationIssue[] {
  if (typeof s !== "string") return [issue(path, "invalid_type", "expected text", { expected: "string" })];
  if (c?.maxLen !== undefined && s.length > c.maxLen) {
    return [issue(path, "too_big", `at most ${c.maxLen} characters (got ${s.length})`, { expected: `<= ${c.maxLen} characters` })];
  }
  if (c?.minLen !== undefined && s.length < c.minLen) {
    return [issue(path, "too_small", `at least ${c.minLen} characters (got ${s.length})`, { expected: `>= ${c.minLen} characters` })];
  }
  return [];
}

function checkNumber(n: unknown, c: SlotConstraints | undefined, path: PathSeg[]): ValidationIssue[] {
  if (typeof n !== "number" || !Number.isFinite(n)) return [issue(path, "invalid_type", "expected a number", { expected: "number" })];
  if (c?.integer && !Number.isInteger(n)) return [issue(path, "invalid_type", "expected a whole number", { expected: "integer" })];
  if (c?.min !== undefined && n < c.min) return [issue(path, "too_small", `must be >= ${c.min} (got ${n})`, { expected: `>= ${c.min}` })];
  if (c?.max !== undefined && n > c.max) return [issue(path, "too_big", `must be <= ${c.max} (got ${n})`, { expected: `<= ${c.max}` })];
  return [];
}

/**
 * Check one value against its slot. `path` is where to report (`values.price`).
 * `iconNames`, when given, is the installed Phosphor library (an unknown name
 * is `unknown_icon` with the nearest name as a hint); without it only the
 * name's shape is checked (the caller loads the library when it can).
 */
export function checkSlotValue(
  slot: TemplateSlot,
  value: unknown,
  path: PathSeg[],
  iconNames?: ReadonlySet<string>,
): ValidationIssue[] {
  const c = slot.constraints;
  switch (slot.type) {
    case "text":
      return checkText(value, c, path);
    case "number":
      return checkNumber(value, c, path);
    case "color":
      if (typeof value !== "string" || !SLOT_COLOR_PATTERN.test(value)) {
        return [issue(path, "invalid_value", "expected a hex colour (#rgb, #rrggbb or #rrggbbaa)", { expected: "#rrggbb" })];
      }
      return [];
    case "image":
      if (typeof value !== "string" || !ASSET_ID_PATTERN.test(value)) {
        return [
          issue(path, "invalid_value", "expected an asset id: sha256:<64 hex>.<ext>", {
            expected: "sha256:<64 hex>.<png|jpg|jpeg|webp|gif|svg>",
            hint: "import the file with motion_import_asset and pass its id",
          }),
        ];
      }
      return [];
    case "icon": {
      if (typeof value !== "string" || !ICON_NAME_PATTERN.test(value)) {
        return [issue(path, "invalid_value", "expected a Phosphor icon name in kebab-case (rocket-launch)", { expected: "kebab-case name" })];
      }
      if (iconNames && !iconNames.has(value)) {
        const near = closest(value, [...iconNames]);
        return [
          issue(path, "unknown_icon", `"${value}" is not a Phosphor icon`, {
            hint: near ? `did you mean "${near}"?` : "names are phosphoricons.com's, in kebab-case",
          }),
        ];
      }
      return [];
    }
    case "enum": {
      const options = c?.options ?? [];
      if (typeof value !== "string" || !options.includes(value)) {
        const near = typeof value === "string" ? closest(value, options) : undefined;
        return [
          issue(path, "invalid_value", `must be one of: ${options.join(", ")}`, {
            expected: options,
            hint: near ? `did you mean "${near}"?` : undefined,
          }),
        ];
      }
      return [];
    }
    case "list": {
      if (!Array.isArray(value)) return [issue(path, "invalid_type", "expected a list", { expected: "array" })];
      if (c?.maxItems !== undefined && value.length > c.maxItems) {
        return [issue(path, "too_big", `at most ${c.maxItems} items (got ${value.length})`, { expected: `<= ${c.maxItems} items` })];
      }
      if (value.length > MAX_LIST_ITEMS) {
        return [issue(path, "too_big", `at most ${MAX_LIST_ITEMS} items`, { expected: `<= ${MAX_LIST_ITEMS} items` })];
      }
      if (c?.minItems !== undefined && value.length < c.minItems) {
        return [issue(path, "too_small", `at least ${c.minItems} items (got ${value.length})`, { expected: `>= ${c.minItems} items` })];
      }
      const itemCheck = c?.itemType === "number" ? checkNumber : checkText;
      return value.flatMap((item, i) => itemCheck(item, c, [...path, i]));
    }
  }
}

/**
 * The caller's `values` checked against the template's slots and merged over
 * the defaults. `null` for a slot means "no value" (even when the slot has a
 * default), which is how an optional slot is cleared. Issues are reported
 * under `values.<slot>` (`values.features[2]` inside a list), in the same
 * shape `motion_validate` uses; a value for a slot the template does not
 * declare is `unrecognized_key` with the nearest slot as a hint.
 */
export function resolveSlotValues(
  template: Pick<MotionTemplate, "slots">,
  values: unknown,
  iconNames?: ReadonlySet<string>,
): { values: Record<string, unknown>; issues: ValidationIssue[] } {
  const issues: ValidationIssue[] = [];
  if (values !== undefined && values !== null && !isPlainObject(values)) {
    return { values: {}, issues: [issue(["values"], "invalid_type", "values is an object of {slotId: value}", { expected: "object" })] };
  }
  const given = (values ?? {}) as Record<string, unknown>;
  const ids = template.slots.map((s) => s.id);
  for (const key of Object.keys(given)) {
    if (!ids.includes(key)) {
      const near = closest(key, ids);
      issues.push(
        issue(["values", key], "unrecognized_key", `"${key}" is not a slot of this template`, {
          expected: ids,
          hint: near ? `did you mean "${near}"?` : `slots: ${ids.join(", ")}`,
        }),
      );
    }
  }
  const out: Record<string, unknown> = {};
  for (const slot of template.slots) {
    const explicit = Object.prototype.hasOwnProperty.call(given, slot.id);
    const raw = explicit ? given[slot.id] : slot.default;
    if (!hasValue(raw)) {
      if (slot.required) {
        issues.push(issue(["values", slot.id], "missing_field", `"${slot.label}" is required`, { hint: `pass values.${slot.id}` }));
      }
      continue;
    }
    const found = checkSlotValue(slot, raw, ["values", slot.id], iconNames);
    issues.push(...found);
    if (found.length === 0) out[slot.id] = raw;
  }
  return { values: out, issues };
}

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

/** A value of the slot's type for checking a body's STRUCTURE when no default
 *  exists (definition-time dry run). Never shown to anyone. */
export function sampleSlotValue(slot: TemplateSlot): unknown {
  if (slot.default !== undefined) return slot.default;
  const c = slot.constraints;
  switch (slot.type) {
    case "text":
      return "Text".padEnd(c?.minLen ?? 0, "x");
    case "number":
      return c?.min ?? 0;
    case "color":
      return "#888888";
    case "image":
      return `sha256:${"0".repeat(64)}.png`;
    case "icon":
      return "star";
    case "enum":
      return c?.options?.[0] ?? "";
    case "list":
      return Array.from({ length: Math.max(1, c?.minItems ?? 1) }, () => (c?.itemType === "number" ? c?.min ?? 0 : "Item"));
  }
}

/** The slots as one JSON Schema object, for an agent (`motion_list_templates`). */
export function slotsJsonSchema(slots: readonly TemplateSlot[]): Record<string, unknown> {
  const properties: Record<string, unknown> = {};
  for (const s of slots) {
    const c = s.constraints;
    const base: Record<string, unknown> = { title: s.label, ...(s.description ? { description: s.description } : {}) };
    if (s.default !== undefined) base.default = s.default;
    switch (s.type) {
      case "text":
        Object.assign(base, { type: "string", ...(c?.maxLen !== undefined ? { maxLength: c.maxLen } : {}), ...(c?.minLen !== undefined ? { minLength: c.minLen } : {}) });
        break;
      case "number":
        Object.assign(base, { type: c?.integer ? "integer" : "number", ...(c?.min !== undefined ? { minimum: c.min } : {}), ...(c?.max !== undefined ? { maximum: c.max } : {}) });
        break;
      case "color":
        Object.assign(base, { type: "string", format: "color", pattern: SLOT_COLOR_PATTERN.source });
        break;
      case "image":
        Object.assign(base, { type: "string", pattern: ASSET_ID_PATTERN.source, description: `${s.description ? `${s.description} ` : ""}(an id from motion_import_asset)` });
        break;
      case "icon":
        Object.assign(base, { type: "string", pattern: ICON_NAME_PATTERN.source, description: `${s.description ? `${s.description} ` : ""}(a Phosphor icon name)` });
        break;
      case "enum":
        Object.assign(base, { type: "string", enum: c?.options ?? [] });
        break;
      case "list":
        Object.assign(base, {
          type: "array",
          items: c?.itemType === "number" ? { type: "number" } : { type: "string", ...(c?.maxLen !== undefined ? { maxLength: c.maxLen } : {}) },
          ...(c?.minItems !== undefined ? { minItems: c.minItems } : {}),
          ...(c?.maxItems !== undefined ? { maxItems: c.maxItems } : {}),
        });
        break;
    }
    properties[s.id] = base;
  }
  return {
    type: "object",
    properties,
    required: slots.filter((s) => s.required && s.default === undefined).map((s) => s.id),
    additionalProperties: false,
  };
}
