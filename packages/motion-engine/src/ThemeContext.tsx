/**
 * ThemeContext.tsx — how a resolved `Theme` reaches every primitive (D-339).
 *
 * What it is: one React context carrying the theme `Video.tsx` resolved from
 * the manifest's top-level `theme` field, plus the `useTheme()` hook every
 * primitive calls instead of importing a module constant.
 *
 * What it does NOT do: it does not resolve the theme (that is `design.ts`'s
 * `resolveTheme`), it does not read the manifest, and it deliberately has no
 * setter — a theme is a property of the document being rendered, not UI state
 * a component can toggle mid-render. Changing it means writing
 * `manifest.theme` (`motion_set_project_theme`, or the raw-JSON editor).
 *
 * Why a context rather than a prop: before D-339 the look was a bare module
 * constant 19 files imported directly, which cannot vary per render. Prop-
 * drilling a theme instead would have to pass through `registry.ts`'s generic
 * `adapt(raw, fps, frame) → props` boundary, which exists precisely so the
 * engine does not have to know each primitive's prop shape — a theme prop
 * would have to be smuggled through that untyped bag and then defended
 * against a manifest that sets `theme:` on a layer. A context sidesteps all
 * of it and matches how Remotion's own `useVideoConfig()` reaches the same
 * components.
 *
 * The default context value is the DEFAULT theme, so a component rendered
 * with no provider at all — every `compositions/*Demo.tsx`, and
 * `@apelles/motion`'s single-layer `LayerThumbnail` before it was taught to
 * provide one — gets exactly the look it got before this context existed.
 */
import React from "react";
import { DEFAULT_THEME, type Theme } from "./design";

const ThemeCtx = React.createContext<Theme>(DEFAULT_THEME);

export const ThemeProvider: React.FC<{
  theme: Theme;
  children: React.ReactNode;
}> = ({ theme, children }) => (
  <ThemeCtx.Provider value={theme}>{children}</ThemeCtx.Provider>
);

/** The active theme. Outside a `<ThemeProvider>`, the engine default. */
export const useTheme = (): Theme => React.useContext(ThemeCtx);
