// Typed build-time env for `import.meta.env` (Vite's canonical `ImportMetaEnv`
// augmentation). Only the `VITE_*` keys this app actually reads are declared.
interface ImportMetaEnv {
  /** D-391 — `off` builds the app without the Motion tab (the beta bundle). */
  readonly VITE_APELLES_MOTION?: string;
}
