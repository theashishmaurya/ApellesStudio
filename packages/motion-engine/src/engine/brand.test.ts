/**
 * D-404/D-405 — the brand building blocks' schema rules, `anim` tracks, the
 * Phosphor name map and the counter's locale-free formatting.
 */
import { describe, expect, it } from "vitest";
import { layerSchema, manifestSchema } from "./schema";
import { validateLayers, iconIssues, containsIcon } from "./validate";
import { primitiveJsonSchema } from "./jsonSchema";
import { applyAnim, trackValue } from "../lib/anim";
import { buildPhosphorMap, kebabFromPascal, loadPhosphorIcons } from "../lib/phosphorIcons";
import { formatCount } from "../primitives/Counter";
import { assetFileName, ASSET_ID_PATTERN } from "../lib/assetId";

const HASH = "a".repeat(64);
const doc = (layers: unknown[]) => ({ title: "t", scenes: [{ id: "s", dur: 3, layers }] });

describe("brand primitives (D-405)", () => {
  it("accepts each new primitive", () => {
    for (const layer of [
      { use: "image", src: `sha256:${HASH}.png`, w: 200, h: 100, fit: "cover", radius: 12 },
      { use: "icon", name: "rocket-launch", weight: "duotone", size: 80 },
      { use: "shape", shape: "star", w: 100, h: 100, points: 5, gradient: { type: "linear", stops: [{ at: 0, color: "#000" }, { at: 1, color: "#fff" }] } },
      { use: "counter", from: 0, to: 1000, prefix: "$", thousands: true },
      { use: "group", children: [{ use: "text", text: "x" }], mask: { kind: "roundrect", x: 0, y: 0, w: 10, h: 10, radius: 2 } },
    ]) {
      expect(layerSchema.safeParse(layer).success, JSON.stringify(layer)).toBe(true);
    }
  });

  it("an image src must be a content-hash asset id, never a path", () => {
    const r = validateLayers([{ use: "image", src: "/Users/me/logo.png" }]);
    expect(r.issues[0]).toMatchObject({ path: "layers[0].src" });
    expect(ASSET_ID_PATTERN.test(`sha256:${HASH}.jpg`)).toBe(true);
    expect(assetFileName(`sha256:${HASH}.jpg`)).toBe(`${HASH}.jpg`);
  });

  it("validates group children recursively, refuses 3D children and depth > 4", () => {
    const deepTypo = validateLayers([{ use: "group", children: [{ use: "group", children: [{ use: "text", text: "x", sise: 3 }] }] }]);
    expect(deepTypo.issues.map((i) => i.path)).toContain("layers[0].children[0].children[0].sise");
    const threeD = validateLayers([{ use: "group", children: [{ use: "labelbox" }] }]);
    expect(threeD.issues[0].message).toMatch(/3D primitive/);
    let g: Record<string, unknown> = { use: "text", text: "x" };
    for (let i = 0; i < 5; i++) g = { use: "group", children: [g] };
    expect(validateLayers([g]).issues.some((i) => /at most 4/.test(i.message))).toBe(true);
  });

  it("a group may not be a scene3d child", () => {
    const r = manifestSchema.safeParse({
      title: "t",
      scenes: [{ id: "s", dur: 1, scene3d: { camera: [{ at: 0, pos: [0, 0, 1] }], children: [{ use: "group", children: [] }] } }],
    });
    expect(r.success).toBe(false);
  });

  it("propsSchema covers the new primitives, group included", () => {
    for (const use of ["image", "icon", "shape", "counter", "group"] as const) {
      expect(primitiveJsonSchema(use).type).toBe("object");
    }
  });
});

