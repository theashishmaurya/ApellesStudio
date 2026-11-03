/** B-309 — `motion_validate` flags text that overflows its container. */
import { describe, expect, it } from "vitest";
import { textBox, textOverflowIssues, type TextMeasurer } from "./textFit";

const shape = (x: number, y: number, w: number, h: number) => ({ use: "shape", shape: "rect", x, y, w, h });
const text = (extra: Record<string, unknown>) => ({ use: "text", text: "thumbnails", ...extra });

describe("textBox", () => {
  it("lays a centred line out around x, as Text.tsx does", () => {
    const box = textBox(text({ x: 500, y: 100, size: 30, font: "IBM Plex Mono", align: "center", letterSpacing: 0 }));
    expect(box).toMatchObject({ width: 180, height: 30 * 1.15, left: 410, top: 100, exact: true });
  });

  it("anchors a right-aligned line at its right edge and a left one at its left", () => {
    expect(textBox(text({ x: 500, y: 0, size: 10, font: "Courier", align: "right", letterSpacing: 0 }))?.left).toBe(440);
    expect(textBox(text({ x: 500, y: 0, size: 10, font: "Courier", letterSpacing: 0 }))?.left).toBe(500);
  });

  it("wraps at maxWidth and counts the lines", () => {
    const box = textBox(text({ text: "aaaa bbbb cccc", x: 0, y: 0, size: 10, font: "mono", maxWidth: 50, letterSpacing: 0 }));
    expect(box?.height).toBeCloseTo(3 * 10 * 1.15);
    expect(box?.width).toBe(24);
  });

  it("skips text in the flow (no x or y) and empty text", () => {
    expect(textBox(text({ x: 10 }))).toBeNull();
    expect(textBox(text({ x: 10, y: 10, text: "" }))).toBeNull();
  });

  it("uses the measurer when it answers and estimates when it declines", () => {
    const measure: TextMeasurer = (line) => (line === "thumbnails" ? 99 : null);
    expect(textBox(text({ x: 0, y: 0 }), measure)?.width).toBe(99);
    expect(textBox(text({ x: 0, y: 0, text: "other" }), measure)?.exact).toBe(false);
  });
});

describe("textOverflowIssues (B-309)", () => {
  it("flags the reported case: 30 px IBM Plex Mono 'thumbnails' centred in a 170 px shape", () => {
    const layers = [
      shape(100, 100, 170, 270),
      text({ x: 185, y: 200, size: 30, font: "IBM Plex Mono", align: "center" }),
    ];
    const issues = textOverflowIssues(layers, ["scenes", 0, "layers"]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "text_overflow", path: "scenes[0].layers[1]" });
    expect(issues[0].message).toContain("the shape at scenes[0].layers[0]");
    expect(issues[0].message).toContain("past the left edge");
    expect(issues[0].hint).toContain("maxWidth");
  });

  it("is quiet when the same text fits, or wraps inside the box", () => {
    const fits = [shape(100, 100, 200, 270), text({ x: 200, y: 200, size: 30, font: "IBM Plex Mono", align: "center" })];
    expect(textOverflowIssues(fits)).toEqual([]);
    const wrapped = [
      shape(100, 100, 170, 270),
      text({ x: 185, y: 200, size: 30, font: "IBM Plex Mono", align: "center", maxWidth: 170, text: "thumb nails" }),
    ];
    expect(textOverflowIssues(wrapped)).toEqual([]);
  });

  it("flags a tall wrapped text running below its box", () => {
    const layers = [
      shape(0, 0, 100, 40),
      text({ x: 10, y: 5, size: 20, font: "mono", maxWidth: 80, text: "one two three four five six", letterSpacing: 0 }),
    ];
    const [issue] = textOverflowIssues(layers);
    expect(issue.message).toContain("below the bottom edge");
  });

  it("picks the smallest shape that holds the text and ignores shapes that do not", () => {
    const layers = [
      shape(0, 0, 1000, 1000),
      shape(100, 100, 170, 270),
      shape(600, 600, 10, 10),
      text({ x: 185, y: 200, size: 30, font: "IBM Plex Mono", align: "center" }),
    ];
    expect(textOverflowIssues(layers)[0].message).toContain("the shape at [1]");
  });

  it("checks text with no shape against the canvas, and not at all without one", () => {
    const layers = [text({ x: 1900, y: 100, size: 60, font: "mono" })];
    expect(textOverflowIssues(layers, [], { canvas: { w: 1920, h: 1080 } })[0].message).toContain("the canvas");
    expect(textOverflowIssues(layers)).toEqual([]);
  });

  it("only flags an estimated (proportional) width past its slack", () => {
    const layers = [shape(0, 0, 100, 100), text({ x: 50, y: 20, size: 20, align: "center", font: "Inter", text: "abcdefghij" })];
    // estimate: 10 chars * (0.55 * 20 + 0.2) = 112 vs 100: within the 12% slack
    expect(textOverflowIssues(layers)).toEqual([]);
    const wide = [shape(0, 0, 100, 100), text({ x: 50, y: 20, size: 20, align: "center", font: "Inter", text: "abcdefghijklmnop" })];
    expect(textOverflowIssues(wide)[0].message).toContain("width estimated");
  });

  it("trusts a measurer over the estimate", () => {
    const layers = [shape(0, 0, 100, 100), text({ x: 50, y: 20, size: 20, align: "center", font: "Inter", text: "abcdefghij" })];
    const wide: TextMeasurer = () => 140;
    expect(textOverflowIssues(layers, [], { measure: wide })).toHaveLength(1);
  });

  it("walks into groups, checking their children against their own siblings", () => {
    const manifest = {
      width: 1920,
      height: 1080,
      scenes: [
        {
          id: "s",
          layers: [{ use: "group", children: [shape(0, 0, 50, 50), text({ x: 25, y: 10, size: 30, font: "mono", align: "center" })] }],
        },
      ],
    };
    const issues = textOverflowIssues(manifest);
    expect(issues).toHaveLength(1);
    expect(issues[0].path).toBe("scenes[0].layers[0].children[1]");
  });
});
