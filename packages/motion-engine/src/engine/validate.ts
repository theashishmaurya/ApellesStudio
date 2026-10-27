/**
 * Manifest validation that an agent (or a person) can act on (D-403, Phase 0
 * of `docs/notes/motion-authoring-mcp.md`).
 *
 * What it is: one function per fragment size — a whole manifest, one scene, a
 * list of layers — each returning `{ok, loads, issues}` where every issue is
 * `{path, code, message, expected?, hint?}`. It is the ONE validator behind
 * `motion_validate`, behind the refusal of every mutating `motion_*` op, and
 * behind the manifest editor's error list, so the three can never disagree
 * about what is wrong.
 *
 * Two levels, on purpose:
 *  - `loads` — does the document parse under `manifestSchema`, i.e. would the
 *    app accept it as-is? Types of known fields are enforced here. This is the
 *    level EVERY commit must pass, because a commit that does not parse leaves
 *    the app showing a parse error and the old picture.
 *  - `ok` — `loads`, AND no unknown keys anywhere (the strict pass below). An
 *    unknown key is almost always a typo (`colour`, `wieght`) that renders as
 *    nothing at all, so the AUTHORING paths refuse it; loading tolerates it,
 *    because existing project files may carry keys no schema knows.
 *
 * What it does NOT do: semantic checks that need more than the document and
 * a synchronous schema (does an icon name exist in the icon library, does an
 * asset id name a file this project holds). Those are added by the caller.
 */
import { z } from "zod";
import { layerSchema, manifestSchema, sceneSchema } from "./schema";
import { defOf, optionFor, unwrap } from "./zodIntrospect";

export { defOf, unwrap };

export interface ValidationIssue {
  /** where, as `scenes[0].layers[2].size` (empty string for the root). */
  path: string;
  /** a stable machine code: zod's own (`invalid_type`, `invalid_value`,
   *  `too_small`, ...) or one of ours (`unrecognized_key`, `unknown_use`). */
  code: string;
  message: string;
  /** what would have been accepted, when that is knowable. */
  expected?: unknown;
  /** what to do about it, when there is something specific to say. */
  hint?: string;
}

export interface ValidationResult {
  /** no issues at all, unknown keys included — what authoring requires. */
  ok: boolean;
  /** parses under the manifest schema — what loading requires. */
  loads: boolean;
  issues: ValidationIssue[];
}

type PathSeg = string | number;

/** `["scenes", 0, "layers", 2, "size"]` → `scenes[0].layers[2].size`. */
export function formatPath(path: readonly PathSeg[]): string {
  let out = "";
  for (const seg of path) {
    if (typeof seg === "number") out += `[${seg}]`;
    else out += out ? `.${seg}` : seg;
  }
  return out;
}

/** Levenshtein distance, for "did you mean". Small strings only. */
function distance(a: string, b: string): number {
  const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...new Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) dp[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1].toLowerCase() === b[j - 1].toLowerCase() ? 0 : 1),
      );
    }
  }
  return dp[a.length][b.length];
}

