/**
 * @chroma/motion — the layer list (D-081, Phase 1 of
 * `docs/notes/global-inspector.md`).
 *
 * The real prerequisite the Inspector scoping doc identified before any
 * property panel makes sense: something to select. This is a plain,
 * expand-per-scene list — scene → its 2D camera (if any) → its `layers[]`
 * (2D) or its `scene3d` camera + `children[]` (3D) — click any row to select
 * it and jump the player to that scene's start frame
 * (`sceneStartFrame`, `@chroma/motion-engine`'s `build.ts` — the exact same
 * math `<Series>` (`Video.tsx`) uses to lay scenes back to back, not a second
 * guess at it). No property panel consumes `Selection` yet (Phase 2,
 * deferred) — this pass is the selection model + a way to see/pick
 * something, standalone-useful on its own as real scene/layer navigation.
 *
 * Not `@chroma/ui`: see `Button.tsx`'s doc comment for why this package
 * can't use that barrel (a real, documented `@react-three/fiber` JSX-typing
 * conflict) — plain elements on the app's own `--color-*` tokens, matching
 * every other file here.
 *
 * **D-158, Phase 3 of `docs/notes/motion-visual-builder-research.md`:** the
 * thing every consumer holds is now `Selection[]`, not a single `Selection |
 * null` — "the owner said 'multiple elements' first, so this is not
 * optional polish." A real design call, made and documented rather than
 * left implicit: **`Selection[]` is constrained to either (a) exactly one
 * entry of ANY kind (`scene`/`camera`/`scene3d-camera`/`layer`/
 * `scene3d-child` — today's existing single-select, unchanged), or (b) two
 * or more entries that are ALL `{kind:'layer'}` in the SAME scene.** Mixed
 * kinds (a scene plus a layer, a camera plus a layer) and cross-scene
 * layer sets are never produced by anything in this package. Why: a
 * "scene + camera" or "two cameras" multi-selection has no coherent
 * meaning — there is exactly one camera per scene and editing "two things
 * that aren't really two things" is a UI a real user would find baffling,
 * not powerful; `scene3d-child` is excluded from multi-select because 3D
 * on-canvas manipulation is out of scope for every phase this research doc
 * covers (§3b/§4), so there is no canvas gesture that could ever produce
 * one anyway; and restricting to one scene is a hard requirement, not a
 * preference — only the scene currently under the playhead has its layers
 * in the DOM at all (§1e), so a marquee or a canvas shift-click physically
 * cannot reach a layer in a different scene. `toggleSelection` below is
 * where this constraint actually lives (the enforcement point, not just the
 * intent) — see its own doc comment. `MotionCanvasOverlay.tsx`'s doc
 * comment covers the drag/marquee side; `manifestEdit.ts`'s
 * `resolveSelection`/`resolveSelections` cover keeping the array pointing
 * at the right layers as the manifest changes under it.
 *
 * **D-160, Phase 5a of `docs/notes/motion-keyframe-timeline-research.md`
 * ("key visibility"):** every row that can carry keyframes (a layer with
 * `transform.keys`, a scene's 2D camera, a scene's 3D camera) now shows a
 * small trailing key-count badge — the visual-builder research doc's own
 * "deliberately cheaper intermediate" for a real keyframe timeline, taken
 * seriously as a real first slice rather than a lesser fallback. Counting
 * logic lives in `keyframeVisibility.ts` (pure, tested), not here.
 *
 * **D-176 — drag-to-reorder (owner, live: "cant resufle layers").** A layer
 * row (`{kind:'layer'}`) or a 3D-scene-child row (`{kind:'scene3d-child'}`)
 * can now be dragged up/down to reorder it — native `pointerdown`/
 * `pointermove`/`pointerup`, this whole package's own repeatedly-reaffirmed
 * convention (D-156/157/158/160/161/162/163), never a drag library. Scoped
 * exactly to `manifestEdit.ts`'s new `reorderLayers`: WITHIN one scene's
 * `layers[]`, or WITHIN one scene's `scene3d.children[]` — never across
 * scenes, and never bridging the two arrays within one scene (they render
 * through entirely different paths, `TwoD` vs `ThreeD`, B-065). A drag onto
 * a DIFFERENT scene's rows, or onto a scene/camera/3D-camera row, is simply
 * not a valid drop target (no indicator drawn, pointerup does nothing) —
 * never a silent corruption.
 *
 * **Gesture shape**, deliberately mirroring `KeyframeTimeline.tsx`'s own
 * marker drag (`handleMarkerPointerDown`/`Move`/`Up`) rather than inventing
 * a fourth variant of the same pattern in this package: `pointerdown` on a
 * row captures the pointer and remembers `fromIndex` (plus the row's own
 * `id`, for the sub-threshold "was actually just a click" fallback);
 * `pointermove` only ARMS the drag once the pointer has travelled
 * `LAYER_DRAG_MIN_PX` (4px — the exact same physical-distance bar
 * `MotionCanvasOverlay.tsx`'s `MARQUEE_MIN_DRAG_PX` and
 * `KeyframeTimeline.tsx`'s `KEY_DRAG_MIN_PX` already use, reused rather than
 * a fourth invented number), then finds which row is under the pointer via
 * `document.elementsFromPoint` + `.closest('[data-layer-row]')` — the SAME
 * DOM-attribute-lookup convention `MotionCanvasOverlay.tsx`'s own
 * `[data-motion-layer]` click/marquee hit-testing already established for
 * this package, reused here for a list instead of a canvas — and shows a
 * thin accent drop-line either above or below that row (whichever half of
 * its own height the pointer is over); `pointerup` below the threshold is a
 * plain click (`onSelect`, unchanged); at or past it, commits the reorder
 * through `onCommit` (`m.commit`, D-155 — real, undo-wired, matching every
 * other mutation this tab makes). Escape cancels an in-flight drag with no
 * mutation, matching `KeyframeTimeline.tsx`'s own precedent for the same key.
 *
 * **No live canvas preview during the drag** (unlike a canvas move-drag,
 * which feeds `onTransientChange` so the picture visibly follows the
 * pointer) — a reorder changes PAINT ORDER, not any layer's own geometry, so
 * there is nothing meaningful to preview in the `<Player>` mid-drag; the
 * list's own drop-line is the complete, honest feedback for this gesture.
 * `onCommit` is optional (this list stays a read-only navigator with nothing
 * wired, D-160's own floor) — when absent, rows fall back to their previous
 * plain `onClick`-only behaviour.
 */
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent } from 'react';
import { Plus } from 'lucide-react';
import type { Manifest, Layer } from '@chroma/motion-engine/src/engine/schema';
import { layerKeyCount, cameraKeyCount, scene3dCameraKeyCount } from './keyframeVisibility';
import { reorderLayers, addScene } from './manifestEdit';
import { LayerThumbnail } from './LayerThumbnail';
import type { MotionEditLink, MotionEditLinks } from './motionOps';

