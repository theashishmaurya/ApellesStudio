/**
 * @chroma/motion — on-canvas select + drag (D-156, Phase 1) + resize (D-157,
 * Phase 2) of `docs/notes/motion-visual-builder-research.md`. The owner's
 * original ask: "i would like to drag and drop multiple elements and set
 * position or change them size crop animation and all those things" — Phase
 * 1 shipped select+move; this pass adds resize handles for the primitives
 * that have a real rectangle (multi-select, rotate, keyframes and `scene3d`
 * manipulation all stay deferred — see the research doc §4).
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
 * the actual click/drag/resize listeners are native `addEventListener`s on
 * `containerRef` (an ANCESTOR of both the `<Player>` and this overlay,
 * `MotionPreview.tsx`), which receive every pointer event via normal DOM
 * bubbling regardless of what got hit, without ever being the hit-test
 * target themselves — Remotion's own controls keep working untouched. A
 * resize handle's pointerdown ALSO bubbles to this same container listener
 * (native bubbling reaches an ancestor's directly-attached listener before
 * React's own synthetic dispatch on the handle would even run one attached
 * there instead — this is why the handle is checked via
 * `[data-motion-resize-handle]` at the TOP of `onPointerDown`, not via a
 * separate React `onPointerDown` prop on the handle element).
 *
 * **Coordinate math is 0d, not reinvented here.** A drag writes the
 * layer's WORLD `x`/`y` (`manifestEdit.ts`'s `setLayerPosition`); a resize
 * writes its WORLD `w`/`h` (`setLayerSize`) — both converted from a
 * screen-space pointer delta via `canvasGeometry.ts`'s
 * `measureWorldMap`/`worldDelta` — "measure the live DOM, don't re-derive
 * the camera" (research doc §3a). The world map is re-measured at
 * drag-start and is NOT re-measured mid-drag: a drag is a bounded, sub-
 * second human gesture, and `manifest.width` never changes during one — the
 * one thing that WOULD invalidate a stale map (the camera itself moving
 * under the drag) doesn't happen either, since `manifest` here is the
 * STABLE, already-committed manifest, not the transient one this same
 * drag is writing into `<Player inputProps>` (0b) — the layer moves, the
 * camera doesn't, so the map measured once at pointerdown stays correct
 * for the whole gesture.
 *
 * **A known, documented gap (D-157):** if a layer ALSO carries the Phase 2
 * layer-transform wrapper (`schema.ts`'s `layerTransform` — `scale`/`rot`
 * set to something other than identity), this overlay's screen↔world map is
 * still measured off `[data-motion-world]` alone (the CAMERA's own
 * transform, per D-155 §3a) and does NOT additionally account for that
 * layer's own transform sitting between the camera and the primitive — a
 * drag or resize on such a layer will be slightly off. Fixing this would
 * mean measuring a PER-LAYER world map instead of one shared map per drag,
 * a real generalization out of scope for this pass (the transform wrapper
 * is brand new this same pass — nothing existing hits this today) — left
 * for whichever future phase actually needs to drag/resize a transformed
 * layer (see `docs/08-decisions.md`'s D-157 entry for the fuller writeup).
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';

import type { Selection } from './LayerList';
import { selectedLayer, layerWorldPosition, setLayerPosition, layerWorldSize, setLayerSize } from './manifestEdit';
import { measureWorldMap, worldDelta, unionRects, toContainerLocal, axisLock, type RectLike } from './canvasGeometry';
import { measureLayerScreenBox, findWorldElement } from './layerMeasure';
import { sizeFields } from './propCatalog';

/** Which edge/corner a resize handle drives — `'e'`/`'s'` change one axis
 *  independently, `'se'` changes both together. Which of the three a given
 *  selection actually gets is `handlesForUse` below, keyed off
 *  `propCatalog.ts`'s `sizeFields`. */
type HandleId = 'e' | 's' | 'se';

/** In-flight gesture state — local, uncommitted (0b). `null` when no drag is
 *  active. Kept in a ref, not state: a pointermove firing at display refresh
 *  rate has no business going through a re-render to read its own drag
 *  origin back. A discriminated union on `kind` — `'move'` (D-156) and
 *  `'resize'` (D-157) share the same pointerdown/move/up plumbing below but
 *  carry different starting snapshots (`startWorld` vs. `startSize`). */
