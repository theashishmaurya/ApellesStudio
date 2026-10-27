/**
 * renderer.tsx — how a custom-component layer reaches the screen (D-409).
 *
 * What it is: the `custom` branch of the layer renderer, split from WHO draws
 * the component. `CustomLayerNode` does what every layer does — times it
 * (a `Sequence` from its `at`, for its `dur`), places it (an absolute box at
 * `x`/`y`, `w`×`h`) and resolves its props (declared defaults under the layer's
 * own, `anim` already applied) — and then hands one `CustomRenderRequest` to
 * the `CustomRenderer` the runtime provides through context.
 *
 * **The security boundary is this injection.** Agent-written code must never
 * execute inside the Tauri webview, which has IPC to the backend. So the
 * engine itself never runs component code: the DEFAULT renderer here is a
 * labelled placeholder box. Only the Remotion renderer process — the headless
 * Chrome that `remotion render` / `still` drive, with no Tauri IPC — installs
 * the code renderer (`runtime.tsx`, imported by `Root.tsx` and nothing else).
 * The app's live player installs a PROXY renderer instead
 * (`@apelles/motion`'s `customProxy.tsx`), which shows frames that the
 * renderer process rendered. Nothing in the webview's module graph imports
 * `runtime.tsx`, so the evaluator is not even present there.
 *
 * What it does NOT do: load, check or evaluate code.
 */
import React, { createContext, useContext } from "react";
import { Sequence } from "remotion";
import type { Theme } from "../design";
import { useTheme } from "../ThemeContext";
import { componentDefaults, type ComponentRef } from "./componentDef";

/** Everything a renderer needs to draw one custom layer at this frame. */
export interface CustomRenderRequest {
  /** the pinned definition, from the manifest */
  def: ComponentRef;
  /** the layer as authored (props and anim tracks un-evaluated) — what a
   *  proxy renderer re-renders out of process */
  raw: Readonly<Record<string, unknown>>;
  /** the props at this frame: declared defaults, the layer's own over them,
   *  `anim` tracks applied */
  props: Readonly<Record<string, unknown>>;
  theme: Theme;
  /** the box, px */
  width: number;
  height: number;
  /** how long the layer plays: its `dur`, else the component's `duration` */
  durationInFrames: number;
}

export type CustomRenderer = React.FC<CustomRenderRequest>;

/** The safe default: a labelled box, never the component's code. */
export const PlaceholderRenderer: CustomRenderer = ({ def, theme, width, height }) => (
  <div
    style={{
      width,
      height,
      boxSizing: "border-box",
      border: `2px dashed ${theme.strokeSoft}`,
      color: theme.textDim,
      fontFamily: theme.fontUi,
      fontSize: Math.max(12, Math.min(28, Math.round(Math.min(width, height) / 10))),
      display: "flex",
      alignItems: "center",
      justifyContent: "center",
      textAlign: "center",
    }}
  >
    {def.name} · custom
  </div>
);

const RendererCtx = createContext<CustomRenderer>(PlaceholderRenderer);
const ComponentsCtx = createContext<Readonly<Record<string, ComponentRef>>>({});

export const CustomRendererProvider: React.FC<{ renderer: CustomRenderer; children: React.ReactNode }> = ({
  renderer,
  children,
}) => <RendererCtx.Provider value={renderer}>{children}</RendererCtx.Provider>;

/** The document's embedded definitions, published once by `Video.tsx`. */
export const CustomComponentsProvider: React.FC<{
  components: Readonly<Record<string, ComponentRef>>;
  children: React.ReactNode;
}> = ({ components, children }) => <ComponentsCtx.Provider value={components}>{children}</ComponentsCtx.Provider>;

export const useCustomComponents = (): Readonly<Record<string, ComponentRef>> => useContext(ComponentsCtx);

/** A custom layer with its declared defaults filled in under its own props,
 *  so `anim` tracks on `props.<id>` always have an object to land in. The same
 *  object for anything that is not a custom layer with a known definition. */
export function withCustomDefaults<T extends Record<string, unknown>>(
  layer: T,
  components: Readonly<Record<string, ComponentRef>>,
): T {
  if (layer.use !== "custom" || typeof layer.component !== "string") return layer;
  const def = components[layer.component];
  if (!def) return layer;
  const own = layer.props && typeof layer.props === "object" ? (layer.props as Record<string, unknown>) : {};
  return { ...layer, props: { ...componentDefaults(def), ...own } };
}

const num = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);

/**
 * One custom layer. `layer` has its props materialised and `anim` applied at
 * the parent's frame (`Video.tsx`'s `renderLayers`); `raw` is as authored.
 * Inside, `useCurrentFrame()` counts from the layer's own start, like every
 * primitive's local time.
 */
export const CustomLayerNode: React.FC<{
  layer: Readonly<Record<string, unknown>>;
  raw: Readonly<Record<string, unknown>>;
  fps: number;
}> = ({ layer, raw, fps }) => {
  const Renderer = useContext(RendererCtx);
  const components = useContext(ComponentsCtx);
  const theme = useTheme();
  const def = typeof layer.component === "string" ? components[layer.component] : undefined;
  // A missing definition cannot load (the manifest schema refuses it); this
  // floor only keeps a hand-broken document from crashing the player.
  if (!def) return null;
  const start = Math.round(num(layer.at, 0) * fps);
  const dur = typeof layer.dur === "number" && layer.dur > 0 ? Math.max(1, Math.round(layer.dur * fps)) : undefined;
  const width = num(layer.w, def.size.w);
  const height = num(layer.h, def.size.h);
  const props = layer.props && typeof layer.props === "object" ? (layer.props as Record<string, unknown>) : {};
  return (
    <Sequence from={start} durationInFrames={dur} layout="none">
      <div
        data-motion-box
        style={{ position: "absolute", left: num(layer.x, 0), top: num(layer.y, 0), width, height }}
      >
        <Renderer
          def={def}
          raw={raw}
          props={props}
          theme={theme}
          width={width}
          height={height}
          durationInFrames={dur ?? Math.max(1, Math.round(def.duration * fps))}
        />
      </div>
    </Sequence>
  );
};