/**
 * `id` on the two layer-shaped target kinds is D-158 (Phase 3 of
 * `docs/notes/motion-visual-builder-research.md`, "stable layer identity" —
 * §1g's own finding). It is a SNAPSHOT of `schema.ts`'s new optional
 * `layer.id` field, captured when the selection was made — `undefined` for
 * a layer that has none (every hand-written manifest, and any manifest
 * written before this pass), which is the documented, non-breaking fallback
 * to positional identity `manifestEdit.ts`'s `resolveSelection` already
 * held before `id` existed and still holds when it's absent. `index` is
 * NEVER dropped even when `id` is present — it stays the best-known
 * position (used directly whenever `id` is absent, and as the starting
 * point `resolveSelection` corrects FROM when it IS present but the layer
 * has moved).
 */
export type SelectionTarget =
  | { kind: 'scene' }
  | { kind: 'camera' }
  | { kind: 'scene3d-camera' }
  | { kind: 'layer'; index: number; id?: string }
  | { kind: 'scene3d-child'; index: number; id?: string }
  /** D-182 (Phase 3 of 3) — one CARD within a `layers`-primitive layer:
   *  `index` is the layer's own index into `scene.layers[]` (same meaning as
   *  `{kind:'layer'}`'s `index`), `itemIndex` is the card's own position in
   *  that layer's `items[]`. No `id` — `LayerItem` (`Layers.tsx`) has no id
   *  field (nothing reorders cards today, unlike D-158's own `layer.id`
   *  motivation), so this is addressed by plain index, the same honest
   *  "doesn't survive a reorder" floor every other un-id'd target already
   *  holds. */
  | { kind: 'layer-item'; index: number; itemIndex: number };

