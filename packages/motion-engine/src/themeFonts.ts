/**
 * themeFonts.ts — the webfonts each theme's type stacks actually need (D-339).
 *
 * What it is: one `ensureThemeFonts(name)` call that injects the `@font-face`
 * rules for a theme's own faces via `@remotion/google-fonts`, at most once per
 * theme per process.
 *
 * What it does NOT do: it does not pick fonts (the stacks live in `design.ts`,
 * sourced from the site's own `--font-*` tokens) and it does not wait — each
 * `loadFont()` registers its own `delayRender()` internally, which is exactly
 * how Remotion already blocks a frame until a face is ready.
 *
 * Why eager for the default and lazy for the rest: `Kalam` was loaded
 * unconditionally at `engine/Video.tsx`'s module scope before this file
 * existed, and every pre-D-339 manifest renders through the theme that uses
 * it — so it keeps loading exactly when and how it always did, at module
 * scope, below. A theme nobody selected has no business paying for three more
 * font downloads on every render, so the others load the first time a render
 * actually resolves to them. `loadFont()` is itself idempotent; the `loaded`
 * set is here so a second render (or React's double-invoked render in dev)
 * does not re-enter the loader at all.
 */
import { loadFont as loadKalam } from "@remotion/google-fonts/Kalam";
import { loadFont as loadNewsreader } from "@remotion/google-fonts/Newsreader";
import { loadFont as loadInstrumentSans } from "@remotion/google-fonts/InstrumentSans";
import { loadFont as loadIBMPlexMono } from "@remotion/google-fonts/IBMPlexMono";
import { DEFAULT_THEME_NAME, type ThemeName } from "./design";

const LOADERS: Record<ThemeName, () => void> = {
  "dark-excalidraw": () => {
    // Deliberately argument-free: this is `Video.tsx`'s own pre-D-339 call,
    // moved here verbatim. Narrowing it would change which faces exist at
    // render time for every existing manifest.
    loadKalam();
  },
  // Latin only, and only the weights the primitives actually render — a
  // full-family load pulls every weight AND every subset (latin-ext,
  // vietnamese, cyrillic, …) for no visible gain.
  "apelles-studio": () => {
    loadNewsreader("normal", { subsets: ["latin"], weights: ["400", "600"] });
    loadInstrumentSans("normal", { subsets: ["latin"], weights: ["400", "500", "600"] });
    loadIBMPlexMono("normal", { subsets: ["latin"], weights: ["400", "500"] });
  },
};

const loaded = new Set<ThemeName>();

export const ensureThemeFonts = (name: ThemeName): void => {
  if (loaded.has(name)) return;
  loaded.add(name);
  LOADERS[name]();
};

// The default theme's face, loaded at module scope exactly as `Video.tsx` did
// before D-339 — see this file's header for why this one is not lazy.
ensureThemeFonts(DEFAULT_THEME_NAME);
