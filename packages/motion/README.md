# @chroma/motion

**The Motion tab** (D-039, MVP shipped D-046). A `@remotion/player` embed of
`@chroma/motion-engine`'s `Video` composition (the same component the
`Animation` composition registers) + a JSON scene-manifest editor validated
against the engine's own `zod` schema. Manifest persistence and rendering go
through the `chroma_motion_*` Tauri commands
(`app/src-tauri/src/chroma/motion.rs`) → the `chroma-motion` crate.

## Files

- `MotionTab.tsx` — the tab: gates on a project being open (same contract
  `@chroma/editor`'s `EditorTab` uses — manifest persistence is
  project-scoped), then lays out `MotionPreview` + `ManifestEditor`.
- `motionProjectStore.ts` — **readiness** (B-058/D-150): `projectOpen`, pushed in
  from the composition root (`app/src/main.tsx`), plus where the manifest read
  stands (`idle`/`loading`/`ready`/`error`). A store, not tab-local state,
  because the signal comes from outside this package and the tab is mounted from
  boot. Nothing here infers "no project is open" from a failed read — that
  inference *was* B-058, and is what B-034/D-112 removed from the Edit tab before
  it.
- `useMotionManifest.ts` — the *editing* state: seeds the editor from whatever
  `motionProjectStore` last read (or the engine's sample, for a project with no
  saved manifest yet), live-parses every edit (debounced) against
  `@chroma/motion-engine`'s `manifestSchema`, drives save/render. Component-local
  — nothing outside this tab needs it.
- `MotionPreview.tsx` — the `@remotion/player` embed. `durationInFrames` /
  `fps` / `compositionWidth` / `compositionHeight` come from the engine's own
  `totalFrames`/schema defaults (`build.ts`), not reimplemented here.
- `ManifestEditor.tsx` — the JSON `<textarea>` + inline parse/save/render
  error surfacing. JSON-in on purpose this pass — see D-046.
- `manifestIO.ts` — thin wrappers around the three `chroma_motion_*` Tauri
  commands. Pure I/O, no validation (that's the schema, applied before ever
  calling save/render).
- `Button.tsx` — a small local button, not `@chroma/ui`'s. See the comment at
  the top of the file / B-008: `@chroma/ui`'s barrel also exports `Text`,
  whose polymorphic typing breaks once `@react-three/fiber`'s global JSX
  augmentation (pulled in transitively via `@chroma/motion-engine`) is in the
  same `tsc` program, and `@chroma/ui`'s `exports` map has no subpath for
  `Button` alone to deep-import around it. Two buttons didn't warrant a
  shared-package edit.

## Deep-importing `@chroma/motion-engine`

`@chroma/motion-engine`'s `package.json` has no `main`/`exports` field (it's
a Remotion CLI project, not built as a library, and is treated as read-only
here) — imports go straight at its source, e.g.
`@chroma/motion-engine/src/engine/Video`. This resolves fine because there's
no `exports` map to sandbox subpath imports; it needs zero changes on the
engine side.

## Status

D-046 — real preview + editor + save + render, one manifest per project. No
visual editor (JSON-in is this pass's scope, see
`docs/notes/product-direction.md` §9), no multi-manifest, no render
progress/cancel/queue.
