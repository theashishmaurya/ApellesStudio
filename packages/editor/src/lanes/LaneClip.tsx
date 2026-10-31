/**
 * @apelles/editor — one clip in a lane (D-437 S3a, plan §2.1–2.2).
 *
 * What it is: the memoised unit of the lane renderer. A positioning SLOT
 * (`left`/`width` in content px, set at render time and constant while
 * scrolling — `transform` is reserved for the edit gestures, which write it on
 * the body inside) wrapping `ClipBody` → `ClipBlock`, `ClipFadeOverlay` and the
 * two trim zones: exactly what `TimelinePane.getActionRender` returned for the
 * library's "action", now as its own component.
 *
 * Why `React.memo`: every prop is a primitive or a stable identity (`clip`
 * objects are `===` across a commit that did not touch them — `shareUnchanged`,
 * F4; `actions` never changes — `useLaneActions`), so one changed clip, or one
 * selection flip, re-renders ONE `LaneClip` and not the lane. The React
 * Compiler does not memoise per item of a `.map`, hence explicit `memo`.
 *
 * Paint isolation (plan §2.9): the slot is `contain: layout size style`, NOT
 * `paint` — a head trim translates the body outside its slot, and paint
 * containment would clip it. The body keeps its own `contain: layout paint
 * style`. No `will-change` at rest.
 *
 * What it does NOT do: choose which clips exist (`laneWindow.ts`), compute its
 * own geometry (the lane passes it), or know what a click means (`actions`).
 */
import { memo } from 'react';
import { ClipBlock, CLIP_KIND_CLASSES } from '../ClipBlock';
import { ClipFadeOverlay } from '../ClipFadeOverlay';
import { CLIP_VERTICAL_INSET_PX, clipAnatomy, type ClipKind } from '../clipAnatomy';
import type { Clip, ClipKeyframeParam } from '../timeline';
import { TIMELINE_TEST_IDS } from '../timelineTestIds';
import { ClipBody } from './ClipBody';
import { TRIM_ZONE_MAX_FRACTION, TRIM_ZONE_PX } from './laneLayout';
import type { LaneActions } from './useLaneActions';

export interface LaneClipProps {
  clip: Clip;
  trackIndex: number;
  /** Index of `clip` in its track's `clips` (what `set_clip_fade` addresses). */
  clipIndex: number;
  kind: ClipKind;
  trackHeight: number;
  /** Slot box in content px. */
  leftPx: number;
  widthPx: number;
  fps: number;
  pxPerSec: number;
  bandRatio: number;
  showName: boolean;
  showBadges: boolean;
  selected: boolean;
  /** The selected clip's A/V-linked half (D-128). Never true when `selected`. */
  avLinked: boolean;
  /** Touched by a ripple from the selection (sync lock). Never true when `selected`. */
  syncLinked: boolean;
  locked: boolean;
  /** How the cut at this clip's left edge is drawn (`cutStyleAt`). */
  cut: 'none' | 'cut' | 'through';
  /** The property the curve lane would open on, or `null` if nothing is animated. */
  curveParam: ClipKeyframeParam | null;
  /** This clip's curve lane is the open one. */
  curveOpen: boolean;
  /** The on-screen slice of this clip, px from its own left edge (clamped and
   *  bucketed by `visibleSlice`), so the filmstrip and waveform fetch only that. */
  visibleStartPx: number;
  visibleEndPx: number;
  actions: LaneActions;
}

