/**
 * perfMarks.mjs - the one place that decides which build-time debug defines a web
 * bundle gets: the `apelles:*` performance marks (D-437 S0a) and the debug-tooling
 * gate `APELLES_DEBUG_TOOLS` (B-358).
 *
 * What it is: `perfMarksEnabled(command)` and the `define` entry the app's Vite
 * config and the packages' vitest configs share, so the gate cannot drift.
 *
 * The define is the STRING 'true' / 'false' (vitest turns a define on import.meta.env.* into a string).
 *
 * The rule (the standard Tauri way, not a project flag): Tauri sets
 * `TAURI_ENV_DEBUG=true` for `tauri build --debug` and `tauri dev`, and `false` for
 * a release build (https://v2.tauri.app/reference/environment-variables/). So:
 *   - `vite dev` (command `serve`)          -> marks ON
 *   - `tauri build --debug` (production React, Rust debug) -> marks ON, which is the
 *     bundle whose numbers ship, and why `import.meta.env.DEV` was the wrong gate
 *   - `tauri build` (release)               -> marks OFF; Vite folds every helper away
 *   - `APELLES_PERF_MARKS=1` forces ON, for a plain `vite build` measurement bundle.
 *
 * `APELLES_DEBUG_TOOLS` (the frontend half of CLAUDE.md's debug tooling: the
 * `debug_*` op registry, the Cmd+Shift+D screenshot shortcut, the preview timing
 * the `debug_frame_timing` op reads) mirrors Rust's `#[cfg(debug_assertions)]`:
 * ON for `vite serve` and `TAURI_ENV_DEBUG=true`, OFF otherwise. Both halves of the
 * debug tooling are therefore present in exactly the same builds. (It was
 * `import.meta.env.DEV`, which is false in `tauri build --debug`, so the Rust ops
 * existed with no frontend registry to answer them.)
 *
 * What it does NOT do: read or write any mark (`@apelles/editor`'s `editPerf.ts` does).
 * Debug-only per CLAUDE.md: a release bundle contains none of it.
 */

/** `TAURI_ENV_DEBUG` is the STRING "true" / "false", so test the value, not truthiness. */
export const tauriDebugBuild = () => process.env.TAURI_ENV_DEBUG === 'true';

export const perfMarksEnabled = (command) => command === 'serve' || tauriDebugBuild() || process.env.APELLES_PERF_MARKS === '1';

/** The debug-tooling gate: dev server or a Tauri debug build, never a release. */
export const debugToolsEnabled = (command) => command === 'serve' || tauriDebugBuild();

/** The Vite/vitest `define` entry for the perf marks. */
export const perfMarksDefine = (command) => ({ 'import.meta.env.APELLES_PERF_MARKS': JSON.stringify(String(perfMarksEnabled(command))) });

/** The `define` entry for the debug-tooling gate. */
export const debugToolsDefine = (command) => ({ 'import.meta.env.APELLES_DEBUG_TOOLS': JSON.stringify(String(debugToolsEnabled(command))) });

/** Every build-time debug define, for the one `define:` slot of a Vite/vitest config. */
export const buildDefines = (command) => ({ ...perfMarksDefine(command), ...debugToolsDefine(command) });
