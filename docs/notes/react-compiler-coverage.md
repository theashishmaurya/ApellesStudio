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
~~`app/src/components/chroma/SourcesPanel.tsx`~~ **FIXED (D-201)**,
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
~~`packages/editor/src/PreviewPane.tsx`~~ **FIXED (D-201)**,
`packages/motion/src/useMotionManifest.ts` (attempted and reverted — see the
status section at the bottom).

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
~~`packages/editor/src/Filmstrip.tsx`~~ **FIXED (D-201)**,
~~`packages/editor/src/useEditorControl.ts`~~ **FIXED (D-201)**,
`packages/motion/src/MotionPreview.tsx`,
`packages/motion/src/useMotionControl.ts`.

**`Existing memoization could not be preserved` (3 files)** — the file already has
manual `useMemo`/`useCallback` that conflicts with what the compiler would generate.
Usually fixable by deleting the manual memoization and trusting the compiler:
`app/src/hooks/useAppNavigation.ts`,
~~`packages/editor/src/TimelinePane.tsx`~~ **FIXED (D-201)**,
~~`packages/editor/src/TransformOverlay.tsx`~~ **FIXED (D-201)**.

> **D-201, 2026-09-07 — the two hot files are fixed and now pinned by a test.**
> `TimelinePane` had **seven** hand-written arrays disagreeing with the
> compiler's inferred dependencies (`getActionRender`, `onClickAction`,
> `onActionResizeEndCb`, `linkCheck`, `onDndDragMove`, `onDndDragEnd` —
> inferring `idxOf`/`clipsOf`/`s2f`/`dndBoundary`/`inferNewTrackKind`/
> `trackIndexAfterMove`/`setSelection`); `TransformOverlay` had two
> (`localPoint`, `commit`). ONE disagreement bails the compiler out of the
> whole component, so both files were getting zero auto-memoization while still
> paying for the hand-written kind — the exact opposite of what B-024 added
> those arrays for. Two of `TimelinePane`'s seven were memoizing nothing at all
> anyway (they listed `idxOf`/`clipsOf`, plain arrows re-created every render).
> All nine are plain functions now; both files compile with **zero** bailouts.
> `packages/editor/src/reactCompiler.test.ts` runs the same preset
> `app/vite.config.mjs` uses over every source file in this package and fails if
> a bailout comes back — negative-tested, not assumed. See D-201 Part 2, and
> "Status after the D-201 fix pass" at the bottom of this note for everything
> else that pass changed.

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

## Not attempted here (as originally filed)

This was an inventory, not a fix — owner's own framing: document first, then dispatch
a real fix pass. **That pass happened (D-201, same day); see "Status after the D-201
fix pass" below for what it changed and what it deliberately left.** B-081, filed
alongside this note as a related-but-separate finding, was root-caused in the same
pass and turned out not to be an IPC bug at all.

---

# Status after the D-201 fix pass (2026-09-07)

The inventory above is the state as filed. This section is what actually
changed, what is still open, and — for every item the inventory flagged as
"possibly a REAL bug, not just a compiler limitation" — whether it turned out
to be one.

## How to check any file yourself

The bailout reasons above came from grepping dev-server logs. There is a faster
loop now: `packages/editor/src/reactCompiler.test.ts` runs the *same*
`reactCompilerPreset` `app/vite.config.mjs` uses over every source file in
`@apelles/editor` and fails on any bailout, so `npm test --workspace
@apelles/editor` is a real regression gate. The same few lines work standalone
for any other file (`transformAsync` with `reactCompilerPreset({logger}).preset`
and a `parserOpts: { plugins: ['typescript','jsx'] }`) if you need to check
something outside that package.

## Fixed

- **`packages/editor/*` — the WHOLE package is now bailout-free** (30 source
  files, verified against a real dev-server boot as well as the standalone
  reporter). Specifically:
  - `TimelinePane.tsx`, `TransformOverlay.tsx` — *Existing memoization could not
    be preserved*. Nine hand-written `useMemo`/`useCallback` arrays disagreeing
    with the compiler's inferred dependencies; all now plain functions. See
    D-201 Part 2 for the full reasoning (including that two of them were
    memoizing nothing at all).
  - `PreviewPane.tsx` — *TryStatement with a finalizer*, and then a second
    bailout it had been masking (*Cannot access variable before it is
    declared*). The `finally` bodies became plain tails after the `try/catch`
    (equivalent: the `catch` swallows, nothing returns from either block), and
    `fetchFrame`'s tail-recursive self-call became a `while` drain loop
    (equivalent: the recursion happened synchronously right after clearing
    `inFlight`/`pending`, with no `await` in between, and nothing awaits
    `fetchFrame`). A named function expression was tried first and trips an
    internal compiler error — don't.
  - `Filmstrip.tsx` — *React ESLint rules were disabled*, and a second bailout
    behind it, *Cannot access refs during render*. The suppression was on an
    effect that must key on the SNAPPED window, not the window object's
    identity; replaced with the standard latest-ref-written-in-an-effect shape,
    so the dependency array is honest and needs no suppression. The ref read
    during render (`lastGood.current`) was a real Rules-of-React violation and
    is gone: simply never overwriting good tiles with an empty response gives
    the identical on-screen behaviour with one piece of state and no ref.
  - `useEditorControl.ts` — *React ESLint rules were disabled* (a **stale**
    suppression: this hook takes no arguments and its one effect closes over
    nothing but module-level values, so `[]` was always honest), then *value
    blocks within a try/catch* (`args || {}`, `result?.error ?? null`,
    `String(e?.message || e)`), hoisted verbatim into three module-scope
    helpers.
  - `CanvasSettingsPopover.tsx`, `EditorExportDialog.tsx`,
    `useCompositionSize.ts` — landed by sibling branches while this pass was in
    flight and caught by the new guard test on rebase. A `finally` clause became
    a plain tail; two `exhaustive-deps` suppressions went away (one replaced by
    the latest-ref shape, one by referencing the deliberate refetch token in the
    effect body so the array is honest rather than suppressed).