describe("anim property tracks (D-405)", () => {
  it("accepts numeric and colour tracks, and one level into an object prop", () => {
    const ok = validateLayers([
      { use: "shape", fill: "#000", anim: { w: [{ at: 0, v: 0 }, { at: 1, v: 400 }], fill: [{ at: 0, v: "#000000" }, { at: 1, v: "#ffffff" }] } },
      { use: "group", children: [], mask: { kind: "rect", x: 0, y: 0, w: 0, h: 100 }, anim: { "mask.w": [{ at: 0, v: 0 }, { at: 1, v: 800 }] } },
    ]);
    expect(ok.issues).toEqual([]);
  });

  it("refuses a track on a non-animatable or unknown prop, and a value of the wrong kind", () => {
    const r = validateLayers([
      { use: "text", text: "x", anim: { text: [{ at: 0, v: 1 }], size: [{ at: 0, v: "big" }], nope: [{ at: 0, v: 1 }] } },
    ]);
    const msgs = r.issues.map((i) => `${i.path}: ${i.message}`);
    expect(msgs.some((m) => m.startsWith("layers[0].anim.text:"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("layers[0].anim.size[0].v:"))).toBe(true);
    expect(msgs.some((m) => m.startsWith("layers[0].anim.nope:"))).toBe(true);
  });

  it("interpolates numbers and colours on the shared key timing", () => {
    const keys = [{ at: 0, v: 0 }, { at: 1, v: 100, ease: [0, 0, 1, 1] as const }];
    expect(trackValue(keys, 0, 30)).toBe(0);
    expect(trackValue(keys, 15, 30)).toBeCloseTo(50, 5);
    expect(trackValue(keys, 99, 30)).toBe(100);
    const col = trackValue([{ at: 0, v: "#000000" }, { at: 1, v: "#ffffff", ease: [0, 0, 1, 1] }], 15, 30);
    expect(typeof col).toBe("string");
    expect(col).not.toBe("#000000");
  });

  it("applyAnim returns the same object when there are no tracks, and sets nested props", () => {
    const plain = { use: "text", text: "x" };
    expect(applyAnim(plain, 10, 30)).toBe(plain);
    const g = { use: "group", mask: { kind: "rect", x: 0, y: 0, w: 0, h: 9 }, anim: { "mask.w": [{ at: 0, v: 0 }, { at: 1, v: 30 }] } };
    const out = applyAnim(g, 30, 30) as { mask: { w: number; h: number } };
    expect(out.mask).toMatchObject({ w: 30, h: 9 });
    expect(g.mask.w).toBe(0);
  });
});

/** loading ~1,500 icon modules takes a second or two, more on a busy machine */
const ICON_LOAD_TIMEOUT_MS = 20_000;

describe("Phosphor by name (D-405)", () => {
  it("kebab names follow phosphoricons.com", () => {
    expect(kebabFromPascal("RocketLaunch")).toBe("rocket-launch");
    expect(kebabFromPascal("ChartLineUp")).toBe("chart-line-up");
  });

  it("the installed library maps every icon to a unique kebab name", async () => {
    const icons = await loadPhosphorIcons();
    expect(icons.size).toBeGreaterThan(1000);
    expect(icons.has("rocket-launch")).toBe(true);
    expect(icons.has("rocket-launch-icon")).toBe(false);
    // unique: as many names as distinct components
    const mod = (await import("@phosphor-icons/react")) as unknown as Record<string, unknown>;
    expect(buildPhosphorMap(mod).size).toBe(icons.size);
  }, ICON_LOAD_TIMEOUT_MS);

  it("flags an unknown icon name with the nearest real one", async () => {
    const known = new Set((await loadPhosphorIcons()).keys());
    const layers = [{ use: "group", children: [{ use: "icon", name: "rocket-lunch" }] }];
    expect(containsIcon(layers)).toBe(true);
    expect(iconIssues(layers, known, ["layers"])).toEqual([
      expect.objectContaining({ path: "layers[0].children[0].name", code: "unknown_icon", hint: 'did you mean "rocket-launch"?' }),
    ]);
  }, ICON_LOAD_TIMEOUT_MS);
});

describe("counter formatting is locale-free (D-405)", () => {
  it("groups with a fixed comma and pads decimals", () => {
    expect(formatCount(12500, 0, true)).toBe("12,500");
    expect(formatCount(1234567.891, 2, true)).toBe("1,234,567.89");
    expect(formatCount(999.5, 1, false)).toBe("999.5");
    expect(formatCount(-0.001, 0, true)).toBe("0");
    expect(formatCount(-1500, 0, true)).toBe("-1,500");
  });

  it("a whole brand scene loads", () => {
    expect(manifestSchema.safeParse(doc([{ use: "counter", to: 5 }])).success).toBe(true);
  });
});
