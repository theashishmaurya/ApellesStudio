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