export const LaneClip = memo(function LaneClip({
  clip,
  trackIndex,
  clipIndex,
  kind,
  trackHeight,
  leftPx,
  widthPx,
  fps,
  pxPerSec,
  bandRatio,
  showName,
  showBadges,
  selected,
  avLinked,
  syncLinked,
  locked,
  cut,
  curveParam,
  curveOpen,
  visibleStartPx,
  visibleEndPx,
  actions,
}: LaneClipProps) {
  const anatomy = clipAnatomy(trackHeight, kind, bandRatio);
  const trimZonePx = Math.min(TRIM_ZONE_PX, widthPx * TRIM_ZONE_MAX_FRACTION);
  return (
    <div
      data-testid={TIMELINE_TEST_IDS.clipSlot}
      data-chroma-clip-slot=""
      className="absolute top-0"
      style={{ left: leftPx, width: widthPx, height: trackHeight, contain: 'layout size style' }}
      onClick={(e) => actions.onClipClick(e, trackIndex, clip.id)}
    >
      <ClipBody
        track={trackIndex}
        clipId={clip.id}
        linkPartner={avLinked}
        onPointerDownCapture={(e) => actions.onClipPointerDownCapture(e, trackIndex, clip.id)}
        className={
          // D-432 §4.3 — the FCP clip: opaque kind colour, a 2 px radius, a
          // 1 px inset top and bottom inside the lane. `group/clip` lets the
          // fade handles reveal on hover (D-207). The ::after is the hover
          // wash, pre-laid so hovering recomputes no colour.
          'group/clip absolute inset-x-0 overflow-hidden rounded-xs ' +
          CLIP_KIND_CLASSES[kind].body +
          " after:pointer-events-none after:absolute after:inset-0 after:content-[''] hover:after:bg-white/5" +
          // States (§4.3): outlines and opacity only — never a box-shadow
          // `ring` (painted OUTSIDE the clip, over its neighbours) and never a
          // filter. Drawn on a pre-laid ::before above the clip's own strip
          // and bands (an outline on the body itself is painted UNDER its
          // positioned children, so the strip would hide the top edge of it).
          ' before:pointer-events-none before:absolute before:inset-0 before:z-(--z-timeline-clip-controls)' +
          " before:rounded-xs before:content-['']" +
          (selected ? ' before:outline-2 before:-outline-offset-2 before:outline-selection' : '') +
          (avLinked ? ' before:outline-1 before:-outline-offset-1 before:outline-selection/55' : '') +
          (syncLinked && !avLinked ? ' before:outline-1 before:-outline-offset-1 before:outline-white/35' : '') +
          (locked ? ' opacity-60' : '')
        }
        style={{ top: CLIP_VERTICAL_INSET_PX, bottom: CLIP_VERTICAL_INSET_PX, contain: 'layout paint style' }}
      >
        <ClipBlock
          clip={clip}
          kind={kind}
          trackHeight={trackHeight}
          bandRatio={bandRatio}
          showName={showName}
          showBadges={showBadges}
          widthPx={widthPx}
          fps={fps}
          visibleStartPx={visibleStartPx}
          visibleEndPx={visibleEndPx}
          cut={cut}
          keyframed={curveParam !== null}
          curveOpen={curveOpen}
          onToggleCurve={() =>
            // Off when this clip's lane is already open; otherwise open on its
            // first animated property (the lane's header switches it).
            actions.onToggleCurve(trackIndex, clip.id, curveOpen || !curveParam ? null : curveParam)
          }
        />
        {/* D-207 — the fade ramps and their handles, under the name strip (§4.5).
            Its own component, so a fade drag re-renders one clip. */}
        <ClipFadeOverlay
          track={trackIndex}
          clipIndex={clipIndex}
          clip={clip}
          widthPx={widthPx}
          heightPx={anatomy.height}
          topPx={anatomy.labelsOnly ? 0 : anatomy.strip}
          fps={fps}
          pxPerSec={pxPerSec}
          disabled={locked}
        />
        {/* D-432 §4.4 — the clip's own edge-trim zones (B-344): invisible,
            `col-resize`, ≥ 8 px. Their press is claimed by `useEditGesture` in
            the capture phase above. A locked track offers none. */}
        {!locked && (
          <>
            <div
              data-testid={TIMELINE_TEST_IDS.clipTrimStart}
              data-chroma-trim-edge="start"
              className="absolute inset-y-0 left-0 z-(--z-timeline-clip-controls) cursor-col-resize"
              style={{ width: trimZonePx }}
            />
            <div
              data-testid={TIMELINE_TEST_IDS.clipTrimEnd}
              data-chroma-trim-edge="end"
              className="absolute inset-y-0 right-0 z-(--z-timeline-clip-controls) cursor-col-resize"
              style={{ width: trimZonePx }}
            />
          </>
        )}
      </ClipBody>
    </div>
  );
});
