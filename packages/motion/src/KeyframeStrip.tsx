/**
 * @chroma/motion — Phase 5a of `docs/notes/motion-keyframe-timeline-research.md`
 * (D-160). A small, read-only strip rendered under the live player showing
 * WHERE keyframes are and where the playhead is, plus click-to-seek — the
 * visual-builder research doc's own "deliberately cheaper intermediate" for
 * a real keyframe timeline (Phase 5b, not attempted here — see that doc's
 * §4 and the new doc's own §3/§4 for the full scoping and why this is a
 * separate component rather than a literal modification of the player's own
 * scrub bar).
 *
 * **Why this is a component next to `<Player>`, not inside it.** Checked
 * directly this pass: `@remotion/player`'s bundled `PlayerControls.js` has
 * no extension point for injecting markers into its own scrub bar, and
 * `<Player controls>` is a single boolean toggle for the whole built-in bar,
 * not a slot system. Building "the player's own scrubber gains markers" as
 * literally worded would mean forking Remotion's controls or replacing them
 * outright with a fully custom transport bar — real, but most of a whole
 * timeline's own chrome, which is exactly the scope this phase is trying
 * NOT to build yet. This component gets the same INTENT (see keyframes,
 * jump between them, scrub coupled to the player) through a smaller,
 * lower-risk mechanism instead.
 *
 * **D-16x, Phase 5b of the same research doc ("drag a key along time"):**
 * a marker can now be DRAGGED to retime it — `onTransientChange`/`onCommit`
 * (both optional; drag-to-retime is only wired up when BOTH are supplied,
 * matching this file's own "still useful with none of this wired" floor —
 * a caller with neither still gets Phase 5a's plain click-to-seek) mirror
 * `MotionCanvasOverlay.tsx`'s own D-155/D-156 transient-preview/commit
 * discipline applied to a 1D time axis instead of a 2D canvas: pointermove
 * feeds a live manifest override through `onTransientChange` (so the player
 * shows the retimed key's effect immediately), pointerup commits ONCE
 * through `onCommit` (D-155's undo-wired `commit(next, label)`), Escape
 * cancels. The three write primitives this drives —
 * `moveCamera2dKeyAt`/`moveCamera3dKeyAt`/`moveLayerTransformKeyAt`
 * (`manifestEdit.ts`) — are always recomputed from the STABLE `manifest`
 * plus the CURRENT pointer position, never from a previous pointermove's
 * own transient output, the same "recompute from a stable base every time"
 * discipline every other drag primitive in this package already follows.
 *
 * **Gesture disambiguation (D-137/D-158's discipline, a third application):**
 * a marker `<button>`'s own `onPointerDown` starts a POTENTIAL key-drag;
 * the bare strip background keeps its existing `onClick`-to-seek
 * (Phase 5a, unchanged) — determined structurally by WHICH ELEMENT was hit
 * (a marker vs. the strip's own background div), not by an ad-hoc priority
 * check. A marker's own `onClick` always `stopPropagation`s (so the
 * background's seek-on-click never ALSO fires for a marker interaction,
 * drag or not) but only performs its OWN seek when the strip isn't
 * drag-capable — when it is, seek-vs-retime is resolved by
 * `onPointerUp` alone, gated by a real movement threshold
 * (`KEY_DRAG_MIN_PX`, the same "4px" bar `MotionCanvasOverlay.tsx`'s own
 * marquee uses): a sub-threshold press is a plain click (seek to the key's
 * own frame, matching Phase 5a exactly — no regression), a real drag
 * commits a retime instead. This mirrors the marquee's own reason for
 * needing an explicit distance check (D-158's own doc comment) rather than
 * the plain move/resize drags' "no threshold, `commit`'s own no-op-diff
 * guard absorbs a zero-delta press" shape: unlike a layer move (where
 * "select" and "maybe also drag" are compatible outcomes of the same
 * gesture), a keyframe marker's click and drag are two MUTUALLY EXCLUSIVE
 * meanings (seek vs. retime) that must not both fire.
 *
 * **Live visual feedback without touching marker identity mid-drag.** The
 * dragged marker's OWN rendered position follows the pointer via a small
 * local `dragPreview` override (matched by `{kind, sceneIndex, keyIndex}`,
 * never by array position) rather than by re-deriving the WHOLE marker list
 * from a transient manifest. Deliberate: `moveCamera2dKeyAt`/
 * `moveCamera3dKeyAt`/`moveLayerTransformKeyAt` (Phase 5b, `manifestEdit.ts`)
 * can REORDER a key's array position when a drag crosses a neighbor — if
 * marker `<button>` elements were keyed by array position (or by
 * `keyIndex`, which can also shift once a reorder happens) and the marker
 * list were recomputed from a live-mutating transient manifest DURING the
 * very gesture that's dragging one of those same buttons, the dragged
 * button's own React key could change mid-drag, React would unmount/
 * remount it, and the in-flight `setPointerCapture` on the OLD (now
 * removed) DOM node would be lost — silently ending the drag partway
 * through. Keeping the rendered marker LIST derived from the STABLE
 * `manifest` (unchanged for the whole gesture — only `onTransientChange`'s
 * argument, which feeds the PLAYER, ever reflects the in-flight reorder)
 * sidesteps this entirely: every marker's `{kind, sceneIndex, keyIndex}`
 * identity — and therefore its DOM element — is fixed for the life of the
 * gesture, and `dragPreview` is a pure visual overlay on top of that fixed
 * identity. A real, disclosed consequence: a live drag that crosses a
 * neighbor shows the crossed-over neighbor marker STAYING PUT at its own
 * unchanged frame (rather than visually swapping) until the drag commits,
 * at which point the strip re-renders from the freshly-committed (and now
 * actually reordered) manifest — a one-frame "catch-up" on release, not a
 * continuous live swap. Judged the right trade for a first slice: the
 * ALTERNATIVE (identity-stable keys via a synthetic id threaded through the
 * reorder) is real, separable follow-up work, not a correctness bug in what
 * ships here.
 *
 * **Pure navigation-only interactions still need no commit discipline.**
 * Every click-to-seek path (background click, a non-draggable marker click,
 * a sub-threshold marker press) only ever calls `PlayerRef.seekTo(frame)` —
 * nothing to commit there, the same reason `LayerList`'s own row-click-to-
 * seek has never needed it either. All the frame/position math lives in the
 * pure, unit-tested `keyframeVisibility.ts` (Phase 5b adds `percentToFrame`,
 * the pointer-position→frame inverse of `frameToPercent`) and
 * `manifestEdit.ts` (the three `move*KeyAt` write primitives) — this file
 * is DOM/pointer wiring only, deliberately untested per this package's
 * established split (`MotionCanvasOverlay.tsx`'s own precedent: pure math
 * tested, the component wiring around it is not).
 *
 * Spans the WHOLE composition (every scene), not just the scene under the
 * playhead — reading a key's `at` needs no live DOM (unlike measuring where
 * a layer is actually drawn on screen), so there is no reason to restrict
 * this to what's currently mounted, unlike every canvas gesture in
 * `MotionCanvasOverlay.tsx`.
 */
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { totalFrames, sceneStartFrame } from '@chroma/motion-engine/src/engine/build';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';

