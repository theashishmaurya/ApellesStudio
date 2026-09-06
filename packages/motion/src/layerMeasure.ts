/**
 * @chroma/motion — shared DOM measurement for a layer's tight screen rect
 * (D-155 §3b's "union of `[data-motion-box]` descendants" technique).
 *
 * Factored out so `MotionCanvasOverlay.tsx`'s own selection-outline
 * measurement and the new "snap to layer" action (D-157, Phase 2 of
 * `docs/notes/motion-visual-builder-research.md` §3d) don't each carry their
 * own copy of the same `querySelector('[data-motion-layer=...]')` +
 * `querySelectorAll('[data-motion-box]')` + "fall back to the first
 * rendered child" logic — CLAUDE.md's "if two places need it, extract it."
 *
 * DOM-touching, so — the same split every file in this package already
 * follows (`canvasGeometry.ts`'s own doc comment) — this is NOT unit-tested;
 * `canvasGeometry.ts`'s `unionRects` (the pure math half of "union a list of
 * rects") already is, and this file is a thin, untestable-without-a-real-DOM
 * wrapper around it plus two `querySelector` calls.
 */
import { unionRects, type RectLike } from './canvasGeometry';

/** The union of `sceneIndex.layerIndex`'s `[data-motion-box]` descendants
 *  inside `container` (viewport/screen coordinates, straight off
 *  `getBoundingClientRect()`) — falling back to the layer wrapper's first
 *  rendered child when the primitive has no tight box of its own (`graph`,
 *  `emphasis`'s `pulse`/`glow` — research doc §3b's documented "whole
 *  canvas" case), and to `null` when the layer isn't in the DOM at all right
 *  now (wrong scene under the playhead per §1e, an out-of-range index, or a
 *  layer whose `at` schedule hasn't mounted it yet). */
export function measureLayerScreenBox(
  container: Element,
  sceneIndex: number,
  layerIndex: number,
): RectLike | null {
  const layerEl = container.querySelector(`[data-motion-layer="${sceneIndex}.${layerIndex}"]`);
  if (!layerEl) return null;
  const boxEls = layerEl.querySelectorAll('[data-motion-box]');
  const rects =
    boxEls.length > 0
      ? Array.from(boxEls).map((el) => el.getBoundingClientRect())
      : layerEl.firstElementChild
        ? [layerEl.firstElementChild.getBoundingClientRect()]
        : [];
  return unionRects(rects);
}

/** The `[data-motion-world]` element inside `container` — the one stable
 *  reference every fresh `measureWorldMap` call needs (D-155 §3a). Shared so
 *  every DOM caller that needs a world-map reference queries for it the same
 *  way, rather than re-typing the selector string per call site. */
export function findWorldElement(container: Element): Element | null {
  return container.querySelector('[data-motion-world]');
}

/** D-182 (Phase 3 of 3) — ONE card's own screen rect within a `layers`
 *  primitive, scoped by `sceneIndex.layerIndex` first (`data-motion-item-
 *  index` alone isn't unique across different `layers` layers — every stack
 *  starts its own item indices from 0) then that item's own index inside it.
 *  Unlike `measureLayerScreenBox` above, this is never a UNION — a card is
 *  addressed as one specific element, not "whatever boxes exist," since
 *  D-182's whole point is selecting/measuring/dragging ONE card independent
 *  of its siblings. `null` when the layer or that item index isn't in the
 *  DOM right now (same floor `measureLayerScreenBox` already holds). */
export function measureLayerItemScreenBox(
  container: Element,
  sceneIndex: number,
  layerIndex: number,
  itemIndex: number,
): RectLike | null {
  const layerEl = container.querySelector(`[data-motion-layer="${sceneIndex}.${layerIndex}"]`);
  if (!layerEl) return null;
  const itemEl = layerEl.querySelector(`[data-motion-item-index="${itemIndex}"]`);
  return itemEl ? itemEl.getBoundingClientRect() : null;
}
