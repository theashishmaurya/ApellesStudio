/**
 * componentDef.ts — a certified custom component as DATA (D-409).
 *
 * What it is: the shapes a custom Remotion component takes once it is outside
 * its source file. Three of them, one per stage of its life:
 *  - `ComponentSpec` — what an author declares beside the code: an id, a name,
 *    the props it takes (declared as SLOTS, the same typed fields a template
 *    exposes, `../slots.ts`), its box and how long it is meant to play.
 *  - `ComponentMeta` — one library version as the backend stores it
 *    (`<app data>/motion/components/<id>/<version>/meta.json`): the spec plus
 *    its version, status (`draft` | `certified`), the content hashes of the
 *    source and of the compiled module, the static check's warnings, the
 *    certification proof and, once certified, the certificate.
 *  - `ComponentRef` — the copy a MANIFEST embeds (`manifest.components`), so a
 *    project renders without the library: the spec plus the pinned version,
 *    the hashes and the content-addressed asset ids of the compiled module and
 *    its source inside the project (`sha256:<hex>.js`, `sha256:<hex>.tsx`).
 *
 * A layer uses one as `{"use": "custom", "component": "<id>@<version>", "props":
 * {...}}` (`schema.ts`). The props are checked against the pinned ref's slots
 * when the manifest loads, so a typo is a parse error naming the field.
 *
 * What it does NOT do: run, check or compile code (`sourceCheck.ts` checks,
 * `runtime.tsx` runs, in the renderer only), or store anything.
 */
import { z } from "zod";
import { checkSlotValue, templateSlotSchema, type TemplateSlot } from "../slots";
import type { ValidationIssue } from "../engine/issues";
import { formatPath } from "../engine/issues";

/** Component ids are folder names: lowercase kebab, at most 64 (the template
 *  id rule, D-407). */
export const COMPONENT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** `<id>@<version>` — how a layer pins one certified version. */
export const COMPONENT_REF_PATTERN = /^([a-z0-9][a-z0-9-]{0,63})@([1-9][0-9]{0,5})$/;
/** a compiled module in a project's asset folder */
export const COMPONENT_CODE_ID_PATTERN = /^sha256:[0-9a-f]{64}\.js$/;
/** a component's source in a project's asset folder */
export const COMPONENT_SOURCE_ID_PATTERN = /^sha256:[0-9a-f]{64}\.tsx$/;
const HEX64 = /^[0-9a-f]{64}$/;
const TAG_PATTERN = /^[a-z0-9][a-z0-9-]{0,31}$/;

/** The schema version of a library `meta.json` this build writes and reads. */
export const COMPONENT_META_SCHEMA_VERSION = 1;

/**
 * The slot types a component prop may have. `image` and `icon` are left out on
 * purpose: a component cannot import the icon library (not in the import
 * allowlist) and a library component cannot carry a project's image asset as a
 * default, so certification could not render either.
 */
export const COMPONENT_PROP_TYPES = ["text", "number", "color", "enum", "list"] as const;
/** the most props one component declares (the template slot cap) */
export const MAX_COMPONENT_PROPS = 32;
/** the largest box side, px (a 4K frame) */
export const MAX_COMPONENT_SIDE = 4096;
/** the longest declared play time, seconds */
export const MAX_COMPONENT_DURATION = 60;

const boxSide = z.number().int().positive().max(MAX_COMPONENT_SIDE);

/** The author's declaration (everything but the code). */
export const componentSpecSchema = z.object({
  id: z.string().regex(COMPONENT_ID_PATTERN, "lowercase letters, digits and hyphens, at most 64"),
  name: z.string().min(1).max(80),
  description: z.string().max(500).optional(),
  tags: z.array(z.string().regex(TAG_PATTERN, "a tag: lowercase letters, digits, hyphens")).max(12).optional(),
  props: z.array(templateSlotSchema).max(MAX_COMPONENT_PROPS),
  /** the box the component is designed for; a layer's `w`/`h` default to it */
  size: z.object({ w: boxSide, h: boxSide }),
  /** seconds it is meant to play; what certification renders and what the
   *  component's `durationInFrames` is when a layer sets no `dur` */
  duration: z.number().positive().max(MAX_COMPONENT_DURATION),
});
export type ComponentSpec = z.infer<typeof componentSpecSchema>;

/** The copy a manifest embeds under `components["<id>@<version>"]`. */
export const componentRefSchema = componentSpecSchema.extend({
  version: z.number().int().positive(),
  /** SHA-256 of the source text that was certified */
  sourceHash: z.string().regex(HEX64),
  /** SHA-256 of the compiled module that was certified (what renders) */
  codeHash: z.string().regex(HEX64),
  /** the compiled module in the project's asset folder */
  code: z.string().regex(COMPONENT_CODE_ID_PATTERN),
  /** the source in the project's asset folder (provenance; never executed) */
  source: z.string().regex(COMPONENT_SOURCE_ID_PATTERN),
});
export type ComponentRef = z.infer<typeof componentRefSchema>;

/** One issue the static check found (`sourceCheck.ts`), as stored. */
const storedIssue = z.object({
  path: z.string(),
  code: z.string(),
  message: z.string(),
  hint: z.string().optional(),
});

