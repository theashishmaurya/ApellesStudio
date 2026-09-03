# @chroma/inspector

The Global Inspector's shared chrome (D-103, Phase 4 of `docs/notes/global-inspector.md`).

## What this is

Two tiny, presentation-only components — `InspectorEmptyState` and `InspectorSection` —
factored out of `@chroma/motion`'s `InspectorPanel.tsx` (Phase 2, D-099) and
`@chroma/editor`'s `ClipInspectorPanel.tsx` (Phase 3, D-102), which had converged on
byte-identical Tailwind classes for their "nothing selected" message and their
section-heading typography. This package is that shared surface, nothing more.

## What this is NOT

Not a merged Inspector component. Motion's selection (a `Manifest` + scene/layer/camera
target) and the NLE's selection (a `Clip` + track/id) are different enough — different
data shapes, different field sets, different edit operations — that forcing them through
one polymorphic component would mean rewriting two already-working, already-tested
panels for no real user-facing benefit. `InspectorPanel.tsx` and `ClipInspectorPanel.tsx`
stay separate, each owning its own fields/layout/edit logic; this package only shares the
parts that were genuinely identical.

Not a shared resizable-panel wrapper either. `@chroma/editor` correctly uses
`@chroma/ui`'s real `ResizablePanel` (no reason not to — that package has no conflict
with it); `@chroma/motion` cannot (`@react-three/fiber`'s global JSX augmentation breaks
`@chroma/ui`'s barrel once `Scene3D`/`ParticleFlow` share the same `tsc` program — see
`packages/motion/src/Button.tsx`'s doc comment) and uses its own local
`resizable.tsx` wrapper around the same underlying `react-resizable-panels` instead.
Routing both through a third shared wrapper here would mean either downgrading
`@chroma/editor` away from the real `@chroma/ui` component it already correctly uses, or
reintroducing the JSX conflict into `@chroma/motion` — neither is a real improvement, so
each package keeps wrapping its own panel in whichever resizable implementation is
actually correct for it.

## Why a separate package, not `@chroma/ui`

`@chroma/motion` cannot import `@chroma/ui` at all (see above) — so a shared component
both `@chroma/motion` and `@chroma/editor` need to use cannot live there. This package
has zero dependency on `@chroma/ui`, Tauri, or either tab package, so both `@chroma/motion`
and `@chroma/editor` can depend on it without depending on each other — the same
"neither tab package imports the other" boundary `@chroma/shell`'s own doc comment
establishes for the tab registry itself.