import type { Selection } from './LayerList';
import {
  cameraKeyMarkers,
  selectedLayerKeyMarkers,
  sceneBoundaryFrames,
  frameToPercent,
  percentToFrame,
  type KeyMarker,
} from './keyframeVisibility';
import { moveCamera2dKeyAt, moveCamera3dKeyAt, moveLayerTransformKeyAt } from './manifestEdit';

const markerBase =
  'absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45';

/** Same physical-distance bar `MotionCanvasOverlay.tsx`'s own marquee uses
 *  (D-158, itself reused from D-137) — not imported (the two files have no
 *  shared "gesture threshold" module, and one duplicated numeric literal
 *  with a doc comment pointing at its own precedent is cheaper than adding
 *  one for a single shared constant). */
const KEY_DRAG_MIN_PX = 4;

/** In-flight key-drag state (Phase 5b) — a ref, not React state, for the
 *  same reason `MotionCanvasOverlay.tsx`'s own `DragState` is: a
 *  pointermove firing at display refresh rate has no business going
 *  through a re-render to read its own drag origin back. `marker` is the
 *  ORIGINAL marker captured at `pointerdown` (from the STABLE manifest,
 *  never re-read from a later, possibly-reordered transient list — see the
 *  module doc comment's "live visual feedback" section for why this
 *  matters). `layerSelection` is only meaningful for `marker.kind ===
 *  'layer'` — captured once, same as `MotionCanvasOverlay.tsx` captures its
 *  own drag-start snapshots, since a drag is a bounded gesture and the live
 *  selection doesn't change during one in practice. */
