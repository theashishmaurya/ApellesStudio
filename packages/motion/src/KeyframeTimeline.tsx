/**
 * @chroma/motion — Phase 5b part 2 of `docs/notes/
 * motion-keyframe-timeline-research.md` ("per-row lanes", D-162). Replaces
 * D-160/D-161's `KeyframeStrip.tsx` (one flat strip, every marker on one
 * row) with a real per-row lane timeline: one row per keyed 2D/3D camera and
 * one row per keyed layer, a shared horizontal time ruler, independent zoom,
 * per-row click-to-select, and D-161's own drag-a-key-along-time gesture —
 * now scoped to its own row instead of one shared row.
 *
 * **Layout decision — a full-width sibling panel in `MotionTab.tsx`, not
 * embedded inside `MotionPreview.tsx` under the player (D-160's own
 * placement).** Read both real precedents before deciding, per the task's
 * own instruction: `packages/editor/src/EditorTab.tsx` puts `TimelinePane`
 * in its OWN row below `PreviewPane`, inside the SAME left `ResizablePanel`
 * (a nested vertical split), as a real, independently resizable region
 * (`h-[46%] min-h-[180px]`) — NOT nested inside the preview pane's own
 * component the way D-160 put `KeyframeStrip` inside `MotionPreview.tsx`.
 * That placement stopped being viable the moment "one flat strip" became
 * "N independently-scrollable rows": a fixed 24px strip could live squeezed
 * under the player with zero layout cost, but a real per-row lane timeline
 * needs its OWN real estate — a resizable height, a scrollable region, and
 * enough width to show a ruler and several rows of markers — none of which
 * a strip wedged into the bottom of the preview's `flex flex-col` can give
 * it without starving the player. `MotionTab.tsx` now nests a VERTICAL
 * `PanelGroup` (`orientation="vertical"`) inside the existing left
 * `ResizablePanel` — `<MotionPreview>` on top, `<KeyframeTimeline>` below,
 * a real `ResizableHandle` between them — mirroring the Edit tab's own
 * preview-then-timeline stack exactly, one nesting level deeper than
 * `EditorTab.tsx` needs (that tab has no OTHER sibling columns inside its
 * own left panel; Motion's left panel is itself one of four columns in the
 * tab's outer horizontal group). `MotionPreview.tsx` goes back to exactly
 * its pre-D-160 shape (no strip inside it at all) — see that file's own
 * updated doc comment.
 *
 * **Row model.** `keyframeVisibility.ts`'s `keyframeLanes` (pure, tested) is
 * the "which rows exist, in what order" function the research doc's §4
 * asked for — one row per (scene, 2D camera) with `>0` keys, one per (scene,
 * layer) with `>0` `transform.keys`, one per (scene, 3D camera) with `>0`
 * keys, in `LayerList.tsx`'s own scene→camera→layers→3D-camera order. Rows
 * appear/disappear as keys are added/removed — the SAME "badge only when
 * count > 0" precedent D-160 already set for `LayerList`'s own badges, now
 * applied to whether a row exists at all rather than just whether it shows
 * a number. D-178/B-067 adds a SECOND per-layer lane kind, `'active'` — a
 * `layers`/`layerstack` primitive's own `active: [{at,i}]` schedule, an
 * entirely separate keyed array from `transform.keys` that this timeline
 * previously had no row for at all (see that decision's own writeup for
 * why: it was completely invisible/unretimeable outside a raw JSON edit).
 *
 * **Shared time axis, independent zoom.** Every row (and the ruler) renders
 * its own track div at the SAME pixel width — `timelineZoom.ts`'s
 * `trackWidthPx(totalFrames, fps, pxPerSecond)` — so a frame's `left: N%`
 * position (`keyframeVisibility.ts`'s `frameToPercent`, unchanged by zoom:
 * percent-of-track-width stays correct at any zoom since every row's track
 * is the same width) lands at the identical pixel offset in every row. "One
 * shared axis, independent zoom" (the research doc's own §4 phrase) is read
 * here as ONE zoom level for the whole timeline (a single `pxPerSecond`
 * state, a toolbar +/- pair) — the alternative, a PER-ROW zoom level, was
 * considered and rejected: rows would no longer agree on where in time a
 * given pixel column sits, defeating the entire point of a shared axis a
 * scene-boundary line or the playhead could be drawn once across. "shared…
 * and independent [of the Edit tab's own zoom system]" is the reading this
 * component implements — see `timelineZoom.ts`'s own module doc comment for
 * why this zoom's bounds are new, not reused from `ruler.ts`'s D-134 ones.
 *
 * **The ruler.** `timelineRuler.ts`'s `rulerTicks` (a REIMPLEMENTATION of
 * `packages/editor/src/ruler.ts`'s "nice numbers" tick-density algorithm,
 * confirmed by the research doc's §2b and D-160/D-161's own decision
 * entries to be reused as TECHNIQUE only, never as an import — see that
 * file's own module doc comment for the full reasoning) plus
 * `sceneBoundaryFrames` (D-160, unchanged) for the vertical scene-divider
 * lines every row also draws.
 *
 * **Vertical + horizontal scroll, one region.** The whole ruler+lanes stack
 * lives inside ONE `overflow-auto` div. Each lane's own label column is
 * `position: sticky; left: 0` (stays visible while scrolling horizontally,
 * scrolls away normally with the rest of the row when scrolling
 * vertically); the ruler row is `position: sticky; top: 0` (stays visible
 * while scrolling vertically through many rows) and its own corner cell is
 * sticky on BOTH axes — the standard "frozen row + frozen column" CSS
 * technique, needing no virtualization library for the row counts this
 * engine's manifests realistically have (one row per keyed layer/camera,
 * not per video frame).
 *
 * **Selection — reuses `MotionTab.tsx`'s existing `onSelect`, no parallel
 * mechanism.** Clicking a row's label OR its own track background (off any
 * marker) calls `onSelect(selectionForLane(manifest, lane))` — the EXACT
 * `Selection` shape `LayerList.tsx`'s own row click already produces
 * (`keyframeVisibility.ts`'s `selectionForLane`, including the layer's own
 * `id` snapshot, D-158). `MotionTab.tsx`'s `onSelect` already seeks the
 * player to the scene's start frame on every call (unchanged) — a
 * track-background click additionally seeks to the EXACT clicked frame
 * right after (the more precise of the two wins, since it runs second).
 *
 * **Per-row drag (D-161, generalized).** The old flat strip could only
 * drag the CURRENTLY SELECTED layer's keys (`selectedLayerKeyMarkers`
 * scoped every layer marker to the live single-layer selection). A lane
 * already names its own exact (scene, layer) — the drag's write primitive
 * (`moveLayerTransformKeyAt`/`moveCamera2dKeyAt`/`moveCamera3dKeyAt`,
 * `manifestEdit.ts`, unchanged) is built straight from the LANE the pointer
 * landed in, never from the tab's live `selections` — a real capability
 * improvement, not just a reshuffling: any keyed layer's keys can now be
 * dragged without first selecting that layer in `LayerList`. D-161's own
 * "live visual feedback without touching marker identity mid-drag" problem
 * (a marker list re-derived from a live-reordering transient manifest could
 * remount the dragged button and drop `setPointerCapture`) still applies
 * WITHIN one row exactly as before — the `dragPreview` override is now
 * scoped by `{laneKey(lane), keyIndex}` rather than `{kind, sceneIndex,
 * keyIndex}`, since two DIFFERENT layers in the same scene can each have
 * their own `keyIndex === 0` marker now that both get their own row.
 *
 * **Phase 5b part 3 — box-select + nudge multiple keys (this pass).** Two
 * new gestures layered onto the three this file already had (marker click,
 * marker drag/retime, track-background click-to-seek), disambiguated the
 * SAME way — structural DOM-position checks, never priority/z-order guesses
 * (D-137/D-158's own discipline, a further application in this file):
 *
 * - **Shift-click a marker** toggles it into/out of a NEW, separate
 *   selection model for individual KEYS (`keyframeVisibility.ts`'s
 *   `KeySelectionEntry` — `{lane, keyIndex}`, distinct from `Selection[]`,
 *   which points at whole layers/cameras, never one key within one). Local
 *   `useState` in this component — see `KeySelectionEntry`'s own module doc
 *   comment in `keyframeVisibility.ts` for why it isn't lifted to
 *   `MotionTab.tsx` and why it is NOT cleared on every manifest commit.
 * - **A rubber-band drag over empty track space** (not a marker, not a lane
 *   label) box-selects every key whose marker falls inside the rectangle —
 *   `keyframeVisibility.ts`'s `keysInMarqueeRect`, which needs NO DOM
 *   measurement of individual markers at all (unlike
 *   `MotionCanvasOverlay.tsx`'s own 2D marquee, which genuinely must
 *   measure the DOM since a layer's on-screen box depends on the live
 *   camera transform): this timeline's row/column layout is already fully
 *   known from pure numbers (`keyframeLanes`' row order, each marker's own
 *   frame, `trackWidthPx`'s pixel width), so the intersection test is pure
 *   and unit-tested, the same "canvasGeometry.ts's rectFromPoints/
 *   rectsIntersect translate directly, reused verbatim" call the research
 *   doc's own §4 asked to be checked rather than assumed. The ONE DOM
 *   measurement this file still needs is the scrollable CONTENT div's own
 *   `getBoundingClientRect()` (`contentRef`), read fresh on every
 *   pointermove — translating a pointer's `clientX`/`clientY` into
 *   "content-local" px this way automatically accounts for the current
 *   scroll position (exactly like `MotionCanvasOverlay.tsx`'s own
 *   `toContainerLocal`), without needing to query any individual marker.
 *
 * **Nudge — dragging ANY ONE selected key (when 2+ are selected) moves ALL
 * of them by one shared `deltaSeconds`.** The direct analog of D-158's
 * `moveLayersByDelta`, generalized in `manifestEdit.ts` as `moveKeysByDelta`
 * (see that function's own doc comment for the cross-lane-spanning and
 * independent-boundary-clamp decisions — both explicitly ALLOWED/chosen for
 * consistency with `moveKeyAt`'s own established never-block philosophy).
 * `deltaSeconds` itself is computed from raw pointer pixel movement via
 * `timelineZoom.ts`'s new `pxDeltaToSeconds` — since `pxPerSecond` is the
 * ONE shared axis every row already agrees on, a pixel distance IS a time
 * distance regardless of which row the drag started in, so (unlike D-161's
 * single-key drag, which resolves an ABSOLUTE new position and therefore
 * does need to know which scene the pointer is currently over) this nudge
 * needs no `frameFromClientX` call at all to compute its shared delta. A
 * single selected key (or a marker not in any live multi-selection) is
 * just the `moves.length === 1` case of the exact same code path — not a
 * separately maintained one, the same unification D-158 already did for
 * layers.
 *
 * **Escape cancels an in-flight nudge (and a marquee), same as every other
 * drag in this tab.**
 */
