/**
 * <Video manifest> — compiles a validated manifest into a sequence of scenes.
 * Registered as the `Animation` composition in Root.tsx (duration + size come
 * from the manifest via calculateMetadata).
 */
import React, { useId } from "react";
import { AbsoluteFill, Sequence, Series, useCurrentFrame, useVideoConfig } from "remotion";
import { Camera } from "../primitives/Camera";
import { interpolateKeys } from "../lib/interpolateKeys";
import { Scene3D } from "../primitives/Scene3D";
import { FilmGrain, Vignette } from "../primitives/postfx";
import { motion } from "../design";
import { resolveManifestTheme } from "../themeDef";
import { ThemeProvider, useTheme } from "../ThemeContext";
import { ensureThemeFonts } from "../themeFonts";
import { lookup } from "./registry";
import { applyAnim } from "../lib/anim";
import {
  CustomComponentsProvider,
  CustomLayerNode,
  useCustomComponents,
  withCustomDefaults,
} from "../custom/renderer";
import type { ComponentRef } from "../custom/componentDef";
import type { Layer, LayerTransform, Manifest, Scene as SceneT } from "./schema";

/**
 * `data-motion-layer="<sceneIndex>.<layerIndex>"` (D-155, `docs/notes/
 * motion-visual-builder-research.md` §3a/§4 Phase 0a) — the hook `@apelles/
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
 * need per-primitive position knowledge (`@apelles/motion`'s `positionFields`)
 * that this ENGINE package must not depend on (wrong direction, `@apelles/
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
type RawLayer = { use: string; transform?: LayerTransform; [key: string]: unknown };

/**
 * D-405 — `renderLayers` takes `layerKey` for a layer's `data-motion-layer`
 * address. At scene level it is the layer's own `<scene>.<index>`; inside a
 * `group` it is `null`, so a click on a group's child resolves (through
 * `.closest('[data-motion-layer]')`) to the GROUP — the one thing the layer
 * list and every `motion_*` op can address today. `anim` tracks are applied
 * first (`../lib/anim.ts`), so an animated prop reaches the adapter, the
 * transform and the group's mask already at this frame's value; a layer with
 * no `anim` is passed through as the same object.
 */
const renderLayers = (
  layers: readonly RawLayer[] | undefined,
  fps: number,
  frame: number,
  sceneIndex: number,
  components: Readonly<Record<string, ComponentRef>>,
  layerKey: ((i: number) => string) | null = (i) => `${sceneIndex}.${i}`,
): React.ReactNode[] =>
  (layers ?? []).map((l0, i) => {
    // D-409 — a custom layer's declared defaults sit under its own props first,
    // so an `anim` track on `props.<id>` always has an object to land in.
    const l = applyAnim(withCustomDefaults(l0, components), frame, fps);
    const t = l.transform;
    let tx = t?.x ?? 0;
    let ty = t?.y ?? 0;
    let tscale = t?.scale ?? 1;
    let trot = t?.rot ?? 0;
    let topacity = t?.opacity ?? 1;
    let tblur = t?.blur ?? 0;
    if (t?.keys && t.keys.length > 0) {
      const frameKeys = t.keys.map((k) => ({ ...k, at: Math.round(k.at * fps) }));
      const delta = interpolateKeys(
        frameKeys,
        frame,
        ["x", "y", "scale", "rot", "opacity", "blur"] as const,
        { x: 0, y: 0, scale: 0, rot: 0, opacity: 0, blur: 0 },
        motion.ease.inOut,
      );
      tx += delta.x;
      ty += delta.y;
      tscale += delta.scale;
      trot += delta.rot;
      topacity += delta.opacity;
      tblur += delta.blur;
    }
    const content =
      l.use === "group" ? (
        <GroupNode layer={l} fps={fps} sceneIndex={sceneIndex} />
      ) : l.use === "custom" ? (
        <CustomLayerNode layer={l} raw={l0} fps={fps} />
      ) : (
        (() => {
          const { component: C, adapt } = lookup(l.use as Layer["use"]);
          return <C {...adapt(l, fps, frame)} />;
        })()
      );
    // D-393 — a Gaussian blur radius in px; `undefined` (no `filter` at all)
    // whenever it resolves to <= 0, so a layer that never blurs renders exactly
    // as it did before the field existed.
    const tfilter = tblur > 0 ? `blur(${tblur}px)` : undefined;
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
                filter: tfilter,
              }
            : {
                position: "absolute",
                inset: 0,
                transformOrigin: "0 0",
                transform: `translate(${tx}px, ${ty}px) rotate(${trot}deg) scale(${tscale})`,
                opacity: topacity,
                filter: tfilter,
              }
        }
      >
        {content}
      </div>
    ) : (
      content
    );
    return (
      <div
        key={`${l.use}-${i}`}
        data-motion-layer={layerKey ? layerKey(i) : undefined}
        style={{ display: "contents" }}
      >
        {node}
      </div>
    );
  });

