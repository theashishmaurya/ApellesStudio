# `lanes/` — Apelles' own timeline lane renderer (D-437)

The pieces that replace `@xzdarcy/react-timeline-editor`'s edit area and
playhead. Plan and rationale: `docs/notes/timeline-lanes.md`; decision: D-437.

**Status: wired (S4), library removed (S5, S6), scroll out of React state (S8).** `TimelinePane` renders
`TimelineLanes` and `Playhead`; the library package is gone from the repo. The lane
parts are addressed by test ids only (`TIMELINE_TEST_IDS`: `scroller`, `trackRow`,
`clipSlot`, `playhead`, `playheadHead`, `playheadBand`).

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
| `timelineScroll.ts` | The per-pane scroll store (S8): a zustand vanilla store mirroring the scroller's `left`/`top`, `setTimelineScroll`, `useTimelineScroll(store, selector)` and `WithScrollLeft` (re-renders a pinned strip, not the pane, on a horizontal scroll). |

## Boundary

- Imports from `..` (types, `ClipBlock`, `ClipFadeOverlay`, `clipAnatomy`, `timeline`,
  `timelineStore` types, `timelineTestIds`, `trimMode`, `editGesture`'s `timecode`). **Nothing in
  `lanes/` imports `TimelinePane`** — the pane imports `lanes/`.
- No timeline-store reads, no Tauri calls. Everything arrives as props, through the handle or
  through the pane's scroll store (`timelineScroll.ts`, which the pane owns and writes); everything
  the user does leaves through `actions` / the scrub callbacks.
- The overlays' code stays in the pane. Since S8 the row/frame ones (transitions, gap selection,
  drag ghosts, marquee, drop and height zones) are passed to `TimelineLanes` as `children` and drawn
  inside the scroller's content in content coordinates; the pinned ones (ruler, markers, beat lane,
  skim line, edit feedback) stay outside the scroller.
- Every file here is held to zero React Compiler bailouts by `reactCompiler.test.ts`.

## Rules the files obey

- A clip is positioned by `left`/`width`; `transform` is reserved for the edit gestures (D-098/D-100).
- No `will-change` at rest on lanes or clips (S7 adds it per gesture, measured). The playhead's
  `will-change: transform` is the one standing layer.
- `TimelineLanes` selects only `windowScrollLeft(left, viewportWidth)` from the scroll store, so a
  scroll inside a bucket renders nothing and a crossing renders the lanes, never the pane (S8).
  `viewportWidth` 0 means no culling.