import { useEffect, useRef, useState } from 'react';
import type { PointerEvent as ReactPointerEvent, RefObject } from 'react';
import { ZoomIn, ZoomOut } from 'lucide-react';
import type { PlayerRef } from '@remotion/player';
import { totalFrames, sceneStartFrame } from '@chroma/motion-engine/src/engine/build';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';

import type { Selection } from './LayerList';
import { sameSelection, layerLabel } from './LayerList';
import {
  keyframeLanes,
  laneKey,
  laneKeyMarkers,
  laneKeyAtSeconds,
  selectionForLane,
  sceneBoundaryFrames,
  frameToPercent,
  percentToFrame,
  sameKeySelectionEntry,
  toggleKeySelectionEntry,
  unionKeySelectionEntries,
  keysInMarqueeRect,
  type KeyframeLane,
  type KeyMarker,
  type KeySelectionEntry,
} from './keyframeVisibility';
import { moveKeysByDelta, type KeyMoveTarget } from './manifestEdit';
import { rectFromPoints, type Point, type RectLike } from './canvasGeometry';
import { rulerTicks } from './timelineRuler';
import {
  MIN_PX_PER_SEC,
  MAX_PX_PER_SEC,
  DEFAULT_PX_PER_SEC,
  zoomStep,
  trackWidthPx,
  pxDeltaToSeconds,
} from './timelineZoom';