type DragState =
  | {
      kind: 'move';
      pointerId: number;
      selection: Selection;
      map: ReturnType<typeof measureWorldMap>;
      start: { x: number; y: number };
      startWorld: { x: number; y: number };
    }
  | {
      kind: 'resize';
      handle: HandleId;
      pointerId: number;
      selection: Selection;
      map: ReturnType<typeof measureWorldMap>;
      start: { x: number; y: number };
      startSize: { w: number; h: number | null };
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

export function MotionCanvasOverlay({
  containerRef,
  playerRef,
  manifest,
  selection,
  onSelect,
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
  selection: Selection | null;
  onSelect: (s: Selection) => void;
  /** 0b: set during a drag (feeds `<Player inputProps>` live), `null` to clear it. */
  onTransientChange: (next: Manifest | null) => void;
  /** 0c: one commit on pointer-up, through `useMotionManifest`'s undo-wired `commit`. */
  onCommit: (next: Manifest, label: string) => void;
}) {
  const dragRef = useRef<DragState | null>(null);
  const [box, setBox] = useState<RectLike | null>(null);

  // The drawn selection outline — the union of the selected layer's
  // `[data-motion-box]` descendants (research doc §3b), via the shared
  // `layerMeasure.ts` helper (also used by the "snap to layer" action in
  // `MotionTab.tsx`/`InspectorPanel.tsx`, D-157).
  const recomputeBox = useCallback(() => {
    const container = containerRef.current;
    if (!container || !selection || selection.target.kind !== 'layer') {
      setBox(null);
      return;
    }
    const union = measureLayerScreenBox(container, selection.sceneIndex, selection.target.index);
    if (!union) {
      setBox(null);
      return;
    }
    setBox(toContainerLocal(union, container.getBoundingClientRect()));
  }, [containerRef, selection]);

  useEffect(() => {
    recomputeBox();
  }, [recomputeBox]);

  // Re-measure whenever the picture might have moved — a camera animating
  // under the current selection (`frameupdate`) or the player's own
  // fit-scale changing (a resized pane, `scalechange`). Both events are
  // already exposed by `PlayerRef` (research doc §1d) — no rAF loop needed.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    player.addEventListener('frameupdate', recomputeBox);
    player.addEventListener('scalechange', recomputeBox);
    return () => {
      player.removeEventListener('frameupdate', recomputeBox);
      player.removeEventListener('scalechange', recomputeBox);
    };
  }, [playerRef, recomputeBox]);

  // Escape cancels an in-flight drag OR resize (research doc §4 Phase 1) —
  // reverts to the pre-drag state, no commit. A single always-mounted
  // listener reading `dragRef` on demand, rather than one added/removed per
  // drag: simpler, and there is nothing to clean up between drags either
  // way. Generic across both `DragState` kinds — cancelling never needs to
  // know which one was in flight.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      const drag = dragRef.current;
      if (!drag) return;
      dragRef.current = null;
      containerRef.current?.releasePointerCapture(drag.pointerId);
      onTransientChange(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [containerRef, onTransientChange]);

  // Click-to-select + drag + resize — native listeners on `containerRef`,
  // not this component's own JSX (see the module doc comment for why).
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

    const onPointerDown = (e: PointerEvent) => {
      if (e.button !== 0) return;

      // A resize handle (D-157) — checked FIRST, since it's rendered by
      // this same overlay on top of the canvas and must never fall through
      // to the click-to-select/move logic below. See the module doc
      // comment for why this is a native-listener check rather than a
      // React `onPointerDown` on the handle element itself.
      const handleAttr = (e.target as Element | null)
        ?.closest?.('[data-motion-resize-handle]')
        ?.getAttribute('data-motion-resize-handle') as HandleId | null | undefined;
      if (handleAttr && selection && manifest) {
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

      const layerEl = findLayer(e.clientX, e.clientY);
      // No layer under the pointer — empty canvas, or (just as likely) one
      // of Remotion's own controls. Do nothing: no preventDefault, no
      // pointer capture, so whatever's really there handles the click.
      if (!layerEl) return;
      const attr = layerEl.getAttribute('data-motion-layer');
      if (!attr) return;
      const [sceneIndexStr, indexStr] = attr.split('.');
      const sel: Selection = {
        sceneIndex: Number(sceneIndexStr),
        target: { kind: 'layer', index: Number(indexStr) },
      };
      onSelect(sel);

      if (!manifest) return; // selected, but nothing to compute a drag against yet
      const startWorld = layerWorldPosition(manifest, sel);
      if (!startWorld) return; // selectable but not draggable (e.g. `graph`)
      const worldEl = findWorldElement(container);
      if (!worldEl) return;

      e.preventDefault();
      container.setPointerCapture(e.pointerId);
      dragRef.current = {
        kind: 'move',
        pointerId: e.pointerId,
        selection: sel,
        map: measureWorldMap(worldEl.getBoundingClientRect(), manifest.width),
        start: { x: e.clientX, y: e.clientY },
        startWorld,
      };
    };

    const nextPosition = (
      drag: Extract<DragState, { kind: 'move' }>,
      e: PointerEvent,
    ) => {
      let delta = worldDelta(drag.map, { x: e.clientX - drag.start.x, y: e.clientY - drag.start.y });
      if (e.shiftKey) delta = axisLock(delta);
      return { x: drag.startWorld.x + delta.x, y: drag.startWorld.y + delta.y };
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

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId || !manifest) return;
      if (drag.kind === 'move') {
        const p = nextPosition(drag, e);
        onTransientChange(setLayerPosition(manifest, drag.selection, p.x, p.y));
      } else {
        const s = nextSize(drag, e);
        onTransientChange(setLayerSize(manifest, drag.selection, s.w, s.h));
      }
    };

    const onPointerUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      container.releasePointerCapture(e.pointerId);
      onTransientChange(null);
      if (!manifest) return;
      if (drag.kind === 'move') {
        const p = nextPosition(drag, e);
        onCommit(setLayerPosition(manifest, drag.selection, p.x, p.y), 'Move layer');
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
  }, [containerRef, manifest, selection, onSelect, onTransientChange, onCommit]);

  const selectedUse =
    manifest && selection && selection.target.kind === 'layer'
      ? selectedLayer(manifest, selection)?.use
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
    </div>
  );
}