/** D-405 — a group's `mask` as a CSS `clip-path` for a shape, or `null` for a
 *  text mask (which needs an SVG `<clipPath>`, see `GroupNode`). Coordinates
 *  are world px; `W`/`H` are the canvas, which the group's wrapper fills. */
function shapeClipPath(mask: Record<string, unknown>, W: number, H: number): string | null {
  const n = (k: string) => (typeof mask[k] === "number" ? (mask[k] as number) : 0);
  const [x, y, w, h, r] = [n("x"), n("y"), n("w"), n("h"), n("radius")];
  if (mask.kind === "ellipse") return `ellipse(${w / 2}px ${h / 2}px at ${x + w / 2}px ${y + h / 2}px)`;
  if (mask.kind === "rect" || mask.kind === "roundrect") {
    const round = mask.kind === "roundrect" ? ` round ${r}px` : "";
    return `inset(${y}px ${W - x - w}px ${H - y - h}px ${x}px${round})`;
  }
  return null;
}

/** The group's children at the group's LOCAL frame (inside its `Sequence`). */
const GroupChildren: React.FC<{ layers: readonly RawLayer[]; fps: number; sceneIndex: number }> = ({
  layers,
  fps,
  sceneIndex,
}) => {
  const frame = useCurrentFrame();
  const components = useCustomComponents();
  return <>{renderLayers(layers, fps, frame, sceneIndex, components, null)}</>;
};

/**
 * D-405 — one `group`: its children inside a `Sequence` that starts at the
 * group's `at` (so their own `at`s, and every primitive's `useCurrentFrame`,
 * are relative to it) and ends after its `dur` when one is set, clipped by its
 * `mask`. The group's `transform` is applied by `renderLayers` around this,
 * exactly as for any layer, so it moves all of its children at once.
 *
 * A text mask is an SVG `<clipPath>` holding a `<text>`, referenced by
 * `clip-path: url(#…)`: the letters use the document's own (theme) fonts, which
 * an SVG image or a mask image could not load. Its id comes from `useId`,
 * which is stable for a given tree, so a render is deterministic.
 */