const LANE_LABEL_WIDTH = 148;
const RULER_HEIGHT = 20;
const LANE_HEIGHT = 26;

/** Same physical-distance bar `MotionCanvasOverlay.tsx`'s own marquee and
 *  D-161's flat-strip drag both use — duplicated as a literal with a doc
 *  comment pointing at its own precedent (D-161's own reasoning: one
 *  duplicated numeric constant is cheaper than a new cross-file module for
 *  a single shared number). Reused again this pass for the NEW marquee's
 *  own click-vs-drag threshold — the same bar, the same reasoning, a THIRD
 *  gesture on this surface deciding it needs it. */
const KEY_DRAG_MIN_PX = 4;

/** In-flight key/nudge-drag state — a ref, not React state, for the
 *  identical reason `KeyframeStrip.tsx`'s own `KeyDragState` was (D-161): a
 *  pointermove firing at display refresh rate has no business going through
 *  a re-render to read its own drag origin back.
 *
 *  **Generalized this pass from a single `{lane, marker}` pair to a `moves`
 *  array** — the direct analog of D-158's own `DragState['moves']` for
 *  layers: a single-key drag is just the `moves.length === 1` case of the
 *  same shape, not a separately maintained code path. Every entry's
 *  `baseAtSeconds` is captured ONCE here, from the STABLE manifest, at
 *  `pointerdown` — never re-read mid-gesture (see `manifestEdit.ts`'s
 *  `KeyMoveTarget` and `moveKeysAt`'s own doc comments for why re-reading a
 *  key's CURRENT `at` mid-batch is the exact correctness trap this
 *  discipline avoids). */
interface KeyDragState {
  pointerId: number;
  moves: { lane: KeyframeLane; keyIndex: number; baseAtSeconds: number }[];
  /** The EXACT marker the pointer went down on — used only for the
   *  sub-threshold "plain click, never became a drag" fallback (seek to
   *  its own already-known, already-rounded frame and select its own
   *  lane) — never for the nudge math itself, which only ever reads
   *  `moves`. Kept separate from `moves` rather than assuming
   *  `moves[0]` is the clicked marker, since a multi-key nudge's `moves`
   *  order is the live `keySelection`'s own order, not "clicked one
   *  first." */
  primaryLane: KeyframeLane;
  primaryFrame: number;
  startClientX: number;
}

/** In-flight marquee state — mirrors `MotionCanvasOverlay.tsx`'s own
 *  `DragState['marquee']` variant exactly: `additive`/`baseSelection` read
 *  ONCE at `pointerdown` (D-137/D-158's "a modifier tapped mid-drag must not
 *  change the meaning of a gesture already under way" rule), `start` in
 *  CONTENT-LOCAL px (the scrollable content div's own coordinate space —
 *  see the module doc comment's "box-select" section for why this needs
 *  only ONE DOM measurement, not per-marker ones). `lane` is the row the
 *  gesture started on — irrelevant to a REAL marquee (which scans every
 *  row), needed only for the sub-threshold "plain click" fallback (the
 *  EXISTING D-161/162 click-to-select-lane-and-seek behaviour). */
interface MarqueeDragState {
  pointerId: number;
  additive: boolean;
  baseSelection: KeySelectionEntry[];
  start: Point;
  lane: KeyframeLane;
}

function labelForLaneKind(kind: KeyframeLane['kind']): string {
  switch (kind) {
    case 'camera':
      return 'Move camera keyframe';
    case 'scene3d-camera':
      return 'Move 3D camera keyframe';
    case 'layer':
      return 'Move layer keyframe';
    case 'active':
      return 'Move active-index keyframe';
  }
}

