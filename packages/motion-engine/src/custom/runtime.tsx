/**
 * runtime.tsx — the ONE place certified custom-component code runs (D-409).
 *
 * What it is: the `CustomRenderer` the Remotion renderer process installs
 * (`Root.tsx` wraps the `Animation` composition in it). For a layer it fetches
 * the component's compiled module from the project's asset folder (Remotion's
 * `public/`, `--public-dir`; the file is named by the SHA-256 of its bytes),
 * checks those bytes against the `codeHash` the manifest pinned, evaluates the
 * module once with a `require` that hands out only the allowlisted modules
 * (`allowlist.ts`), and renders its default export with the layer's props.
 * `delayRender` holds the frame until the module is ready, so no frame is
 * captured before the component can draw.
 *
 * **Where this runs, and where it must not.** Only in the headless Chrome
 * that `remotion render` / `remotion still` drive: a separate process with no
 * Tauri IPC and no app privileges. Nothing in the app webview imports this
 * module (the live player uses `@apelles/motion`'s proxy renderer, which only
 * shows frames rendered here). That process boundary is the security
 * boundary. The static check (`sourceCheck.ts`) and certification are about
 * determinism and hygiene; they are not a sandbox, and this file does not
 * pretend to be one.
 *
 * What it does NOT do: check source (done before a version can exist),
 * compile anything (the library stores the compiled module), or cache across
 * renders (one evaluation per module per renderer page).
 */
import * as React from "react";
import { useEffect, useState } from "react";
import * as jsxRuntime from "react/jsx-runtime";
import * as remotion from "remotion";
import { cancelRender, continueRender, delayRender, staticFile } from "remotion";
import * as remotionShapes from "@remotion/shapes";
import * as remotionPaths from "@remotion/paths";
import * as remotionNoise from "@remotion/noise";
import * as remotionAnimationUtils from "@remotion/animation-utils";
import * as remotionThree from "@remotion/three";
import * as three from "three";
import * as reactThreeFiber from "@react-three/fiber";
import * as d3Force from "d3-force";
import { assetFileName } from "../lib/assetId";
import type { AllowedComponentImport } from "./allowlist";
import type { ComponentProps } from "./componentApi";
import type { ComponentRef } from "./componentDef";
import type { CustomRenderer } from "./renderer";

type Component = React.ComponentType<ComponentProps>;

/** What `require(spec)` returns inside a component: exactly the allowlist.
 *  Typed against it, so adding a module to the list without wiring it here
 *  is a `tsc` error. `@apelles/component` is types only. */
const MODULES: Record<AllowedComponentImport, unknown> = {
  react: React,
  "react/jsx-runtime": jsxRuntime,
  remotion,
  "@remotion/shapes": remotionShapes,
  "@remotion/paths": remotionPaths,
  "@remotion/noise": remotionNoise,
  "@remotion/animation-utils": remotionAnimationUtils,
  "@remotion/three": remotionThree,
  three,
  "@react-three/fiber": reactThreeFiber,
  "d3-force": d3Force,
  "@apelles/component": {},
};

function isAllowed(spec: string): spec is AllowedComponentImport {
  return Object.prototype.hasOwnProperty.call(MODULES, spec);
}

function toHex(buf: ArrayBuffer): string {
  return Array.from(new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Evaluate one compiled CommonJS module and return its default export. */
function evaluate(code: string, ref: string): Component {
  const module: { exports: Record<string, unknown> } = { exports: {} };
  const requireAllowed = (spec: string): unknown => {
    if (isAllowed(spec)) return MODULES[spec];
    throw new Error(`custom component ${ref} requires "${spec}", which is not an allowed import`);
  };
  // The one evaluation of component code in the codebase, in the renderer
  // process only (see the header). The module's text was checked statically
  // and certified before it could reach a project, and its bytes were just
  // matched against the pinned hash.
  const factory = new Function("require", "module", "exports", code) as (
    require: (spec: string) => unknown,
    module: { exports: Record<string, unknown> },
    exports: Record<string, unknown>,
  ) => void;
  factory(requireAllowed, module, module.exports);
  const C = module.exports.default;
  if (typeof C !== "function") throw new Error(`custom component ${ref} has no default-exported component`);
  return C as Component;
}

const loading = new Map<string, Promise<Component>>();
const ready = new Map<string, Component>();

/** The component for `def`, loaded and verified once per renderer page. */
function load(def: ComponentRef): Promise<Component> {
  const ref = `${def.id}@${def.version}`;
  const existing = loading.get(def.code);
  if (existing) return existing;
  const p = (async () => {
    const res = await fetch(staticFile(assetFileName(def.code)));
    if (!res.ok) throw new Error(`custom component ${ref}: its module ${def.code} is missing from the project (HTTP ${res.status})`);
    const bytes = await res.arrayBuffer();
    const hash = toHex(await crypto.subtle.digest("SHA-256", bytes));
    if (hash !== def.codeHash) {
      throw new Error(`custom component ${ref}: module bytes hash to ${hash}, not the certified ${def.codeHash}`);
    }
    const C = evaluate(new TextDecoder().decode(bytes), ref);
    ready.set(def.code, C);
    return C;
  })();
  loading.set(def.code, p);
  return p;
}

/** Runs the certified component (renderer process only). */
export const CodeRenderer: CustomRenderer = ({ def, props, theme, width, height, durationInFrames }) => {
  const [C, setC] = useState<Component | null>(() => ready.get(def.code) ?? null);
  const [handle] = useState(() => (ready.has(def.code) ? null : delayRender(`custom component ${def.id}@${def.version}`)));
  useEffect(() => {
    if (handle === null) return;
    let live = true;
    load(def).then(
      (loaded) => {
        if (live) setC(() => loaded);
        continueRender(handle);
      },
      (err: unknown) => cancelRender(err instanceof Error ? err : new Error(String(err))),
    );
    return () => {
      live = false;
    };
  }, [def, handle]);
  if (!C) return null;
  return <C props={props} theme={theme} width={width} height={height} durationInFrames={durationInFrames} />;
};
