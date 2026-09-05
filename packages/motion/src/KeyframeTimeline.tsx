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
 * a number.
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
 */
import { useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent, RefObject } from 'react';
import type { PlayerRef } from '@remotion/player';
import { totalFrames, sceneStartFrame } from '@chroma/motion-engine/src/engine/build';
import type { Manifest } from '@chroma/motion-engine/src/engine/schema';

import type { Selection } from './LayerList';
import { sameSelection, layerLabel } from './LayerList';
import {
  keyframeLanes,
  laneKey,
  laneKeyMarkers,
  selectionForLane,
  sceneBoundaryFrames,
  frameToPercent,
  percentToFrame,
  type KeyframeLane,
  type KeyMarker,
} from './keyframeVisibility';
import { moveCamera2dKeyAt, moveCamera3dKeyAt, moveLayerTransformKeyAt } from './manifestEdit';
import { rulerTicks } from './timelineRuler';
import { MIN_PX_PER_SEC, MAX_PX_PER_SEC, DEFAULT_PX_PER_SEC, zoomStep, trackWidthPx } from './timelineZoom';

const LANE_LABEL_WIDTH = 148;
const RULER_HEIGHT = 20;
const LANE_HEIGHT = 26;

/** Same physical-distance bar `MotionCanvasOverlay.tsx`'s own marquee and
 *  D-161's flat-strip drag both use — duplicated as a literal with a doc
 *  comment pointing at its own precedent (D-161's own reasoning: one
 *  duplicated numeric constant is cheaper than a new cross-file module for
 *  a single shared number). */
const KEY_DRAG_MIN_PX = 4;

/** In-flight key-drag state — a ref, not React state, for the identical
 *  reason `KeyframeStrip.tsx`'s own `KeyDragState` was (D-161): a
 *  pointermove firing at display refresh rate has no business going through
 *  a re-render to read its own drag origin back. `lane`/`marker` are the
 *  ORIGINAL values captured at `pointerdown`, from the STABLE manifest —
 *  never re-read from a later, possibly-reordered render (see the module
 *  doc comment's "per-row drag" section). */
interface KeyDragState {
  pointerId: number;
  lane: KeyframeLane;
  marker: KeyMarker;
  startClientX: number;
}