/** A lane's own display label — `Camera`/`3D Camera`/the layer's own
 *  `layerLabel` (the SAME label `LayerList.tsx`'s row already shows),
 *  prefixed with its own scene's `id` whenever the manifest has more than
 *  one scene (a bare "Camera" is ambiguous the moment two scenes both have
 *  one; with a single scene it would just be visual noise). Component-only
 *  presentation logic — not in `keyframeVisibility.ts`, which stays
 *  structural data only (see that file's own module doc comment for why:
 *  moving `layerLabel` there would create a real runtime import cycle with
 *  `LayerList.tsx`, which already imports FROM `keyframeVisibility.ts`). */
function laneLabel(manifest: Manifest, lane: KeyframeLane): string {
  const scene = manifest.scenes[lane.sceneIndex];
  const layer = lane.layerIndex !== undefined ? scene?.layers?.[lane.layerIndex] : undefined;
  const kind =
    lane.kind === 'camera'
      ? 'Camera'
      : lane.kind === 'scene3d-camera'
        ? '3D Camera'
        : layer
          // D-178/B-067 — 'active' gets a ' · Active' suffix so it never
          // reads identically to a 'layer' (transform.keys) lane on the
          // SAME layer, which would otherwise show the exact same label.
          ? `${layerLabel(layer)}${lane.kind === 'active' ? ' · Active' : ''}`
          : 'Layer';
  return manifest.scenes.length > 1 ? `${scene?.id ?? '?'} · ${kind}` : kind;
}

