/**
 * @apelles/editor — how far a `@dnd-kit/core` drag has really moved, in the
 * timeline's own coordinates (B-145 / D-302).
 *
 * **What it is.** One pure function. Every gesture in `TimelinePane` that has
 * to answer "where did this drag end up" — the clip move, the create-a-track
 * drop, the slip/slide body drag, the transitions-palette drop — needs the
 * drag's displacement, and used to take it from `@dnd-kit/core`'s own
 * `event.delta`. That value is **not** safe on this surface. dnd-kit defines
 * `delta` as `translate + scrollAdjustment`, where `scrollAdjustment` is the
 * scroll change since the drag began, measured against the scrollable
 * ancestors of `over?.node ?? active.node` — a set that *changes mid-drag the
 * moment a droppable resolves*. In this pane the dragged clip lives inside the
 * timeline library's own horizontally-scrolling `react-virtualized` grid,
 * while the `TrackDropZone` droppables are overlay siblings **outside** it, so
 * the instant `over` resolves the grid drops out of that set: dnd-kit's
 * captured "initial" offset still contains the grid's `scrollLeft`, the live
 * one no longer does, and every `delta.x` for the rest of the drag is short by
 * exactly the horizontal scroll offset the drag started at. Scrolled to 2000px
 * and dragging a clip 150px right, `event.delta.x` reads `-1850`. That is
 * B-145: the clip lands ~`scrollLeft` worth of frames earlier than it was
 * dropped, which for a clip you can actually see on screen is at or near frame
 * 0 — "when i move this instead of moving it moves to very starting".
 *
 * **What this uses instead.** `active.rect.current`, dnd-kit's own public
 * record of the dragged node's measured box: `initial` is that box as
 * measured, `translated` is the same box plus the drag's `modifiedTranslate`
 * — i.e. the *un*-scroll-adjusted translate. Their difference is therefore the
 * pointer's real on-screen displacement, with no scroll term in it at all, and
 * both are written into the same ref in the same layout effect so they can
 * never disagree about which measurement they came from. The scroll term is
 * then added back by the caller from the pane's OWN `scrollLeft`/`scrollTop`
 * (the values it already tracks through the library's `onScroll`), which is
 * the one source that actually knows what the timeline content is offset by.
 *
 * **What it does NOT do.** No DOM, no dnd-kit imports, no frames — every
 * quantity here is on-screen or content pixels. Converting to frames stays
 * with the caller, which owns `pxPerSec`/`fps`. It also does not know about
 * zoom: a `pxPerSec` change *mid-drag* would reinterpret an already-accumulated
 * pixel displacement, which is a separate (and currently unreachable-by-design)
 * concern — see `docs/notes/timeline-drag-interactions.md`.
 */

/** The two corners `@dnd-kit/core` publishes on `active.rect.current`. Only
 *  the origin is read, so this is deliberately narrower than dnd-kit's own
 *  `ClientRect` — nothing here needs a width or a height. */
export interface DragRectOrigin {
  left: number;
  top: number;
}

/** `event.active.rect.current`, structurally. */
export interface DragRects {
  initial: DragRectOrigin | null;
  translated: DragRectOrigin | null;
}

/** A scroll position of the timeline's own content, as `TimelinePane` tracks
 *  it (`scrollLeft`/`scrollTop`, fed by the library's `onScroll`). */
export interface ScrollOffset {
  left: number;
  top: number;
}

export interface DragDelta {
  /** How far the pointer has moved on screen, in px. */
  screenX: number;
  screenY: number;
  /** How far the drag has moved through the timeline's CONTENT, in px —
   *  the on-screen movement plus however much the content scrolled underneath
   *  it since the drag began. This is the one to convert to frames. */
  contentX: number;
  contentY: number;
}

/**
 * The drag's displacement, or `null` when dnd-kit has no measurement for it
 * (both rect corners are derived from the same nullable `draggingNodeRect`, so
 * they are absent together — the same "this drag cannot be resolved" condition
 * `TimelinePane`'s own `dndBoundary` already refuses on).
 *
 * @param rects         `event.active.rect.current`.
 * @param scrollAtStart the timeline's scroll offset when the drag began.
 * @param scrollNow     the timeline's scroll offset right now.
 */
export function dragDelta(rects: DragRects, scrollAtStart: ScrollOffset, scrollNow: ScrollOffset): DragDelta | null {
  const { initial, translated } = rects;
  if (!initial || !translated) return null;
  const screenX = translated.left - initial.left;
  const screenY = translated.top - initial.top;
  return {
    screenX,
    screenY,
    contentX: screenX + (scrollNow.left - scrollAtStart.left),
    contentY: screenY + (scrollNow.top - scrollAtStart.top),
  };
}