const GroupNode: React.FC<{ layer: RawLayer; fps: number; sceneIndex: number }> = ({ layer, fps, sceneIndex }) => {
  const { width: W, height: H } = useVideoConfig();
  const theme = useTheme();
  const clipId = `group-clip-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const start = typeof layer.at === "number" ? Math.round(layer.at * fps) : 0;
  const dur = typeof layer.dur === "number" ? Math.max(1, Math.round(layer.dur * fps)) : undefined;
  const children = (Array.isArray(layer.children) ? layer.children : []) as RawLayer[];
  const mask = layer.mask && typeof layer.mask === "object" ? (layer.mask as Record<string, unknown>) : null;
  const shapeClip = mask ? shapeClipPath(mask, W, H) : null;
  const textMask = mask && mask.kind === "text" ? mask : null;
  const anchor = textMask?.align === "center" ? "middle" : textMask?.align === "right" ? "end" : "start";
  return (
    <Sequence from={start} durationInFrames={dur} layout="none">
      {textMask && (
        <svg width={0} height={0} style={{ position: "absolute" }} aria-hidden>
          <clipPath id={clipId} clipPathUnits="userSpaceOnUse">
            <text
              x={typeof textMask.x === "number" ? textMask.x : 0}
              y={typeof textMask.y === "number" ? textMask.y : 0}
              dominantBaseline="hanging"
              textAnchor={anchor}
              fontFamily={typeof textMask.font === "string" ? textMask.font : theme.fontDisplay}
              fontSize={typeof textMask.size === "number" ? textMask.size : 160}
              fontWeight={typeof textMask.weight === "number" ? textMask.weight : 800}
              letterSpacing={typeof textMask.letterSpacing === "number" ? textMask.letterSpacing : undefined}
            >
              {typeof textMask.text === "string" ? textMask.text : ""}
            </text>
          </clipPath>
        </svg>
      )}
      <div
        style={{
          position: "absolute",
          inset: 0,
          clipPath: textMask ? `url(#${clipId})` : (shapeClip ?? undefined),
        }}
      >
        <GroupChildren layers={children} fps={fps} sceneIndex={sceneIndex} />
      </div>
    </Sequence>
  );
};

const TwoD: React.FC<{ scene: SceneT; fps: number; sceneIndex: number }> = ({ scene, fps, sceneIndex }) => {
  const frame = useCurrentFrame();
  const components = useCustomComponents();
  const nodes = renderLayers(scene.layers as RawLayer[] | undefined, fps, frame, sceneIndex, components);
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
  const theme = useTheme();
  const showGrain = scene.grain ?? grain;
  const vig = scene.vignette ?? vignette;
  // The scene's OWN `bg` still wins over the theme's ground, exactly as it
  // won over the old module constant (D-339).
  const bg = scene.bg ?? (transparent ? "transparent" : theme.bg);
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

/**
 * props ARE the manifest (so `--props=manifest.json` works directly)
 *
 * D-339 — this is the one place a manifest's optional top-level `theme` is
 * turned into a real `Theme` and published to every primitive below
 * (`ThemeProvider`, `../ThemeContext.tsx`). It is the right place because it
 * is already where a scene manifest is consumed per render, and because a
 * theme is a property of the DOCUMENT: everything under here — 2D layers, the
 * camera, the 3D scene, the post-FX — is inside exactly one manifest.
 *
 * `theme` absent ⇒ `resolveManifestTheme` ⇒ the engine default, i.e. every
 * manifest written before this pass renders exactly as it did. D-399: a
 * manifest's own `themeDef` (an embedded user theme) wins over a name.
 *
 * `ensureThemeFonts` runs here rather than at module scope so a theme nobody
 * selected never pays for its webfonts; it is idempotent per theme per
 * process, and the default theme's own face is still loaded eagerly at
 * `../themeFonts.ts`'s module scope, which is where this file's old
 * unconditional `loadFont()` (Kalam) moved to.
 */
/** A stable empty map, so a document without components re-renders nothing. */
const NO_COMPONENTS: Readonly<Record<string, ComponentRef>> = {};

export const Video: React.FC<Manifest> = (manifest) => {
  const { fps } = manifest;
  const theme = resolveManifestTheme(manifest);
  ensureThemeFonts(theme);
  return (
    <ThemeProvider theme={theme}>
    {/* D-409 — the document's embedded custom-component definitions. Who
        DRAWS them is the runtime's choice (`../custom/renderer.tsx`). */}
    <CustomComponentsProvider components={manifest.components ?? NO_COMPONENTS}>
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
    </CustomComponentsProvider>
    </ThemeProvider>
  );
};