export interface Selection {
  sceneIndex: number;
  target: SelectionTarget;
}

export function sameTarget(a: SelectionTarget, b: SelectionTarget): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === 'layer' && b.kind === 'layer') return a.index === b.index;
  if (a.kind === 'scene3d-child' && b.kind === 'scene3d-child') return a.index === b.index;
  if (a.kind === 'layer-item' && b.kind === 'layer-item') return a.index === b.index && a.itemIndex === b.itemIndex;
  return true;
}

/** Whole-`Selection` equality (scene + target) — the array-level building
 *  block `MotionCanvasOverlay.tsx`'s multi-select gestures and
 *  `manifestEdit.ts`'s `resolveSelections` both need, once a single
 *  `Selection` stopped being the whole story (D-158, Phase 3). */
export function sameSelection(a: Selection, b: Selection): boolean {
  return a.sceneIndex === b.sceneIndex && sameTarget(a.target, b.target);
}

/** Order-sensitive array equality for `Selection[]` — used ONLY to decide
 *  whether re-resolving the live selection against a freshly committed
 *  manifest actually changed anything (`MotionTab.tsx`'s own effect), so a
 *  no-op resolve doesn't hand back a new array reference and re-render
 *  every selection-consuming panel for nothing. Order matters here (unlike
 *  set equality) because the callers that build these arrays always build
 *  them in a stable, deterministic order (DOM query order for a marquee,
 *  append order for a toggle) — two arrays with the same members in a
 *  different order would mean something actually reordered, which is worth
 *  noticing, not silently treating as "unchanged." */
export function sameSelectionArray(a: Selection[], b: Selection[]): boolean {
  return a.length === b.length && a.every((s, i) => sameSelection(s, b[i]));
}

/**
 * Shift-click membership toggle (D-158, Phase 3 — "shift-click to extend").
 * Removes `sel` if it's already selected; otherwise adds it — but ONLY when
 * doing so keeps the selection in the one shape this build actually
 * supports multiple of: 2+ `{kind:'layer'}` targets in the SAME scene (see
 * this file's own module doc comment on `Selection[]`'s same-kind
 * constraint, and `MotionCanvasOverlay.tsx`'s own doc comment for why —
 * only one scene's layers are ever in the DOM at once, per the research
 * doc's §1e). Shift-clicking a NON-layer target (a scene/camera row), or a
 * layer in a DIFFERENT scene than the current selection, replaces the
 * selection with just that one target instead of trying to build a mixed
 * or cross-scene multi-selection nothing in this Inspector/canvas knows how
 * to render. */
export function toggleSelection(current: Selection[], sel: Selection): Selection[] {
  const idx = current.findIndex((s) => sameSelection(s, sel));
  if (idx !== -1) return current.filter((_, i) => i !== idx);
  if (sel.target.kind !== 'layer') return [sel];
  if (current.length === 0) return [sel];
  const allSameSceneLayers = current.every((s) => s.target.kind === 'layer' && s.sceneIndex === sel.sceneIndex);
  if (!allSameSceneLayers) return [sel];
  return [...current, sel];
}

