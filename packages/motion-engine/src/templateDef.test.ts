/**
 * templateDef.test.ts — the template schema, its migration hook, slot value
 * checks, value resolution and body filling (D-407).
 */
import { describe, expect, it } from "vitest";
import {
  checkSlotValue,
  fillTemplateBody,
  interpolate,
  migrateTemplate,
  parseTemplate,
  resolveSlotValues,
  sampleSlotValue,
  slotsJsonSchema,
  TEMPLATE_SCHEMA_VERSION,
  type TemplateSlot,
} from "./templateDef";
import { sceneSchema, layerSchema } from "./engine/schema";

const LOGO = `sha256:${"a".repeat(64)}.png`;

const base = (over: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  id: "card",
  name: "Card",
  version: 1,
  kind: "scene",
  authoredAt: { width: 1920, height: 1080, fps: 30 },
  slots: [{ id: "title", type: "text", label: "Title", default: "Hello" }],
  body: { dur: 2, layers: [{ use: "text", text: { $slot: "title" } }] },
  ...over,
});

const issuesOf = (raw: unknown) => {
  const r = parseTemplate(raw);
  return "issues" in r ? r.issues : [];
};

describe("the template schema", () => {
  it("accepts a minimal scene template", () => {
    const r = parseTemplate(base());
    expect("template" in r && r.template.id).toBe("card");
  });

  it("refuses a duplicate slot, an enum without options and a default of the wrong type", () => {
    const issues = issuesOf(
      base({
        slots: [
          { id: "title", type: "text", label: "A" },
          { id: "title", type: "text", label: "B" },
          { id: "tier", type: "enum", label: "Tier" },
          { id: "n", type: "number", label: "N", default: "seven" },
        ],
      }),
    );
    const paths = issues.map((i) => i.path);
    expect(paths).toContain("slots[1].id");
    expect(paths).toContain("slots[2].constraints.options");
    expect(paths).toContain("slots[3].default");
  });

  it("names a binding to an undeclared slot, with the nearest slot as a hint", () => {
    const issues = issuesOf(base({ body: { dur: 2, layers: [{ use: "text", text: { $slot: "titel" } }] } }));
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("body.layers[0].text");
    expect(issues[0].message).toContain('did you mean "title"?');
  });

  it("checks interpolations and $when against the slots too", () => {
    const issues = issuesOf(
      base({ body: { dur: 2, layers: [{ use: "text", text: "{title} {nope}", $when: "missing" }] } }),
    );
    expect(issues.map((i) => i.path).sort()).toEqual(["body.layers[0].$when", "body.layers[0].text"]);
  });

  it("refuses an id in a scene body, malformed markers, and an empty group body", () => {
    expect(issuesOf(base({ body: { id: "x", dur: 2 } }))[0].path).toBe("body.id");
    const malformed = issuesOf(
      base({ body: { dur: 2, $when: "title", layers: [{ use: "text", text: { $slot: "title", extra: 1 } }] } }),
    );
    expect(malformed.map((i) => i.path).sort()).toEqual(["body.$when", "body.layers[0].text"]);
    expect(issuesOf(base({ kind: "group", body: [] }))[0].path).toBe("body");
  });

  it("refuses bad ids, tags and a non-integer canvas", () => {
    const issues = issuesOf(base({ id: "Card One", tags: ["Brand"], authoredAt: { width: 19.5, height: 1080, fps: 30 } }));
    expect(issues.map((i) => i.path).sort()).toEqual(["authoredAt.width", "id", "tags[0]"]);
  });
});

describe("migration by schemaVersion", () => {
  it("passes the current version through", () => {
    const r = migrateTemplate(base());
    expect("raw" in r && r.raw.schemaVersion).toBe(TEMPLATE_SCHEMA_VERSION);
  });

  it("refuses a missing version and a newer one, naming why", () => {
    const missing = migrateTemplate({ ...base(), schemaVersion: undefined });
    expect("error" in missing && missing.error).toContain("schemaVersion");
    const newer = migrateTemplate(base({ schemaVersion: TEMPLATE_SCHEMA_VERSION + 1 }));
    expect("error" in newer && newer.error).toContain("newer than this app");
    expect(issuesOf(base({ schemaVersion: 9 }))[0]).toMatchObject({ path: "schemaVersion", code: "invalid_value" });
  });
});

