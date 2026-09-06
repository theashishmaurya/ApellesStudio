/**
 * @chroma/motion — on-canvas select + drag (D-156, Phase 1) + resize (D-157,
 * Phase 2) + multi-select/marquee/group-move (D-158, Phase 3) of
 * `docs/notes/motion-visual-builder-research.md`. The owner's original ask:
 * "i would like to drag and drop multiple elements and set position or
 * change them size crop animation and all those things" — Phase 1 shipped
 * select+move, Phase 2 added resize, this pass adds the "multiple elements"
 * half: marquee-select, shift-click-to-extend, and a shared-delta group move
 * (rotate, keyframes and `scene3d` manipulation all stay deferred — see the
 * research doc §4).
 *
 * **Why this does NOT mirror `TransformOverlay.tsx`'s pointer-event wiring,
 * only its "DOM sibling of the preview" shape.** The Edit tab's overlay
 * deliberately defers click-to-select (its own doc comment: "Clicking on
 * the picture to select is deliberately deferred") and only ever draws
 * handles for an ALREADY-selected clip, so it can afford `pointer-events:
 * none` on everything except the box/handles it draws. Phase 1 here
 * explicitly does NOT defer click-to-select — the research doc calls it out
 * as a real advantage this tab's live-DOM preview has over the Edit tab's
 * server-rendered JPEG (§4 Phase 1) — which means SOMETHING has to be
 * clickable across the WHOLE canvas before any selection exists to draw a
 * box around. Making this component itself `pointer-events: auto` over the
 * whole player would sit on top of `@remotion/player`'s OWN control bar
 * (`PlayerControls.js` — a plain absolutely-positioned div with no
 * `pointer-events` toggling of its own, verified by reading it this pass)
 * and silently break play/pause/scrub. So: this component's own rendered
 * `<div>` stays `pointer-events: none` throughout — EXCEPT the small resize
 * handles it draws once something resizable is selected (D-157), which are
 * individually `pointer-events: auto` (the same "invisible except real
 * grab targets" shape `TransformOverlay.tsx`'s own corner handles use) — and
 * the actual click/drag/resize/marquee listeners are native
 * `addEventListener`s on `containerRef` (an ANCESTOR of both the `<Player>`
 * and this overlay, `MotionPreview.tsx`), which receive every pointer event
 * via normal DOM bubbling regardless of what got hit, without ever being the
 * hit-test target themselves — Remotion's own controls keep working
 * untouched. A resize handle's pointerdown ALSO bubbles to this same
 * container listener (native bubbling reaches an ancestor's
 * directly-attached listener before React's own synthetic dispatch on the
 * handle would even run one attached there instead — this is why the handle
 * is checked via `[data-motion-resize-handle]` at the TOP of `onPointerDown`,
 * not via a separate React `onPointerDown` prop on the handle element).
 *
 * **D-158's fourth gesture, and D-137's discipline applied explicitly.**
 * Four pointer gestures now share this ONE surface: resize-handle-drag,
 * click-to-select/move-drag, shift-click-toggle, and marquee-select. Per
 * `docs/08-decisions.md`'s D-137 ("Marquee-select... made mutually exclusive
 * with the dnd-kit clip drag by DOM position rather than by precedence") —
 * the SAME discipline this file already used for resize-vs-move in D-157 —
 * `onPointerDown` below determines which gesture starts by checking WHAT WAS
 * STRUCTURALLY HIT, in order, never by an ad-hoc "if nothing else matched,
 * assume X" fallback chain that could silently swallow the wrong case:
 *   1. `[data-motion-resize-handle]` → resize (unchanged from D-157, single-
 *      selection only — group resize is not in this phase's scope).
 *   2. `[data-motion-layer]` (via `elementsFromPoint`+`closest`, D-156) →
 *      click-to-select, shift-toggle, or the start of a move/group-move.
 *   3. Otherwise: is the pointerdown target a descendant of
 *      `[data-motion-world]` (the camera's own transformed container, or a
 *      camera-less scene's root — D-155 §3a)? If NOT, it's Remotion's own
 *      chrome (the control bar, letterboxing) — a SIBLING subtree of the
 *      composition in `@remotion/player`'s own DOM (`PlayerUI.js`, read
 *      directly: `VideoComponent` and `Controls` are rendered as siblings
 *      under one wrapping div), so nothing here is or should be hit-testing
 *      it — do nothing, exactly as before this phase. If it IS inside the
 *      world container, this is truly empty canvas SPACE INSIDE THE
 *      COMPOSITION → marquee. This is a DOM-containment fact, not a class-
 *      name guess (D-137's own class-list approach doesn't transfer here —
 *      Remotion's controls carry no distinguishing class or attribute at
 *      all, verified by reading `PlayerControls.js` — containment against
 *      `[data-motion-world]` is the structural fact this engine already
 *      guarantees instead).
 *
 * **Coordinate math is 0d, not reinvented here.** A drag writes the
 * layer's WORLD `x`/`y` (`manifestEdit.ts`'s `layerDragBase`/
 * `moveLayersByDeltaAutoKey`, D-159 — see below); a resize writes its WORLD
 * `w`/`h` (`setLayerSize`) — both converted from a screen-space pointer
 * delta via `canvasGeometry.ts`'s `measureWorldMap`/`worldDelta` — "measure
 * the live DOM, don't re-derive the camera" (research doc §3a). The world
 * map is re-measured at drag-start and is NOT re-measured mid-drag: a drag
 * is a bounded, sub-second human gesture, and `manifest.width` never
 * changes during one — the one thing that WOULD invalidate a stale map (the
 * camera itself moving under the drag) doesn't happen either, since
 * `manifest` here is the STABLE, already-committed manifest, not the
 * transient one this same drag is writing into `<Player inputProps>` (0b) —
 * the layer(s) move, the camera doesn't, so the map measured once at
 * pointerdown stays correct for the whole gesture.
 *
 * **D-159, Phase 4 — auto-keyframe on drag.** A move-drag's WRITE TARGET
 * now depends on whether the dragged layer's `transform.keys` (the new
 * per-layer animation channel) already keyframes `x`/`y`: `manifestEdit.ts`'s
 * `layerDragBase(manifest, selection, currentFrame, fps)` decides this ONCE
 * per selected layer at pointerdown — `keyed: true` means the drag's base is
 * the CURRENT INTERPOLATED transform delta at the playhead (not the
 * primitive's native position), and the commit path
 * (`moveLayersByDeltaAutoKey`) upserts a `transform.keys` row AT THE
 * CURRENT PLAYHEAD FRAME (`drag.atSeconds`, captured once at pointerdown,
 * same as `map`) instead of writing the primitive's own base field. `keyed:
 * false` (the common case — no `keys` at all, or `keys` that never touched
 * `x`/`y`) drags the native base position exactly as Phase 1 always has.
 * See `layerDragBase`'s own doc comment in `manifestEdit.ts` for the full
 * per-property (not per-layer) reasoning, and D-159's decision entry for the
 * dedicated "auto-keyframe design decision" writeup. Resize is UNCHANGED by
 * this — `transformKey` (the new schema type) has no width/height field to
 * write to (it mirrors `cam2dKey`'s x/y/zoom-shaped fields, not a size
 * concept), so a resize handle always writes the primitive's own size
 * field(s) regardless of `transform.keys`, a deliberate scope call recorded
 * in the same decision entry rather than an oversight.
 *
 * **Multi-select is `Selection[]`, constrained to same-kind (`layer`),
 * same-scene, per `LayerList.tsx`'s own module doc comment** — see that
 * file for the full reasoning. `toggleSelection`/`sameSelection` (also
 * there) enforce it; this file never needs to re-check the constraint
 * itself, only to build candidate `Selection`s that already respect it.
 *
 * **A known, documented gap (D-157, still true here):** if a layer ALSO
 * carries the Phase 2 layer-transform wrapper (`schema.ts`'s
 * `layerTransform` — `scale`/`rot` set to something other than identity),
 * this overlay's screen↔world map is still measured off `[data-motion-
 * world]` alone (the CAMERA's own transform) and does NOT additionally
 * account for that layer's own transform sitting between the camera and the
 * primitive — a drag, resize, OR group-move on such a layer will be
 * slightly off. Unchanged scope call from D-157; see its own decision entry.
 * D-159 doesn't widen this gap (the auto-keyframe write is additive onto
 * whatever `transform.x/y` already resolves to, using the SAME world map),
 * but doesn't fix it either — worth re-stating since a KEYED layer is
 * exactly the layer most likely to also carry a non-identity `scale`/`rot`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';

import type { Selection } from './LayerList';
import { sameSelection, toggleSelection } from './LayerList';
import {
  selectedLayer,
  layerDragBase,
  moveLayersByDeltaAutoKey,
  layerWorldSize,
  setLayerSize,
  selectedLayerItem,
  setLayerItemOffset,
} from './manifestEdit';
import {
  measureWorldMap,
  worldDelta,
  unionRects,
  toContainerLocal,
  axisLock,
  rectFromPoints,
  rectsIntersect,
  type RectLike,
  type Point,
} from './canvasGeometry';
import { measureLayerScreenBox, measureLayerItemScreenBox, findWorldElement } from './layerMeasure';
import { sizeFields } from './propCatalog';

/** Which edge/corner a resize handle drives — `'e'`/`'s'` change one axis
 *  independently, `'se'` changes both together. Which of the three a given
 *  selection actually gets is `handlesForUse` below, keyed off
 *  `propCatalog.ts`'s `sizeFields`. Resize stays single-selection only
 *  (D-158 doesn't scope a group-resize shape — see the module doc comment). */