/** A short, human label for a layer row — `use`, plus its `text` content
 *  when it's a text layer (the one primitive whose main identity is its
 *  copy, not its position) since "text" alone among several text layers in
 *  one scene isn't useful to pick between. `layer` is `.passthrough()`
 *  (`schema.ts`) so per-primitive fields like `text` aren't statically
 *  typed — same cast `registry.ts`'s own adapters already use to read them.
 *  Exported (D-157) so `InspectorPanel.tsx`'s "snap to layer" target picker
 *  can list sibling layers with the SAME label this list already uses,
 *  rather than growing its own second copy of "how do I describe a layer." */
export function layerLabel(layer: Layer): string {
  const raw = layer as unknown as Record<string, unknown>;
  if (layer.use === 'text' && typeof raw.text === 'string') {
    const text = raw.text as string;
    return `text: "${text.length > 24 ? text.slice(0, 24) + '…' : text}"`;
  }
  return layer.use;
}

const rowBase =
  'w-full text-left px-2 py-1 rounded truncate transition-colors hover:bg-hover-color';
const rowSelected = 'bg-accent text-button-text hover:bg-accent';

/** Same physical-distance bar `MotionCanvasOverlay.tsx`'s `MARQUEE_MIN_DRAG_PX`
 *  and `KeyframeTimeline.tsx`'s `KEY_DRAG_MIN_PX` already use — reused, not
 *  reinvented, per this module's own doc comment. */
const LAYER_DRAG_MIN_PX = 4;

/** Which reorderable array a dragged row belongs to — exactly
 *  `reorderLayers`'s own `kind` parameter, kept as its own alias here so
 *  every reorder-related local below reads the same word `manifestEdit.ts`
 *  uses. */
type ReorderKind = 'layer' | 'scene3d-child';

/** In-flight drag state — a ref, not React state, for the identical reason
 *  every other pointer-drag in this package keeps its own origin out of the
 *  render cycle (`MotionCanvasOverlay.tsx`'s `DragState`,
 *  `KeyframeTimeline.tsx`'s `KeyDragState`): a `pointermove` firing at
 *  display refresh rate has no business going through a re-render just to
 *  read back where the gesture started. `dragging` flips true only once the
 *  pointer has crossed `LAYER_DRAG_MIN_PX` — before that, this is still
 *  "possibly just a click." `id`/`label` are captured ONCE here, at
 *  `pointerdown`, purely for the sub-threshold "this turned out to be a
 *  plain click" fallback (`onSelect`) — never re-read from `manifest`
 *  mid-gesture, matching the "recompute from a stable base, never from a
 *  previous call's own transient result" discipline this package holds
 *  everywhere else. */
interface LayerDragState {
  pointerId: number;
  sceneIndex: number;
  kind: ReorderKind;
  fromIndex: number;
  id?: string;
  startX: number;
  startY: number;
  dragging: boolean;
  /** The CURRENT drop target, mirroring the `dropIndicator` React state
   *  below but kept on THIS ref too — the actual value `pointerup` commits
   *  through. React state updates (`setDropIndicator`) are batched/async
   *  (React 18's automatic batching): a `pointerdown`→`pointermove`→
   *  `pointerup` burst delivered without an intervening render (a fast real
   *  drag, or — found while live-verifying this gesture — a same-tick
   *  synthetic event sequence) would otherwise let `pointerup`'s closure
   *  read a STALE `dropIndicator` from before this gesture's own
   *  `pointermove` update ever committed, silently dropping the reorder.
   *  This ref field is written synchronously in the SAME statement as its
   *  `setDropIndicator` counterpart, so `pointerup` always reads the
   *  gesture's own true current value regardless of React's render timing —
   *  the identical "why a ref, not state, for in-flight gesture data" reason
   *  `MotionCanvasOverlay.tsx`'s/`KeyframeTimeline.tsx`'s own `DragState`
   *  refs already hold everything else about an in-flight drag. */
  dropTarget: DropIndicator | null;
}

/** Where the drop-line currently shows, in the SAME `toIndex` domain
 *  `reorderLayers` itself takes (0..`length-1`, the moved layer's own final
 *  resting index) — computed once here, at `pointermove` time, so
 *  `pointerup` only has to hand the number straight to `reorderLayers`
 *  rather than re-deriving it from a raw "insert before/after" pair. `null`
 *  whenever the pointer isn't over a valid drop target for the drag in
 *  progress (a different scene, a different array `kind`, or no
 *  `[data-layer-row]` at all under the pointer — a scene/camera row, empty
 *  space, or nothing) — the drag continues, simply with nothing to commit
 *  if released right now. */
