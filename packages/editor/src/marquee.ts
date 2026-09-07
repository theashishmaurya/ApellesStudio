/**
 * @chroma/editor — marquee-select, the pure half (roadmap item 12 Phase 2,
 * D-137).
 *
 * **What it is.** Every DOM-free decision a rubber-band selection on the Edit
 * tab's timeline has to make: whether a given `pointerdown` is even allowed to
 * begin one, whether the pointer has moved far enough for it to count as a
 * drag rather than a click, which clips a finished rectangle actually
 * contains, how that result composes with whatever was already selected, and
 * where the live rectangle paints on screen.
 *
 * **What it does NOT do.** No React, no DOM, no `window`/`document`, no
 * pointer capture — `TimelinePane.tsx` owns the gesture's wiring and state and
 * calls into here for every judgement. That split is not cosmetic: this
 * package's vitest runs in a bare `node` environment (`vitest.config.ts`), the
 * same reason `ruler.ts` / `clipKeyframes.ts` / `transformGeometry.ts` are all
 * split out from their components, and it is the only way this gesture's math
 * gets real tests at all in this sandbox.
 *
 * **The dnd-kit coexistence rule lives here, in `MARQUEE_BLOCKING_SELECTOR`.**
 * This file's timeline already runs `@dnd-kit/core` for clip move and track
 * reorder, and D-094–D-100 is six consecutive decisions' worth of scar tissue
 * about two drag systems racing for one `pointerdown` on one element. A
 * marquee starts from a `pointerdown` on the SAME edit-area subtree a clip
 * drag starts from, so the two must be separated structurally, not by
 * priority, ordering, or a "who wins" tiebreak.
 *
 * They are separated by **event target**, and the separation is exact rather
 * than approximate. dnd-kit's `PointerSensor` is not a document-level
 * listener: its activator is an `onPointerDown` prop that `useDraggable`
 * returns in `listeners`, and this file's timeline spreads those listeners on
 * exactly two kinds of node — `ClipBody` (every clip, D-100) and
 * `SortableTrackHeader`'s grip icon (D-098). The grip lives in the track-
 * header `ResizablePanel`, a different subtree from the edit area entirely, so
 * the edit area's own handler never sees it. `ClipBody` is inside the edit
 * area and does bubble to it — so `ClipBody` now carries
 * `data-chroma-clip-drag`, and `canStartMarquee` refuses any `pointerdown`
 * whose target has that attribute on an ancestor. The predicate is therefore
 * not "probably not a clip"; it is literally "no dnd-kit draggable node is on
 * this event's propagation path," which is the same condition dnd-kit itself
 * uses to decide whether its sensor runs.
 *
 * The rest of the selector list is the same idea applied to the timeline
 * library's own gestures (edge-trim, ruler scrub, playhead drag) so a marquee
 * can't start out from under those either — class names read out of
 * `@xzdarcy/react-timeline-editor`'s bundled CSS, not guessed.
 */

import { endFrame, timelineFps, type Timeline } from './timeline';

/** How far the pointer must travel before a press on empty timeline canvas
 *  becomes a marquee rather than a click. Deliberately the SAME number as the
 *  `PointerSensor`'s own `activationConstraint: { distance: 4 }` in
 *  `TimelinePane.tsx`, and measured the same way (euclidean distance from the
 *  press point — dnd-kit's `hasExceededDistance` with a scalar `distance`
 *  computes `Math.sqrt(x*x + y*y)`, read in its bundled source, not assumed).
 *  Reusing the existing pattern rather than inventing a second activation
 *  threshold is the point: two pointer gestures on one surface that disagree
 *  about what counts as "a drag" is exactly the kind of near-miss this file's
 *  own history is made of. */
export const MARQUEE_MIN_DRAG_PX = 4;

/** Every ancestor a `pointerdown` may NOT have if it is to start a marquee.
 *
 *  - `[data-chroma-clip-drag]` — `ClipBody`, the one `@dnd-kit/core`
 *    `useDraggable` node inside the edit area (D-100). This entry is the
 *    coexistence guarantee; see the module doc.
 *  - `.timeline-editor-action` — the library's own action wrapper. Redundant
 *    with the attribute above today (a `ClipBody` is always rendered inside
 *    one) and kept anyway, because it is also the ancestor of the library's
 *    `.timeline-editor-action-{left,right}-stretch` edge-trim handles, which
 *    are the library's siblings of our content, not our children.
 *  - `.timeline-editor-time-area` / `-cursor` / `-cursor-area` — the ruler and
 *    the playhead. `onClickTimeArea` / `onCursorDrag` own those presses.
 *  - `.timeline-editor-edit-row-drag-handle` — the library's own row-drag
 *    grip. Unused by this app (D-094 chose a custom header sidebar instead)
 *    but present in the library's DOM, so listed rather than assumed absent.
 *  - `[data-chroma-no-marquee]` — a real escape hatch for anything later
 *    rendered into the edit area that owns its own press. */
