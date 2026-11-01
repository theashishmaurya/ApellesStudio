/**
 * Build-time constant (D-437 S0a): `import.meta.env.APELLES_PERF_MARKS` is the string 'true' when
 * the `apelles:*` performance marks are compiled in (`vite dev`, `tauri build
 * --debug`) and 'false' in a release build. Defined by `app/perfMarks.mjs` in the
 * app's Vite config and by this package's vitest config; undefined elsewhere.
 */
interface ImportMetaEnv {
  readonly APELLES_PERF_MARKS?: 'true' | 'false';
  /** B-358: 'true' when the debug tooling is compiled in (`vite dev`, `tauri build --debug`); see `app/perfMarks.mjs`. */
  readonly APELLES_DEBUG_TOOLS?: 'true' | 'false';
}
