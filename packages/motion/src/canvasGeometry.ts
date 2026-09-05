/**
 * @chroma/motion — pure screen↔world coordinate math for `MotionCanvasOverlay.tsx`
 * (D-155/D-156, Phase 0d/Phase 1 of `docs/notes/motion-visual-builder-research.md`).
 *
 * Kept apart from the component for the same reason `@chroma/editor`'s own
 * `transformGeometry.ts` is split from `TransformOverlay.tsx`: this
 * package's `vitest.config.ts` runs in a bare `node` environment, and this
 * is exactly the kind of math the research doc's own §7.2 warns is a real,
 * NOT-hypothetical risk — "getting this wrong is silent: the manifest still
 * validates, the render still succeeds, the picture is just wrong." It gets
 * a real unit-test floor (`canvasGeometry.test.ts`); the DOM measuring and
 * pointer-event wiring around it (`MotionCanvasOverlay.tsx`) does not, same
 * split as that file.
 *
 * The technique (research doc §3a, "measure the live DOM, don't re-derive
 * the camera"): the Motion engine's camera is a 2D similarity transform —
 * uniform scale plus translate, no rotation or shear (`motion-engine`'s
 * `Camera.tsx`) — so `getBoundingClientRect()` on the camera's transformed
 * container (`data-motion-world`, added to `Camera.tsx`/`Video.tsx` this
 * same pass) already reports the EXACT composed scale/origin: the player's
 * own fit-scale times the camera's `zoom`, PLUS the camera's translate and
 * its always-on ambient drift — with no need for this package to re-read
 * `scene.camera`, re-sort its keys, or re-run its easing. One measurement,
 * taken fresh at drag-start and (via `frameupdate`/`scalechange`) whenever
 * the picture might have moved since, is the whole answer:
 *
 *   worldRect     = worldEl.getBoundingClientRect()
 *   k             = worldRect.width / manifest.width
 *   world(p)      = ((p.x - worldRect.left) / k, (p.y - worldRect.top) / k)
 *   worldDelta(d) = (d.x / k, d.y / k)
 *
 * A drag writes the layer's WORLD position (§2b/§4 Phase 0d) — never a raw
 * screen-space pointer delta — precisely so it keeps meaning the same place
 * at every frame the camera later visits, camera move or not.
 */

export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** The measured screen↔world map at one instant. `k` is `playerScale ×
 *  cameraZoom`, composed and read straight off the DOM — never recomputed
 *  from `scene.camera`'s keys, easing, or the ambient-drift sinusoid. */
export interface WorldMap {
  left: number;
  top: number;
  k: number;
}

/** `worldRect`: the `[data-motion-world]` element's own
 *  `getBoundingClientRect()` (or an equivalent plain object — kept as a
 *  `RectLike`, not a real `DOMRect`, so this whole module stays testable
 *  under `vitest`'s `node` environment with no real DOM). `manifestWidth`:
 *  `manifest.width` — the same denominator `metadataFromManifest`
 *  (`motion-engine`'s `build.ts`) feeds the renderer and the preview
 *  `<Player>` alike, so `k` is exact regardless of the player's own preview
 *  zoom or the camera's current zoom — both are already baked into
 *  `worldRect.width` by the time this runs. */
export function measureWorldMap(worldRect: RectLike, manifestWidth: number): WorldMap {
  return { left: worldRect.left, top: worldRect.top, k: worldRect.width / manifestWidth };
}

/** An absolute screen point (e.g. `{x: e.clientX, y: e.clientY}`) → world px. */
export function screenToWorld(map: WorldMap, p: Point): Point {
  return { x: (p.x - map.left) / map.k, y: (p.y - map.top) / map.k };
}

/** A screen-space DELTA (e.g. `pointermove.clientX - pointerdown.clientX`) →
 *  a world-space delta. Not `screenToWorld` applied twice and subtracted —
 *  written as its own function so a caller never has to reason about why
 *  the origin (and the drift baked into it) cancels out of a difference; it
 *  just does, because division by `k` is linear. */
export function worldDelta(map: WorldMap, d: Point): Point {
  return { x: d.x / map.k, y: d.y / map.k };
}

/** The smallest rect containing every rect in `rects` — how
 *  `MotionCanvasOverlay` turns a primitive's `[data-motion-box]`
 *  descendants (research doc §3b — the tight visible element(s) inside a
 *  `[data-motion-layer]` wrapper) into one selection outline. `null` for an
 *  empty list — the caller's cue to fall back to the layer wrapper's own
 *  first child, per §3b's own honest "whole canvas" fallback for a
 *  primitive with no tight box (`graph`). */
export function unionRects(rects: RectLike[]): RectLike | null {
  if (rects.length === 0) return null;
  let left = Infinity;
  let top = Infinity;
  let right = -Infinity;
  let bottom = -Infinity;
  for (const r of rects) {
    left = Math.min(left, r.left);
    top = Math.min(top, r.top);
    right = Math.max(right, r.left + r.width);
    bottom = Math.max(bottom, r.top + r.height);
  }
  return { left, top, width: right - left, height: bottom - top };
}

/** `rect` (viewport coordinates, e.g. straight from `getBoundingClientRect()`)
 *  placed relative to `container`'s own rect — what an absolutely positioned
 *  overlay child's `left`/`top`/`width`/`height` CSS should be, so the drawn
 *  outline tracks the measured element regardless of where the container
 *  itself sits on the page. */
export function toContainerLocal(rect: RectLike, container: RectLike): RectLike {
  return { left: rect.left - container.left, top: rect.top - container.top, width: rect.width, height: rect.height };
}

/** Shift-axis-lock (research doc §3c — Remotion Studio's own drag
 *  modifier): given the TOTAL world-space delta since the drag started,
 *  zero out whichever axis has moved less, so the drag holds to a single
 *  axis. Recomputed on every move from the total delta (not the previous
 *  move's), so reversing direction can flip which axis is locked — the
 *  live "whichever axis is currently dominant" behaviour, not a one-time
 *  choice frozen at drag start. */
export function axisLock(d: Point): Point {
  return Math.abs(d.x) >= Math.abs(d.y) ? { x: d.x, y: 0 } : { x: 0, y: d.y };
}
