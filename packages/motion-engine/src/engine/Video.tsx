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

const renderLayers = (layers: SceneT["layers"], fps: number, frame: number) =>
  (layers ?? []).map((l, i) => {
    const { component: C, adapt } = lookup(l.use);
    const props = adapt(l as unknown as Record<string, unknown>, fps, frame);
    return <C key={`${l.use}-${i}`} {...props} />;
  });

const TwoD: React.FC<{ scene: SceneT; fps: number }> = ({ scene, fps }) => {
  const frame = useCurrentFrame();
  const nodes = renderLayers(scene.layers, fps, frame);
  if (scene.camera && scene.camera.length) {
    const keys = scene.camera.map((k) => ({ ...k, at: Math.round(k.at * fps) }));
    return <Camera keys={keys}>{nodes}</Camera>;
  }
  return <>{nodes}</>;
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
  fps: number;
  grain: boolean;
  vignette: boolean | number;
  transparent: boolean;
}> = ({ scene, fps, grain, vignette, transparent }) => {
  const showGrain = scene.grain ?? grain;
  const vig = scene.vignette ?? vignette;
  const bg = scene.bg ?? (transparent ? "transparent" : design.bg);
  return (
    <AbsoluteFill style={{ backgroundColor: bg }}>
      {scene.scene3d ? <ThreeD scene={scene} fps={fps} /> : <TwoD scene={scene} fps={fps} />}
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
      {manifest.scenes.map((scene) => (
        <Series.Sequence
          key={scene.id}
          durationInFrames={Math.max(1, Math.round(scene.dur * fps))}
        >
          <OneScene
            scene={scene}
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