type HandleId = 'e' | 's' | 'se';

/** D-158 — a marquee starts additive (unions onto the existing selection)
 *  when shift/cmd/ctrl is held at the moment the drag BEGINS, mirroring
 *  D-137's own "additive marquee unions, it does not toggle" rule for the
 *  timeline's marquee, reused here for consistency rather than inventing a
 *  second modifier convention in the same codebase. */
const MARQUEE_MIN_DRAG_PX = 4; // same physical-distance bar D-137 set

/** In-flight gesture state — local, uncommitted (0b). `null` when no drag is
 *  active. Kept in a ref, not state: a pointermove firing at display refresh
 *  rate has no business going through a re-render to read its own drag
 *  origin back. A discriminated union on `kind` — `'move'` (D-156, now
 *  carrying N moves instead of one — D-158), `'resize'` (D-157), and
 *  `'marquee'` (D-158, new) share the same pointerdown/move/up plumbing
 *  below but carry different starting snapshots. */
type DragState =
  | {
      kind: 'move';
      pointerId: number;
      /** D-158: one entry per selected layer that resolves a draggable
       *  position at drag-start — a single-selection move is just the
       *  `moves.length === 1` case of this same shape, not a separately
       *  maintained code path. D-159 (Phase 4, "auto-keyframe on drag"):
       *  `base`/`keyed` now come from `manifestEdit.ts`'s `layerDragBase`
       *  (not `layerWorldPosition` directly) — `keyed` records, PER ENTRY,
       *  whether THIS layer's `transform.keys` already defines `x`/`y`, so a
       *  mixed selection (some keyed, some not) is fully supported: each
       *  entry routes independently in `moveLayersByDeltaAutoKey`. */
      moves: { selection: Selection; base: { x: number; y: number }; keyed: boolean }[];
      map: ReturnType<typeof measureWorldMap>;
      start: Point;
      /** D-159: the playhead's position in SECONDS at drag-start
       *  (`playerRef.getCurrentFrame() / manifest.fps`) — where a keyed
       *  entry's `transform.keys` row gets created/updated (Remotion
       *  Studio's own cited rule: "drags create or update a keyframe AT THE
       *  CURRENT FRAME"). Captured once, like `map` above, since a drag is a
       *  bounded gesture and the playhead doesn't move during one. */
      atSeconds: number;
    }
  | {
      kind: 'resize';
      handle: HandleId;
      pointerId: number;
      selection: Selection;
      map: ReturnType<typeof measureWorldMap>;
      start: Point;
      startSize: { w: number; h: number | null };
    }
  | {
      kind: 'marquee';
      pointerId: number;
      /** shift/cmd/ctrl held at `pointerdown` — read once, matching D-137's
       *  own "a modifier tapped mid-drag must not change the meaning of a
       *  gesture already under way" rule. */
      additive: boolean;
      /** the selection to union onto if `additive`; ignored otherwise. */
      baseSelections: Selection[];
      start: Point;
    }
  | {
      /** D-182 (Phase 3 of 3) — dragging ONE card within a `layers`
       *  primitive. Deliberately its own kind, not folded into `'move'`
       *  (whose `moves[]` shape is a list of WHOLE-LAYER positions, keyable
       *  via `transform.keys` — a card has neither of those; it always
       *  writes through `setLayerItemOffset`'s own `dx`/`dy`, single card
       *  only, no keyframing, no group case). */
      kind: 'move-item';
      pointerId: number;
      /** always a `{kind:'layer-item'}` selection in practice (the only
       *  caller, `onPointerDown`'s new card-hit branch, constructs it that
       *  way) — typed as the plain `Selection` union, matching `'resize'`'s
       *  own `selection` field above, rather than narrowing the type here. */
      selection: Selection;
      map: ReturnType<typeof measureWorldMap>;
      start: Point;
      /** the card's OWN `dx`/`dy` at drag-start (`0,0` if it had none yet) —
       *  the base a live pointer delta adds to, mirroring every other drag
       *  in this file's "recompute from a stable base + delta" discipline. */
      baseDx: number;
      baseDy: number;
    };

