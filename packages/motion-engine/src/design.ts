/**
 * design.ts — the motion engine's THEME REGISTRY (D-339), plus the small set
 * of motion constants that are deliberately NOT themed.
 *
 * What it is
 *   A named registry of complete look definitions (`THEMES`), one of which is
 *   resolved per render from the scene manifest's optional top-level `theme`
 *   field (`engine/schema.ts`) and handed to every primitive through a React
 *   context (`../ThemeContext.tsx`). A `Theme` is the whole look: the ground,
 *   the ink, the accents, the stroke feel, the type, and how much (if at all)
 *   things drift.
 *
 * What it does NOT do
 *   It does not hold per-scene or per-layer overrides (a scene's own `bg` and
 *   a layer's own `color` props already do that, and always win over the
 *   theme), and it does not hold the engine's motion grammar — see `motion`
 *   at the bottom of this file.
 *
 * History (D-339)
 *   Until 2026-09-17 this file exported ONE flat `design` object, documented
 *   as "the locked dark Excalidraw / tldraw look… every primitive pulls from
 *   here; content varies via props, the look does not." That lock was a real,
 *   deliberate decision and it is NOT reversed: those exact values are still
 *   here, unchanged to the byte, as the `dark-excalidraw` preset, and they
 *   are still the engine's DEFAULT — a manifest with no `theme` key renders
 *   exactly as it always did. What changed is that the look is now selectable
 *   rather than hardcoded, so a second project can have a second look without
 *   a second engine (owner, 2026-09-16: "We should have a way to setup a
 *   theme for any of them should be dynamic but for our video please lock the
 *   design while developing").
 */

import type { ThemeFont, ThemeFontFile } from "./themeDef";

/** The complete look one render resolves to. Every field is consumed by at
 *  least one primitive — see each field's own note for who reads it. */
export interface Theme {
  /** the registry key this theme is published under; for a user theme
   *  (`themeDef.ts`, D-399) its own id, which is never a built-in's */
  name: string;
  /** one line, for a picker/tool listing */
  description: string;

  // ---- ground ----
  /** the scene's default background (`Video.tsx`'s `OneScene`, `Scene3D`) */
  bg: string;
  /** the second ground: card/panel fills, 3D box faces, the vignette's edge */
  bgDeep: string;

  // ---- ink ----
  /** primary stroke colour — graph node rings, the roughjs default */
  stroke: string;
  /** secondary lines: matrix cell borders, graph edges, inactive card borders */
  strokeSoft: string;
  /** primary text */
  text: string;
  /** secondary text: captions, labels, inactive card text */
  textDim: string;

  // ---- accents ----
  /**
   * The emphasis / active-state colour: `emphasis`'s default, the lit card in
   * `layers` (and its callout), the typewriter caret, the active plane in a
   * 3D `layerstack`. (Was `accentRed` before D-339 — renamed to the ROLE,
   * since a registry whose second preset has no red in it cannot keep a
   * colour name in the token.)
   */
  accent: string;
  /**
   * The signal / energy colour: matrix cell fills, graph pulses and node
   * highlights, `particleflow`'s default, the 3D glow/point-light. (Was
   * `accentBlue`.) A theme MAY set this to the same value as `accent` when
   * its own palette has only one working colour — `apelles-studio` does.
   */
  accentSignal: string;

  // ---- stroke feel ----
  /** px at 1080p */
  strokeWidth: number;
  /** roughjs `roughness`. `0` ⇒ clean, exact geometry (see `apelles-studio`) */
  roughness: number;
  /** roughjs `bowing`. `0` ⇒ straight lines stay straight */
  bowing: number;

  // ---- type ----
  /** headlines — `text`'s default font */
  fontDisplay: string;
  /** labels and body — `graph` node labels, `layers` card labels/callouts */
  fontUi: string;
  /** numbers, data, axis labels */
  fontMono: string;

  // ---- ambient motion ----
  /** amplitude of the always-on drift, in px. `0` ⇒ nothing drifts at all. */
  ambientDriftPx: number;

  // ---- webfonts (user themes only) ----
  /** Google Fonts families to download for the stacks above. Built-ins leave
   *  this unset: their faces load through `themeFonts.ts`'s own loaders. */
  fonts?: ThemeFont[];
  /** D-416 — font FILES from the document's asset folder (a brand kit's own
   *  type), registered under their family names by `themeFonts.ts`. */
  fontFiles?: ThemeFontFile[];
}

/**
 * The original locked look, value-for-value as it stood before D-339.
 *
 * Do not "improve" these numbers: every manifest written against this engine
 * before 2026-09-17 renders through this preset, and the engine's own
 * determinism invariant (CLAUDE.md — same doc + same frame ⇒ identical
 * pixels) makes a drift here a regression, not a tweak. `themes.test.ts`
 * (`@apelles/motion`) pins every field below against a frozen copy of the
 * pre-D-339 `design` object for exactly this reason.
 */
