/**
 * D-403 — the per-primitive layer schema and the validator agents act on.
 *
 * What is pinned here: (1) the layer schema is a discriminated union that
 * type-checks known props and still LOADS unknown ones; (2) the validator's
 * issues carry a path, a stable code, what was expected and a usable hint;
 * (3) the strict pass finds an unknown key at any depth; (4) every primitive
 * publishes a JSON Schema built from the same zod object.
 */
import { describe, expect, it } from "vitest";
import { layerSchema, manifestSchema } from "./schema";
import { PRIMITIVE_USES } from "./primitiveProps";
import { primitiveJsonSchema } from "./jsonSchema";
import { formatIssues, formatPath, validateLayers, validateManifest, validateScene } from "./validate";

const doc = (layers: unknown[]) => ({ title: "t", scenes: [{ id: "s", dur: 2, layers }] });

describe("layer schema (D-403)", () => {
  it("accepts a well-typed layer of every primitive's catalogue shape", () => {
    expect(layerSchema.safeParse({ use: "text", text: "hi", size: 40, color: "#fff" }).success).toBe(true);
    expect(layerSchema.safeParse({ use: "matrix", rows: 2, cols: 3 }).success).toBe(true);
    expect(layerSchema.safeParse({ use: "particleflow", preset: "stream" }).success).toBe(true);
  });

  it("refuses a known prop with the wrong type, naming the field", () => {
    const r = manifestSchema.safeParse(doc([{ use: "text", text: "hi", size: "big" }]));
    expect(r.success).toBe(false);
    expect(r.error?.issues[0].path).toEqual(["scenes", 0, "layers", 0, "size"]);
  });

  it("still LOADS an unknown key and keeps it in the parse output (existing files)", () => {
    const r = manifestSchema.safeParse(doc([{ use: "text", text: "hi", legacyThing: 3 }]));
    expect(r.success).toBe(true);
    expect((r.data?.scenes[0].layers?.[0] as Record<string, unknown>).legacyThing).toBe(3);
  });

  it("keeps unknown keys inside nested content too (no silent stripping)", () => {
    const r = manifestSchema.safeParse(
      doc([{ use: "graph", nodes: [{ id: "a", note: "x" }], edges: [] }]),
    );
    expect(r.success).toBe(true);
    const node = (r.data?.scenes[0].layers?.[0] as { nodes: Record<string, unknown>[] }).nodes[0];
    expect(node.note).toBe("x");
  });
});

describe("validate (D-403)", () => {
  it("reports a missing required prop as missing_field with a hint", () => {
    const r = validateLayers([{ use: "matrix", rows: 2 }]);
    expect(r.ok).toBe(false);
    expect(r.loads).toBe(false);
    expect(r.issues).toEqual([
      expect.objectContaining({ path: "layers[0].cols", code: "missing_field", expected: "number", hint: 'add "cols"' }),
    ]);
  });

  it("reports an unknown use with the legal ones and a did-you-mean", () => {
    const r = validateLayers([{ use: "txt", text: "x" }]);
    expect(r.issues[0]).toMatchObject({ path: "layers[0].use", code: "unknown_use", hint: 'did you mean "text"?' });
    // D-409 — plus `custom` (a certified component, pinned by `component`).
    expect(r.issues[0].expected).toEqual([...PRIMITIVE_USES, "custom"]);
  });

  it("reports a bad enum value with the options and the nearest one", () => {
    const r = validateLayers([{ use: "text", text: "x", preset: "fadeup" }]);
    expect(r.issues[0]).toMatchObject({
      path: "layers[0].preset",
      code: "invalid_value",
      expected: ["fade-up", "mask-up", "type", "stroke-on"],
      hint: 'did you mean "fade-up"?',
    });
  });

  it("flags an unknown key as unrecognized_key (ok=false) while the layer still loads", () => {
    const r = validateLayers([{ use: "text", text: "x", colour: "#fff" }]);
    expect(r.loads).toBe(true);
    expect(r.ok).toBe(false);
    expect(r.issues[0]).toMatchObject({ path: "layers[0].colour", code: "unrecognized_key", hint: 'did you mean "color"?' });
    expect(r.issues[0].expected).toContain("color");
  });

  it("finds an unknown key deep inside nested content", () => {
    const r = validateLayers([
      { use: "graph", nodes: [{ id: "a" }, { id: "b" }], edges: [{ from: "a", to: "b", wieght: 0.5 }] },
    ]);
    expect(r.issues).toEqual([
      expect.objectContaining({ path: "layers[0].edges[0].wieght", code: "unrecognized_key", hint: 'did you mean "weight"?' }),
    ]);
  });

  it("finds unknown keys in the transform and on the scene", () => {
    const r = validateScene({ id: "s", dur: 1, bgColor: "#000", layers: [{ use: "text", text: "x", transform: { scal: 2 } }] }, 0);
    const paths = r.issues.map((i) => i.path);
    expect(paths).toContain("scenes[0].bgColor");
    expect(paths).toContain("scenes[0].layers[0].transform.scal");
  });

  it("an ease with x out of [0,1] is refused with the refine's message", () => {
    const r = validateLayers([{ use: "text", text: "x", transform: { keys: [{ at: 0, ease: [2, 0, 0.5, 1] }] } }]);
    expect(r.loads).toBe(false);
    expect(r.issues[0].message).toContain("ease x1/x2");
  });

  it("a valid manifest is ok and loads", () => {
    expect(validateManifest(doc([{ use: "text", text: "x" }]))).toEqual({ ok: true, loads: true, issues: [] });
  });

  it("formats paths and issue lists readably", () => {
    expect(formatPath(["scenes", 0, "layers", 2, "size"])).toBe("scenes[0].layers[2].size");
    expect(formatIssues([{ path: "a.b", code: "x", message: "bad", hint: "fix it" }])).toBe("a.b: bad (fix it)");
  });
});

describe("primitiveJsonSchema (D-403)", () => {
  it("publishes a JSON Schema for every primitive, closed to unknown keys", () => {
    for (const use of PRIMITIVE_USES) {
      const js = primitiveJsonSchema(use);
      expect(js.type).toBe("object");
      expect(js.additionalProperties).toBe(false);
      const props = js.properties as Record<string, { const?: string }>;
      expect(props.use.const).toBe(use);
    }
  });

  it("marks colour props with format: color", () => {
    const props = primitiveJsonSchema("text").properties as Record<string, Record<string, unknown>>;
    expect(props.color.format).toBe("color");
  });

  it("lists required props as required", () => {
    expect(primitiveJsonSchema("matrix").required).toEqual(expect.arrayContaining(["use", "rows", "cols"]));
  });
});
