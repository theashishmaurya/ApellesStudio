// @vitest-environment jsdom
/**
 * Emphasis — B-212 regression (`docs/BUGS.md`).
 *
 * `pulse`/`glow` used to be children-only wrappers (`<div>{children}</div>`
 * with a transform/filter on it) — but a manifest layer is rendered by
 * `Video.tsx` as `<C {...props} />`, self-closing, so it can never pass
 * `children`. That made `pulse`/`glow` render an empty, invisible `<div>`
 * from the one authoring surface that matters (the scene manifest), while
 * `ring`/`scribble` worked fine because they already derived their shape
 * from `box` instead of `children`.
 *
 * These tests exercise the REAL manifest path — `registry.ts`'s `emphasis`
 * adapter (exactly what `Video.tsx` runs a manifest layer's raw JSON props
 * through) feeding the real `Emphasis` component with no `children` — and
 * assert real drawn SVG output, not just "did not throw." `ring`/`scribble`
 * are included as a sanity check that the harness itself proves something:
 * they must already pass, since B-212 was never about them.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render } from "@testing-library/react";

let mockFrame = 0;
const FPS = 30;

// `Emphasis` (and `lib/draw.ts`, which it calls into for `ring`/`scribble`)
// needs `useCurrentFrame`/`useVideoConfig`, which only resolve inside a real
// Remotion composition render. Everything else from `remotion` (`interpolate`,
// `spring`, `Easing`, used by `lib/draw.ts`) is real — only the two hooks that
// require Remotion's render context are stubbed, with a fixed 1920x1080/30fps
// video config that nothing here reads besides `fps`.
vi.mock("remotion", async (importOriginal) => {
  const actual = await importOriginal<typeof import("remotion")>();
  return {
    ...actual,
    useCurrentFrame: () => mockFrame,
    useVideoConfig: () => ({
      fps: FPS,
      width: 1920,
      height: 1080,
      durationInFrames: 300,
      id: "emphasis-test",
      defaultProps: {},
      props: {},
    }),
  };
});

const { lookup } = await import("../engine/registry");

afterEach(cleanup);

type Preset = "pulse" | "glow" | "ring" | "scribble";

const BOX: [number, number, number, number] = [400, 300, 200, 150];

/**
 * Exactly what `Video.tsx` does with one manifest layer: run its raw JSON
 * props through the registry's own adapter, then mount the primitive with
 * the adapted props and NO children (`Video.tsx` ~L118: `<C {...props} />`).
 */
function renderManifestLayer(preset: Preset, frame: number) {
  mockFrame = frame;
  const raw = { use: "emphasis", preset, at: 0, dur: 1, box: BOX };
  const entry = lookup("emphasis");
  const props = entry.adapt(raw, FPS, frame);
  const Component = entry.component;
  return render(<Component {...props} />);
}

describe("B-212 — emphasis pulse/glow draw real output from a manifest layer", () => {
  it("pulse draws an SVG path sized from box, not an empty wrapper", () => {
    const { container } = renderManifestLayer("pulse", 5);
    expect(container.querySelector("svg")).not.toBeNull();
    const path = container.querySelector("path[data-motion-box]");
    expect(path).not.toBeNull();
    expect(path?.getAttribute("d")?.trim().length ?? 0).toBeGreaterThan(0);
    // pre-fix behaviour: an empty <div>, no svg/path anywhere
    expect(container.querySelector("div")).toBeNull();
  });

  it("glow draws an SVG path sized from box, not an empty wrapper", () => {
    const { container } = renderManifestLayer("glow", 5);
    expect(container.querySelector("svg")).not.toBeNull();
    const path = container.querySelector("path[data-motion-box]");
    expect(path).not.toBeNull();
    expect(path?.getAttribute("d")?.trim().length ?? 0).toBeGreaterThan(0);
    expect(container.querySelector("div")).toBeNull();
  });

  it("pulse/glow draw nothing outside their own [start, start+dur] window", () => {
    // dur: 1s @ 30fps = 30 frames; frame 999 is far past it.
    expect(renderManifestLayer("pulse", 999).container.firstChild).toBeNull();
    cleanup();
    expect(renderManifestLayer("glow", 999).container.firstChild).toBeNull();
  });

  it("sanity check: sibling presets ring/scribble already draw a path (proves the harness, not just the fix)", () => {
    const ring = renderManifestLayer("ring", 5);
    expect(ring.container.querySelector("path[data-motion-box]")).not.toBeNull();
    cleanup();
    const scribble = renderManifestLayer("scribble", 5);
    expect(scribble.container.querySelector("path[data-motion-box]")).not.toBeNull();
  });
});