describe("checking a value against its slot", () => {
  const slot = (s: Partial<TemplateSlot> & Pick<TemplateSlot, "type">): TemplateSlot => ({ id: "v", label: "V", ...s });
  const at = ["values", "v"];

  it("text: type and length", () => {
    expect(checkSlotValue(slot({ type: "text", constraints: { maxLen: 3 } }), "abcd", at)[0]).toMatchObject({ path: "values.v", code: "too_big" });
    expect(checkSlotValue(slot({ type: "text", constraints: { minLen: 2 } }), "a", at)[0].code).toBe("too_small");
    expect(checkSlotValue(slot({ type: "text" }), 3, at)[0].code).toBe("invalid_type");
  });

  it("number: range and integer", () => {
    const s = slot({ type: "number", constraints: { min: 0, max: 3, integer: true } });
    expect(checkSlotValue(s, 2, at)).toEqual([]);
    expect(checkSlotValue(s, 4, at)[0].code).toBe("too_big");
    expect(checkSlotValue(s, -1, at)[0].code).toBe("too_small");
    expect(checkSlotValue(s, 1.5, at)[0].expected).toBe("integer");
    expect(checkSlotValue(s, Number.NaN, at)[0].code).toBe("invalid_type");
  });

  it("color: hex only", () => {
    expect(checkSlotValue(slot({ type: "color" }), "#1a2b3c", at)).toEqual([]);
    expect(checkSlotValue(slot({ type: "color" }), "#abc", at)).toEqual([]);
    expect(checkSlotValue(slot({ type: "color" }), "red", at)[0].code).toBe("invalid_value");
  });

  it("image: a content-hash asset id, never a path", () => {
    expect(checkSlotValue(slot({ type: "image" }), LOGO, at)).toEqual([]);
    const bad = checkSlotValue(slot({ type: "image" }), "/Users/me/logo.png", at)[0];
    expect(bad.code).toBe("invalid_value");
    expect(bad.hint).toContain("motion_import_asset");
  });

  it("icon: kebab shape, and membership when the library is given", () => {
    const icons = new Set(["rocket-launch", "star"]);
    expect(checkSlotValue(slot({ type: "icon" }), "rocket-launch", at, icons)).toEqual([]);
    expect(checkSlotValue(slot({ type: "icon" }), "RocketLaunch", at)[0].code).toBe("invalid_value");
    const unknown = checkSlotValue(slot({ type: "icon" }), "rocket-lanch", at, icons)[0];
    expect(unknown).toMatchObject({ code: "unknown_icon", hint: 'did you mean "rocket-launch"?' });
    expect(checkSlotValue(slot({ type: "icon" }), "rocket-lanch", at)).toEqual([]);
  });

  it("enum: one of the options, with a did-you-mean", () => {
    const s = slot({ type: "enum", constraints: { options: ["monthly", "yearly"] } });
    expect(checkSlotValue(s, "yearly", at)).toEqual([]);
    expect(checkSlotValue(s, "yeraly", at)[0]).toMatchObject({ code: "invalid_value", hint: 'did you mean "yearly"?' });
  });

  it("list: length and each item, with the item's index in the path", () => {
    const s = slot({ type: "list", constraints: { maxItems: 3, maxLen: 5 } });
    expect(checkSlotValue(s, ["a", "b"], at)).toEqual([]);
    expect(checkSlotValue(s, ["a", "b", "c", "d"], at)[0].code).toBe("too_big");
    expect(checkSlotValue(s, ["a", "toolong"], at)[0]).toMatchObject({ path: "values.v[1]", code: "too_big" });
    const nums = slot({ type: "list", constraints: { itemType: "number", max: 10 } });
    expect(checkSlotValue(nums, [1, 20], at)[0].path).toBe("values.v[1]");
    expect(checkSlotValue(nums, "1,2", at)[0].code).toBe("invalid_type");
  });
});

