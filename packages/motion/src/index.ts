/**
 * @chroma/motion — the Motion tab (D-039 roadmap "Motion tab MVP", D-046).
 *
 * A `@remotion/player` embed of `@chroma/motion-engine`'s `Video` component
 * (8 registered primitives + the manifest compiler, moved in from
 * `videoAgent/engine/motion/`) + a scene/layer list, a typed property
 * Inspector, a primitive Catalog, and a JSON scene-manifest editor — all
 * validated against the engine's own `zod` schema. Manifest persistence and
 * rendering go through the `chroma_motion_*` Tauri commands
 * (`app/src-tauri/src/chroma/motion.rs`) → the `chroma-motion` crate.
 *
 * Status: real preview + layer list (D-081) + Inspector (D-099/D-103) +
 * primitive Catalog (D-151) + editor + save + render, one manifest per
 * project. Known gaps — no on-canvas manipulation, no timeline UI, no
 * undo/redo, no MCP surface — are audited with citations in
 * `docs/notes/motion-tab-audit.md` and queued as roadmap item 16.
 */

export { MotionTab } from './MotionTab';
// B-058/D-150 — the readiness signal the composition root pushes in (the same
// shape `@chroma/editor` exports its timeline store for): app → tabs, never the
// other way round (D-039).
export { useMotionProjectStore } from './motionProjectStore';
