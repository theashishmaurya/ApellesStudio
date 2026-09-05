/**
 * <Video manifest> — compiles a validated manifest into a sequence of scenes.
 * Registered as the `Animation` composition in Root.tsx (duration + size come
 * from the manifest via calculateMetadata).
 */
import React from "react";
import { AbsoluteFill, Series, useCurrentFrame } from "remotion";
import { loadFont } from "@remotion/google-fonts/Kalam";
import { Camera } from "../primitives/Camera";

loadFont();
import { Scene3D } from "../primitives/Scene3D";
import { FilmGrain, Vignette } from "../primitives/postfx";
import { design } from "../design";
import { lookup } from "./registry";
import type { Manifest, Scene as SceneT } from "./schema";

/**
 * `data-motion-layer="<sceneIndex>.<layerIndex>"` (D-155, `docs/notes/
 * motion-visual-builder-research.md` §3a/§4 Phase 0a) — the hook `@chroma/
 * motion`'s canvas overlay walks up to from a click (`elementsFromPoint` →
 * `.closest('[data-motion-layer]')`) to resolve a screen point back to a
 * `Selection`. `display: "contents"` so the wrapper is invisible to layout
 * AND to absolute positioning (a primitive's own `position: absolute` still
 * resolves against `<Camera>`'s (or the camera-less root's) `AbsoluteFill`,
 * exactly as before this wrapper existed) — zero pixel/visual change.
 * `sceneIndex` is `<Video>`'s own `manifest.scenes` index, so it lines up
 * directly with `LayerList.tsx`'s `Selection.sceneIndex`.
 */
const renderLayers = (layers: SceneT["layers"], fps: number, frame: number, sceneIndex: number) =>
  (layers ?? []).map((l, i) => {
    const { component: C, adapt } = lookup(l.use);
    const props = adapt(l as unknown as Record<string, unknown>, fps, frame);
    return (
      <div key={`${l.use}-${i}`} data-motion-layer={`${sceneIndex}.${i}`} style={{ display: "contents" }}>
        <C {...props} />
      </div>
    );
  });

const TwoD: React.FC<{ scene: SceneT; fps: number; sceneIndex: number }> = ({ scene, fps, sceneIndex }) => {
  const frame = useCurrentFrame();
  const nodes = renderLayers(scene.layers, fps, frame, sceneIndex);
  if (scene.camera && scene.camera.length) {
    const keys = scene.camera.map((k) => ({ ...k, at: Math.round(k.at * fps) }));
    return <Camera keys={keys}>{nodes}</Camera>;
  }
  // No camera: `<Camera>` isn't mounted at all, so ITS OWN `data-motion-world`
  // (`Camera.tsx`) never renders either — the research doc's "a camera-less
  // scene's root" case (§4 Phase 0a). This extra `AbsoluteFill` is pixel-
  // identical to the fragment it replaces (same full-fill flex defaults
  // `OneScene`'s own outer `AbsoluteFill` already uses one layer up — see
  // `AbsoluteFillElement.js`), so it costs nothing but the attribute.
  return <AbsoluteFill data-motion-world>{nodes}</AbsoluteFill>;
};

const ThreeD: React.FC<{ scene: SceneT; fps: number }> = ({ scene, fps }) => {
  const frame = useCurrentFrame();
  const s3 = scene.scene3d;
  if (!s3) return null;
  const camera = s3.camera.map((k) => ({ ...k, at: Math.round(k.at * fps) }));
  return (
    <Scene3D camera={camera}>
      {s3.children.map((l, i) => {
        const { component: C, adapt } = lookup(l.use);
        return (
          <C
            key={`${l.use}-${i}`}
            {...adapt(l as unknown as Record<string, unknown>, fps, frame)}
          />
        );
      })}
    </Scene3D>
  );
};

const OneScene: React.FC<{
  scene: SceneT;
  sceneIndex: number;
  fps: number;
  grain: boolean;
  vignette: boolean | number;
  transparent: boolean;
}> = ({ scene, sceneIndex, fps, grain, vignette, transparent }) => {
  const showGrain = scene.grain ?? grain;
  const vig = scene.vignette ?? vignette;
  const bg = scene.bg ?? (transparent ? "transparent" : design.bg);
  return (
    <AbsoluteFill style={{ backgroundColor: bg }}>
      {scene.scene3d ? (
        <ThreeD scene={scene} fps={fps} />
      ) : (
        <TwoD scene={scene} fps={fps} sceneIndex={sceneIndex} />
      )}
      {vig ? <Vignette strength={typeof vig === "number" ? vig : 0.45} /> : null}
      {showGrain ? <FilmGrain /> : null}
    </AbsoluteFill>
  );
};

/** props ARE the manifest (so `--props=manifest.json` works directly) */
export const Video: React.FC<Manifest> = (manifest) => {
  const { fps } = manifest;
  return (
    <Series>
      {manifest.scenes.map((scene, sceneIndex) => (
        <Series.Sequence
          key={scene.id}
          durationInFrames={Math.max(1, Math.round(scene.dur * fps))}
        >
          <OneScene
            scene={scene}
            sceneIndex={sceneIndex}
            fps={fps}
            grain={manifest.grain ?? false}
            vignette={manifest.vignette ?? false}
            transparent={manifest.transparent ?? false}
          />
        </Series.Sequence>
      ))}
    </Series>
  );
};
