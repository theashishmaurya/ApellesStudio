// Typed build-time env for `import.meta.env` (Vite's canonical `ImportMetaEnv`
// augmentation). Only the `VITE_*` keys this app actually reads are declared.
interface ImportMetaEnv {
  /** D-391 — `off` builds the app without the Motion tab (the v0.2.0 beta did; unused since D-417). */
  readonly VITE_APELLES_MOTION?: string;
  /** B-358 - 'true' when the debug tooling is compiled in (`vite dev`, `tauri build --debug`); see `perfMarks.mjs`. */
  readonly APELLES_DEBUG_TOOLS?: 'true' | 'false';
}