export const MARQUEE_BLOCKING_SELECTOR = [
  '[data-chroma-clip-drag]',
  '[data-chroma-no-marquee]',
  '.timeline-editor-action',
  '.timeline-editor-time-area',
  '.timeline-editor-cursor',
  '.timeline-editor-cursor-area',
  '.timeline-editor-edit-row-drag-handle',
].join(',');

/** The one thing `canStartMarquee` needs from an `EventTarget`. Structural,
 *  not `Element`, so this whole module stays testable under vitest's `node`
 *  environment — there is no DOM there to build a real element in. */
export interface MarqueeHitTarget {
  closest(selector: string): unknown;
}

/** Primary mouse button, matching dnd-kit's own `PointerSensor` default
 *  (`MouseButton.RightClick` is the only one it explicitly rejects, but every
 *  drag gesture in this file is left-button in practice). */
const PRIMARY_BUTTON = 0;

/**
 * Is this `pointerdown` allowed to begin a marquee?
 *
 * True only for a primary-button press whose propagation path contains no
 * dnd-kit draggable and no timeline-library gesture surface — i.e. a press on
 * genuinely empty timeline canvas. See the module doc for why this is the
 * whole coexistence story and not merely a heuristic.
 */
export function canStartMarquee(button: number, target: MarqueeHitTarget | null | undefined): boolean {
  if (button !== PRIMARY_BUTTON) return false;
  if (!target) return false;
  return target.closest(MARQUEE_BLOCKING_SELECTOR) == null;
}

/** Has the pointer moved far enough from the press point for this to be a
 *  drag? Below the threshold the press stays a plain click, which is what
 *  clears the selection / selects a gap (D-100/D-105) — a bare click on empty
 *  space must never draw a zero-size marquee and swallow that. */
export function marqueeActivated(dx: number, dy: number, threshold = MARQUEE_MIN_DRAG_PX): boolean {
  return Math.sqrt(dx * dx + dy * dy) >= threshold;
}

/** One corner of a marquee, in TIMELINE units rather than pixels: a timeline
 *  `frame`, and a fractional track `row` (`1.5` = halfway down track 1).
 *
 *  Storing the anchor this way — rather than as edit-area pixels — is what
 *  makes the gesture survive a scroll or a ctrl-wheel zoom mid-drag: both only
 *  change how frames and rows MAP to pixels, never the frame or row the press
 *  actually landed on. The pixel press point is still kept separately by the
 *  caller, but only for `marqueeActivated`'s threshold, which genuinely is a
 *  physical-distance question. */
export interface MarqueeAnchor {
  frame: number;
  row: number;
}

/** A normalised marquee, in the same timeline units. `frameStart <= frameEnd`
 *  and `rowStart <= rowEnd` always, regardless of which way the drag went. */
export interface MarqueeRect {
  frameStart: number;
  frameEnd: number;
  rowStart: number;
  rowEnd: number;
}

/** Normalise two drag corners into a rectangle. A drag up-and-left produces
 *  the same rect as the equivalent drag down-and-right. */
export function marqueeRect(a: MarqueeAnchor, b: MarqueeAnchor): MarqueeRect {
  return {
    frameStart: Math.min(a.frame, b.frame),
    frameEnd: Math.max(a.frame, b.frame),
    rowStart: Math.min(a.row, b.row),
    rowEnd: Math.max(a.row, b.row),
  };
}

/** Track `index`'s row band is `[index, index + 1)`; does the marquee overlap
 *  it? Kept fractional (not `Math.floor`ed at both ends) on purpose: a rect
 *  that crosses the seam between two rows by a single pixel must catch both
 *  tracks, and flooring both ends silently drops the second one whenever the
 *  rect's bottom edge lands exactly on a boundary. */
function overlapsRow(index: number, rect: MarqueeRect): boolean {
  return index < rect.rowEnd && index + 1 > rect.rowStart;
}

