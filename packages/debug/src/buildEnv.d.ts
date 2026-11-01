/**
 * Build-time constants this package reads (defined by `app/perfMarks.mjs` in the app's Vite
 * config and by this package's vitest config; undefined elsewhere):
 * `APELLES_DEBUG_TOOLS` is 'true' in `vite dev` and `tauri build --debug`, 'false' in a
 * release build (B-358); `APELLES_PERF_MARKS` is the D-437 S0a perf-mark gate.
 */
interface ImportMetaEnv {
  readonly APELLES_DEBUG_TOOLS?: 'true' | 'false';
  readonly APELLES_PERF_MARKS?: 'true' | 'false';
}
