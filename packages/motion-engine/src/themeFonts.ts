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
import { continueRender, delayRender } from "remotion";
import { getAvailableFonts } from "@remotion/google-fonts";
import { DEFAULT_THEME_NAME, THEMES, type Theme, type ThemeName } from "./design";

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
  // D-394 — the same three faces as its dark sibling.
  "apelles-studio-light": () => {
    loadNewsreader("normal", { subsets: ["latin"], weights: ["400", "600"] });
    loadInstrumentSans("normal", { subsets: ["latin"], weights: ["400", "500", "600"] });
    loadIBMPlexMono("normal", { subsets: ["latin"], weights: ["400", "500"] });
  },
};

const loaded = new Set<string>();

/** The one shape of a family module's `loadFont` this file relies on; the
 *  generated per-family typings differ in their weight/subset unions, which
 *  user-supplied data cannot satisfy statically. */
type LoadFont = (
  style: "normal" | "italic",
  options: { weights?: string[]; subsets?: string[] },
) => { waitUntilDone: () => Promise<unknown> };

/**
 * D-399 — a user theme's webfonts, by Google Fonts family NAME.
 *
 * Each family is looked up in `@remotion/google-fonts`' catalogue, loaded
 * through its dynamic import, and held with `delayRender` until the face is
 * ready, so a frame is never rendered in the fallback font. A family the
 * catalogue does not have is warned about and skipped: the stack's own
 * fallbacks (`serif`, `monospace`, …) then render, which is a degraded look,
 * not a failed render.
 */
const loadCustomFonts = (theme: Theme): void => {
  const available = getAvailableFonts();
  for (const font of theme.fonts ?? []) {
    const entry = available.find((f) => f.fontFamily === font.family);
    if (!entry) {
      console.warn(`[themeFonts] theme "${theme.name}": no Google Fonts family "${font.family}"`);
      continue;
    }
    const handle = delayRender(`theme font ${font.family}`);
    void entry
      .load()
      .then((mod) => {
        const loadFont = (mod as unknown as { loadFont: LoadFont }).loadFont;
        return loadFont(font.italic ? "italic" : "normal", {
          weights: font.weights,
          subsets: ["latin"],
        }).waitUntilDone();
      })
      .catch((e: unknown) => {
        console.warn(`[themeFonts] theme "${theme.name}": could not load "${font.family}": ${String(e)}`);
      })
      .finally(() => continueRender(handle));
  }
};

/** Load the faces `theme` needs, at most once per theme name per process. A
 *  built-in uses its own loader above; a user theme loads its `fonts`. */
export const ensureThemeFonts = (theme: Theme): void => {
  // A user theme can be redefined under the same name with other fonts, so its
  // key includes them; a built-in's name is its whole identity.
  const key = theme.name in THEMES ? theme.name : `${theme.name}|${JSON.stringify(theme.fonts ?? [])}`;
  if (loaded.has(key)) return;
  loaded.add(key);
  if (theme.name in THEMES) LOADERS[theme.name as ThemeName]();
  else loadCustomFonts(theme);
};

// The default theme's face, loaded at module scope exactly as `Video.tsx` did
// before D-339 — see this file's header for why this one is not lazy.
ensureThemeFonts(THEMES[DEFAULT_THEME_NAME]);
