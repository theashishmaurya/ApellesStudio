/**
 * perfMarks.mjs - the one place that decides whether the `apelles:*` performance
 * marks are compiled into a web bundle (D-437 S0a).
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
 * What it does NOT do: read or write any mark (`@apelles/editor`'s `editPerf.ts` does).
 * Debug-only per CLAUDE.md: a release bundle contains none of it.
 */

/** `TAURI_ENV_DEBUG` is the STRING "true" / "false", so test the value, not truthiness. */
export const tauriDebugBuild = () => process.env.TAURI_ENV_DEBUG === 'true';

export const perfMarksEnabled = (command) => command === 'serve' || tauriDebugBuild() || process.env.APELLES_PERF_MARKS === '1';

/** The Vite/vitest `define` entry. */
export const perfMarksDefine = (command) => ({ 'import.meta.env.APELLES_PERF_MARKS': JSON.stringify(String(perfMarksEnabled(command))) });