interface DropIndicator {
  sceneIndex: number;
  kind: ReorderKind;
  /** Draws the line ABOVE the row at this index; `list.length` draws it
   *  below the very last row instead (there is no row at that index to draw
   *  "above"). */
  insertionPoint: number;
}

/** Finds the `[data-layer-row]` (D-176, mirroring `MotionCanvasOverlay.tsx`'s
 *  own `[data-motion-layer]` hit-testing convention exactly) actually under
 *  a screen point, via `document.elementsFromPoint` — needed instead of
 *  `event.target` because `setPointerCapture` (held by the row the drag
 *  STARTED on) retargets every subsequent pointer event back to that same
 *  element regardless of where the cursor physically is, per spec. Returns
 *  the row's own parsed identity plus its live `getBoundingClientRect()` (to
 *  decide top-half-vs-bottom-half in the caller) — `null` if the point isn't
 *  over any row at all. */
function findDropRow(clientX: number, clientY: number): { sceneIndex: number; kind: ReorderKind; index: number; rect: DOMRect } | null {
  for (const el of document.elementsFromPoint(clientX, clientY)) {
    const rowEl = (el as Element).closest?.('[data-layer-row]');
    if (!rowEl) continue;
    const attr = rowEl.getAttribute('data-layer-row');
    if (!attr) return null;
    const [sceneStr, kindStr, indexStr] = attr.split(':');
    return {
      sceneIndex: Number(sceneStr),
      kind: kindStr as ReorderKind,
      index: Number(indexStr),
      rect: rowEl.getBoundingClientRect(),
    };
  }
  return null;
}

/** D-158, Phase 3 — `selections` is now an array (was a single `Selection |
 *  null`, see `MotionTab.tsx`'s own doc comment on why). A row click ALWAYS
 *  replaces the whole selection with just that one row — this list doesn't
 *  grow its own shift-click/marquee multi-select gesture; the canvas
 *  overlay is where those live (research doc §4 Phase 3 scopes the gesture
 *  to "the canvas," and a list of rows has no rubber-band-able geometry to
 *  speak of anyway). A row still highlights whenever it matches ANY entry
 *  in `selections`, so a multi-selection made on the canvas is visible here
 *  too — the same "panel and canvas agree on what's selected" rule D-156
 *  already followed for the single-selection case. */
