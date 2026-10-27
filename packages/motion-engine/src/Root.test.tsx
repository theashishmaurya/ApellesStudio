/**
 * B-281 — a render must draw exactly the manifest it is given.
 *
 * Remotion merges a render's input props over a composition's `defaultProps`,
 * and the live player does not, so any default that is not the schema's own
 * neutral value leaks into exports and stills. These tests pin that: the
 * `Animation` composition carries no look setting, and merging a manifest over
 * its defaults yields the manifest the player is given, key for key.
 */
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { RemotionRoot } from "./Root";
import { animationDefaultProps, metadataFromManifest, parseManifest } from "./engine/build";
import { manifestSchema, type Manifest } from "./engine/schema";
import { sample } from "./engine/sample";

type CompositionProps = { id: string; defaultProps?: Record<string, unknown> };

const compositions = (): CompositionProps[] => {
  const root = RemotionRoot({}) as ReactElement<{ children?: ReactNode }>;
  return Children.toArray(root.props.children)
    .filter(isValidElement)
    .map((el) => (el as ReactElement<CompositionProps>).props);
};

/** A document with nothing but what the schema requires: the shape of a fresh one. */
const bare = (): Record<string, unknown> => ({
  title: "bare",
  scenes: [{ id: "a", dur: 2, layers: [{ use: "text", text: "hi", at: 0, x: 100, y: 100 }] }],
});

describe("the Animation composition's defaultProps (B-281)", () => {
  it("is the neutral set, not the engine sample", () => {
    const animation = compositions().find((c) => c.id === "Animation");
    expect(animation?.defaultProps).toBe(animationDefaultProps);
    expect(animation?.defaultProps).not.toBe(sample);
  });

  it("carries no value a manifest may omit that the schema itself would not supply", () => {
    // What parsing a manifest with only the required keys yields IS "absent":
    // the schema's own defaults (size, fps). Every key the defaults carry must
    // equal that, and every other optional key must be missing from them, so a
    // future field cannot leak from the defaults into a render.
    const absent = manifestSchema.parse({ title: "", scenes: animationDefaultProps.scenes }) as Record<string, unknown>;
    const optionalKeys = Object.keys(manifestSchema.shape).filter((k) => manifestSchema.shape[k as keyof Manifest].isOptional());
    expect(optionalKeys).toEqual(expect.arrayContaining(["grain", "vignette", "theme", "themeDef", "transparent", "components"]));
    for (const key of optionalKeys) {
      if (key in absent) expect(animationDefaultProps[key as keyof Manifest]).toEqual(absent[key]);
      else expect(animationDefaultProps).not.toHaveProperty(key);
    }
  });

  it("renders a manifest exactly as the player is given it: merged over the defaults, no key comes from the sample", () => {
    const input = bare();
    const merged = { ...animationDefaultProps, ...input };
    const rendered = metadataFromManifest(merged).props;
    expect(rendered).toEqual(parseManifest(input));
    expect(rendered.grain).toBeUndefined();
    expect(rendered.vignette).toBeUndefined();
  });

  it("holds for a fully-optioned manifest too, whichever optional keys are set", () => {
    const input = { ...bare(), grain: false, vignette: 0.2, theme: "apelles-studio", transparent: true };
    const rendered = metadataFromManifest({ ...animationDefaultProps, ...input }).props;
    expect(rendered).toEqual(parseManifest(input));
  });

  it("keeps the sample available to the Studio as its own composition", () => {
    const sampleComposition = compositions().find((c) => c.id === "AnimationSample");
    expect(sampleComposition?.defaultProps).toBe(sample);
  });
});
