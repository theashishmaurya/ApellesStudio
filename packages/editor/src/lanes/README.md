# `lanes/` — Apelles' own timeline lane renderer (D-437)

The pieces that replace `@xzdarcy/react-timeline-editor`'s edit area and
playhead. Plan and rationale: `docs/notes/timeline-lanes.md`; decision: D-437.

**Status: built standalone (S1, S2, S3a, S3b), not yet wired.** `TimelinePane`
still renders the library; S4 switches it over. Only `ClipBody` is imported by
the pane today (S2).

## Files

| file | what it is |
|---|---|
| `laneLayout.ts` | Pure geometry in content px: `contentWidth` (the library's formula), `clipLeftPx`/`clipWidthPx`, `frameAtContentX`, the clamped + bucketed `visibleSlice`. |
| `laneWindow.ts` | Pure culling: per-`Track`-object index (WeakMap; start-sorted with a running max of ends, so overlap is safe), `laneWindow` (one viewport of overscan each side, half-viewport re-render bucket), `windowClipIndices` (the window plus pinned ids). |
| `ClipBody.tsx` | The clip's `useDraggable` node and its `data-chroma-*` contract. Moved verbatim from `TimelinePane.tsx` (S2). |
| `LaneClip.tsx` | `React.memo`ised clip: positioning slot (`left`/`width`, `contain: layout size style`) around `ClipBody` / `ClipBlock` / `ClipFadeOverlay` / trim zones. |
| `TrackLane.tsx` | One track's absolutely positioned row (`contain: strict`, bottom border = row line). Not memoised. |
| `TimelineLanes.tsx` | The native scroller (both axes), the content box, a `TrackLane` per track, the pinned set (selection, drag source, gesture target, focused clip). |
| `useLaneActions.ts` | A stable `{ onClipPointerDownCapture, onClipClick, onToggleCurve }` object that forwards to the latest pane handlers through a ref written in a layout effect. |
| `Playhead.tsx` | Transform-only playhead on its own layer: pointer-transparent line, grabbable head (in the ruler) and band, scrub callbacks, edge autoscroll. Driven by a handle (`setFrame`, `setScroll`), never by React state. |
| `playheadAutoscroll.ts` | The pure edge-autoscroll speed curve. |

## Boundary

- Imports from `..` (types, `ClipBlock`, `ClipFadeOverlay`, `clipAnatomy`, `timeline`,
  `timelineStore` types, `timelineTestIds`, `trimMode`, `editGesture`'s `timecode`). **Nothing in
  `lanes/` imports `TimelinePane`** — the pane imports `lanes/`.
- No store reads, no Tauri calls, no scroll state of its own. Everything arrives as props or
  through the handle; everything the user does leaves through `actions` / the scrub callbacks.
- Overlays (ruler, markers, transitions, gap selection, drop zones, marquee) are not here; they
  stay in the pane until S8.
- Every file here is held to zero React Compiler bailouts by `reactCompiler.test.ts`.

## Rules the files obey

- A clip is positioned by `left`/`width`; `transform` is reserved for the edit gestures (D-098/D-100).
- No `will-change` at rest on lanes or clips (S7 adds it per gesture, measured). The playhead's
  `will-change: transform` is the one standing layer.
- `windowLeft` is passed already floored to the window bucket (`windowScrollLeft`), so a scroll
  inside a bucket is not a prop change. `viewportWidth` 0 means no culling.