const DARK_EXCALIDRAW: Theme = {
  name: "dark-excalidraw",
  description:
    "The house hand-drawn look: flat dark slate, off-white roughjs strokes, one red and one blue accent, Kalam lettering.",

  // ground
  bg: "#1e1e24", // flat dark slate — a clean solid UI colour, NOT a textured chalkboard
  bgDeep: "#17171c", // slightly darker, for layered panels / vignette edges

  // ink
  stroke: "#e8e8e8", // off-white hand-drawn strokes
  strokeSoft: "#a9a9b2", // secondary lines, captions
  text: "#efefef",
  textDim: "#9a9aa4",

  // accents — exactly two, used sparingly (an underline, a highlight, one arrow)
  accent: "#e5484d",
  accentSignal: "#5b8def",

  // stroke feel
  strokeWidth: 3, // px at 1080p; scale with resolution
  roughness: 1.6, // roughjs roughness
  bowing: 1.2, // roughjs bowing

  // type
  fontDisplay: '"Kalam", "Comic Neue", "Segoe Print", cursive', // load via @remotion/google-fonts (Kalam)
  fontUi: '"Kalam", "Comic Neue", "Segoe Print", cursive', // this look has ONE face; see the D-339 note below
  fontMono: '"JetBrains Mono", ui-monospace, monospace',

  // "nothing sits perfectly still" — amplitude of the always-on ambient drift, in px
  ambientDriftPx: 1.5,
};

/**
 * apelles.studio's own editorial look (D-339), sourced field-by-field from
 * `website/src/styles/tokens.css` — the site's single colour/type source
 * (D-264, palette from the Alexander Mosaic; signature moved to ink by
 * D-284). Nothing here is invented: every value below is either a
 * `--pigment-*` / `--font-*` token verbatim, or one of that file's own
 * `color-mix()` tints flattened to an opaque hex (see the note on
 * `strokeSoft`).
 *
 * Three rules this preset inherits from the site rather than re-deciding:
 *
 *  1. **Ochre, not terracotta, is the working colour on a basalt ground.**
 *     `tokens.css` states it outright: terracotta is 2.9:1 on basalt and
 *     fails even large-text contrast, while ochre — capped at marks/rules on
 *     the light ground because it is only 3.0:1 there — reaches 5.1:1 on
 *     basalt. So inside a dark section ochre takes over the link/emphasis
 *     role and terracotta is not used at all. That is why BOTH accent slots
 *     below are ochre: this palette genuinely has one working colour on
 *     dark, and splitting it into two competing hues to fill a token slot
 *     would be inventing a palette the site does not have. (The site's one
 *     remaining terracotta-on-dark value, `--danger-inverse`, is a form
 *     error state — no primitive in this engine has a danger role, so
 *     carrying it here would be a dead token.)
 *  2. **The ground is basalt, a warm black. `#000` appears nowhere.**
 *  3. **This is not a sketch style.** `roughness`/`bowing` are `0`, which
 *     makes roughjs emit exact geometry (a line is a line, an ellipse is an
 *     ellipse) rather than a hand-drawn approximation of it — so the shared
 *     roughjs path (`lib/rough.ts`) needs no structural change to render a
 *     clean look, it just stops jittering. `ambientDriftPx` is `0` for the
 *     same reason: "nothing sits perfectly still" is an Excalidraw-ism, and
 *     the website has no motion of that kind anywhere on it.
 */
const APELLES_STUDIO: Theme = {
  name: "apelles-studio",
  description:
    "apelles.studio's editorial look: warm-black basalt ground, marble ink, one ochre working colour, Newsreader / Instrument Sans / IBM Plex Mono, clean (non-sketch) geometry.",

  // ground — `--pigment-basalt`. A basalt section on the site has ONE ground:
  // a panel on it is separated by a marble hairline, not by a second, darker
  // fill, so `bgDeep` is deliberately the same value rather than a hand-picked
  // darker one that exists nowhere in the palette.
  bg: "#1c1a17",
  bgDeep: "#1c1a17",

  // ink — `--ink-inverse` (= `--pigment-marble`) and `--ink-inverse-soft`
  // (`color-mix(in srgb, marble 68%, transparent)`).
  //
  // The soft value is FLATTENED against the basalt ground to an opaque hex
  // rather than carried as `rgba(244,239,230,0.68)`: these tokens are read by
  // an SVG `stroke`, a CSS `border`, AND a three.js material (`Scene3D.tsx`),
  // and three.js's colour parser discards alpha — so a translucent token
  // would silently render as full-strength marble in 3D while reading correctly
  // in 2D. One opaque value behaves identically everywhere, which is what the
  // determinism invariant wants.
  stroke: "#f4efe6", // --pigment-marble
  strokeSoft: "#afaba4", // --ink-inverse-soft over basalt
  text: "#f4efe6",
  textDim: "#afaba4",

  // accents — `--pigment-ochre`, in both roles. See rule 1 above.
  accent: "#b4823a",
  accentSignal: "#b4823a",

  // stroke feel — clean, editorial. See rule 3 above.
  strokeWidth: 2,
  roughness: 0,
  bowing: 0,

  // type — `--font-display` / `--font-ui` / `--font-mono`, verbatim.
  fontDisplay: "'Newsreader', 'Iowan Old Style', Georgia, serif",
  fontUi: "'Instrument Sans', system-ui, -apple-system, sans-serif",
  fontMono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",

  // nothing drifts. See rule 3 above.
  ambientDriftPx: 0,
};