/**
 * Every clip whose bounding box intersects `rect`, in track order then clip
 * order.
 *
 * Intersection is the standard open-interval overlap on both axes —
 * `clip.start < rect.end && clip.end > rect.start` — so partial overlap and
 * full containment both select, and a rect that merely *touches* a clip's edge
 * (zero-area overlap) does not. That last case is a deliberate call, not an
 * accident of `<` vs `<=`: a marquee's own activation threshold means a
 * degenerate zero-width or zero-height rect can only arise from a perfectly
 * axis-aligned drag, and "a purely vertical drag down a gap between two clips
 * selects everything it grazes" is the wrong answer in every NLE this was
 * checked against.
 *
 * Clips on a locked track ARE included, matching what a plain click on one
 * already does (`onClickAction` has no lock guard — the lock is enforced by
 * the ops themselves, not by the selection). Consistency with the existing
 * click behaviour beats inventing a second, marquee-only rule.
 */
export function clipsInMarquee(tl: Timeline | null, rect: MarqueeRect): Array<{ track: number; id: string }> {
  if (!tl) return [];
  const fps = timelineFps(tl);
  const hits: Array<{ track: number; id: string }> = [];
  tl.tracks.forEach((track, ti) => {
    if (!overlapsRow(ti, rect)) return;
    for (const clip of track.clips) {
      if (clip.start_frame < rect.frameEnd && endFrame(clip, fps) > rect.frameStart) {
        hits.push({ track: ti, id: clip.id });
      }
    }
  });
  return hits;
}

/**
 * Fold a marquee's hits into the existing selection.
 *
 * `additive` (shift or cmd/ctrl held when the gesture STARTED — read once at
 * `pointerdown`, so a modifier tapped mid-drag can't change the meaning of a
 * gesture already under way) unions the hits onto what was already selected,
 * preserving the previous selection's order and appending only genuinely new
 * `{track, id}` pairs. Otherwise the hits replace the selection outright.
 *
 * This is the same shift-adds / plain-replaces split `onClickAction` already
 * implements for clicks (D-107), and the same one every real NLE and file
 * manager uses for a marquee. Note the deliberate asymmetry with click: an
 * additive marquee UNIONS, it does not toggle. Cmd-clicking one clip twice
 * reasonably means "select then deselect it"; sweeping a rectangle over a clip
 * that happens to already be selected must not silently deselect it, because
 * the user is aiming at a region, not at that clip.
 */
export function composeMarqueeSelection(
  prev: ReadonlyArray<{ track: number; id: string }>,
  hits: ReadonlyArray<{ track: number; id: string }>,
  additive: boolean,
): Array<{ track: number; id: string }> {
  if (!additive) return hits.map((h) => ({ track: h.track, id: h.id }));
  const next = prev.map((s) => ({ track: s.track, id: s.id }));
  for (const h of hits) {
    if (!next.some((s) => s.track === h.track && s.id === h.id)) next.push({ track: h.track, id: h.id });
  }
  return next;
}

/** The pixel geometry `TimelinePane.tsx` already uses to place every overlay
 *  in the edit area: `START_LEFT_PX`, `RULER_AND_MARGIN_PX`, `ROW_HEIGHT`, the
 *  current zoom, and the current scroll. Passed in rather than imported so
 *  this module stays free of that component's module-scope constants (and so
 *  the tests can state them explicitly). */
export interface MarqueeViewport {
  fps: number;
  pxPerSec: number;
  scrollLeft: number;
  scrollTop: number;
  startLeftPx: number;
  rulerPx: number;
  rowHeight: number;
}

/** Edit-area-relative pixels for the pointer at `clientX`/`clientY`, converted
 *  to timeline units. The exact inverse of `marqueeOverlayBox` below, and the
 *  same conversion the edit area's own click handler already does inline. */
export function marqueeAnchorFromPoint(
  offsetX: number,
  offsetY: number,
  v: MarqueeViewport,
): MarqueeAnchor {
  return {
    frame: ((offsetX + v.scrollLeft - v.startLeftPx) / v.pxPerSec) * v.fps,
    row: (offsetY - v.rulerPx + v.scrollTop) / v.rowHeight,
  };
}

/** Where the live marquee paints, in the same edit-area-relative coordinate
 *  space every other overlay in `TimelinePane.tsx` uses. Recomputed from the
 *  rect on every render rather than stored, so a scroll or zoom mid-drag moves
 *  the rectangle with the content it actually encloses. */
export function marqueeOverlayBox(
  rect: MarqueeRect,
  v: MarqueeViewport,
): { left: number; top: number; width: number; height: number } {
  const left = v.startLeftPx + (rect.frameStart / v.fps) * v.pxPerSec - v.scrollLeft;
  const right = v.startLeftPx + (rect.frameEnd / v.fps) * v.pxPerSec - v.scrollLeft;
  const top = v.rulerPx + rect.rowStart * v.rowHeight - v.scrollTop;
  const bottom = v.rulerPx + rect.rowEnd * v.rowHeight - v.scrollTop;
  return { left, top, width: right - left, height: bottom - top };
}
