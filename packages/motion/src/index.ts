/**
 * @chroma/motion — the Motion tab (D-039 roadmap "Motion tab MVP", D-046).
 *
 * A `@remotion/player` embed of `@chroma/motion-engine`'s `Video` component
 * (7 primitives + the manifest compiler, moved in from
 * `videoAgent/engine/motion/`) + a JSON scene-manifest editor validated
 * against the engine's own `zod` schema. Manifest persistence and rendering
 * go through the `chroma_motion_*` Tauri commands
 * (`app/src-tauri/src/chroma/motion.rs`) → the `chroma-motion` crate.
 *
 * Status: D-046 — real preview + editor + save + render, one manifest per
 * project. No visual editor (JSON-in is this pass's scope), no multi-manifest.
 */

export { MotionTab } from './MotionTab';