/**
 * apelles.studio's PAGE look (D-394) — the site's own light ground, where
 * `apelles-studio` above is its inverse (basalt) band. Same sourcing rule as
 * that preset: every value is a `website/src/styles/tokens.css` token
 * verbatim, or one of its `color-mix()` tints flattened to an opaque hex
 * (three.js discards alpha — see `apelles-studio`'s `strokeSoft` note).
 *
 * The working colours follow the site's own rule for a marble ground, the
 * mirror of rule 1 above: TERRACOTTA is the link/emphasis colour (it reads on
 * marble), and OCHRE is held to marks, rules and large display type (3.0:1 on
 * marble — `tokens.css` caps it there). So `accent` is terracotta and
 * `accentSignal` — matrix fills, graph pulses, glows — is ochre.
 */
const APELLES_STUDIO_LIGHT: Theme = {
  name: "apelles-studio-light",
  description:
    "apelles.studio's page look: warm marble ground, basalt ink, terracotta emphasis with ochre marks, Newsreader / Instrument Sans / IBM Plex Mono, clean geometry.",

  // ground — `--pigment-marble`, and `--pigment-marble-deep` (the site's own
  // second ground) for panels and cards.
  bg: "#f4efe6",
  bgDeep: "#eae2d4",

  // ink — `--pigment-basalt`; soft lines are `--edge-strong`
  // (`color-mix(in srgb, basalt 28%, transparent)`) flattened over marble;
  // dim text is `--pigment-basalt-soft` (8.5:1 on marble).
  stroke: "#1c1a17",
  strokeSoft: "#b8b3ac",
  text: "#1c1a17",
  textDim: "#4a443c",

  // accents — `--pigment-terracotta` (emphasis) and `--pigment-ochre` (marks).
  accent: "#a6432c",
  accentSignal: "#b4823a",

  // stroke feel and type — identical to `apelles-studio`: one site, one hand.
  strokeWidth: 2,
  roughness: 0,
  bowing: 0,
  fontDisplay: "'Newsreader', 'Iowan Old Style', Georgia, serif",
  fontUi: "'Instrument Sans', system-ui, -apple-system, sans-serif",
  fontMono: "'IBM Plex Mono', ui-monospace, SFMono-Regular, Menlo, monospace",
  ambientDriftPx: 0,
};

export const THEMES = {
  "dark-excalidraw": DARK_EXCALIDRAW,
  "apelles-studio": APELLES_STUDIO,
  "apelles-studio-light": APELLES_STUDIO_LIGHT,
} as const;

export type ThemeName = keyof typeof THEMES;

/** every registered theme name, in registry order (default first) */
export const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

/**
 * The engine-wide default, used whenever a manifest carries no `theme`.
 *
 * Deliberately still `dark-excalidraw` rather than the newer preset: it is a
 * reasonable general-purpose look for any Motion project by any user, every
 * manifest in existence was authored against it, and silently re-skinning
 * them all is not what "make the theme selectable" was asked to mean.
 */
export const DEFAULT_THEME_NAME: ThemeName = "dark-excalidraw";

export const DEFAULT_THEME: Theme = THEMES[DEFAULT_THEME_NAME];

/**
 * A theme name (typically `manifest.theme`) → the theme to render with.
 *
 * Forgiving by design: `undefined` (the overwhelmingly common case — no
 * `theme` key at all) and an unregistered name both resolve to the default.
 * `manifestSchema` already rejects an unknown name at parse time, so the
 * second case is only reachable from the raw-JSON editor's pre-parse text or
 * a caller that skipped validation — where falling back to a working look
 * beats throwing out of a render.
 */
export const resolveTheme = (name?: string | null): Theme =>
  (name && (THEMES as Record<string, Theme>)[name]) || DEFAULT_THEME;

/**
 * The engine's motion grammar — deliberately NOT part of `Theme`.
 *
 * `ease` is read by pure, component-less helpers (`lib/draw.ts`'s `inAt`/
 * `outAt`, `lib/interpolateKeys.ts`'s fallback curve) and is the documented
 * contract behind the manifest's own `easeCurve` field (`engine/schema.ts`'s
 * `cam2dKey`/`cam3dKey`/`transformKey`) and `@apelles/motion`'s ease-preset
 * picker. `fps` is the authoring default a NEW manifest gets, not a render-
 * time value (a real render always uses `useVideoConfig().fps` — B-060).
 * Neither is a property of the LOOK, and threading a theme into every frame
 * helper to make them per-theme would buy nothing today — both presets want
 * the same curves. If a future theme genuinely needs its own motion feel,
 * that is a real, separate decision, not an accident of this split.
 */
export const motion = {
  fps: 30,
  ease: {
    // cubic-bezier presets, use with interpolate(..., {easing})
    out: [0.22, 1, 0.36, 1] as const, // gentle settle
    inOut: [0.65, 0, 0.35, 1] as const,
    anticipate: [0.68, -0.55, 0.27, 1.55] as const,
  },
} as const;
