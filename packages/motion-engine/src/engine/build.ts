/**
 * build.ts — manifest → Remotion metadata.
 *
 * The `Animation` composition in Root.tsx uses `calculateMetadata` to size and
 * time itself from the manifest passed as props:
 *
 *   npx remotion render Animation out.mp4 --props=./projects/<name>/animation/manifest.json
 *
 * Author manifests as JSON (see schema.ts for the shape). Validation errors from
 * zod point straight at the offending field.
 */
import { manifestSchema, type Manifest } from "./schema";

export const parseManifest = (raw: unknown): Manifest => manifestSchema.parse(raw);

export const totalFrames = (m: Manifest): number =>
  m.scenes.reduce((sum, s) => sum + Math.max(1, Math.round(s.dur * m.fps)), 0);

/** A scene's own duration in frames — the exact per-scene term `totalFrames`
 *  sums, and what `<Series.Sequence durationInFrames={...}>` (`Video.tsx`)
 *  is given per scene — kept here so nothing computes this independently. */
export const sceneDurationFrames = (m: Manifest, sceneIndex: number): number =>
  Math.max(1, Math.round(m.scenes[sceneIndex].dur * m.fps));

/** Composition-absolute start frame of `m.scenes[sceneIndex]` — mirrors
 *  exactly how `<Series>` (`Video.tsx`) lays scenes back to back (each
 *  scene's `durationInFrames` is this same `sceneDurationFrames` term), so a
 *  UI that wants to seek the player to a specific scene/layer never
 *  reinvents this math. */
export const sceneStartFrame = (m: Manifest, sceneIndex: number): number => {
  let start = 0;
  for (let i = 0; i < sceneIndex; i++) start += sceneDurationFrames(m, i);
  return start;
};

/**
 * B-281 — the `Animation` composition's `defaultProps`. Remotion merges a
 * render's input props OVER `defaultProps`, so every key listed here is taken
 * from here whenever a manifest leaves it out, while the live player is handed
 * the manifest as-is. So this carries ONLY what the schema needs to parse and
 * nothing that changes a pixel: no `grain`, `vignette`, `theme`, `transparent`
 * `components`, and a size/fps equal to the schema's own defaults. A
 * manifest is therefore rendered exactly as given. The engine sample is NOT a
 * default; it is the `AnimationSample` composition (Root.tsx).
 */
export const animationDefaultProps: Manifest = {
  title: "",
  width: 1920,
  height: 1080,
  fps: 30,
  scenes: [{ id: "empty", dur: 1, layers: [] }],
};

/** for Composition.calculateMetadata — props ARE the manifest */
export const metadataFromManifest = (raw: unknown) => {
  const m = parseManifest(raw);
  return {
    durationInFrames: totalFrames(m),
    fps: m.fps,
    width: m.width,
    height: m.height,
    props: m,
  };
};