/** the closest candidate within a typo's reach, or `undefined`. */
export function closest(word: string, candidates: readonly string[]): string | undefined {
  let best: string | undefined;
  let bestD = Infinity;
  for (const c of candidates) {
    const d = distance(word, c);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  const reach = Math.max(2, Math.floor(word.length / 3));
  return bestD <= reach ? best : undefined;
}

// --------------------------------------------------------------------------
// walking a zod schema alongside the data
// --------------------------------------------------------------------------

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** The object keys `schema` declares at `data`, or `undefined` when the
 *  schema there is not an object. */
function objectKeys(schema: z.ZodType, data: unknown): string[] | undefined {
  const s = unwrap(schema);
  const d = defOf(s);
  if (d.type === "object" && d.shape) return Object.keys(d.shape);
  if (d.type === "union") {
    const opt = optionFor(d, data);
    return opt ? objectKeys(opt, data) : undefined;
  }
  return undefined;
}

/**
 * The strict pass: every key in `data` that the schema at that point does
 * not declare, as an `unrecognized_key` issue with the declared keys as
 * `expected` and the nearest one as a hint. Recurses through objects,
 * arrays, tuples, records and unions (following the option the data actually
 * belongs to), so a typo inside `graph.edges[3]` is found as surely as one at
 * the top of a layer.
 */
export function unknownKeyIssues(schema: z.ZodType, data: unknown, path: PathSeg[] = []): ValidationIssue[] {
  const s = unwrap(schema);
  const d = defOf(s);
  const out: ValidationIssue[] = [];
  if (d.type === "object" && d.shape && isPlainObject(data)) {
    const known = Object.keys(d.shape);
    for (const key of Object.keys(data)) {
      const child = d.shape[key];
      if (!child) {
        const near = closest(key, known);
        out.push({
          path: formatPath([...path, key]),
          code: "unrecognized_key",
          message: `"${key}" is not a field here`,
          expected: known,
          hint: near ? `did you mean "${near}"?` : `known fields: ${known.join(", ")}`,
        });
      } else {
        out.push(...unknownKeyIssues(child, data[key], [...path, key]));
      }
    }
  } else if (d.type === "array" && d.element && Array.isArray(data)) {
    data.forEach((item, i) => out.push(...unknownKeyIssues(d.element as z.ZodType, item, [...path, i])));
  } else if (d.type === "tuple" && d.items && Array.isArray(data)) {
    data.forEach((item, i) => {
      const item_schema = d.items?.[i] ?? d.rest ?? undefined;
      if (item_schema) out.push(...unknownKeyIssues(item_schema, item, [...path, i]));
    });
  } else if (d.type === "record" && d.valueType && isPlainObject(data)) {
    for (const [k, v] of Object.entries(data)) out.push(...unknownKeyIssues(d.valueType, v, [...path, k]));
  } else if (d.type === "union") {
    const opt = optionFor(d, data);
    if (opt) out.push(...unknownKeyIssues(opt, data, path));
  }
  return out;
}

// --------------------------------------------------------------------------
// zod issues → ValidationIssue
// --------------------------------------------------------------------------

/** Walk `schema` down `path` (following `data` through unions) to the schema
 *  that owns the last segment's PARENT object — used to name the known keys
 *  when a required field is missing. */
function schemaAt(schema: z.ZodType, data: unknown, path: readonly PathSeg[]): z.ZodType | undefined {
  let s: z.ZodType | undefined = schema;
  let v: unknown = data;
  for (const seg of path) {
    if (!s) return undefined;
    let u = unwrap(s);
    let d = defOf(u);
    if (d.type === "union") {
      const opt = optionFor(d, v);
      if (!opt) return undefined;
      u = unwrap(opt);
      d = defOf(u);
    }
    if (d.type === "object" && d.shape && typeof seg === "string") s = d.shape[seg];
    else if (d.type === "array" && d.element) s = d.element;
    else if (d.type === "tuple" && d.items && typeof seg === "number") s = d.items[seg] ?? d.rest ?? undefined;
    else if (d.type === "record" && d.valueType) s = d.valueType;
    else return undefined;
    v = isPlainObject(v) || Array.isArray(v) ? (v as Record<string | number, unknown>)[seg] : undefined;
  }
  return s;
}

function valueAt(data: unknown, path: readonly PathSeg[]): unknown {
  let v = data;
  for (const seg of path) {
    if (!isPlainObject(v) && !Array.isArray(v)) return undefined;
    v = (v as Record<string | number, unknown>)[seg];
  }
  return v;
}

/** One zod issue as one or more `ValidationIssue`s, with `expected` and a hint
 *  filled in where the issue carries enough to say something specific. */
function convertIssue(issue: z.core.$ZodIssue, schema: z.ZodType, data: unknown, prefix: PathSeg[]): ValidationIssue[] {
  const rel = issue.path.filter((p): p is PathSeg => typeof p === "string" || typeof p === "number");
  const path = formatPath([...prefix, ...rel]);
  switch (issue.code) {
    case "invalid_type": {
      const missing = valueAt(data, rel) === undefined;
      return [
        {
          path,
          code: missing ? "missing_field" : "invalid_type",
          message: missing ? `required field is missing (${issue.expected})` : issue.message,
          expected: issue.expected,
          hint: missing ? `add "${String(rel[rel.length - 1] ?? "")}"` : undefined,
        },
      ];
    }
    case "invalid_value": {
      const got = valueAt(data, rel);
      const values = issue.values.map((v) => String(v));
      const near = typeof got === "string" ? closest(got, values) : undefined;
      return [
        {
          path,
          code: "invalid_value",
          message: issue.message,
          expected: issue.values,
          hint: near ? `did you mean "${near}"?` : undefined,
        },
      ];
    }
    case "invalid_union": {
      const disc = (issue as { discriminator?: string }).discriminator;
      const options = (issue as { options?: unknown[] }).options;
      if (disc && options) {
        const got = valueAt(data, rel);
        const values = options.map((v) => String(v));
        const near = typeof got === "string" ? closest(got, values) : undefined;
        return [
          {
            path,
            code: disc === "use" ? "unknown_use" : "invalid_value",
            message:
              got === undefined
                ? `"${disc}" is required`
                : `"${String(got)}" is not a ${disc === "use" ? "primitive" : disc}`,
            expected: options,
            hint: near
              ? `did you mean "${near}"?`
              : disc === "use"
                ? "motion_list_primitives lists every primitive and its props"
                : undefined,
          },
        ];
      }
      return [{ path, code: "invalid_union", message: issue.message }];
    }
    case "too_small":
      return [{ path, code: "too_small", message: issue.message, expected: `>= ${String(issue.minimum)}` }];
    case "too_big":
      return [{ path, code: "too_big", message: issue.message, expected: `<= ${String(issue.maximum)}` }];
    case "unrecognized_keys": {
      const known = objectKeys(schemaAt(schema, data, rel) ?? schema, valueAt(data, rel)) ?? [];
      return issue.keys.map((key) => {
        const near = closest(key, known);
        return {
          path: formatPath([...prefix, ...rel, key]),
          code: "unrecognized_key",
          message: `"${key}" is not a field here`,
          expected: known,
          hint: near ? `did you mean "${near}"?` : undefined,
        };
      });
    }
    default:
      return [{ path, code: issue.code, message: issue.message }];
  }
}

/** Every zod issue in `error`, converted, with `prefix` put in front of each
 *  path (e.g. `["layers", 3]` when validating one element of a list). */
export function issuesFromZod(
  error: z.ZodError,
  schema: z.ZodType,
  data: unknown,
  prefix: PathSeg[] = [],
): ValidationIssue[] {
  return error.issues.flatMap((i) => convertIssue(i, schema, data, prefix));
}

function check(schema: z.ZodType, data: unknown, prefix: PathSeg[]): ValidationResult {
  const parsed = schema.safeParse(data);
  const typeIssues = parsed.success ? [] : issuesFromZod(parsed.error, schema, data, prefix);
  const keyIssues = unknownKeyIssues(schema, data, prefix);
  // A key zod already reported as unrecognised (a strict object somewhere) is
  // not reported twice.
  const seen = new Set(typeIssues.map((i) => `${i.code}:${i.path}`));
  const issues = [...typeIssues, ...keyIssues.filter((i) => !seen.has(`${i.code}:${i.path}`))];
  return { ok: issues.length === 0, loads: parsed.success, issues };
}

/** A whole manifest. */
export function validateManifest(data: unknown): ValidationResult {
  return check(manifestSchema, data, []);
}

/** One scene, reported under `scenes[sceneIndex]` when an index is given. */
export function validateScene(data: unknown, sceneIndex?: number): ValidationResult {
  return check(sceneSchema, data, sceneIndex === undefined ? ["scene"] : ["scenes", sceneIndex]);
}

/** A list of layers, each reported under `<container>[i]` (`layers` unless
 *  the caller says otherwise). */
export function validateLayers(data: unknown, container: PathSeg[] = ["layers"]): ValidationResult {
  if (!Array.isArray(data)) {
    return {
      ok: false,
      loads: false,
      issues: [{ path: formatPath(container), code: "invalid_type", message: "expected an array of layers", expected: "array" }],
    };
  }
  const results = data.map((layer, i) => check(layerSchema, layer, [...container, i]));
  const issues = results.flatMap((r) => r.issues);
  return { ok: issues.length === 0, loads: results.every((r) => r.loads), issues };
}

/** Several results as one (an op that validates a fragment AND the document
 *  it lands in reports both). */
export function mergeResults(...results: ValidationResult[]): ValidationResult {
  const issues = results.flatMap((r) => r.issues);
  return { ok: issues.length === 0, loads: results.every((r) => r.loads), issues };
}

/** The issues as text lines — the manifest editor's error panel and an op's
 *  `error` string both read this, so the wording is the same everywhere. */
export function formatIssues(issues: readonly ValidationIssue[]): string {
  return issues
    .map((i) => `${i.path || "(root)"}: ${i.message}${i.hint ? ` (${i.hint})` : ""}`)
    .join("\n");
}

/**
 * D-405 — the semantic check a schema cannot make synchronously: every `icon`
 * layer (at any depth, group children included) names an icon that exists in
 * the installed Phosphor library. `known` is that library's names
 * (`../lib/phosphorIcons.ts`'s map keys), loaded by the caller. Issues carry
 * `code: "unknown_icon"` and the nearest real name as a hint.
 */
export function iconIssues(data: unknown, known: ReadonlySet<string>, root: PathSeg[] = []): ValidationIssue[] {
  const out: ValidationIssue[] = [];
  const names = [...known];
  const walk = (v: unknown, path: PathSeg[]) => {
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, [...path, i]));
      return;
    }
    if (!isPlainObject(v)) return;
    if (v.use === "icon" && typeof v.name === "string" && !known.has(v.name)) {
      const near = closest(v.name, names);
      out.push({
        path: formatPath([...path, "name"]),
        code: "unknown_icon",
        message: `"${v.name}" is not a Phosphor icon`,
        hint: near ? `did you mean "${near}"?` : "names are phosphoricons.com's, in kebab-case (rocket-launch)",
      });
    }
    for (const [k, child] of Object.entries(v)) walk(child, [...path, k]);
  };
  walk(data, root);
  return out;
}

/** does `data` contain an `icon` layer anywhere? (whether to load the library) */
export function containsIcon(data: unknown): boolean {
  if (Array.isArray(data)) return data.some(containsIcon);
  if (!isPlainObject(data)) return false;
  if (data.use === "icon") return true;
  return Object.values(data).some(containsIcon);
}

/** `result` with `extra` issues added (a semantic pass after the schema). */
export function withIssues(result: ValidationResult, extra: readonly ValidationIssue[]): ValidationResult {
  if (extra.length === 0) return result;
  const issues = [...result.issues, ...extra];
  return { ok: false, loads: result.loads, issues };
}