export function KeyframeTimeline({
  manifest,
  selections,
  playerRef,
  onSelect,
  onTransientChange,
  onCommit,
}: {
  /** `null` mirrors every other consumer of the STABLE manifest in this tab
   *  — renders an empty placeholder rather than assuming non-null. */
  manifest: Manifest | null;
  selections: Selection[];
  playerRef: RefObject<PlayerRef | null>;
  /** Reuses `MotionTab.tsx`'s existing row-selection callback — see the
   *  module doc comment's "Selection" section. Optional: a caller with no
   *  selection model at all still gets a fully useful, navigable timeline,
   *  matching this package's own "still useful with nothing wired" floor
   *  (D-160). */
  onSelect?: (s: Selection) => void;
  /** Feeds a live retime preview to `<Player inputProps>`, same mechanism
   *  `MotionCanvasOverlay.tsx`'s own drags use. Optional, required TOGETHER
   *  with `onCommit`: omit both to keep this a read-only navigation
   *  timeline (D-160's own floor). */
  onTransientChange?: (next: Manifest | null) => void;
  /** One commit per completed drag, through `useMotionManifest`'s
   *  undo-wired `commit(next, label)` (D-155's discipline). */
  onCommit?: (next: Manifest, label: string) => void;
}) {
  const [frame, setFrame] = useState(() => playerRef.current?.getCurrentFrame() ?? 0);
  const [pxPerSecond, setPxPerSecond] = useState(DEFAULT_PX_PER_SEC);
  const dragRef = useRef<KeyDragState | null>(null);
  const marqueeRef = useRef<MarqueeDragState | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Every DRAGGED marker's LIVE position while a nudge is in flight — an
  // ARRAY this pass (was a single nullable object pre-nudge, D-161/162):
  // a multi-key nudge previews N markers at once, scoped by
  // `{laneKeyStr, keyIndex}` per entry for the identical reason D-162 first
  // introduced the lane-scoped key (two DIFFERENT layers can each have
  // their own `keyIndex === 0` marker).
  const [dragPreview, setDragPreview] = useState<{ laneKeyStr: string; keyIndex: number; frame: number }[]>([]);
  // The NEW key-selection model (Phase 5b part 3) — see
  // `keyframeVisibility.ts`'s `KeySelectionEntry` doc comment for why this
  // lives here (local) rather than lifted to `MotionTab.tsx`, and why it is
  // deliberately NOT cleared on every manifest commit.
  const [keySelection, setKeySelection] = useState<KeySelectionEntry[]>([]);
  // The drawn marquee band, in CONTENT-LOCAL px (see `MarqueeDragState`'s
  // own doc comment) — `null` outside a marquee drag.
  const [marqueeRect, setMarqueeRect] = useState<RectLike | null>(null);

  const draggable = Boolean(onTransientChange && onCommit);

  // Same event `MotionCanvasOverlay.tsx`/D-160's `KeyframeStrip.tsx` already
  // subscribe to — the playhead line on the ruler and every row tracks it
  // live, during both playback and scrubbing.
  useEffect(() => {
    const player = playerRef.current;
    if (!player) return;
    setFrame(player.getCurrentFrame());
    const onFrameUpdate = (e: { detail: { frame: number } }) => setFrame(e.detail.frame);
    player.addEventListener('frameupdate', onFrameUpdate);
    return () => player.removeEventListener('frameupdate', onFrameUpdate);
  }, [playerRef]);

  // D-175 — ctrl+scroll-wheel zoom, matching `@chroma/editor`'s own
  // `TimelinePane.tsx` convention exactly (its own doc comment there: the
  // library has no wheel handling of its own, so this is a plain native
  // listener rather than React's `onWheel`, which attaches passively by
  // default and silently ignores `preventDefault`, letting the page scroll
  // underneath the zoom). Zooms ONLY on `ctrlKey` (synthesized by the
  // browser for both an explicit Ctrl+scroll on a mouse and a real pinch
  // gesture on a trackpad) — a plain two-finger scroll or physical wheel
  // tick is left alone entirely (no `preventDefault`) and falls through to
  // this div's own native `overflow-auto` scroll, exactly the same
  // scroll-vs-zoom split the Edit tab's own timeline already established.
  // Same geometric step (`zoomStep`, 1.4×) the toolbar buttons already use,
  // so a wheel tick and a button press feel like the same unit of zoom.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setPxPerSecond((v) => zoomStep(v, e.deltaY < 0 ? 1 : -1));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  // Escape cancels an in-flight NUDGE (D-161's own precedent, generalized
  // to N keys) OR an in-flight MARQUEE (D-158's own precedent for its 2D
  // canvas marquee — "never touched `onTransientChange`, so clearing it
  // here is a harmless no-op; only the drawn band actually matters" applies
  // verbatim here too, since this marquee likewise never calls
  // `onTransientChange`). No `releasePointerCapture` call, matching the
  // EXISTING (pre-this-pass) behaviour above: the browser releases capture
  // on its own once the button is actually let go, and a subsequent
  // pointerup on a `null` ref is already a no-op.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (dragRef.current) {
        dragRef.current = null;
        setDragPreview([]);
        onTransientChange?.(null);
      }
      if (marqueeRef.current) {
        marqueeRef.current = null;
        setMarqueeRect(null);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onTransientChange]);

  if (!manifest) {
    return (
      <div className="h-full w-full flex items-center justify-center border-t border-border-color bg-bg-secondary text-text-secondary text-[11px]">
        No manifest to show keyframes for.
      </div>
    );
  }

  const total = totalFrames(manifest);
  const totalSeconds = manifest.fps > 0 ? total / manifest.fps : 0;
  const lanes = keyframeLanes(manifest);
  const boundaries = sceneBoundaryFrames(manifest);
  const trackW = trackWidthPx(total, manifest.fps, pxPerSecond);
  const ticks = rulerTicks(totalSeconds, manifest.fps, pxPerSecond);
  const timelineLayout = { laneAreaTop: RULER_HEIGHT, laneHeight: LANE_HEIGHT, labelWidth: LANE_LABEL_WIDTH };

  const isSelected = (lane: KeyframeLane): boolean => {
    const sel = selectionForLane(manifest, lane);
    return !!sel && selections.some((s) => sameSelection(s, sel));
  };

  const isKeySelected = (lane: KeyframeLane, m: KeyMarker): boolean =>
    keySelection.some((e) => sameKeySelectionEntry(e, { lane, keyIndex: m.keyIndex }));

  const displayFrame = (lane: KeyframeLane, m: KeyMarker) => {
    const preview = dragPreview.find((p) => p.laneKeyStr === laneKey(lane) && p.keyIndex === m.keyIndex);
    return preview ? preview.frame : m.frame;
  };

  /** Pointer clientX -> absolute composition frame, via ONE row's own
   *  measured track width — every row's track is the SAME width
   *  (`trackWidthPx`, the shared axis), so it doesn't matter which row's
   *  element this is called against; `percentToFrame`'s whole reason to
   *  exist (D-161). `null` only if the element isn't in the DOM. */
  const frameFromClientX = (clientX: number, trackEl: HTMLElement | null): number | null => {
    if (!trackEl) return null;
    const rect = trackEl.getBoundingClientRect();
    const fraction = rect.width > 0 ? Math.min(1, Math.max(0, (clientX - rect.left) / rect.width)) : 0;
    return percentToFrame(fraction * 100, total);
  };

  /** A pointer's screen position -> CONTENT-LOCAL px (the scrollable
   *  content div's own coordinate space) — the marquee's own single DOM
   *  measurement, refreshed on every call so it stays correct even if the
   *  user scrolls mid-drag (the div's own `getBoundingClientRect()` already
   *  reflects the CURRENT scroll offset, the same mechanism
   *  `MotionCanvasOverlay.tsx`'s own `toContainerLocal` relies on). `null`
   *  only if the content div isn't mounted (can't happen while a marquee is
   *  in flight — the div is what the pointerdown that started it fired on
   *  — defended anyway). */
  const contentLocalPoint = (clientX: number, clientY: number): Point | null => {
    const el = contentRef.current;
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return { x: clientX - rect.left, y: clientY - rect.top };
  };

  /** The manifest a nudge WOULD produce if released/previewed at the
   *  current pointer position — always recomputed from the STABLE
   *  `manifest` captured in this render plus `drag`'s own drag-start
   *  snapshot (`moves`' captured `baseAtSeconds`), never from a previous
   *  call's own output (D-161's own discipline, unchanged; now routed
   *  through `moveKeysByDelta` for N keys at once instead of one wrapper
   *  per kind). */
  const nextManifestForDrag = (drag: KeyDragState, deltaSeconds: number): Manifest => {
    const targets: KeyMoveTarget[] = drag.moves.map((mv) => ({
      sceneIndex: mv.lane.sceneIndex,
      kind: mv.lane.kind,
      layerIndex: mv.lane.layerIndex,
      keyIndex: mv.keyIndex,
      baseAtSeconds: mv.baseAtSeconds,
    }));
    return moveKeysByDelta(manifest, targets, deltaSeconds);
  };

  /** The frame a `move` entry's OWN marker should show mid-drag, for the
   *  `dragPreview` overlay — mirrors `moveKeysAt`'s own clamp exactly
   *  (`[0, scene.dur]`) without going through the write path itself, so
   *  computing N preview positions never risks the "re-derive markers from
   *  a live-reordering transient manifest" identity trap the module doc
   *  comment's "per-row drag" section already describes for the single-key
   *  case (still true here, unchanged in mechanism — just applied to more
   *  than one marker at once). */
  const previewFrameFor = (mv: KeyDragState['moves'][number], deltaSeconds: number): number => {
    const scene = manifest.scenes[mv.lane.sceneIndex];
    const dur = scene?.dur ?? 0;
    const clampedAt = Math.min(dur, Math.max(0, mv.baseAtSeconds + deltaSeconds));
    return sceneStartFrame(manifest, mv.lane.sceneIndex) + Math.round(clampedAt * manifest.fps);
  };

  const selectAndMaybeSeek = (lane: KeyframeLane, seekFrame?: number) => {
    const sel = selectionForLane(manifest, lane);
    if (sel) onSelect?.(sel);
    if (seekFrame !== undefined) playerRef.current?.seekTo(seekFrame);
  };

  // ---- marker gestures: shift-click (key-selection toggle), plain click
  // (seek + select lane, unchanged from D-161/162), drag/nudge ----

  const handleMarkerPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, lane: KeyframeLane, marker: KeyMarker) => {
    const entry: KeySelectionEntry = { lane, keyIndex: marker.keyIndex };

    if (e.shiftKey) {
      // Shift-click toggles KEY-selection membership and NEVER starts a
      // drag of its own — D-158's own exact convention for shift-click on
      // a layer, reused verbatim rather than inventing a second modifier
      // rule in this same file. Selection-only: works regardless of
      // `draggable`, the same "selection is free, retiming needs write
      // capability" split the marquee below also follows.
      setKeySelection((cur) => toggleKeySelectionEntry(cur, entry));
      return;
    }

    if (!draggable) return; // read-only timeline: the plain onClick below still seeks

    // D-158's own "click inside an existing multi-selection keeps the WHOLE
    // group selected and drags all of it" convention, generalized to keys:
    // clicking a marker already part of a live 2+ key-selection nudges the
    // whole group; clicking anything else replaces the key-selection with
    // just this one marker and drags it alone.
    const alreadyInGroup = keySelection.length > 1 && keySelection.some((s) => sameKeySelectionEntry(s, entry));
    const activeSelection = alreadyInGroup ? keySelection : [entry];
    if (!alreadyInGroup) setKeySelection([entry]);

    const moves = activeSelection.reduce<KeyDragState['moves']>((acc, s) => {
      const baseAtSeconds = laneKeyAtSeconds(manifest, s.lane, s.keyIndex);
      if (baseAtSeconds !== null) acc.push({ lane: s.lane, keyIndex: s.keyIndex, baseAtSeconds });
      return acc;
    }, []);
    if (moves.length === 0) return; // every selected key turned out stale — nothing to drag

    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = {
      pointerId: e.pointerId,
      moves,
      primaryLane: lane,
      primaryFrame: marker.frame,
      startClientX: e.clientX,
    };
  };

  const handleMarkerPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (Math.abs(e.clientX - drag.startClientX) < KEY_DRAG_MIN_PX) return; // not a real drag yet
    const deltaSeconds = pxDeltaToSeconds(e.clientX - drag.startClientX, pxPerSecond, manifest.fps);
    setDragPreview(
      drag.moves.map((mv) => ({
        laneKeyStr: laneKey(mv.lane),
        keyIndex: mv.keyIndex,
        frame: previewFrameFor(mv, deltaSeconds),
      })),
    );
    onTransientChange?.(nextManifestForDrag(drag, deltaSeconds));
  };

  const handleMarkerPointerUp = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    dragRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setDragPreview([]);
    const moved = Math.abs(e.clientX - drag.startClientX) >= KEY_DRAG_MIN_PX;
    if (!moved) {
      // A plain click (no real drag) on a marker — jump to its own
      // (un-retimed, already-rounded) frame, and select its own lane (the
      // layer/camera it belongs to), the same "clicking anything in this
      // row makes it the active selection" behaviour the row's own
      // background/label clicks already have. The key-selection itself is
      // untouched here — it was already set correctly at `pointerdown`
      // above (either collapsed to just this marker, or left as the live
      // group it was already part of), so a tap that never became a drag
      // has nothing further to do.
      selectAndMaybeSeek(drag.primaryLane, drag.primaryFrame);
      return;
    }
    const deltaSeconds = pxDeltaToSeconds(e.clientX - drag.startClientX, pxPerSecond, manifest.fps);
    onTransientChange?.(null);
    const next = nextManifestForDrag(drag, deltaSeconds);
    const label = drag.moves.length > 1 ? 'Move keyframes' : labelForLaneKind(drag.moves[0].lane.kind);
    onCommit?.(next, label);
  };

  const markerHandlers = (lane: KeyframeLane, m: KeyMarker) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => handleMarkerPointerDown(e, lane, m),
    onPointerMove: handleMarkerPointerMove,
    onPointerUp: handleMarkerPointerUp,
  });

  // ---- track-background gestures: plain click (seek + select lane,
  // unchanged from D-161/162) vs. a real marquee drag (box-select) ----

  const handleTrackPointerDown = (e: ReactPointerEvent<HTMLDivElement>, lane: KeyframeLane) => {
    // Structural check (D-137/D-158's discipline, a further application):
    // did this pointerdown actually originate on a MARKER (which bubbles up
    // to this same track div)? If so, that marker's own `onPointerDown`
    // already owns the gesture — bail rather than also starting a marquee.
    if ((e.target as Element).closest('[data-key-marker]')) return;
    if (e.button !== 0) return;
    const start = contentLocalPoint(e.clientX, e.clientY);
    if (!start) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    marqueeRef.current = {
      pointerId: e.pointerId,
      additive: e.shiftKey || e.metaKey || e.ctrlKey,
      baseSelection: keySelection,
      start,
      lane,
    };
  };

  const handleTrackPointerMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const mq = marqueeRef.current;
    if (!mq || mq.pointerId !== e.pointerId) return;
    const current = contentLocalPoint(e.clientX, e.clientY);
    if (!current) return;
    setMarqueeRect(rectFromPoints(mq.start, current));
  };

  const handleTrackPointerUp = (e: ReactPointerEvent<HTMLDivElement>) => {
    const mq = marqueeRef.current;
    if (!mq || mq.pointerId !== e.pointerId) return;
    marqueeRef.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    setMarqueeRect(null);
    const end = contentLocalPoint(e.clientX, e.clientY) ?? mq.start;
    const distance = Math.hypot(end.x - mq.start.x, end.y - mq.start.y);

    if (distance < KEY_DRAG_MIN_PX) {
      // A plain click (never became a real drag). No modifier: the
      // ordinary click-to-select-lane-and-seek behaviour (unchanged from
      // D-161/162), PLUS "click away" clears the key-selection — D-158's
      // own rule for its 2D canvas marquee, reused here. A modifier-held
      // sub-threshold press arms NOTHING (D-137/D-158's own rule for a
      // press that never became a real gesture): no seek, no selection
      // change either way.
      if (!mq.additive) {
        setKeySelection([]);
        const f = frameFromClientX(e.clientX, e.currentTarget);
        selectAndMaybeSeek(mq.lane, f ?? undefined);
      }
      return;
    }

    const rect = rectFromPoints(mq.start, end);
    const hits = keysInMarqueeRect(manifest, lanes, rect, total, trackW, timelineLayout);
    setKeySelection(mq.additive ? unionKeySelectionEntries(mq.baseSelection, hits) : hits);
  };

  return (
    <div className="h-full w-full flex flex-col min-h-0 border-t border-border-color bg-bg-secondary">
      <div className="shrink-0 h-6 flex items-center justify-between gap-2 px-2 border-b border-border-color text-[10px] text-text-secondary">
        <span className="uppercase tracking-wide">Keyframes</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            className="h-5 w-5 flex items-center justify-center rounded hover:bg-hover-color disabled:opacity-30"
            title="Zoom out (or ctrl+scroll down over the timeline)"
            aria-label="Zoom out"
            disabled={pxPerSecond <= MIN_PX_PER_SEC}
            onClick={() => setPxPerSecond((v) => zoomStep(v, -1))}
          >
            <ZoomOut size={12} />
          </button>
          {/* D-175 — a percentage relative to `DEFAULT_PX_PER_SEC`, matching
              `@chroma/editor`'s own `TimelinePane.tsx` zoom readout exactly
              (`zoomPct = Math.round((pxPerSec / DEFAULT_PX_PER_SEC) * 100)`)
              — was a raw `px/s` number, meaningless without knowing this
              timeline's own bounds; "100%" reads the same way across both
              tabs even though the underlying `pxPerSecond` RANGES are
              deliberately different (D-162's own note: this timeline has no
              video-decimation ladder to bracket, so its bounds are sized for
              its own screen real estate, not reused from `ruler.ts`). */}
          <span className="tabular-nums w-9 text-center">
            {Math.round((pxPerSecond / DEFAULT_PX_PER_SEC) * 100)}%
          </span>
          <button
            type="button"
            className="h-5 w-5 flex items-center justify-center rounded hover:bg-hover-color disabled:opacity-30"
            title="Zoom in (or ctrl+scroll up over the timeline)"
            aria-label="Zoom in"
            disabled={pxPerSecond >= MAX_PX_PER_SEC}
            onClick={() => setPxPerSecond((v) => zoomStep(v, 1))}
          >
            <ZoomIn size={12} />
          </button>
        </div>
      </div>

      {lanes.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-[11px] text-text-secondary text-center px-6">
          No keyframes yet — add a camera or layer keyframe (Inspector) to see it here.
        </div>
      ) : (
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-auto">
          <div ref={contentRef} className="relative flex flex-col" style={{ width: LANE_LABEL_WIDTH + trackW }}>
            {/* the shared ruler — sticky top, its own corner cell sticky on
                both axes (the standard "frozen row + frozen column" trick). */}
            <div
              className="flex sticky top-0 z-20 bg-bg-secondary border-b border-border-color"
              style={{ height: RULER_HEIGHT }}
            >
              <div
                className="sticky left-0 z-10 shrink-0 bg-bg-secondary border-r border-border-color"
                style={{ width: LANE_LABEL_WIDTH }}
              />
              <div
                data-lane-track
                className="relative shrink-0 cursor-pointer"
                style={{ width: trackW }}
                title="Click to seek"
                onClick={(e) => playerRef.current?.seekTo(frameFromClientX(e.clientX, e.currentTarget) ?? 0)}
              >
                {ticks.map((t) => (
                  <div
                    key={`tick-${t.frame}`}
                    className="absolute top-0 bottom-0 flex flex-col justify-end"
                    style={{ left: `${frameToPercent(t.frame, total)}%` }}
                  >
                    <span className="absolute bottom-0.5 left-1 text-[9px] text-text-secondary whitespace-nowrap select-none">
                      {t.label}
                    </span>
                    <div className="w-px h-1.5 bg-border-color" />
                  </div>
                ))}
                {boundaries.map((f) => (
                  <div
                    key={`boundary-${f}`}
                    className="pointer-events-none absolute top-0 bottom-0 w-px bg-border-color"
                    style={{ left: `${frameToPercent(f, total)}%` }}
                  />
                ))}
                <div
                  className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent"
                  style={{ left: `${frameToPercent(frame, total)}%` }}
                />
              </div>
            </div>

            {lanes.map((lane) => {
              const key = laneKey(lane);
              const markers = laneKeyMarkers(manifest, lane);
              const sceneStart = sceneStartFrame(manifest, lane.sceneIndex);
              const sceneEnd =
                lane.sceneIndex + 1 < manifest.scenes.length ? sceneStartFrame(manifest, lane.sceneIndex + 1) : total;
              const selected = isSelected(lane);
              return (
                <div key={key} className="flex border-b border-border-color/60" style={{ height: LANE_HEIGHT }}>
                  <button
                    type="button"
                    className={[
                      'sticky left-0 z-10 shrink-0 flex items-center px-2 text-[10px] truncate text-left border-r border-border-color',
                      selected ? 'bg-accent text-button-text' : 'bg-bg-secondary text-text-secondary hover:text-text-primary',
                    ].join(' ')}
                    style={{ width: LANE_LABEL_WIDTH }}
                    title={laneLabel(manifest, lane)}
                    onClick={() => selectAndMaybeSeek(lane)}
                  >
                    <span className="truncate">{laneLabel(manifest, lane)}</span>
                  </button>
                  <div
                    data-lane-track
                    className={['relative shrink-0 cursor-pointer', selected ? 'bg-accent/10' : ''].join(' ')}
                    style={{ width: trackW }}
                    title="Click to seek and select — drag a rectangle to box-select keys"
                    onPointerDown={(e) => handleTrackPointerDown(e, lane)}
                    onPointerMove={handleTrackPointerMove}
                    onPointerUp={handleTrackPointerUp}
                  >
                    {/* the lane's own scene span — everywhere else on this
                        row's track is time this layer/camera doesn't exist
                        in, shaded differently so that's visible at a
                        glance. */}
                    <div
                      className="pointer-events-none absolute top-0 bottom-0 bg-text-secondary/5"
                      style={{
                        left: `${frameToPercent(sceneStart, total)}%`,
                        width: `${frameToPercent(sceneEnd, total) - frameToPercent(sceneStart, total)}%`,
                      }}
                    />
                    {boundaries.map((f) => (
                      <div
                        key={`b-${f}`}
                        className="pointer-events-none absolute top-0 bottom-0 w-px bg-border-color/40"
                        style={{ left: `${frameToPercent(f, total)}%` }}
                      />
                    ))}
                    {markers.map((m) => {
                      const keySelected = isKeySelected(lane, m);
                      return (
                        <button
                          key={`k-${m.keyIndex}`}
                          type="button"
                          data-key-marker
                          className={[
                            'absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border',
                            keySelected
                              ? 'border-accent bg-button-text ring-2 ring-accent'
                              : lane.kind === 'layer' || lane.kind === 'active'
                                ? 'border-accent bg-accent'
                                : 'border-text-secondary bg-bg-primary',
                            draggable ? 'cursor-ew-resize' : 'cursor-pointer',
                          ].join(' ')}
                          style={{ left: `${frameToPercent(displayFrame(lane, m), total)}%` }}
                          title={`Key @ frame ${displayFrame(lane, m)}${draggable ? ' — drag to retime, shift-click to box-select' : ''}`}
                          onClick={(e) => {
                            e.stopPropagation();
                            // Shift-click is handled entirely by
                            // `handleMarkerPointerDown` above (toggles
                            // key-selection, never seeks/selects the lane)
                            // — this native `click` (which still fires
                            // afterward, since neither handler calls
                            // `preventDefault`) must not ALSO perform the
                            // ordinary click behaviour on top of it.
                            if (!draggable && !e.shiftKey) selectAndMaybeSeek(lane, m.frame);
                          }}
                          {...markerHandlers(lane, m)}
                        />
                      );
                    })}
                    <div
                      className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent"
                      style={{ left: `${frameToPercent(frame, total)}%` }}
                    />
                  </div>
                </div>
              );
            })}

            {/* the marquee band itself, while a box-select drag is in
                flight — content-local px, drawn as a child of the SAME
                content div the marquee's own coordinates are measured
                against (D-158's `MotionCanvasOverlay.tsx` equivalent draws
                its band container-local for the identical reason). */}
            {marqueeRect && (
              <div
                className="pointer-events-none absolute z-[15] border border-accent bg-accent/10"
                style={{
                  left: marqueeRect.left,
                  top: marqueeRect.top,
                  width: marqueeRect.width,
                  height: marqueeRect.height,
                }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  );
}