/** Which resize handles a selection's primitive gets, per `sizeFields`'
 *  `SizeKind` (D-157's own doc comment on that type has the full per-shape
 *  reasoning): `'w-only'` (text) gets just the width edge, `'scalar'`
 *  (matrix — one field drives both axes) gets just the corner, everything
 *  else gets all three so width and height are each independently
 *  adjustable AND a corner still moves both together. */
function handlesForUse(use: string | undefined): HandleId[] {
  if (!use) return [];
  const kind = sizeFields(use);
  if (!kind) return [];
  if (kind.kind === 'w-only') return ['e'];
  if (kind.kind === 'scalar') return ['se'];
  return ['e', 's', 'se'];
}

const HANDLE_SIZE = 10;
const HANDLE_HIT_SLOP = 6;
const HANDLE_HIT = HANDLE_SIZE + HANDLE_HIT_SLOP * 2;

const HANDLE_CURSOR: Record<HandleId, string> = {
  e: 'ew-resize',
  s: 'ns-resize',
  se: 'nwse-resize',
};

/** Reads the `id` (D-158) a manifest's layer at `sceneIndex.index` carries,
 *  if any — used whenever this overlay builds a `Selection` from a raw
 *  `data-motion-layer` attribute (click, marquee), so a canvas-made
 *  selection is just as identity-stable as one made any other way. */
