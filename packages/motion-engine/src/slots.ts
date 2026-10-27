/**
 * slots.ts — a typed, constrained FIELD as data: the "slot" a template exposes
 * (D-407) and the "prop" a certified custom component declares (D-409).
 *
 * What it is: the slot schema (`templateSlotSchema`: id, type, label,
 * description, default, required, constraints), the check of one value against
 * its slot (`checkSlotValue`), resolving a caller's values against a slot list
 * (`resolveSlotValues`), a sample value for a structural dry run, and the JSON
 * Schema an agent reads. Moved here from `templateDef.ts` unchanged when D-409
 * gave it a second user: the manifest schema checks a custom layer's props
 * against its component's declared slots, and `schema.ts` cannot import
 * `templateDef.ts` (which imports the validator, which imports the schema).
 * `templateDef.ts` re-exports everything here, so its importers are unchanged.
 *
 * What it does NOT do: know what a slot is bound to (a template body or a
 * component prop), or load the icon library (callers pass the names in).
 */
import { z } from "zod";
import { closest, formatPath, type ValidationIssue } from "./engine/issues";
import { ICON_NAME_PATTERN } from "./engine/primitiveProps";
import { ASSET_ID_PATTERN } from "./lib/assetId";

export const SLOT_TYPES = ["text", "number", "color", "image", "icon", "enum", "list"] as const;
export type SlotType = (typeof SLOT_TYPES)[number];

/** Slot ids are identifiers (no hyphen), so `{price}` in text is unambiguous. */
export const SLOT_ID_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;
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

type PathSeg = string | number;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

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

/** Where `resolveSlotValues` reports and what it calls the fields: a
 *  template's `values` (the default) or a custom component's `props`. */
export interface SlotReportOptions {
  /** the path every issue starts with (default `["values"]`) */
  root?: PathSeg[];
  /** how an unknown key is described (default "a slot of this template") */
  owner?: string;
}

/**
 * The caller's `values` checked against the slots and merged over the
 * defaults. `null` for a slot means "no value" (even when the slot has a
 * default), which is how an optional slot is cleared. Issues are reported
 * under `values.<slot>` (`values.features[2]` inside a list) — or under
 * `opts.root` — in the same shape `motion_validate` uses; a value for a slot
 * that is not declared is `unrecognized_key` with the nearest slot as a hint.
 */
export function resolveSlotValues(
  template: { slots: readonly TemplateSlot[] },
  values: unknown,
  iconNames?: ReadonlySet<string>,
  opts: SlotReportOptions = {},
): { values: Record<string, unknown>; issues: ValidationIssue[] } {
  const root = opts.root ?? ["values"];
  const owner = opts.owner ?? "a slot of this template";
  const rootName = formatPath(root);
  const issues: ValidationIssue[] = [];
  if (values !== undefined && values !== null && !isPlainObject(values)) {
    return { values: {}, issues: [issue(root, "invalid_type", `${rootName} is an object of {slotId: value}`, { expected: "object" })] };
  }
  const given = (values ?? {}) as Record<string, unknown>;
  const ids = template.slots.map((s) => s.id);
  for (const key of Object.keys(given)) {
    if (!ids.includes(key)) {
      const near = closest(key, ids);
      issues.push(
        issue([...root, key], "unrecognized_key", `"${key}" is not ${owner}`, {
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
        issues.push(issue([...root, slot.id], "missing_field", `"${slot.label}" is required`, { hint: `pass ${rootName}.${slot.id}` }));
      }
      continue;
    }
    const found = checkSlotValue(slot, raw, [...root, slot.id], iconNames);
    issues.push(...found);
    if (found.length === 0) out[slot.id] = raw;
  }
  return { values: out, issues };
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