describe("resolving values", () => {
  const slots: TemplateSlot[] = [
    { id: "title", type: "text", label: "Title", required: true },
    { id: "accent", type: "color", label: "Accent" },
    { id: "icon", type: "icon", label: "Icon", default: "star" },
  ];

  it("merges over defaults and reports unknown and missing values by path", () => {
    const r = resolveSlotValues({ slots }, { titl: "x" });
    expect(r.issues.map((i) => [i.path, i.code])).toEqual([
      ["values.titl", "unrecognized_key"],
      ["values.title", "missing_field"],
    ]);
    expect(r.issues[0].hint).toBe('did you mean "title"?');
    const ok = resolveSlotValues({ slots }, { title: "Hi" });
    expect(ok).toEqual({ values: { title: "Hi", icon: "star" }, issues: [] });
  });

  it("null clears a slot even when it has a default; a non-object is refused", () => {
    expect(resolveSlotValues({ slots }, { title: "Hi", icon: null }).values).toEqual({ title: "Hi" });
    expect(resolveSlotValues({ slots }, [1]).issues[0]).toMatchObject({ path: "values", code: "invalid_type" });
  });
});

describe("filling a body", () => {
  it("replaces bindings, drops unset keys, interpolates, and honours $when", () => {
    const body = {
      dur: 2,
      layers: [
        { use: "text", text: "{plan}: {{{price}}}/mo", color: { $slot: "accent" } },
        { $when: "logo", use: "image", src: { $slot: "logo" } },
        { $when: "plan", use: "text", text: "{features}" },
      ],
    };
    const out = fillTemplateBody(body, { plan: "Pro", price: 29, features: ["A", "B"] }) as {
      layers: Record<string, unknown>[];
    };
    expect(out.layers).toEqual([
      { use: "text", text: "Pro: {29}/mo" },
      { use: "text", text: "A\nB" },
    ]);
    // the result parses as a scene: no marker leaks into the document
    expect(sceneSchema.safeParse({ id: "s", ...out }).success).toBe(true);
  });

  it("never shares objects with the values it was given", () => {
    const stops = [{ at: 0, color: "#000000" }];
    const out = fillTemplateBody({ use: "shape", gradient: { type: "linear", stops: { $slot: "stops" } } }, { stops }) as {
      gradient: { stops: unknown[] };
    };
    expect(out.gradient.stops).toEqual(stops);
    expect(out.gradient.stops).not.toBe(stops);
    expect(layerSchema.safeParse({ ...out }).success).toBe(false); // one stop is too few: the schema still rules
  });

  it("interpolates an unset slot as nothing", () => {
    expect(interpolate("a{x}b", {})).toBe("ab");
  });
});

describe("helpers for agents and definition checks", () => {
  it("publishes slots as one JSON Schema object", () => {
    const schema = slotsJsonSchema([
      { id: "title", type: "text", label: "Title", required: true, constraints: { maxLen: 40 } },
      { id: "price", type: "number", label: "Price", default: 9, required: true, constraints: { min: 0, integer: true } },
      { id: "tier", type: "enum", label: "Tier", constraints: { options: ["a", "b"] } },
      { id: "items", type: "list", label: "Items", constraints: { maxItems: 3 } },
    ]);
    expect(schema).toMatchObject({
      type: "object",
      required: ["title"],
      additionalProperties: false,
      properties: {
        title: { type: "string", maxLength: 40, title: "Title" },
        price: { type: "integer", minimum: 0, default: 9 },
        tier: { enum: ["a", "b"] },
        items: { type: "array", items: { type: "string" }, maxItems: 3 },
      },
    });
  });

  it("samples a value of the right type for every slot type", () => {
    const types: TemplateSlot["type"][] = ["text", "number", "color", "image", "icon", "enum", "list"];
    for (const type of types) {
      const s: TemplateSlot = { id: "v", type, label: "V", constraints: type === "enum" ? { options: ["x"] } : undefined };
      expect(checkSlotValue(s, sampleSlotValue(s), ["v"])).toEqual([]);
    }
  });
});