- **`app/src/components/chroma/SourcesPanel.tsx`** — *TryStatement with a
  finalizer*, same plain-tail rewrite as `PreviewPane`.

**Careful — the compiler reads comments.** Its ESLint-suppression check
matches the suppression text itself, so even *mentioning*
`eslint-disable-next-line react-hooks/…` verbatim in a prose comment
re-triggers the bailout. Describe the rule by name instead.

## The "possibly a real bug" items — investigated, one by one

| flagged item | verdict |
|---|---|
| `app/src/App.tsx`, `app/src/components/views/EditorView.tsx` — *Hooks may not be referenced as normal values* | **REAL BUG — filed as B-084.** Both call `store.getState()` in the render body, so render output depends on state they never subscribe to. The visible one: Colorist's Paste button stays disabled after a copy until something unrelated re-renders `EditorView`. Not fixed here (Colorist-tab UI in the vendored fork; wants its own live check + an engine-notes divergence entry). |
| `app/src/components/panel/Filmstrip.tsx` — *This value cannot be modified* | **REAL Rules-of-React violation.** `FilmstripList` does `currentDataRef.current = data;` in the render body (line ~366) — a ref written during render, aliasing a prop. Benign in the common case, but a render React throws away (StrictMode's double render, an interrupted concurrent render) leaves the ref holding data that never committed, which the event handlers reading it would then act on. Same file also reads `ratioMapRef.current` from inside a `useMemo` during render, invalidated by a hand-rolled `ratioMapVersion` counter — same class. Not fixed: RapidRAW-fork code with no test coverage, and the correct fix (moving the ratio map into real state) is a real change to the filmstrip's virtualised sizing path that deserves its own pass and live verification. |
| `app/src/components/panel/Filmstrip.tsx` — *Cannot access variable before it is declared* (`performSafeScroll`) | **False alarm.** `performSafeScroll` calls itself from inside its own `setTimeout` callback (line ~507). The reference resolves to its own render's binding, is only reached 250 ms after that render, and can never hit the temporal dead zone. Same shape as `PreviewPane.fetchFrame`, which is why the loop rewrite there is the general remedy if this file is ever cleaned up. |
| `app/src/hooks/useProductivityActions.ts` — *Expected all references to a variable to be consistently local or context references* | **False alarm.** The identifier it names, `err_1$91`, is compiler-generated: the file has six separate `catch (err)` blocks in one function, and the disambiguated names confuse the compiler's own local/context classification. There is no user-visible closure in the source with that shape. |
| `app/src/components/panel/right/TetheringPanel.tsx` — *Handle UpdateExpression to variables captured within lambdas* | **False alarm.** `consecutiveErrors++` on a plain counter local to an async polling loop (line ~513). Correct as written; the compiler simply cannot lower `++` on a captured binding. |
| `packages/motion-engine/src/primitives/ParticleFlow.tsx` — *This value cannot be modified* | **Not resolved.** The message is the more specific *"Modifying a value previously passed as an argument to a hook"*, not `Filmstrip`'s prop-mutation variant, so the two do **not** share a root cause as the inventory speculated. Needs its own look; it is a Remotion primitive rendered inside `motion-engine`'s own bundler, the lowest-stakes surface on this list. |

## Still open, and why each was left

- **`try {} finally {}` (the big bucket) in `app/`'s modals, settings, presets,
  tethering, export and AI-masking hooks.** Mechanical and low-risk
  individually (the `PreviewPane`/`SourcesPanel` rewrites above are the
  pattern), but these are one-off modals and settings panels — the inventory's
  own "low-stakes" half. Deliberately not spent time on ahead of the hot
  surfaces.
- **`packages/motion/src/useMotionManifest.ts`.** Attempted and **reverted**
  deliberately, which is worth recording so nobody re-treads it: the two
  `finally` clauses and the `??`/`?.` value blocks all rewrite cleanly, but
  underneath them sits *"value blocks within a try/catch"* on the per-scene
  render `for` loop itself. Clearing that means lifting the whole scene-render
  loop out of the `try` into a separate function — a real change to the Motion
  render path — and stopping short of that leaves the file still bailing out,
  i.e. all of the churn and none of the benefit.
- **`app/src/hooks/useAiMasking.ts`.** The inventory's "unusually
  compiler-unfriendly file" reading is confirmed: 10 distinct bailouts
  (`finally` ×8, `for(;;)` with an empty test, non-variable `for` init, `throw`
  inside `try/catch`). Nothing here looked like a latent bug — it is a long
  imperative polling/retry hook — but clearing it is a rewrite of that hook,
  not a touch-up.
- **`app/src/components/panel/editor/ImageCanvas.tsx`** — *`this` is not
  supported syntax* plus *TryStatement without a catch clause*. RapidRAW-fork
  canvas code; the `this` use needs reading before anything is changed.
- **The remaining `React ESLint rules were disabled` files in `app/`.** Each
  needs its own judgement about whether the suppressed rule is right (like
  `useEditorControl`'s, which was simply stale) or is hiding something (like
  `Filmstrip`'s, which was load-bearing and needed a restructure).