export function LayerList({
  manifest,
  selections,
  onSelect,
  onCommit,
  editLinks,
}: {
  manifest: Manifest;
  selections: Selection[];
  onSelect: (s: Selection) => void;
  /** One commit per completed drag, through `useMotionManifest`'s
   *  undo-wired `commit(next, label)` (D-155's discipline) — the same shape
   *  `KeyframeTimeline.tsx`'s own `onCommit` prop already takes. Optional:
   *  omitting it keeps this list a read-only navigator with no reorder
   *  gesture at all (D-160's own "still useful with nothing wired" floor) —
   *  rows fall back to their previous plain `onClick`-only behaviour. */
  onCommit?: (next: Manifest, label: string) => void;
  /** D-259 — each scene's Edit-tab footprint, for the "N in Edit" badge on
   *  its scene row. Supplied by the app layer through `MotionTab` (this
   *  package may not import the media pool or the Edit timeline itself —
   *  D-039's layer direction); omitting it simply draws no badges. */
  editLinks?: MotionEditLinks;
}) {
  const draggable = Boolean(onCommit);
  const dragRef = useRef<LayerDragState | null>(null);
  const [draggingRow, setDraggingRow] = useState<{ sceneIndex: number; kind: ReorderKind; index: number } | null>(null);
  const [dropIndicator, setDropIndicator] = useState<DropIndicator | null>(null);

  // Escape cancels an in-flight drag with no mutation — the same key,
  // same "just drop the ref and clear the visual state" shape
  // `KeyframeTimeline.tsx`'s own drag-cancel effect already uses.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || !dragRef.current) return;
      dragRef.current = null;
      setDraggingRow(null);
      setDropIndicator(null);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const row = (
    sceneIndex: number,
    target: SelectionTarget,
    label: string,
    indent = false,
    keyCount = 0,
    /** D-259 — a scene row's Edit-tab footprint, when it has one. */
    editLink?: MotionEditLink,
  ) => {
    const isSel = selections.some((s) => s.sceneIndex === sceneIndex && sameTarget(s.target, target));
    const clipCount = editLink?.clips.length ?? 0;
    return (
      <button
        type="button"
        key={`${target.kind}-${'index' in target ? target.index : ''}`}
        className={[rowBase, 'flex items-center justify-between gap-1', isSel ? rowSelected : 'text-text-secondary', indent ? 'pl-4' : ''].join(' ')}
        onClick={() => onSelect({ sceneIndex, target })}
      >
        <span className="truncate">{label}</span>
        {/* D-259 — "Used in N Edit clips": the mechanism is visible, never a
           silent side effect. Shown only on a scene whose render is actually
           PLACED on the Edit timeline (a scene rendered but only sitting in
           Sources has nothing that a re-render would refresh, and a badge
           reading "0" on every un-placed scene would be noise). Re-rendering
           this scene refreshes exactly these clips — see D-259. */}
        {clipCount > 0 && (
          <span
            data-scene-edit-links={clipCount}
            className={[
              'shrink-0 rounded-full px-1.5 text-[9px] leading-4',
              isSel ? 'bg-button-text/20 text-button-text' : 'bg-accent/15 text-accent',
            ].join(' ')}
            title={`Used in ${clipCount} Edit clip${clipCount === 1 ? '' : 's'} — re-rendering this scene refreshes ${clipCount === 1 ? 'it' : 'them'}`}
          >
            {`${clipCount} in Edit`}
          </span>
        )}
        {/* D-160 — a key-count badge, only when there's something to count
           (0 keys shows nothing rather than a "0" that would clutter every
           un-keyed row, the common case for most manifests today). */}
        {keyCount > 0 && (
          <span
            className={[
              'shrink-0 rounded-full px-1.5 text-[9px] leading-4',
              isSel ? 'bg-button-text/20 text-button-text' : 'bg-bg-primary text-text-secondary',
            ].join(' ')}
            title={`${keyCount} keyframe${keyCount === 1 ? '' : 's'}`}
          >
            {keyCount}
          </span>
        )}
      </button>
    );
  };

  /** The draggable counterpart to `row` above — used ONLY for `{kind:
   *  'layer'}` and `{kind:'scene3d-child'}` rows (the two arrays
   *  `reorderLayers` knows how to reorder). Carries a `data-layer-row`
   *  attribute (`findDropRow`'s own lookup key) and, when `draggable`, real
   *  pointer handlers instead of a plain `onClick` — mirroring
   *  `KeyframeTimeline.tsx`'s own marker exactly: `pointerdown` arms a
   *  possible drag (and does nothing when `!draggable`, leaving the
   *  fallback `onClick` below to handle selection exactly as before this
   *  pass); `pointerup` below `LAYER_DRAG_MIN_PX` is a plain click
   *  (`onSelect`); at or past it, commits the reorder. The native `click`
   *  that still fires after a real drag's `pointerup` is a deliberate no-op
   *  when `draggable` (the `onClick` guard below) — the exact same "must
   *  not ALSO perform the ordinary click behaviour on top of it" reasoning
   *  `KeyframeTimeline.tsx`'s own marker `onClick` doc comment states. */
  const layerRow = (sceneIndex: number, kind: ReorderKind, index: number, layer: Layer, keyCount: number) => {
    const id = layer.id;
    const label = layerLabel(layer);
    const target: SelectionTarget = { kind, index, id };
    const isSel = selections.some((s) => s.sceneIndex === sceneIndex && sameTarget(s.target, target));
    const isDragging = draggable && draggingRow?.sceneIndex === sceneIndex && draggingRow.kind === kind && draggingRow.index === index;
    const dropBefore = dropIndicator?.sceneIndex === sceneIndex && dropIndicator.kind === kind && dropIndicator.insertionPoint === index;

    const onPointerDown = (e: ReactPointerEvent<HTMLButtonElement>) => {
      if (!draggable || e.button !== 0) return;
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = {
        pointerId: e.pointerId,
        sceneIndex,
        kind,
        fromIndex: index,
        id,
        startX: e.clientX,
        startY: e.clientY,
        dragging: false,
        dropTarget: null,
      };
    };

    const onPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      if (!drag.dragging) {
        if (Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) < LAYER_DRAG_MIN_PX) return;
        drag.dragging = true;
        setDraggingRow({ sceneIndex: drag.sceneIndex, kind: drag.kind, index: drag.fromIndex });
      }
      const hit = findDropRow(e.clientX, e.clientY);
      if (!hit || hit.sceneIndex !== drag.sceneIndex || hit.kind !== drag.kind) {
        // A different scene, a different array (`layers` vs
        // `scene3d.children`), or no row at all under the pointer (a
        // scene/camera row, or empty space) — not a valid drop target for
        // THIS drag. No indicator; the drag stays alive (the pointer may
        // well move back over a valid row next).
        drag.dropTarget = null;
        setDropIndicator(null);
        return;
      }
      const before = e.clientY < hit.rect.top + hit.rect.height / 2;
      const next: DropIndicator = { sceneIndex: drag.sceneIndex, kind: drag.kind, insertionPoint: before ? hit.index : hit.index + 1 };
      drag.dropTarget = next;
      setDropIndicator(next);
    };

    const onPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
      const drag = dragRef.current;
      if (!drag || drag.pointerId !== e.pointerId) return;
      dragRef.current = null;
      e.currentTarget.releasePointerCapture(e.pointerId);
      // Read the drop target off the REF (`drag.dropTarget`), not the
      // `dropIndicator` React-state closure — see `LayerDragState.dropTarget`'s
      // own doc comment for why the state value can be stale here.
      const indicator = drag.dropTarget;
      setDraggingRow(null);
      setDropIndicator(null);

      if (!drag.dragging) {
        // Sub-threshold press — a plain click, unchanged behaviour.
        onSelect({ sceneIndex: drag.sceneIndex, target: { kind: drag.kind, index: drag.fromIndex, id: drag.id } });
        return;
      }
      if (!indicator || !onCommit) return; // released over an invalid drop target, or reorder not wired — no-op

      // `indicator.insertionPoint` is "insert before/after the hovered row,"
      // counted against the CURRENT (pre-move) array. `reorderLayers`'s own
      // `toIndex` is the moved item's desired FINAL index in the resulting
      // array — the same number whenever the target sits at or before
      // `fromIndex` (nothing shifts), one less when it sits after (the
      // dragged item's own removal shifts everything after it back by one).
      const toIndex = indicator.insertionPoint <= drag.fromIndex ? indicator.insertionPoint : indicator.insertionPoint - 1;
      const next = reorderLayers(manifest, drag.sceneIndex, drag.kind, drag.fromIndex, toIndex);
      if (next !== manifest) onCommit(next, drag.kind === 'layer' ? 'Reorder layers' : 'Reorder 3D layers');
    };

    return (
      <button
        type="button"
        key={`${kind}-${index}`}
        data-layer-row={`${sceneIndex}:${kind}:${index}`}
        className={[
          rowBase,
          'flex items-center gap-1.5 pl-4',
          isSel ? rowSelected : 'text-text-secondary',
          draggable ? 'cursor-grab active:cursor-grabbing' : '',
          isDragging ? 'opacity-40' : '',
          dropBefore ? 'border-t-2 border-accent' : '',
        ].join(' ')}
        onClick={() => {
          // The native `click` that still fires after a completed drag's
          // `pointerup` (neither handler calls `preventDefault`) — when
          // `draggable`, selection is already handled by `onPointerUp`
          // above (both the plain-click and the real-drag cases), so this
          // must be a no-op. When NOT draggable (`onCommit` absent), this is
          // the ONLY selection path, unchanged from before this pass.
          if (!draggable) onSelect({ sceneIndex, target });
        }}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
      >
        {/* D-176 — a real live (or, for the 3D three, static-glyph) preview
           of what this specific layer actually is, "so we know what we're
           working with" (the owner's own words) — see `LayerThumbnail.tsx`'s
           own doc comment for the full approach/performance reasoning. */}
        <LayerThumbnail layer={layer} manifest={manifest} />
        <span className="truncate flex-1 min-w-0 text-left">{label}</span>
        {keyCount > 0 && (
          <span
            className={[
              'shrink-0 rounded-full px-1.5 text-[9px] leading-4',
              isSel ? 'bg-button-text/20 text-button-text' : 'bg-bg-primary text-text-secondary',
            ].join(' ')}
            title={`${keyCount} keyframe${keyCount === 1 ? '' : 's'}`}
          >
            {keyCount}
          </span>
        )}
      </button>
    );
  };

  return (
    <div data-layer-list-scroll className="h-full w-full overflow-y-auto text-[11px] px-2 py-2 flex flex-col gap-2">
      {manifest.scenes.map((scene, si) => (
        <div key={scene.id} className="flex flex-col gap-0.5">
          {row(si, { kind: 'scene' }, scene.id, false, 0, editLinks?.[scene.id])}
          {scene.camera && row(si, { kind: 'camera' }, 'Camera', true, cameraKeyCount(scene))}
          {scene.layers?.map((layer, li) => layerRow(si, 'layer', li, layer, layerKeyCount(layer)))}
          {/* the drop-line for "append after the last layer" — there is no
             row AT `list.length` to draw a top border on, so this is drawn
             as its own bottom border on the last row instead. */}
          {scene.layers && scene.layers.length > 0 && dropIndicator?.sceneIndex === si && dropIndicator.kind === 'layer' && dropIndicator.insertionPoint === scene.layers.length && (
            <div className="h-0 border-t-2 border-accent -mt-0.5 ml-4" />
          )}
          {scene.scene3d && (
            <>
              {row(si, { kind: 'scene3d-camera' }, '3D Camera', true, scene3dCameraKeyCount(scene))}
              {scene.scene3d.children.map((child, ci) => layerRow(si, 'scene3d-child', ci, child, 0))}
              {scene.scene3d.children.length > 0 && dropIndicator?.sceneIndex === si && dropIndicator.kind === 'scene3d-child' && dropIndicator.insertionPoint === scene.scene3d.children.length && (
                <div className="h-0 border-t-2 border-accent -mt-0.5 ml-4" />
              )}
            </>
          )}
        </div>
      ))}
      {/* D-179 (owner, live: "we need a way to create multiple scene…
         create a scene and edit it") — appends a new, minimal-but-valid
         scene via `addScene` right after the CURRENTLY selected one (so it
         lands where the owner is looking, not always at the bottom of a
         long list), falling back to the very end when nothing is selected.
         Gated on `onCommit` the same way every other mutating gesture in
         this file already is (D-160's "no onCommit ⇒ read-only navigator"
         floor) — a caller with no write capability wired simply never sees
         this button, rather than seeing one that silently does nothing. */}
      {onCommit && (
        <button
          type="button"
          onClick={() => {
            const { manifest: next, selection } = addScene(manifest, selections[0]?.sceneIndex);
            onCommit(next, 'Add scene');
            onSelect(selection);
          }}
          className="shrink-0 h-6 flex items-center justify-center gap-1 rounded-md border border-dashed border-border-color text-text-secondary hover:text-text-primary hover:border-accent hover:bg-hover-color transition-colors"
        >
          <Plus size={12} />
          Add scene
        </button>
      )}
    </div>
  );
}
