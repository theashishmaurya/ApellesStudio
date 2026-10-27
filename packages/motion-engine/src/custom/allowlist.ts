/**
 * allowlist.ts — the modules a custom component may import (D-409).
 *
 * What it is: one list, read by both ends. The static check
 * (`sourceCheck.ts`) refuses any import not named here; the renderer
 * (`runtime.tsx`) hands a component exactly these modules and nothing else
 * when it evaluates it. Every entry is already a dependency of this package
 * (`package.json`), so allowing it adds nothing to install. Left out on
 * purpose: `@remotion/google-fonts` and `@remotion/media` (network and media
 * I/O), `mediabunny`, `@phosphor-icons/react` (the `icon` primitive draws
 * icons), `@react-three/drei` (loads remote assets), React DOM,
 * `@remotion/skia` (needs react-native, reanimated and a global bundler
 * override; see D-412).
 *
 * `roughjs` and the pure-maths d3 modules were first left out and are in since
 * D-412. roughjs seeds from `Math.random` unless given a non-zero `seed`, so
 * `sourceCheck.ts` refuses a drawing call without an explicit one. The d3
 * modules (`d3-scale`, `d3-shape`, `d3-array`, `d3-interpolate`, `d3-format`)
 * are pure functions of their inputs. `d3-force` was already allowed.
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
  "d3-scale",
  "d3-shape",
  "d3-array",
  "d3-interpolate",
  "d3-format",
  "roughjs",
  "@apelles/component",
] as const;

export type AllowedComponentImport = (typeof ALLOWED_COMPONENT_IMPORTS)[number];