interface KeyDragState {
  pointerId: number;
  marker: KeyMarker;
  layerSelection: Selection | null;
  startClientX: number;
}

function labelForMarkerKind(kind: KeyMarker['kind']): string {
  switch (kind) {
    case 'camera':
      return 'Move camera keyframe';
    case 'scene3d-camera':
      return 'Move 3D camera keyframe';
    case 'layer':
      return 'Move layer keyframe';
  }
}

export function KeyframeStrip({
  manifest,
  selections,
  playerRef,
  onTransientChange,
  onCommit,
}: {
  /** `null` mirrors `MotionCanvasOverlay.tsx`'s own `manifest` prop — the
   *  caller (`MotionPreview.tsx`) may still hold a `null` STABLE manifest
   *  for an instant even while `shown` (transient-or-stable) is truthy;
   *  this component simply renders nothing rather than assuming non-null. */
  manifest: Manifest | null;
  selections: Selection[];
  playerRef: RefObject<PlayerRef | null>;
  /** Phase 5b — feeds a live retime preview to `<Player inputProps>` via
   *  the SAME mechanism `MotionCanvasOverlay.tsx`'s own move/resize drags
   *  already use (`MotionPreview.tsx`'s `transientManifest` prop, set from
   *  here through the identical setter). Optional, and required TOGETHER
   *  with `onCommit` below: omit both to keep this strip exactly Phase 5a's
   *  read-only navigation (a caller with no on-canvas editing wired up at
   *  all still gets a fully useful strip, just without the drag). */
  onTransientChange?: (next: Manifest | null) => void;
  /** Phase 5b — one commit per completed drag, through `useMotionManifest`'s
   *  undo-wired `commit(next, label)` (D-155's discipline), exactly like
   *  every other mutating gesture in this tab. */
  onCommit?: (next: Manifest, label: string) => void;
}) {
  const [frame, setFrame] = useState(() => playerRef.current?.getCurrentFrame() ?? 0);
  const containerRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<KeyDragState | null>(null);
  // The one dragged marker's LIVE position while a drag is in flight — see
  // the module doc comment's "live visual feedback" section for why this is
  // a targeted overlay keyed by `{kind, sceneIndex, keyIndex}` rather than
  // re-deriving the whole marker list from a transient manifest.
  const [dragPreview, setDragPreview] = useState<{
    kind: KeyMarker['kind'];
    sceneIndex: number;
    keyIndex: number;
    frame: number;
  } | null>(null);

  const draggable = Boolean(onTransientChange && onCommit);

  // Same event this package's own `MotionCanvasOverlay.tsx` already
  // subscribes to (`player.addEventListener('frameupdate', …)`) — the
  // playhead line below tracks it live, during both playback and scrubbing.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    setFrame(player.getCurrentFrame());
    const onFrameUpdate = (e: { detail: { frame: number } }) => setFrame(e.detail.frame);
    player.addEventListener('frameupdate', onFrameUpdate);
    return () => player.removeEventListener('frameupdate', onFrameUpdate);
  }, [playerRef]);

  // Escape cancels an in-flight key-drag — matches every other drag gesture
  // in this tab (D-156/157/158's own cancel path in `MotionCanvasOverlay.tsx`).
  // Unlike that file's own handler, this one does NOT explicitly
  // `releasePointerCapture`: there is no stable ref to "whichever marker
  // button currently holds capture" the way `MotionCanvasOverlay.tsx` has
  // its own always-present `containerRef` — clearing `dragRef.current` here
  // is enough, since the subsequent native `pointerup` (which still fires
  // on the capturing element regardless) finds `dragRef.current` already
  // `null` and does nothing; the browser releases capture on that same
  // `pointerup`/`pointercancel` exactly as it always does.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragPreview(null);
      onTransientChange?.(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onTransientChange]);

  if (!manifest) return <div className="h-6 shrink-0 border-t border-border-color bg-bg-secondary" />;

  const total = totalFrames(manifest);
  const boundaries = sceneBoundaryFrames(manifest);
  const cameraMarkers = cameraKeyMarkers(manifest);
  const layerMarkers = selectedLayerKeyMarkers(manifest, selections);
  // D-158's own "single layer selection" precedent — the only selection
  // shape `selectedLayerKeyMarkers` ever returns markers for, so it's also
  // the only shape a `kind:'layer'` marker's drag ever needs to write
  // through. Computed once per render, captured into `dragRef` at
  // `pointerdown` (drags are bounded, sub-second gestures — the live
  // selection isn't expected to change mid-drag, the same assumption every
  // other drag primitive in this package already makes about its own
  // drag-start snapshot).
  const activeLayerSelection =
    selections.length === 1 && selections[0].target.kind === 'layer' ? selections[0] : null;

  const isDragPreview = (m: KeyMarker) =>
    !!dragPreview &&
    dragPreview.kind === m.kind &&
    dragPreview.sceneIndex === m.sceneIndex &&
    dragPreview.keyIndex === m.keyIndex;

  const displayFrame = (m: KeyMarker) => (isDragPreview(m) ? dragPreview!.frame : m.frame);

  /** Pointer clientX -> absolute composition frame, via the strip's own
   *  measured width — `percentToFrame`'s whole reason to exist (Phase 5b).
   *  `null` only if the container isn't in the DOM (shouldn't happen while
   *  a drag it started is in flight, but defensive rather than assumed). */
  const frameFromClientX = (clientX: number): number | null => {
    const container = containerRef.current;
    if (!container) return null;
    const rect = container.getBoundingClientRect();
    const fraction = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    return percentToFrame(fraction * 100, total);
  };

  /** The manifest a key-drag WOULD produce if released/previewed at
   *  `absFrame` right now — always recomputed from the STABLE `manifest`
   *  captured in this render plus `drag`'s own drag-start snapshot, never
   *  from a previous call's own output (see the module doc comment). `null`
   *  only for a `'layer'` marker whose captured selection no longer applies
   *  (defensive; can't happen in practice since `activeLayerSelection` is
   *  what produced the marker in the first place). */
  const nextManifestForDrag = (drag: KeyDragState, absFrame: number): Manifest | null => {
    const atSeconds = (absFrame - sceneStartFrame(manifest, drag.marker.sceneIndex)) / manifest.fps;
    if (drag.marker.kind === 'camera') {
      return moveCamera2dKeyAt(manifest, drag.marker.sceneIndex, drag.marker.keyIndex, atSeconds);
    }
    if (drag.marker.kind === 'scene3d-camera') {
      return moveCamera3dKeyAt(manifest, drag.marker.sceneIndex, drag.marker.keyIndex, atSeconds);
    }
    if (drag.layerSelection) {
      return moveLayerTransformKeyAt(manifest, drag.layerSelection, drag.marker.keyIndex, atSeconds);
    }
    return null;
  };

  const seekToClientX = (clientX: number, rect: DOMRect) => {
    const fraction = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    playerRef.current?.seekTo(Math.round(fraction * total));
  };

  const handleMarkerPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, marker: KeyMarker) => {
    if (!draggable) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      marker,
      layerSelection: marker.kind === 'layer' ? activeLayerSelection : null,
      startClientX: e.clientX,
    };
  };

  const handleMarkerPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (Math.abs(e.clientX - drag.startClientX) < KEY_DRAG_MIN_PX) return; // not a real drag yet
    const absFrame = frameFromClientX(e.clientX);
    if (absFrame === null) return;
    setDragPreview({ kind: drag.marker.kind, sceneIndex: drag.marker.sceneIndex, keyIndex: drag.marker.keyIndex, frame: absFrame });
    const next = nextManifestForDrag(drag, absFrame);
    if (next) onTransientChange?.(next);
  };

  const handleMarkerPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragPreview(null);
    const moved = Math.abs(e.clientX - drag.startClientX) >= KEY_DRAG_MIN_PX;
    if (!moved) {
      // A plain click (no real drag) — Phase 5a's own behaviour, unchanged:
      // jump to the key's own (un-retimed) frame. Any transient preview a
      // sub-threshold wobble might already have produced never happened
      // (guarded by the same threshold in `handleMarkerPointerMove` above),
      // so there is nothing to clear here beyond the local `dragPreview`.
      playerRef.current?.seekTo(drag.marker.frame);
      return;
    }
    const absFrame = frameFromClientX(e.clientX);
    onTransientChange?.(null);
    if (absFrame === null) return;
    const next = nextManifestForDrag(drag, absFrame);
    if (next) onCommit?.(next, labelForMarkerKind(drag.marker.kind));
  };

  const markerHandlers = (m: KeyMarker) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => handleMarkerPointerDown(e, m),
    onPointerMove: handleMarkerPointerMove,
    onPointerUp: handleMarkerPointerUp,
  });

  return (
    <div
      ref={containerRef}
      className="relative h-6 shrink-0 border-t border-border-color bg-bg-secondary select-none"
      title="Click to seek — diamonds are keyframes"
      onClick={(e) => seekToClientX(e.clientX, e.currentTarget.getBoundingClientRect())}
    >
      {boundaries.map((f) => (
        <div
          key={`boundary-${f}`}
          className="absolute top-0 bottom-0 w-px bg-border-color"
          style={{ left: `${frameToPercent(f, total)}%` }}
        />
      ))}
      {cameraMarkers.map((m, i) => (
        <button
          key={`camera-${i}`}
          type="button"
          className={`${markerBase} border border-text-secondary bg-bg-primary ${draggable ? 'cursor-ew-resize' : 'cursor-pointer'}`}
          style={{ left: `${frameToPercent(displayFrame(m), total)}%` }}
          title={`${m.kind === 'scene3d-camera' ? '3D camera' : 'Camera'} key @ frame ${displayFrame(m)}${draggable ? ' — drag to retime' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!draggable) playerRef.current?.seekTo(m.frame);
          }}
          {...(draggable ? markerHandlers(m) : {})}
        />
      ))}
      {layerMarkers.map((m, i) => (
        <button
          key={`layer-${i}`}
          type="button"
          className={`${markerBase} border border-accent bg-accent ${draggable ? 'cursor-ew-resize' : 'cursor-pointer'}`}
          style={{ left: `${frameToPercent(displayFrame(m), total)}%` }}
          title={`Layer key @ frame ${displayFrame(m)}${draggable ? ' — drag to retime' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            if (!draggable) playerRef.current?.seekTo(m.frame);
          }}
          {...(draggable ? markerHandlers(m) : {})}
        />
      ))}
      <div
        className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent"
        style={{ left: `${frameToPercent(frame, total)}%` }}
      />
    </div>
  );
}
