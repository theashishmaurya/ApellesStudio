/**
 * @apelles/editor — one track's lane (D-437 S3a, plan §2.1, §2.9).
 *
 * What it is: an absolutely positioned row (`top` = the track's `rowTops[i]`,
 * `height` = its P3 height) inside the scroller's content, holding a `LaneClip`
 * per clip the window selects plus every pinned clip. `contain: strict` (size,
 * layout, paint, style — its size is explicit) means paint invalidation inside
 * one lane never reaches another lane or the scroller. Its bottom border is the
 * row line (one fewer positioned div per track than the overlay it replaces).
 *
 * Not memoised: its loop over the visible clips plus k `memo` comparisons costs
 * microseconds, and `LaneClip` is where the render cost lives.
 *
 * What it does NOT do: window computation (given), selection rules (flags in),
 * or anything scroll-dependent beyond the bucketed viewport it is handed.
 */
import { animatedParams } from '../clipKeyframes';
import { clipKindOf } from '../clipAnatomy';
import type { CurveEditorTarget } from '../timelineStore';
import type { Track } from '../timeline';
import { TIMELINE_TEST_IDS } from '../timelineTestIds';
import { LaneClip } from './LaneClip';
import { clipLeftPx, clipWidthPx, visibleSlice } from './laneLayout';
import { windowClipIndices, type LaneFrameWindow } from './laneWindow';
import type { LaneActions } from './useLaneActions';

/** The filmstrip/waveform slice is rounded outward to this many px, so a
 *  clip straddling the viewport edge re-renders once per 200 px of scroll
 *  rather than per pixel (D-128). */
export const SLICE_BUCKET_PX = 200;

export interface TrackLaneProps {
  track: Track;
  trackIndex: number;
  /** The track's label ("V1"), for the lane's accessible name. */
  label: string;
  top: number;
  height: number;
  /** Lane width = the scroller content's width, px. */
  contentWidthPx: number;
  frameWindow: LaneFrameWindow | null;
  /** Clip ids rendered wherever they are (selection, drag source, gesture target, focus). */
  pinnedIds: ReadonlySet<string>;
  /** Selected clip ids on THIS track. */
  selectedIds: ReadonlySet<string>;
  syncLinkedIds: ReadonlySet<string>;
  avLinkedIds: ReadonlySet<string>;
  cutStyleById: ReadonlyMap<string, 'none' | 'cut' | 'through'>;
  curveEditor: CurveEditorTarget | null;
  fps: number;
  pxPerSec: number;
  startLeftPx: number;
  /** The viewport in content px, for each clip's visible slice. */
  viewStartPx: number;
  viewEndPx: number;
  bandRatio: number;
  showClipNames: boolean;
  showClipBadges: boolean;
  actions: LaneActions;
}

export function TrackLane({
  track,
  trackIndex,
  label,
  top,
  height,
  contentWidthPx,
  frameWindow,
  pinnedIds,
  selectedIds,
  syncLinkedIds,
  avLinkedIds,
  cutStyleById,
  curveEditor,
  fps,
  pxPerSec,
  startLeftPx,
  viewStartPx,
  viewEndPx,
  bandRatio,
  showClipNames,
  showClipBadges,
  actions,
}: TrackLaneProps) {
  const locked = !!track.locked;
  return (
    <div
      role="group"
      aria-label={label}
      data-testid={TIMELINE_TEST_IDS.trackRow}
      data-chroma-track={trackIndex}
      // D-437 S4 — the library-era row class is an inert alias (S6 deletes it).
      className="absolute left-0 border-b border-border-color/60"
      style={{ top, height, width: contentWidthPx, contain: 'strict' }}
    >
      {windowClipIndices(track, frameWindow, fps, pinnedIds).map((clipIndex) => {
        const clip = track.clips[clipIndex];
        const leftPx = clipLeftPx(clip.start_frame, fps, pxPerSec, startLeftPx);
        const widthPx = clipWidthPx(clip, fps, pxPerSec);
        const slice = visibleSlice(leftPx, widthPx, viewStartPx, viewEndPx, SLICE_BUCKET_PX);
        const selected = selectedIds.has(clip.id);
        const curveParam = animatedParams(clip.chroma_keyframes)[0] ?? null;
        return (
          <LaneClip
            key={clip.id}
            clip={clip}
            trackIndex={trackIndex}
            clipIndex={clipIndex}
            kind={clipKindOf(clip, track.kind)}
            trackHeight={height}
            leftPx={leftPx}
            widthPx={widthPx}
            fps={fps}
            pxPerSec={pxPerSec}
            bandRatio={bandRatio}
            showName={showClipNames}
            showBadges={showClipBadges}
            selected={selected}
            // D-128 / sync lock: secondary states, never the selection's own look.
            avLinked={!selected && avLinkedIds.has(clip.id)}
            syncLinked={!selected && syncLinkedIds.has(clip.id)}
            locked={locked}
            cut={cutStyleById.get(clip.id) ?? 'none'}
            curveParam={curveParam}
            curveOpen={curveEditor?.track === trackIndex && curveEditor?.id === clip.id}
            visibleStartPx={slice.start}
            visibleEndPx={slice.end}
            actions={actions}
          />
        );
      })}
    </div>
  );
}
