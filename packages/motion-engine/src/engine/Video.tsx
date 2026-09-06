/**
 * <Video manifest> — compiles a validated manifest into a sequence of scenes.
 * Registered as the `Animation` composition in Root.tsx (duration + size come
 * from the manifest via calculateMetadata).
 */
import React from "react";
import { AbsoluteFill, Series, useCurrentFrame } from "remotion";
import { loadFont } from "@remotion/google-fonts/Kalam";
import { Camera } from "../primitives/Camera";
import { interpolateKeys } from "../lib/interpolateKeys";

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
 *
 * `l.transform` (D-157, Phase 2 of the research doc — "the layer transform
 * wrapper") is applied on an INNER real element only when present, ON TOP OF
 * the primitive's own positioning: a `position:absolute` box exactly the
 * size/place the `display:contents` outer wrapper would otherwise have made
 * invisible (`inset:0` normally, or an explicit `clipWidth`×`clipHeight` box
 * with `overflow:hidden` when both are set — the research doc's own "crop,
 * honestly" call), carrying the CSS transform + opacity. `transformOrigin:
 * "0 0"` matches `Camera.tsx`'s own convention on the SAME kind of transform
 * — scale/rotate pivot at the wrapper's own origin (world `(0,0)`, i.e. the
 * canvas top-left for the common `inset:0` case), not the layer's own
 * position; combining `x`/`y` with `scale`/`rot` to keep a layer's own point
 * fixed under a scale/rotate is on the author (or a future tool), exactly
 * the same way a camera key must combine `x`/`y` with `zoom`. Getting this
 * wrapper to instead pivot around a primitive's own reported anchor would
 * need per-primitive position knowledge (`@chroma/motion`'s `positionFields`)
 * that this ENGINE package must not depend on (wrong direction, `@chroma/
 * motion` depends on this package, never the reverse) — a known, honest
 * scope call, not an oversight. When `l.transform` is absent, `node` below is
 * the exact same JSX this function always produced — zero pixel/visual
 * change, verified with real byte-for-byte `remotion still` renders (D-157).
 *
 * `l.transform.keys` (D-159, Phase 4 — "the animation model: per-layer
 * keyframes") layers a per-frame DELTA on top of the five static fields
 * above, resolved through the SAME shared `interpolateKeys` (`../lib/
 * interpolateKeys.ts`) `Camera.tsx` uses for the scene camera — "reuse the
 * camera's own key mechanics, don't invent a second interpolator," per the
 * research doc. Every key field defaults to `0` when a given key doesn't
 * specify it (see `schema.ts`'s `layerTransform` doc comment for the full
 * "why additive, uniformly across all five fields" reasoning), so an EMPTY
 * or ABSENT `keys` array resolves to an all-zero delta and the applied
 * values below (`tx`/`ty`/`tscale`/`trot`/`topacity`) equal the plain static
 * fields exactly as before this pass — the `keys` branch is only taken when
 * `keys` is a non-empty array, so a manifest that doesn't use this feature
 * renders byte-identically (verified via real `remotion still` renders,
 * D-159's own decision entry). `at` converts from the manifest's seconds via
 * `Math.round(at * fps)`, matching the camera's own conversion one branch up
 * in `TwoD` below.
 */
const renderLayers = (layers: SceneT["layers"], fps: number, frame: number, sceneIndex: number) =>
  (layers ?? []).map((l, i) => {
    const { component: C, adapt } = lookup(l.use);
    const props = adapt(l as unknown as Record<string, unknown>, fps, frame);
    const t = l.transform;
    let tx = t?.x ?? 0;
    let ty = t?.y ?? 0;
    let tscale = t?.scale ?? 1;
    let trot = t?.rot ?? 0;
    let topacity = t?.opacity ?? 1;
    if (t?.keys && t.keys.length > 0) {
      const frameKeys = t.keys.map((k) => ({ ...k, at: Math.round(k.at * fps) }));
      const delta = interpolateKeys(
        frameKeys,
        frame,
        ["x", "y", "scale", "rot", "opacity"] as const,
        { x: 0, y: 0, scale: 0, rot: 0, opacity: 0 },
        design.ease.inOut,
      );
      tx += delta.x;
      ty += delta.y;
      tscale += delta.scale;
      trot += delta.rot;
      topacity += delta.opacity;
    }
    const node = t ? (
      <div
        style={
          t.clipWidth !== undefined && t.clipHeight !== undefined
            ? {
                position: "absolute",
                left: 0,
                top: 0,
                width: t.clipWidth,
                height: t.clipHeight,
                overflow: "hidden",
                transformOrigin: "0 0",
                transform: `translate(${tx}px, ${ty}px) rotate(${trot}deg) scale(${tscale})`,
                opacity: topacity,
              }
            : {
                position: "absolute",
                inset: 0,
                transformOrigin: "0 0",
                transform: `translate(${tx}px, ${ty}px) rotate(${trot}deg) scale(${tscale})`,
                opacity: topacity,
              }
        }
      >
        <C {...props} />
      </div>
    ) : (
      <C {...props} />
    );
    return (
      <div key={`${l.use}-${i}`} data-motion-layer={`${sceneIndex}.${i}`} style={{ display: "contents" }}>
        {node}
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
        <>
          <ThreeD scene={scene} fps={fps} />
          {/* D-174 — a scene with `scene3d` used to NEVER render its own
              `scene.layers` at all: this branch only ever mounted `<ThreeD>`.
              `addLayer` (`manifestEdit.ts`) only routes a primitive into
              `scene3d.children` when the primitive itself is 3D-capable
              (`catalogEntry(use).in3d`) — it never checks whether the TARGET
              scene already has a `scene3d` block, so inserting an ordinary
              2D primitive (e.g. `matrix`) into a `scene3d` scene via the
              Catalog silently created permanently-invisible content: valid,
              committed manifest JSON with no render path to it at all,
              regardless of playhead position. Rendering `<TwoD>` as a 2D
              overlay ON TOP of `<ThreeD>` whenever `scene.layers` actually
              has entries fixes this the general way (2D captions/graphics
              over 3D content is a real, useful composition, not just an
              error case to block) rather than rejecting the insert. Zero
              pixel change for every EXISTING `scene3d` manifest (including
              this engine's own sample `space` scene): none has `layers` at
              all, so this branch never mounts for them — confirmed by the
              condition itself, not merely reasoned about. */}
          {scene.layers && scene.layers.length > 0 && (
            <TwoD scene={scene} fps={fps} sceneIndex={sceneIndex} />
          )}
        </>
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
