/**
 * @chroma/motion — on-canvas select + drag (D-156, Phase 1 of
 * `docs/notes/motion-visual-builder-research.md`). The owner's original ask:
 * "i would like to drag and drop multiple elements and set position... a
 * visual builder for me" — this is the smallest genuinely useful slice of
 * it: select a layer on the canvas, drag it, nothing else (no resize, no
 * rotate, no multi-select, no keyframes, no `scene3d` — all explicitly
 * deferred, see the research doc §4).
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
 * `<div>` stays `pointer-events: none` throughout — purely a visual outline
 * — and the actual click/drag listeners are native `addEventListener`s on
 * `containerRef` (an ANCESTOR of both the `<Player>` and this overlay,
 * `MotionPreview.tsx`), which receive every pointer event via normal DOM
 * bubbling regardless of what got hit, without ever being the hit-test
 * target themselves — Remotion's own controls keep working untouched.
 *
 * **Coordinate math is 0d, not reinvented here.** A drag writes the
 * layer's WORLD `x`/`y` (`manifestEdit.ts`'s `setLayerPosition`), converted
 * from a screen-space pointer delta via `canvasGeometry.ts`'s
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
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';

import type { Selection } from './LayerList';
import { layerWorldPosition, setLayerPosition } from './manifestEdit';
import { measureWorldMap, worldDelta, unionRects, toContainerLocal, axisLock, type RectLike } from './canvasGeometry';

/** In-flight gesture state — local, uncommitted (0b). `null` when no drag is
 *  active. Kept in a ref, not state: a pointermove firing at display refresh
 *  rate has no business going through a re-render to read its own drag
 *  origin back. */
interface DragState {
  pointerId: number;
  selection: Selection;
  map: ReturnType<typeof measureWorldMap>;
  start: { x: number; y: number };
  startWorld: { x: number; y: number };
}

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
  // `[data-motion-box]` descendants (research doc §3b), falling back to its
  // first rendered child (the primitive's own root element) when none exist
  // (`graph` — an honest "whole canvas" outline, per §3b, not a bug).
  const recomputeBox = useCallback(() => {
    const container = containerRef.current;
    if (!container || !selection || selection.target.kind !== 'layer') {
      setBox(null);
      return;
    }
    const layerEl = container.querySelector(
      `[data-motion-layer="${selection.sceneIndex}.${selection.target.index}"]`,
    );
    if (!layerEl) {
      setBox(null);
      return;
    }
    const boxEls = layerEl.querySelectorAll('[data-motion-box]');
    const rects =
      boxEls.length > 0
        ? Array.from(boxEls).map((el) => el.getBoundingClientRect())
        : layerEl.firstElementChild
          ? [layerEl.firstElementChild.getBoundingClientRect()]
          : [];
    const union = unionRects(rects);
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

  // Escape cancels an in-flight drag (research doc §4 Phase 1) — reverts to
  // the pre-drag state, no commit. A single always-mounted listener reading
  // `dragRef` on demand, rather than one added/removed per drag: simpler,
  // and there is nothing to clean up between drags either way.
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

  // Click-to-select + drag — native listeners on `containerRef`, not this
  // component's own JSX (see the module doc comment for why).
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
      const worldEl = container.querySelector('[data-motion-world]');
      if (!worldEl) return;

      e.preventDefault();
      container.setPointerCapture(e.pointerId);
      dragRef.current = {
        pointerId: e.pointerId,
        selection: sel,
        map: measureWorldMap(worldEl.getBoundingClientRect(), manifest.width),
        start: { x: e.clientX, y: e.clientY },
        startWorld,
      };
    };

    const nextPosition = (drag: DragState, e: PointerEvent) => {
      let delta = worldDelta(drag.map, { x: e.clientX - drag.start.x, y: e.clientY - drag.start.y });
      if (e.shiftKey) delta = axisLock(delta);
      return { x: drag.startWorld.x + delta.x, y: drag.startWorld.y + delta.y };
    };

    const onPointerMove = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId || !manifest) return;
      const p = nextPosition(drag, e);
      onTransientChange(setLayerPosition(manifest, drag.selection, p.x, p.y));
    };

    const onPointerUp = (e: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      container.releasePointerCapture(e.pointerId);
      onTransientChange(null);
      if (!manifest) return;
      const p = nextPosition(drag, e);
      onCommit(setLayerPosition(manifest, drag.selection, p.x, p.y), 'Move layer');
    };

    container.addEventListener('pointerdown', onPointerDown);
    container.addEventListener('pointermove', onPointerMove);
    container.addEventListener('pointerup', onPointerUp);
    return () => {
      container.removeEventListener('pointerdown', onPointerDown);
      container.removeEventListener('pointermove', onPointerMove);
      container.removeEventListener('pointerup', onPointerUp);
    };
  }, [containerRef, manifest, onSelect, onTransientChange, onCommit]);

  return (
    <div className="absolute inset-0 pointer-events-none" data-motion-canvas-overlay>
      {box && (
        <div
          className="absolute border-2 border-accent"
          style={{ left: box.left, top: box.top, width: box.width, height: box.height, boxSizing: 'border-box' }}
        />
      )}
    </div>
  );
}
