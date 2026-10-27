/**
 * allowlist.ts — the modules a custom component may import (D-409).
 *
 * What it is: one list, read by both ends. The static check
 * (`sourceCheck.ts`) refuses any import not named here; the renderer
 * (`runtime.tsx`) hands a component exactly these modules and nothing else
 * when it evaluates it. Every entry is already a dependency of this package
 * (`package.json`), so allowing it adds nothing to install. Left out on
 * purpose: `@remotion/google-fonts` and `@remotion/media` (network and media
 * I/O), `mediabunny`, `roughjs`, `@phosphor-icons/react` (the `icon`
 * primitive draws icons), `@react-three/drei` (loads remote assets), React DOM.
 *
 * What it does NOT do: import anything — it is plain data, so the Node check
 * script can read it without loading React.
 */

/** Module specifiers a component may import, exactly as written. */
export const ALLOWED_COMPONENT_IMPORTS = [
  "react",
  "react/jsx-runtime",
  "remotion",
  "@remotion/shapes",
  "@remotion/paths",
  "@remotion/noise",
  "@remotion/animation-utils",
  "@remotion/three",
  "three",
  "@react-three/fiber",
  "d3-force",
  "@apelles/component",
] as const;

export type AllowedComponentImport = (typeof ALLOWED_COMPONENT_IMPORTS)[number];
