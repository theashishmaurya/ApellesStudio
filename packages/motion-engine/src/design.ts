/**
 * Design tokens — the locked "dark Excalidraw / tldraw" look.
 * See engine/catalog.md and the feedback-explainer-card-style memory.
 * Every primitive pulls from here; content varies via props, the look does not.
 */

export const design = {
  // ground
  bg: "#1e1e24", // flat dark slate — a clean solid UI colour, NOT a textured chalkboard
  bgDeep: "#17171c", // slightly darker, for layered panels / vignette edges

  // ink
  stroke: "#e8e8e8", // off-white hand-drawn strokes
  strokeSoft: "#a9a9b2", // secondary lines, captions
  text: "#efefef",
  textDim: "#9a9aa4",

  // accents — exactly two, used sparingly (an underline, a highlight, one arrow)
  accentRed: "#e5484d",
  accentBlue: "#5b8def",

  // stroke feel
  strokeWidth: 3, // px at 1080p; scale with resolution
  roughness: 1.6, // roughjs roughness
  bowing: 1.2, // roughjs bowing

  // type
  fontHand: '"Kalam", "Comic Neue", "Segoe Print", cursive', // load via @remotion/google-fonts (Kalam)
  fontMono: '"JetBrains Mono", ui-monospace, monospace',

  // motion
  fps: 30,
  ease: {
    // cubic-bezier presets, use with interpolate(..., {easing})
    out: [0.22, 1, 0.36, 1] as const, // gentle settle
    inOut: [0.65, 0, 0.35, 1] as const,
    anticipate: [0.68, -0.55, 0.27, 1.55] as const,
  },
  // "nothing sits perfectly still" — amplitude of the always-on ambient drift, in px
  ambientDriftPx: 1.5,
} as const;

export type Design = typeof design;

/** px stroke width for a given render height (tokens are authored at 1080p) */
export const strokeAt = (height: number, base = design.strokeWidth) =>
  (base * height) / 1080;
