# React Compiler coverage — real bailout inventory (2026-09-07)

Owner asked, after a live discussion about UI performance: how much of the app is
actually getting React Compiler's auto-memoization, and where isn't it? This is that
inventory — extracted from real dev-server console output across three separate
`npm run tauri:dev` launches this session (`grep '\[react-compiler\] bailout'` across
the saved logs), not guessed from reading source. 55 unique bailout lines across 45
files, as of this session.

**What a bailout means:** the compiler tried to auto-memoize the component/hook and
hit a pattern it can't safely reason about, so it skips optimizing that one and falls
back to un-memoized re-renders for it — same behavior as before the compiler existed,
just for that one function. It does not break anything; it just means that specific
component doesn't get the free win.

## The real list, grouped by cause (so a fix pass can go bucket-by-bucket)

**`TryStatement with a finally clause` (12 files)** — the single most common cause by
far. The compiler's HIR lowering doesn't yet handle `try {} finally {}` inside a
component/hook body. Likely fixable in most cases by moving the try/finally out of
render into a plain helper function, or restructuring to avoid needing `finally`
inside the component itself:
`app/src/components/adjustments/Effects.tsx`,
`app/src/components/chroma/SourcesPanel.tsx`,
`app/src/components/modals/CollageModal.tsx`,
`app/src/components/modals/DenoiseModal.tsx`,
`app/src/components/modals/FocusStackModal.tsx`,
`app/src/components/modals/HdrModal.tsx`,
`app/src/components/modals/NegativeConversionModal.tsx`,
`app/src/components/modals/PanoramaModal.tsx`,
`app/src/components/panel/editor/ChromaTimeline.tsx`,
`app/src/components/panel/right/ExportPanel.tsx`,
`app/src/components/panel/right/PresetsPanel.tsx`,
`app/src/components/panel/right/TetheringPanel.tsx`,
`app/src/components/panel/SettingsPanel.tsx`,
`app/src/hooks/useAiMasking.ts`,
`app/src/hooks/useImageLoader.ts`,
`app/src/hooks/usePresets.ts`,
`packages/editor/src/PreviewPane.tsx`,
`packages/motion/src/useMotionManifest.ts`.

**`Cannot access refs during render` (5 files)** — a real Rules-of-React violation
pattern (reading `.current` during render instead of an effect/event handler), not
just a compiler limitation — the SAME general class of bug B-069 (this session's own
TimelinePane hooks-order crash) came from. Worth auditing each for whether it's
actually safe-in-practice-but-compiler-cautious, or a latent real bug:
`app/src/components/panel/editor/EditorToolbar.tsx`,
`app/src/components/panel/editor/Waveform.tsx`,
`app/src/components/panel/Filmstrip.tsx`,
`app/src/components/ui/Slider.tsx`,
`app/src/hooks/useThumbnails.ts`,
`packages/motion/src/KeyframeTimeline.tsx`.

**`React Compiler has skipped optimizing this component because one or more React
ESLint rules were disabled` (10 files)** — an explicit escape hatch already in the
code (an `eslint-disable` comment for a react-hooks rule) that also disables the
compiler for that whole file. Fixable by finding the disabled rule and either fixing
the underlying issue or narrowing the disable to the smallest possible scope:
`app/src/components/chroma/ExportDialog.tsx`,
`app/src/components/chroma/RelightPanel.tsx`,
`app/src/components/panel/Editor.tsx`,
`app/src/hooks/useChromaControl.ts`,
`app/src/hooks/useImageProcessing.ts`,
`packages/editor/src/Filmstrip.tsx`,
`packages/editor/src/useEditorControl.ts`,
`packages/motion/src/MotionPreview.tsx`,
`packages/motion/src/useMotionControl.ts`.

