/**
 * @apelles/motion — the Motion tab (D-039 roadmap "Motion tab MVP", D-046).
 *
 * A `@remotion/player` embed of `@apelles/motion-engine`'s `Video` component
 * (8 registered primitives + the manifest compiler, moved in from
 * `videoAgent/engine/motion/`) + a scene/layer list, a typed property
 * Inspector, a primitive Catalog, and a JSON scene-manifest editor — all
 * validated against the engine's own `zod` schema. Manifest persistence and
 * rendering go through the `chroma_motion_*` Tauri commands
 * (`app/src-tauri/src/chroma/motion.rs`) → the `apelles-motion` crate.
 *
 * Status: real preview + layer list (D-081) + Inspector (D-099/D-103) +
 * primitive Catalog (D-151) + editor + save + render, one manifest per
 * project — plus, as of the D-150–D-164 visual-builder/keyframe-timeline
 * initiative: on-canvas click-select/drag/resize/snap-to-layer/multi-select/
 * marquee/align-distribute, undo/redo (`@apelles/history`), per-layer
 * keyframes with auto-keyframe-on-drag, and a real per-row keyframe
 * timeline (lanes, a shared zoomable ruler, drag-a-key, box-select + nudge,
 * a bezier curve/easing editor). See `docs/notes/motion-visual-builder-
 * research.md` and `docs/notes/motion-keyframe-timeline-research.md` for
 * the full scoping, and `docs/08-decisions.md`'s D-150 through D-164 for
 * what actually shipped vs. what's still disclosed as open.
 *
 * Since then: a real MCP surface (**D-257**, 41 `motion_*` ops in
 * `motionOps.ts` — this doc comment claimed "no MCP surface yet" long after
 * that shipped; corrected by D-332), layer/scene delete + duplicate (D-259),
 * Motion→Edit auto-relink (D-260), a GUI "Add camera" (D-331), and a
 * user-level saved-component library (**D-332** — `layerPresets.ts` +
 * `layerPresetIO.ts`, persisted outside any project through
 * `chroma_motion_{load,save}_layer_presets`).
 *
 * `app/motion-harness.html` (D-165) is a standalone browser harness for
 * exercising this tab's real pointer gestures outside the full Tauri app.
 */

export { MotionTab } from './MotionTab';
// B-058/D-150 — the readiness signal the composition root pushes in (the same
// shape `@apelles/editor` exports its timeline store for): app → tabs, never the
// other way round (D-039).
export { useMotionProjectStore } from './motionProjectStore';
// D-260 — the Motion→Edit link, computed BY the app layer (it needs the media
// pool and the Edit timeline, which a tab package must not import) and handed
// down to `MotionTab`. Exported as types only: this package defines the shape,
// the composition root fills it in. Same app → tabs direction as everything
// above.
export type {
  MotionEditLink,
  MotionEditLinkClip,
  MotionEditLinks,
} from './motionOps';
export type { SceneRenderResult } from './useMotionManifest';
// B-202 — the render loop's own status type, so anything holding a
// `MotionOpsApi` (or reading `motion_get_state`'s `render` block) can name it.
export type { MotionRenderState, MotionRenderStatus } from './renderLoop';
export { computeEditLinks, clipReadsItem } from './editLinks';