function labelForLaneKind(kind: KeyframeLane['kind']): string {
  switch (kind) {
    case 'camera':
      return 'Move camera keyframe';
    case 'scene3d-camera':
      return 'Move 3D camera keyframe';
    case 'layer':
      return 'Move layer keyframe';
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
  const kind =
    lane.kind === 'camera'
      ? 'Camera'
      : lane.kind === 'scene3d-camera'
        ? '3D Camera'
        : lane.layerIndex !== undefined && scene?.layers?.[lane.layerIndex]
          ? layerLabel(scene.layers[lane.layerIndex])
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
  // The one dragged marker's LIVE position while a drag is in flight —
  // scoped by `{laneKeyStr, keyIndex}` rather than re-deriving the whole
  // lane/marker list from a transient manifest — see the module doc
  // comment's "per-row drag" section for why (D-161's own finding, now
  // additionally keyed by lane since two layers can share a `keyIndex`).
  const [dragPreview, setDragPreview] = useState<{ laneKeyStr: string; keyIndex: number; frame: number } | null>(
    null,
  );

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

  // Escape cancels an in-flight key-drag — D-161's own precedent, unchanged.
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

  const isSelected = (lane: KeyframeLane): boolean => {
    const sel = selectionForLane(manifest, lane);
    return !!sel && selections.some((s) => sameSelection(s, sel));
  };

  const isDragPreview = (lane: KeyframeLane, m: KeyMarker) =>
    !!dragPreview && dragPreview.laneKeyStr === laneKey(lane) && dragPreview.keyIndex === m.keyIndex;

  const displayFrame = (lane: KeyframeLane, m: KeyMarker) => (isDragPreview(lane, m) ? dragPreview!.frame : m.frame);

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

  /** The manifest a key-drag WOULD produce if released/previewed at
   *  `absFrame` right now — always recomputed from the STABLE `manifest`
   *  captured in this render plus `drag`'s own drag-start snapshot, never
   *  from a previous call's own output (D-161's own discipline,
   *  unchanged). */
  const nextManifestForDrag = (drag: KeyDragState, absFrame: number): Manifest | null => {
    const atSeconds = (absFrame - sceneStartFrame(manifest, drag.lane.sceneIndex)) / manifest.fps;
    if (drag.lane.kind === 'camera') {
      return moveCamera2dKeyAt(manifest, drag.lane.sceneIndex, drag.marker.keyIndex, atSeconds);
    }
    if (drag.lane.kind === 'scene3d-camera') {
      return moveCamera3dKeyAt(manifest, drag.lane.sceneIndex, drag.marker.keyIndex, atSeconds);
    }
    if (drag.lane.kind === 'layer' && drag.lane.layerIndex !== undefined) {
      return moveLayerTransformKeyAt(
        manifest,
        { sceneIndex: drag.lane.sceneIndex, target: { kind: 'layer', index: drag.lane.layerIndex } },
        drag.marker.keyIndex,
        atSeconds,
      );
    }
    return null;
  };

  const selectAndMaybeSeek = (lane: KeyframeLane, seekFrame?: number) => {
    const sel = selectionForLane(manifest, lane);
    if (sel) onSelect?.(sel);
    if (seekFrame !== undefined) playerRef.current?.seekTo(seekFrame);
  };

  const handleTrackClick = (e: ReactMouseEvent<HTMLDivElement>, lane: KeyframeLane) => {
    const f = frameFromClientX(e.clientX, e.currentTarget);
    selectAndMaybeSeek(lane, f ?? undefined);
  };

  const handleMarkerPointerDown = (e: ReactPointerEvent<HTMLButtonElement>, lane: KeyframeLane, marker: KeyMarker) => {
    if (!draggable) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    dragRef.current = { pointerId: e.pointerId, lane, marker, startClientX: e.clientX };
  };

  const handleMarkerPointerMove = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== e.pointerId) return;
    if (Math.abs(e.clientX - drag.startClientX) < KEY_DRAG_MIN_PX) return; // not a real drag yet
    const trackEl = e.currentTarget.closest<HTMLElement>('[data-lane-track]');
    const absFrame = frameFromClientX(e.clientX, trackEl);
    if (absFrame === null) return;
    setDragPreview({ laneKeyStr: laneKey(drag.lane), keyIndex: drag.marker.keyIndex, frame: absFrame });
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
      // A plain click on a marker — jump to its own (un-retimed) frame, and
      // select its own lane (the layer/camera it belongs to), the same
      // "clicking anything in this row makes it the active selection"
      // behaviour the row's own background/label clicks already have.
      selectAndMaybeSeek(drag.lane, drag.marker.frame);
      return;
    }
    const absFrame = frameFromClientX(e.clientX, e.currentTarget.closest<HTMLElement>('[data-lane-track]'));
    onTransientChange?.(null);
    if (absFrame === null) return;
    const next = nextManifestForDrag(drag, absFrame);
    if (next) onCommit?.(next, labelForLaneKind(drag.lane.kind));
  };

  const markerHandlers = (lane: KeyframeLane, m: KeyMarker) => ({
    onPointerDown: (e: ReactPointerEvent<HTMLButtonElement>) => handleMarkerPointerDown(e, lane, m),
    onPointerMove: handleMarkerPointerMove,
    onPointerUp: handleMarkerPointerUp,
  });

  return (
    <div className="h-full w-full flex flex-col min-h-0 border-t border-border-color bg-bg-secondary">
      <div className="shrink-0 h-6 flex items-center justify-between gap-2 px-2 border-b border-border-color text-[10px] text-text-secondary">
        <span className="uppercase tracking-wide">Keyframes</span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            className="h-4 w-4 flex items-center justify-center rounded hover:bg-hover-color disabled:opacity-30"
            title="Zoom out"
            disabled={pxPerSecond <= MIN_PX_PER_SEC}
            onClick={() => setPxPerSecond((v) => zoomStep(v, -1))}
          >
            −
          </button>
          <span className="tabular-nums w-12 text-center">{Math.round(pxPerSecond)}px/s</span>
          <button
            type="button"
            className="h-4 w-4 flex items-center justify-center rounded hover:bg-hover-color disabled:opacity-30"
            title="Zoom in"
            disabled={pxPerSecond >= MAX_PX_PER_SEC}
            onClick={() => setPxPerSecond((v) => zoomStep(v, 1))}
          >
            +
          </button>
        </div>
      </div>

      {lanes.length === 0 ? (
        <div className="flex-1 min-h-0 flex items-center justify-center text-[11px] text-text-secondary text-center px-6">
          No keyframes yet — add a camera or layer keyframe (Inspector) to see it here.
        </div>
      ) : (
        <div className="flex-1 min-h-0 overflow-auto">
          <div className="flex flex-col" style={{ width: LANE_LABEL_WIDTH + trackW }}>
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
                    title="Click to seek and select — diamonds are keyframes"
                    onClick={(e) => handleTrackClick(e, lane)}
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
                    {markers.map((m) => (
                      <button
                        key={`k-${m.keyIndex}`}
                        type="button"
                        className={[
                          'absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rotate-45 border',
                          lane.kind === 'layer' ? 'border-accent bg-accent' : 'border-text-secondary bg-bg-primary',
                          draggable ? 'cursor-ew-resize' : 'cursor-pointer',
                        ].join(' ')}
                        style={{ left: `${frameToPercent(displayFrame(lane, m), total)}%` }}
                        title={`Key @ frame ${displayFrame(lane, m)}${draggable ? ' — drag to retime' : ''}`}
                        onClick={(e) => {
                          e.stopPropagation();
                          if (!draggable) selectAndMaybeSeek(lane, m.frame);
                        }}
                        {...(draggable ? markerHandlers(lane, m) : {})}
                      />
                    ))}
                    <div
                      className="pointer-events-none absolute top-0 bottom-0 w-px bg-accent"
                      style={{ left: `${frameToPercent(frame, total)}%` }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
