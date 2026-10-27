/**
 * D-409 — a custom component as data: the declaration's rules, and the
 * manifest schema's checks of a custom layer against the definition the same
 * document embeds.
 */
import { describe, expect, it } from "vitest";
import { manifestSchema } from "../engine/schema";
import { validateManifest } from "../engine/validate";
import { componentDefaults, componentSpecIssues, customAnimKind, parseComponentRef, type ComponentRef } from "./componentDef";

const HEX = "a".repeat(64);
const def: ComponentRef = {
  id: "burst",
  name: "Burst",
  props: [
    { id: "count", type: "number", label: "Count", default: 10, constraints: { min: 1, max: 100, integer: true } },
    { id: "label", type: "text", label: "Label", default: "Hi" },
    { id: "color", type: "color", label: "Colour" },
  ],
  size: { w: 400, h: 300 },
  duration: 2,
  version: 1,
  sourceHash: HEX,
  codeHash: HEX,
  code: `sha256:${HEX}.js`,
  source: `sha256:${HEX}.tsx`,
};

const doc = (layer: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  title: "t",
  components: { "burst@1": def },
  scenes: [{ id: "s", dur: 2, layers: [layer] }],
  ...extra,
});

describe("componentSpecIssues", () => {
  const spec = { id: "burst", name: "Burst", props: def.props, size: def.size, duration: 2 };
  it("accepts a good declaration", () => {
    expect(componentSpecIssues(spec)).toEqual([]);
  });
  it("refuses a colour default (the theme rule), an image prop, a duplicate id and a bad default", () => {
    const issues = componentSpecIssues({
      ...spec,
      props: [
        { id: "c", type: "color", label: "C", default: "#ff0000" },
        { id: "img", type: "image", label: "I" },
        { id: "c", type: "text", label: "Again" },
        { id: "n", type: "number", label: "N", default: 500, constraints: { max: 100 } },
      ],
    });
    expect(issues.map((i) => [i.path, i.code])).toEqual([
      ["props[0].default", "colour_default"],
      ["props[1].type", "invalid_value"],
      ["props[2].id", "duplicate_prop"],
      ["props[3].default", "too_big"],
    ]);
  });
  it("refuses a bad id and an oversized box by shape", () => {
    expect(componentSpecIssues({ ...spec, id: "Bad Id" })[0].path).toBe("id");
    expect(componentSpecIssues({ ...spec, size: { w: 9000, h: 10 } })[0].path).toBe("size.w");
  });
});

describe("pins, defaults, animatable props", () => {
  it("parses id@version pins", () => {
    expect(parseComponentRef("burst@12")).toEqual({ id: "burst", version: 12 });
    expect(parseComponentRef("burst")).toBeNull();
    expect(parseComponentRef("burst@0")).toBeNull();
  });
  it("collects declared defaults only", () => {
    expect(componentDefaults(def)).toEqual({ count: 10, label: "Hi" });
  });
  it("allows tracks on the box and number/colour props only", () => {
    expect(customAnimKind(def, "x")).toBe("number");
    expect(customAnimKind(def, "props.count")).toBe("number");
    expect(customAnimKind(def, "props.color")).toBe("color");
    expect(customAnimKind(def, "props.label")).toBeNull();
    expect(customAnimKind(def, "props.nope")).toBeNull();
  });
});

describe("the manifest schema and custom layers", () => {
  it("loads a custom layer whose props fit its embedded definition", () => {
    const r = validateManifest(doc({ use: "custom", component: "burst@1", x: 10, props: { count: 5 }, anim: { "props.color": [{ at: 0, v: "#ffffff" }] } }));
    expect(r.issues).toEqual([]);
  });
  it("refuses a pin the document does not embed", () => {
    const r = validateManifest(doc({ use: "custom", component: "other@1" }));
    expect(r.loads).toBe(false);
    expect(r.issues[0].path).toBe("scenes[0].layers[0].component");
  });
  it("refuses props outside the declaration, path-precise, including unknown keys", () => {
    const r = validateManifest(doc({ use: "custom", component: "burst@1", props: { count: 500, colr: "#fff" } }));
    expect(r.issues.map((i) => i.path).sort()).toEqual(["scenes[0].layers[0].props.colr", "scenes[0].layers[0].props.count"]);
  });
  it("refuses a track on a text prop and a wrong-kind value", () => {
    const r = validateManifest(
      doc({ use: "custom", component: "burst@1", anim: { "props.label": [{ at: 0, v: 1 }], "props.count": [{ at: 0, v: "#fff" }] } }),
    );
    expect(r.issues.map((i) => i.path).sort()).toEqual(["scenes[0].layers[0].anim.props.count[0].v", "scenes[0].layers[0].anim.props.label"]);
  });
  it("checks custom layers inside groups", () => {
    const r = validateManifest(doc({ use: "group", children: [{ use: "custom", component: "burst@1", props: { count: 0 } }] }));
    expect(r.issues[0].path).toBe("scenes[0].layers[0].children[0].props.count");
  });
  it("refuses a custom layer in scene3d and a components key that does not match", () => {
    const in3d = manifestSchema.safeParse({
      title: "t",
      components: { "burst@1": def },
      scenes: [{ id: "s", dur: 1, scene3d: { camera: [{ at: 0, pos: [0, 0, 5] }], children: [{ use: "custom", component: "burst@1" }] } }],
    });
    expect(in3d.success).toBe(false);
    const wrongKey = validateManifest({ title: "t", components: { "burst@2": def }, scenes: [{ id: "s", dur: 1 }] });
    expect(wrongKey.issues[0].path).toBe("components.burst@2");
  });
  it("leaves documents without custom components exactly as they were", () => {
    const plain = { title: "t", scenes: [{ id: "s", dur: 1, layers: [{ use: "text", text: "hi" }] }] };
    expect(manifestSchema.parse(plain)).not.toHaveProperty("components");
  });
});