/** What certification proved about one version (`apelles_motion::components`). */
export const componentProofSchema = z.object({
  ok: z.boolean(),
  /** the hashes of exactly what was rendered */
  sourceHash: z.string().regex(HEX64),
  codeHash: z.string().regex(HEX64),
  /** one row per sampled frame: its variant, frame and pixel hash per pass */
  frames: z.array(
    z.object({
      variant: z.string(),
      frame: z.number().int().nonnegative(),
      hashes: z.array(z.string()),
      same: z.boolean(),
      /** how far the in-order pass drifted from the fresh still (the GPU
       *  rasterizer may land 1/255 apart on a few edge pixels; tolerated up to
       *  `IN_ORDER_MAX_DELTA` in `apelles_motion::components`) */
      inOrderMaxDelta: z.number().int().nullable().optional(),
      inOrderPixels: z.number().int().nullable().optional(),
    }),
  ),
  /** how each pass rendered (in order, out of order, …), in pass order */
  passes: z.array(z.string()),
  /** a failure that stopped the proof before it compared anything */
  error: z.string().optional(),
  /** file names inside the version folder, when rendered */
  contactSheet: z.string().optional(),
  thumbnail: z.string().optional(),
});
export type ComponentProof = z.infer<typeof componentProofSchema>;

/** One library version, as `meta.json` holds it. */
export const componentMetaSchema = componentSpecSchema.extend({
  schemaVersion: z.literal(COMPONENT_META_SCHEMA_VERSION),
  version: z.number().int().positive(),
  status: z.enum(["draft", "certified"]),
  sourceHash: z.string().regex(HEX64),
  codeHash: z.string().regex(HEX64),
  /** the static check's non-blocking findings (hard-coded colours) */
  warnings: z.array(storedIssue).optional(),
  proof: componentProofSchema.optional(),
  /** present once certified: the hashes the certificate covers */
  certified: z.object({ sourceHash: z.string().regex(HEX64), codeHash: z.string().regex(HEX64) }).optional(),
});
export type ComponentMeta = z.infer<typeof componentMetaSchema>;

/** `"particle-burst@2"` for an id and version. */
export function componentRefKey(id: string, version: number): string {
  return `${id}@${version}`;
}

/** `"particle-burst@2"` → `{id, version}`; `null` when it is not a pin. */
export function parseComponentRef(ref: string): { id: string; version: number } | null {
  const m = COMPONENT_REF_PATTERN.exec(ref);
  return m ? { id: m[1], version: Number(m[2]) } : null;
}

/** The props a layer gets when it sets none: each declared default. */
export function componentDefaults(def: Pick<ComponentSpec, "props">): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const p of def.props) if (p.default !== undefined) out[p.id] = structuredClone(p.default);
  return out;
}

/** What an `anim` track on a custom layer may target, and of which kind: the
 *  box (`x`, `y`, `w`, `h`) and every number or colour prop (`props.<id>`). */
export function customAnimKind(def: Pick<ComponentSpec, "props">, path: string): "number" | "color" | null {
  if (path === "x" || path === "y" || path === "w" || path === "h") return "number";
  const m = /^props\.([A-Za-z][A-Za-z0-9_]*)$/.exec(path);
  if (!m) return null;
  const slot = def.props.find((p) => p.id === m[1]);
  if (!slot) return null;
  return slot.type === "number" ? "number" : slot.type === "color" ? "color" : null;
}

/**
 * The spec's own rules beyond its shape, as path-precise issues: a prop type a
 * component cannot take, duplicate prop ids, an enum without options, a
 * default that fails its own constraints, and the theme rule — a colour prop
 * has NO default, so a component left unset reads the theme (D-409: "components
 * receive theme tokens and must read colours from them by default").
 */
export function componentSpecIssues(raw: unknown): ValidationIssue[] {
  const parsed = componentSpecSchema.safeParse(raw);
  if (!parsed.success) {
    return parsed.error.issues.map((i) => ({
      path: formatPath(i.path.filter((p): p is string | number => typeof p === "string" || typeof p === "number")),
      code: i.code,
      message: i.message,
    }));
  }
  const spec = parsed.data;
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  spec.props.forEach((p: TemplateSlot, i) => {
    const at = (...rest: (string | number)[]) => formatPath(["props", i, ...rest]);
    if (ids.has(p.id)) issues.push({ path: at("id"), code: "duplicate_prop", message: `duplicate prop id "${p.id}"` });
    ids.add(p.id);
    if (!(COMPONENT_PROP_TYPES as readonly string[]).includes(p.type)) {
      issues.push({
        path: at("type"),
        code: "invalid_value",
        message: `a component prop is one of ${COMPONENT_PROP_TYPES.join(", ")} (got ${p.type})`,
        expected: COMPONENT_PROP_TYPES,
        hint: "a component cannot load project images or the icon library; build those as primitives around it",
      });
    }
    if (p.type === "enum" && !p.constraints?.options) {
      issues.push({ path: at("constraints", "options"), code: "missing_field", message: "an enum prop needs constraints.options" });
    }
    if (p.type === "color" && p.default !== undefined) {
      issues.push({
        path: at("default"),
        code: "colour_default",
        message: "a colour prop has no default: unset, the component reads the theme",
        hint: "drop the default and fall back to theme.accent / theme.text / … in the code",
      });
    } else if (p.default !== undefined) {
      issues.push(...checkSlotValue(p, p.default, ["props", i, "default"]));
    }
  });
  return issues;
}
