import "./index.css";
import { Composition } from "remotion";
import { design } from "./design";
import { Video } from "./engine/Video";
import { metadataFromManifest } from "./engine/build";
import { sample } from "./engine/sample";
import { HelloWorld } from "./compositions/HelloWorld";
import { PrimitivesDemo } from "./compositions/PrimitivesDemo";
import { GraphDemo } from "./compositions/GraphDemo";
import { Scene3DDemo } from "./compositions/Scene3DDemo";
import { LayersDemo } from "./compositions/LayersDemo";
import { ParticleDemo } from "./compositions/ParticleDemo";

/**
 * Motion engine — the Remotion replacement for HyperFrames.
 * Primitives: src/primitives/ · manifest compiler: src/engine/ · see engine/catalog.md
 *
 * `Animation` is the real entry point — it renders a manifest:
 *   npx remotion render Animation out.mp4 --props=./projects/<name>/animation/manifest.json
 * The *Demo compositions below are living references for each primitive.
 */
export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Animation"
        component={Video}
        defaultProps={sample}
        calculateMetadata={({ props }) => metadataFromManifest(props)}
        durationInFrames={300}
        fps={design.fps}
        width={1920}
        height={1080}
      />

      <Composition
        id="HelloWorld"
        component={HelloWorld}
        durationInFrames={90}
        fps={design.fps}
        width={1920}
        height={1080}
      />
      <Composition
        id="PrimitivesDemo"
        component={PrimitivesDemo}
        durationInFrames={320}
        fps={design.fps}
        width={1920}
        height={1080}
      />
      <Composition
        id="GraphDemo"
        component={GraphDemo}
        durationInFrames={210}
        fps={design.fps}
        width={1920}
        height={1080}
      />
      <Composition
        id="Scene3DDemo"
        component={Scene3DDemo}
        durationInFrames={210}
        fps={design.fps}
        width={1920}
        height={1080}
      />
      <Composition
        id="LayersDemo"
        component={LayersDemo}
        durationInFrames={200}
        fps={design.fps}
        width={1920}
        height={1080}
      />
      <Composition
        id="ParticleDemo"
        component={ParticleDemo}
        durationInFrames={200}
        fps={design.fps}
        width={1920}
        height={1080}
      />
    </>
  );
};
