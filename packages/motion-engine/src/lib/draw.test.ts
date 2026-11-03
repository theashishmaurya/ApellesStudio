/** B-320 — a reveal shorter than a frame is a step, not a crash. */
import { describe, expect, it } from "vitest";
import { inAt, outAt } from "./draw";

describe("inAt / outAt with a zero-length range (B-320)", () => {
  it("inAt is hidden before `from` and fully shown from it when dur rounds to 0 frames", () => {
    expect(() => inAt(0, 0, 0)).not.toThrow();
    expect(inAt(0, 0, 0)).toBe(1);
    expect(inAt(5, 3, 3)).toBe(1);
    expect(inAt(2, 3, 3)).toBe(0);
  });

  it("a reversed range behaves the same", () => {
    expect(inAt(4, 6, 2)).toBe(0);
    expect(inAt(6, 6, 2)).toBe(1);
  });

  it("outAt is shown before `from` and gone from it", () => {
    expect(outAt(2, 3, 3)).toBe(1);
    expect(outAt(3, 3, 3)).toBe(0);
  });

  it("a normal range still eases between 0 and 1", () => {
    expect(inAt(0, 0, 10)).toBe(0);
    expect(inAt(10, 0, 10)).toBe(1);
    const mid = inAt(5, 0, 10);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    expect(outAt(0, 0, 10)).toBe(1);
    expect(outAt(10, 0, 10)).toBe(0);
  });
});
