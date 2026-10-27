import "./index.css";
import { Composition } from "remotion";
import { motion } from "./design";
import { Video } from "./engine/Video";
import type { Manifest } from "./engine/schema";
import { CustomRendererProvider } from "./custom/renderer";
import { CodeRenderer } from "./custom/runtime";
import { animationDefaultProps, metadataFromManifest } from "./engine/build";
import { sample } from "./engine/sample";
import { HelloWorld } from "./compositions/HelloWorld";
import { PrimitivesDemo } from "./compositions/PrimitivesDemo";
import { GraphDemo } from "./compositions/GraphDemo";
import { Scene3DDemo } from "./compositions/Scene3DDemo";
import { LayersDemo } from "./compositions/LayersDemo";
import { ParticleDemo } from "./compositions/ParticleDemo";
import { ClaudeChatDemo } from "./compositions/ClaudeChatDemo";

/**
 * Motion engine — the Remotion replacement for HyperFrames.
 * Primitives: src/primitives/ · manifest compiler: src/engine/ · see engine/catalog.md
 *
 * `Animation` is the real entry point — it renders a manifest:
 *   npx remotion render Animation out.mp4 --props=./projects/<name>/animation/manifest.json
 * The *Demo compositions below are living references for each primitive.
 */
/**
 * D-409 — the renderer process's `Animation`: the manifest compiler with the
 * custom-component CODE renderer installed. This file is the Remotion entry
 * (`index.ts` → `registerRoot`), which only the renderer process loads; the app
 * webview imports `Video` directly and installs a proxy renderer instead, so
 * component code never runs there (`custom/renderer.tsx`).
 */
const RenderedVideo: React.FC<Manifest> = (manifest) => (
  <CustomRendererProvider renderer={CodeRenderer}>
    <Video {...manifest} />
  </CustomRendererProvider>
);

export const RemotionRoot: React.FC = () => {
  return (
    <>
      <Composition
        id="Animation"
        component={RenderedVideo}
        defaultProps={animationDefaultProps}
        calculateMetadata={({ props }) => metadataFromManifest(props)}
        durationInFrames={300}
        fps={motion.fps}
        width={1920}
        height={1080}
      />
      {/* B-281 — the engine sample, for the Studio only. A separate
          composition so its grain and vignette can never be merged into a real
          `Animation` render as defaults. */}
      <Composition
        id="AnimationSample"
        component={RenderedVideo}
        defaultProps={sample}
        calculateMetadata={({ props }) => metadataFromManifest(props)}
        durationInFrames={300}
        fps={motion.fps}
        width={1920}
        height={1080}
      />

      <Composition
        id="HelloWorld"
        component={HelloWorld}
        durationInFrames={90}
        fps={motion.fps}
        width={1920}
        height={1080}
      />
      <Composition
        id="PrimitivesDemo"
        component={PrimitivesDemo}
        durationInFrames={320}
        fps={motion.fps}
        width={1920}
        height={1080}
      />
      <Composition
        id="GraphDemo"
        component={GraphDemo}
        durationInFrames={210}
        fps={motion.fps}
        width={1920}
        height={1080}
      />
      <Composition
        id="Scene3DDemo"
        component={Scene3DDemo}
        durationInFrames={210}
        fps={motion.fps}
        width={1920}
        height={1080}
      />
      <Composition
        id="LayersDemo"
        component={LayersDemo}
        durationInFrames={200}
        fps={motion.fps}
        width={1920}
        height={1080}
      />
      <Composition
        id="ParticleDemo"
        component={ParticleDemo}
        durationInFrames={200}
        fps={motion.fps}
        width={1920}
        height={1080}
      />
      {/* D-258 — long enough to walk all three of the demo's conversations
          (the last step starts at 11s) */}
      <Composition
        id="ClaudeChatDemo"
        component={ClaudeChatDemo}
        durationInFrames={480}
        fps={motion.fps}
        width={1920}
        height={1080}
      />
    </>
  );
};