function layerIdAt(manifest: Manifest | null, sceneIndex: number, index: number): string | undefined {
  return manifest?.scenes[sceneIndex]?.layers?.[index]?.id;
}

export function MotionCanvasOverlay({
  containerRef,
  playerRef,
  manifest,
  selections,
  onSelect,
  onSelectionChange,
  onTransientChange,
  onCommit,
}: {
  /** the div wrapping BOTH `<Player>` and this overlay (`MotionPreview.tsx`)
   *  — measured for container-local outline coordinates, and the element
   *  native pointer listeners attach to (see the module doc comment). */
  containerRef: RefObject<HTMLElement | null>;
  playerRef: RefObject<PlayerRef | null>;
  /** the STABLE, already-committed manifest — NEVER the Phase 0b transient
   *  override — see the module doc comment's "why not re-measure mid-drag." */
  manifest: Manifest | null;
  /** D-158: the whole live selection — see `LayerList.tsx`'s own doc
   *  comment for the same-kind/same-scene constraint this array upholds. */
  selections: Selection[];
  /** replace the WHOLE selection with just `s` (and seek the player to its
   *  scene) — a plain click on a layer not already part of a multi-selection,
   *  or a `LayerList` row click. */
  onSelect: (s: Selection) => void;
  /** D-158: set the WHOLE selection array directly, no seek — shift-toggle,
   *  a completed marquee, or clearing the selection on an empty sub-threshold
   *  click. Always the currently-visible scene's layers (per §1e, only one
   *  scene is ever mounted), so there is nothing to seek to. */
  onSelectionChange: (s: Selection[]) => void;
  /** 0b: set during a drag (feeds `<Player inputProps>` live), `null` to clear it. */
  onTransientChange: (next: Manifest | null) => void;
  /** 0c: one commit on pointer-up, through `useMotionManifest`'s undo-wired `commit`. */
  onCommit: (next: Manifest, label: string) => void;
}) {
  const dragRef = useRef<DragState | null>(null);
  // D-157: the single-selection outline + resize handles (unchanged pixel/
  // logic path from before D-158 — a single `{kind:'layer'}` selection still
  // renders exactly as it always did).
  const [box, setBox] = useState<RectLike | null>(null);
  // D-158: plain outlines (no handles) for a 2+ multi-selection.
  const [multiBoxes, setMultiBoxes] = useState<RectLike[]>([]);
  // D-158: the marquee band while a marquee drag is in flight, container-local.
  const [marqueeRect, setMarqueeRect] = useState<RectLike | null>(null);

  // The drawn selection outline(s) — the union of each selected layer's
  // `[data-motion-box]` descendants (research doc §3b), via the shared
  // `layerMeasure.ts` helper (also used by the "snap to layer" action in
  // `MotionTab.tsx`/`InspectorPanel.tsx`, D-157). Single selection keeps the
  // exact D-156/D-157 code path (handles included); 2+ selections (always
  // all `{kind:'layer'}`, per `LayerList.tsx`'s own constraint) get one
  // outline each, no handles (D-158 doesn't scope group resize).
  const recomputeBoxes = useCallback(() => {
    const container = containerRef.current;
    if (!container) {
      setBox(null);
      setMultiBoxes([]);
      return;
    }
    const first = selections.length === 1 ? selections[0] : null;
    if (first && first.target.kind === 'layer') {
      const union = measureLayerScreenBox(container, first.sceneIndex, first.target.index);
      setBox(union ? toContainerLocal(union, container.getBoundingClientRect()) : null);
      setMultiBoxes([]);
      return;
    }
    // D-182 — ONE card's own box, never a union (unlike the whole-layer
    // case above): the entire point of a `layer-item` selection is
    // outlining/dragging ONE card independent of its siblings.
    if (first && first.target.kind === 'layer-item') {
      const rect = measureLayerItemScreenBox(container, first.sceneIndex, first.target.index, first.target.itemIndex);
      setBox(rect ? toContainerLocal(rect, container.getBoundingClientRect()) : null);
      setMultiBoxes([]);
      return;
    }
    setBox(null);
    if (selections.length < 2) {
      setMultiBoxes([]);
      return;
    }
    const containerRect = container.getBoundingClientRect();
    const boxes: RectLike[] = [];
    for (const sel of selections) {
      if (sel.target.kind !== 'layer') continue;
      const union = measureLayerScreenBox(container, sel.sceneIndex, sel.target.index);
      if (union) boxes.push(toContainerLocal(union, containerRect));
    }
    setMultiBoxes(boxes);
  }, [containerRef, selections]);

  useEffect(() => {
    recomputeBoxes();
  }, [recomputeBoxes]);

  // Re-measure whenever the picture might have moved — a camera animating
  // under the current selection (`frameupdate`) or the player's own
  // fit-scale changing (a resized pane, `scalechange`). Both events are
  // already exposed by `PlayerRef` (research doc §1d) — no rAF loop needed.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.addEventListener('frameupdate', recomputeBoxes);
    player.addEventListener('scalechange', recomputeBoxes);
    return () => {
      player.removeEventListener('frameupdate', recomputeBoxes);
      player.removeEventListener('scalechange', recomputeBoxes);
    };
  }, [playerRef, recomputeBoxes]);

  // Escape cancels an in-flight drag, resize, OR marquee (D-158 extends the
  // existing D-156/D-157 cancel path to the third gesture) — reverts to the
  // pre-drag state, no commit. A single always-mounted listener reading
  // `dragRef` on demand, rather than one added/removed per drag: simpler,
  // and there is nothing to clean up between drags either way. A marquee
  // never touched `onTransientChange` in the first place (selection isn't a
  // manifest edit), so clearing it here is a harmless no-op for that case —
  // only clearing the drawn band actually matters.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      containerRef.current?.releasePointerCapture(drag.pointerId);
      onTransientChange(null);
      setMarqueeRect(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [containerRef, onTransientChange]);

  // Click-to-select + drag + resize + marquee — native listeners on
  // `containerRef`, not this component's own JSX (see the module doc
  // comment for why).
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const findLayer = (clientX: number, clientY: number): Element | null => {
      for (const el of document.elementsFromPoint(clientX, clientY)) {
        const layerEl = el.closest('[data-motion-layer]');
        if (layerEl) return layerEl;
      }
      return null;
    };

    /** D-182 (Phase 3 of 3) — a card within a `layers` primitive.
     *  `data-motion-item-index` (`Layers.tsx`) alone only says "which card
     *  in ITS OWN stack" — the enclosing `[data-motion-layer]` (already
     *  written by `Video.tsx` around the WHOLE `Layers` component, an
     *  ancestor of every card it renders) supplies the `sceneIndex.
     *  layerIndex` half of the address, so no new prop had to be threaded
     *  into the primitive itself to make a card individually addressable. */
    const findLayerItem = (clientX: number, clientY: number): { layerEl: Element; itemIndex: number } | null => {
      for (const el of document.elementsFromPoint(clientX, clientY)) {
        const itemEl = el.closest('[data-motion-item-index]');
        if (!itemEl) continue;
        const layerEl = itemEl.closest('[data-motion-layer]');
        const itemIndexAttr = itemEl.getAttribute('data-motion-item-index');
        if (layerEl && itemIndexAttr !== null) return { layerEl, itemIndex: Number(itemIndexAttr) };
      }
      return null;
    };

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;

      // 0 (D-181/found live during D-182's own testing). `e.target` — NOT
      // `elementsFromPoint`, which is exactly the bug this guards against —
      // is inside the solo-scene transport (`MotionPreview.tsx`'s
      // `data-motion-transport`)? Bail before ANY hit-testing below. Every
      // check from here on (`findLayer`/`findLayerItem`) walks the WHOLE
      // `elementsFromPoint` stack at a point looking for a match, not just
      // the topmost element — deliberately, so a click through a
      // `display:contents` wrapper (`data-motion-layer`'s own wrapper,
      // `Video.tsx`) still resolves. That same breadth means a click on an
      // OPAQUE sibling positioned on top of the canvas (the transport bar)
      // would otherwise "see through" it to whatever canvas layer happens
      // to render behind that exact pixel — found live: clicking the
      // transport's own scrubber silently selected-and-dragged the WHOLE
      // `layers` stack underneath it. `e.target` reflects real pointer-
      // events/stacking (unlike `elementsFromPoint`), so it's the right
      // check for "was the ACTUAL click target our own chrome."
      if ((e.target as Element | null)?.closest?.('[data-motion-transport]')) return;

      // 1. A resize handle (D-157) — checked FIRST, since it's rendered by
      // this same overlay on top of the canvas and must never fall through
      // to the click-to-select/move logic below. Single-selection only.
      const handleAttr = (e.target as Element | null)
        ?.closest?.('[data-motion-resize-handle]')
        ?.getAttribute('data-motion-resize-handle') as HandleId | null | undefined;
      if (handleAttr && selections.length === 1 && selections[0].target.kind === 'layer' && manifest) {
        const selection = selections[0];
        const startSize = layerWorldSize(manifest, selection);
        const worldEl = findWorldElement(container);
        if (!startSize || !worldEl) return;
        e.preventDefault();
        container.setPointerCapture(e.pointerId);
        dragRef.current = {
          kind: 'resize',
          handle: handleAttr,
          pointerId: e.pointerId,
          selection,
          map: measureWorldMap(worldEl.getBoundingClientRect(), manifest.width),
          start: { x: e.clientX, y: e.clientY },
          startSize,
        };
        return;
      }

      // 1.5 (D-182). A CARD within a `layers` primitive — checked BEFORE
      // the whole-layer hit below, so clicking a card selects the card, not
      // the whole stack; clicking anywhere else on the stack still falls
      // through unchanged. Single-select only (no shift-toggle/group-move
      // for cards yet — the "expose these compositions" ask was "let me fix
      // ONE overlapping card," not multi-card editing), and no resize
      // handles ever render for a `layer-item` selection (`handlesForUse`
      // below is only ever consulted for `{kind:'layer'}`), so there's
      // nothing else for this branch to check first.
      const itemHit = findLayerItem(e.clientX, e.clientY);
      if (itemHit) {
        const attr = itemHit.layerEl.getAttribute('data-motion-layer');
        if (!attr) return;
        const [sceneIndexStr, indexStr] = attr.split('.');
        const sceneIndex = Number(sceneIndexStr);
        const index = Number(indexStr);
        const sel: Selection = { sceneIndex, target: { kind: 'layer-item', index, itemIndex: itemHit.itemIndex } };
        onSelect(sel);

        if (!manifest) return; // selected, but nothing to compute a drag against yet
        const worldEl = findWorldElement(container);
        const item = selectedLayerItem(manifest, sel);
        if (!worldEl || !item) return;
        e.preventDefault();
        container.setPointerCapture(e.pointerId);
        dragRef.current = {
          kind: 'move-item',
          pointerId: e.pointerId,
          selection: sel,
          map: measureWorldMap(worldEl.getBoundingClientRect(), manifest.width),
          start: { x: e.clientX, y: e.clientY },
          baseDx: item.dx ?? 0,
          baseDy: item.dy ?? 0,
        };
        return;
      }

      // 2. A layer hit (D-156, extended for D-158's shift-toggle + group move).
      const layerEl = findLayer(e.clientX, e.clientY);
      if (layerEl) {
        const attr = layerEl.getAttribute('data-motion-layer');
        if (!attr) return;
        const [sceneIndexStr, indexStr] = attr.split('.');
        const sceneIndex = Number(sceneIndexStr);
        const index = Number(indexStr);
        const sel: Selection = {
          sceneIndex,
          target: { kind: 'layer', index, id: layerIdAt(manifest, sceneIndex, index) },
        };

        if (e.shiftKey) {
          // Shift-click toggles membership and never starts a drag of its
          // own gesture (research doc §4 Phase 3: "shift-click to extend") —
          // a deliberate, documented design call: the user is building a
          // selection, not also relocating it in the same motion. Dragging
          // the resulting group is a SEPARATE, subsequent click-and-drag.
          onSelectionChange(toggleSelection(selections, sel));
          return;
        }

        // Clicking a layer that's ALREADY part of a live multi-selection
        // (without shift) keeps the WHOLE group selected and drags all of
        // it — the standard "click inside an existing multi-selection moves
        // the group" convention (Figma/Illustrator/Premiere all do this).
        // Clicking anything else replaces the selection with just that one
        // layer, exactly as Phase 1 always did.
        const alreadyInGroup = selections.length > 1 && selections.some((s) => sameSelection(s, sel));
        const activeSelections = alreadyInGroup ? selections : [sel];
        if (!alreadyInGroup) onSelect(sel);

        if (!manifest) return; // selected, but nothing to compute a drag against yet
        const worldEl = findWorldElement(container);
        if (!worldEl) return;
        // D-159: the playhead frame this drag's keyframed entries (if any)
        // write to — captured ONCE here, before any move happens, same as
        // `map` below (a canvas drag doesn't move the playhead).
        const currentFrame = playerRef.current?.getCurrentFrame() ?? 0;
        const atSeconds = currentFrame / manifest.fps;
        const moves = activeSelections.reduce<
          { selection: Selection; base: { x: number; y: number }; keyed: boolean }[]
        >((acc, s) => {
          const dragBase = layerDragBase(manifest, s, currentFrame, manifest.fps);
          if (dragBase) acc.push({ selection: s, base: dragBase.base, keyed: dragBase.keyed });
          return acc;
        }, []);
        if (moves.length === 0) return; // nothing draggable in the group (e.g. a lone `graph`)

        e.preventDefault();
        container.setPointerCapture(e.pointerId);
        dragRef.current = {
          kind: 'move',
          pointerId: e.pointerId,
          moves,
          map: measureWorldMap(worldEl.getBoundingClientRect(), manifest.width),
          start: { x: e.clientX, y: e.clientY },
          atSeconds,
        };
        return;
      }

      // 3. Not a handle, not a layer — is it truly empty canvas SPACE
      // INSIDE the composition, or is it Remotion's own chrome (the control
      // bar, letterboxing)? Structural containment, not a class-name guess
      // (D-137's discipline — see the module doc comment for why a class
      // list doesn't transfer to this component).
      const insideWorld = (e.target as Element | null)?.closest?.('[data-motion-world]');
      if (!insideWorld) return; // Remotion's own controls — untouched, as before D-158

      e.preventDefault();
      container.setPointerCapture(e.pointerId);
      dragRef.current = {
        kind: 'marquee',
        pointerId: e.pointerId,
        additive: e.shiftKey || e.metaKey || e.ctrlKey,
        baseSelections: selections,
        start: { x: e.clientX, y: e.clientY },
      };
    };

    // A resize handle's own axis mask: `'e'` only ever changes width, `'s'`
    // only ever changes height, `'se'` changes both — Shift is NOT wired to
    // resize (axis-lock is a move-drag convention, research doc §3c; a
    // single-axis handle is already axis-locked by construction).
    const nextSize = (drag: Extract<DragState, { kind: 'resize' }>, e: PointerEvent) => {
      const delta = worldDelta(drag.map, { x: e.clientX - drag.start.x, y: e.clientY - drag.start.y });
      const dw = drag.handle === 's' ? 0 : delta.x;
      const dh = drag.handle === 'e' ? 0 : delta.y;
      // `startSize.h` is `null` for a `'w-only'` primitive (text) — only an
      // `'e'` handle is ever offered for one (`handlesForUse`), so `dh` is
      // always 0 in that case and this fallback value is never actually
      // written anywhere (`setLayerSize`'s `'w-only'` branch ignores `h`).
      return { w: drag.startSize.w + dw, h: (drag.startSize.h ?? drag.startSize.w) + dh };
    };

    // D-158: the shared world-space delta EVERY selected layer in a 'move'
    // gesture moves by — a single-selection move is `applyMoveDelta` with a
    // `moves` array of length 1, not a separately maintained code path.
    const moveDelta = (drag: Extract<DragState, { kind: 'move' }>, e: PointerEvent) => {
      let delta = worldDelta(drag.map, { x: e.clientX - drag.start.x, y: e.clientY - drag.start.y });
      if (e.shiftKey) delta = axisLock(delta);
      return delta;
    };

    // D-182 — the SAME world-space delta math `moveDelta` above uses (a
    // card's own `dx`/`dy` are already pixel offsets, the exact unit
    // `worldDelta` already produces — no unit conversion needed), just
    // scoped to one card instead of a `moves[]` list.
    const moveItemDelta = (drag: Extract<DragState, { kind: 'move-item' }>, e: PointerEvent) => {
      let delta = worldDelta(drag.map, { x: e.clientX - drag.start.x, y: e.clientY - drag.start.y });
      if (e.shiftKey) delta = axisLock(delta);
      return delta;
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;

      if (drag.kind === 'marquee') {
        const rect = rectFromPoints(drag.start, { x: e.clientX, y: e.clientY });
        setMarqueeRect(toContainerLocal(rect, container.getBoundingClientRect()));
        return;
      }

      if (!manifest) return;
      if (drag.kind === 'move') {
        const d = moveDelta(drag, e);
        onTransientChange(moveLayersByDeltaAutoKey(manifest, drag.moves, d.x, d.y, drag.atSeconds, manifest.fps));
      } else if (drag.kind === 'move-item') {
        const d = moveItemDelta(drag, e);
        onTransientChange(setLayerItemOffset(manifest, drag.selection, drag.baseDx + d.x, drag.baseDy + d.y));
      } else {
        const s = nextSize(drag, e);
        onTransientChange(setLayerSize(manifest, drag.selection, s.w, s.h));
      }
      // D-176 — `onTransientChange` re-renders `<Player inputProps>` with
      // the new (in-flight) manifest, which really does move/resize the
      // primitive's own real DOM element — but `box`/`multiBoxes` (this
      // component's own drawn outline) is a snapshot in React state that
      // was never told to look again: `recomputeBoxes` only re-runs on a
      // `selections` change or a `frameupdate`/`scalechange` player event
      // (this file's own earlier comment: "no rAF loop needed" — true for
      // those triggers, NOT for a transient-manifest-driven DOM change,
      // which is neither). Net effect before this fix: the outline stayed
      // frozen at its PRE-drag size/position for the whole gesture while
      // the actual content visibly moved/resized underneath it — exactly
      // what the owner saw and reported. One `requestAnimationFrame` per
      // pointermove (not a continuous loop) gives the just-triggered
      // re-render one paint to land, then re-measures the NOW-current DOM
      // — the same one-shot-per-gesture-step cost this file already pays
      // for a marquee's own per-frame `setMarqueeRect` call, not a new
      // class of overhead.
      requestAnimationFrame(recomputeBoxes);
    };

    const onPointerUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      container.releasePointerCapture(e.pointerId);

      if (drag.kind === 'marquee') {
        setMarqueeRect(null);
        const distance = Math.hypot(e.clientX - drag.start.x, e.clientY - drag.start.y);
        if (distance < MARQUEE_MIN_DRAG_PX) {
          // A plain click on empty canvas (never a drag at all) clears the
          // selection — standard "click away to deselect." A modifier-held
          // sub-threshold press arms nothing, matching D-137's own rule for
          // its timeline marquee: a press that never became a real gesture
          // shouldn't silently clear whatever the user already had selected
          // via some other means.
          if (!drag.additive) onSelectionChange([]);
          return;
        }
        const marqueeScreenRect = rectFromPoints(drag.start, { x: e.clientX, y: e.clientY });
        const hits: Selection[] = [];
        container.querySelectorAll('[data-motion-layer]').forEach((el) => {
          const attr = el.getAttribute('data-motion-layer');
          if (!attr) return;
          const [sceneIndexStr, indexStr] = attr.split('.');
          const sceneIndex = Number(sceneIndexStr);
          const index = Number(indexStr);
          const layerBox = measureLayerScreenBox(container, sceneIndex, index);
          if (layerBox && rectsIntersect(marqueeScreenRect, layerBox)) {
            hits.push({ sceneIndex, target: { kind: 'layer', index, id: layerIdAt(manifest, sceneIndex, index) } });
          }
        });
        if (drag.additive) {
          const merged = [...drag.baseSelections];
          for (const h of hits) if (!merged.some((s) => sameSelection(s, h))) merged.push(h);
          onSelectionChange(merged);
        } else {
          onSelectionChange(hits);
        }
        return;
      }

      onTransientChange(null);
      if (!manifest) return;
      if (drag.kind === 'move') {
        const d = moveDelta(drag, e);
        const anyKeyed = drag.moves.some((m) => m.keyed);
        const label =
          drag.moves.length > 1
            ? anyKeyed
              ? 'Move layers (keyframe)'
              : 'Move layers'
            : anyKeyed
              ? 'Move layer (keyframe)'
              : 'Move layer';
        onCommit(moveLayersByDeltaAutoKey(manifest, drag.moves, d.x, d.y, drag.atSeconds, manifest.fps), label);
      } else if (drag.kind === 'move-item') {
        const d = moveItemDelta(drag, e);
        onCommit(setLayerItemOffset(manifest, drag.selection, drag.baseDx + d.x, drag.baseDy + d.y), 'Move card');
      } else {
        const s = nextSize(drag, e);
        onCommit(setLayerSize(manifest, drag.selection, s.w, s.h), 'Resize layer');
      }
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
    };
  }, [containerRef, playerRef, manifest, selections, onSelect, onSelectionChange, onTransientChange, onCommit, recomputeBoxes]);

  const selectedUse =
    manifest && selections.length === 1 && selections[0].target.kind === 'layer'
      ? selectedLayer(manifest, selections[0])?.use
      : undefined;
  const handles = box ? handlesForUse(selectedUse) : [];

  return (
    <div className="absolute inset-0 pointer-events-none" data-motion-canvas-overlay>
      {box && (
        <div
          className="absolute border-2 border-accent"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height, boxSizing: 'border-box' }}
        >
          {handles.map((h) => {
            // Screen position of each handle, relative to the box's own
            // top-left (this div IS the box, positioned via `left`/`top`
            // above, so handle coordinates here are box-local, not
            // container-local): `'e'` at the right edge's vertical middle,
            // `'s'` at the bottom edge's horizontal middle, `'se'` at the
            // bottom-right corner.
            const left = h === 's' ? box.width / 2 : box.width;
            const top = h === 'e' ? box.height / 2 : box.height;
            return (
              <div
                key={h}
                data-motion-resize-handle={h}
                className="absolute pointer-events-auto flex items-center justify-center"
                style={{
                  left,
                  top,
                  width: HANDLE_HIT,
                  height: HANDLE_HIT,
                  transform: 'translate(-50%, -50%)',
                  cursor: HANDLE_CURSOR[h],
                }}
              >
                <div
                  className="rounded-sm border border-accent bg-bg-primary"
                  style={{ width: HANDLE_SIZE, height: HANDLE_SIZE }}
                />
              </div>
            );
          })}
        </div>
      )}
      {/* D-158: a 2+ multi-selection draws one plain (handle-less) outline
          per selected layer, dashed to read as visually distinct from the
          single-selection solid box + handles above. */}
      {multiBoxes.map((b, i) => (
        <div
          key={i}
          className="absolute border-2 border-dashed border-accent"
          style={{ left: b.left, top: b.top, width: b.width, height: b.height, boxSizing: 'border-box' }}
        />
      ))}
      {/* D-158: the marquee band itself, while a marquee drag is in flight. */}
      {marqueeRect && (
        <div
          className="absolute border border-accent bg-accent/10"
          style={{
            left: marqueeRect.left,
            top: marqueeRect.top,
            width: marqueeRect.width,
            height: marqueeRect.height,
            boxSizing: 'border-box',
          }}
        />
      )}
    </div>
  );
}