**`Existing memoization could not be preserved` (3 files)** — the file already has
manual `useMemo`/`useCallback` that conflicts with what the compiler would generate.
Usually fixable by deleting the manual memoization and trusting the compiler:
`app/src/hooks/useAppNavigation.ts`, `packages/editor/src/TimelinePane.tsx`,
`packages/editor/src/TransformOverlay.tsx`.

**`Support value blocks (conditional/logical/optional-chaining) within a try/catch`
(5 files)** — a narrower variant of the try/finally issue above, same general fix
direction: `app/src/components/panel/right/MetadataPanel.tsx`,
`app/src/components/ui/LUTControl.tsx`, `app/src/context/TaggingSubMenu.tsx`,
`app/src/hooks/useChromaSubjectTracking.ts`, `app/src/hooks/useEditorActions.ts`,
`app/src/hooks/useExternalEditSession.ts`, `app/src/hooks/useFileOperations.ts`.

**One-off patterns (real, individual issues, not a bucket):**
- `app/src/App.tsx`, `app/src/components/views/EditorView.tsx` — "Hooks may not be
  referenced as normal values" — a real Rules-of-Hooks issue (a hook passed around as
  a value rather than called directly), same general class as B-069.
- `app/src/components/modals/LensCorrectionModal.tsx`,
  `app/src/components/modals/TransformModal.tsx` — "Expected the first argument to be
  an inline function expression" (likely a `useMemo`/`useCallback` call with a
  non-inline function reference).
- `app/src/components/panel/editor/ImageCanvas.tsx` — two distinct bailouts:
  `TryStatement without a catch clause`, and `` `this` is not supported syntax `` (a
  class-component-style `this` reference, or a non-arrow function using `this`).
- `app/src/components/panel/Filmstrip.tsx` — two MORE distinct bailouts beyond its
  refs-during-render one above: "Cannot access variable before it is declared" (a
  real hoisting/ordering bug candidate) and "This value cannot be modified" (a
  mutation of something the compiler considers immutable — possibly a real bug, not
  just a compiler limitation).
- `app/src/hooks/useAiMasking.ts` — THREE more bailouts beyond its try/finally one:
  "Handle empty test in ForStatement", "Handle non-variable initialization in
  ForStatement", "Support ThrowStatement inside of try/catch" — an unusually
  compiler-unfriendly file, worth a closer look as a unit.
- `app/src/components/panel/right/TetheringPanel.tsx` — "Handle UpdateExpression to
  variables captured within lambdas" (an `i++`-style mutation of a captured variable
  inside a closure — a real pattern worth checking for correctness, not just
  compiler-friendliness).
- `app/src/hooks/useProductivityActions.ts` — "Expected all references to a variable
  to be consistently local or context references" (a variable whose scope the
  compiler can't pin down — could indicate a real closure bug).
- `packages/motion-engine/src/primitives/ParticleFlow.tsx` — "This value cannot be
  modified" (same as Filmstrip's third bailout above — worth checking both for a
  real, shared root cause).

## Why this matters for perceived performance

The React Compiler's whole value is eliminating unnecessary re-renders without manual
`useMemo`/`useCallback` bookkeeping. A component that bails out gets NONE of that —
it re-renders on every parent update the old-fashioned way. For most of the list above
(one-off modals, settings panels) this is low-stakes. Two files are NOT low-stakes:
**`TimelinePane.tsx`** and **`TransformOverlay.tsx`** — the highest-update-frequency
surfaces in the whole app (drag, scrub, zoom, live keyframe editing) — both bail out on
"existing memoization could not be preserved," meaning manual memoization already
there is fighting the compiler rather than benefiting from it. These two are the
highest-value targets in this whole list for an actual perceived-speed improvement.

## Not attempted here

This is an inventory, not a fix. Owner's own framing: document first, then dispatch a
real fix pass. See `docs/04-roadmap.md`'s own item for this and `docs/BUGS.md` B-081
(a related but separate finding: an intermittent Tauri IPC-transport fallback found
the same session) for what to actually dispatch against.
