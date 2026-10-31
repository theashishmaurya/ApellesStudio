/**
 * @apelles/editor — the timeline's lanes (D-437 S3a; plan `docs/notes/timeline-lanes.md`
 * §2.1–2.4, §2.8–2.9).
 *
 * What it is: Apelles' own replacement for `@xzdarcy/react-timeline-editor`'s edit
 * area. ONE native scroller (both axes, `overflow: auto` — the DOM is the single
 * source of the scroll position, so the library's two-copy echo loop, B-291,
 * cannot exist) starting at `topPx` in edit-area coordinates, holding a content
 * box `contentWidth × rowsHeight` and one `TrackLane` per track. Clips are
 * positioned with `left`/`width` in content px, so native scrolling moves them
 * with no JS.
 *
 * Culling: only the clips in the scroll window (`laneWindow.ts`: one viewport of
 * overscan each side, re-render threshold half a viewport) plus the pinned ones
 * (selection, the drag source, the gesture target — passed in — and the focused
 * clip, tracked here) are mounted. The caller passes `windowLeft`, the scroll
 * position already floored to the window bucket (`windowScrollLeft`), so a scroll
 * inside a bucket is not a prop change and re-renders nothing here. A
 * `viewportWidth` of 0 (not measured: hidden tab, jsdom) means no culling.
 *
 * Accessibility: the scroller is `tabIndex={-1}` (it never steals Tab) and a
 * labelled group; each lane is a group labelled with its track label. Off-screen
 * clips are not in the accessibility tree, like any virtualised list.
 *
 * Rendered by `TimelinePane` since D-437 S4 (in place of the library). What it
 * does NOT do: own selection or editing (`actions`), draw overlays (ruler,
 * markers, transitions, the playhead — `Playhead.tsx` — stay separate), or read
 * the store.
 */
import { memo, useState, type FocusEvent, type Ref, type UIEventHandler } from 'react';
import type { Selection, CurveEditorTarget } from '../timelineStore';
import type { Track } from '../timeline';
import { contentWidth } from './laneLayout';
import { laneIndexOf, laneWindow, laneWindowParams } from './laneWindow';
import { TrackLane } from './TrackLane';
import type { LaneActions } from './useLaneActions';
import { TIMELINE_LIBRARY_ALIAS_CLASSES, TIMELINE_TEST_IDS } from '../timelineTestIds';

export interface TimelineLanesProps {
  tracks: readonly Track[];
  /** Each track's label ("V1"), same order as `tracks`. */
  trackLabels: readonly string[];
  fps: number;
  pxPerSec: number;
  /** px before frame 0 (`START_LEFT_PX`). */
  startLeftPx: number;
  /** The ruler's tick interval, seconds (`niceTickIntervalSeconds`): sets the content width. */
  tickSeconds: number;
  /** Each track's top and height inside the content box (P3), px. */
  rowTops: readonly number[];
  rowHeights: readonly number[];
  /** Where the scroller starts, px from the top of the edit area. */
  topPx: number;
  /** The scroller's measured width (0 = unmeasured → no culling). */
  viewportWidth: number;
  /** `scrollLeft` floored to the window bucket — `windowScrollLeft(scrollLeft, viewportWidth)`. */
  windowLeft: number;
  bandRatio: number;
  showClipNames: boolean;
  showClipBadges: boolean;
  selection: readonly Selection[];
  syncLinkedIds: ReadonlySet<string>;
  avLinkedIds: ReadonlySet<string>;
  cutStyleById: ReadonlyMap<string, 'none' | 'cut' | 'through'>;
  curveEditor: CurveEditorTarget | null;
  /** Clip ids to keep mounted regardless of the window: the dnd-kit drag source and
   *  the edit gesture's target. Selection and focus are pinned by the lanes themselves. */
  pinnedClipIds?: ReadonlySet<string>;
  /** A stable object (`useLaneActions`). */
  actions: LaneActions;
  /** The scroller element, for imperative scroll writes and its scroll listener. */
  scrollerRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}

const NO_PINS: ReadonlySet<string> = new Set();
/** The focused clip's id, from a `focus` event target inside the lanes. */
function clipIdOf(target: EventTarget): string | null {
  return target instanceof Element ? (target.closest('[data-chroma-clip-id]')?.getAttribute('data-chroma-clip-id') ?? null) : null;
}

export const TimelineLanes = memo(function TimelineLanes({
  tracks,
  trackLabels,
  fps,
  pxPerSec,
  startLeftPx,
  tickSeconds,
  rowTops,
  rowHeights,
  topPx,
  viewportWidth,
  windowLeft,
  bandRatio,
  showClipNames,
  showClipBadges,
  selection,
  syncLinkedIds,
  avLinkedIds,
  cutStyleById,
  curveEditor,
  pinnedClipIds = NO_PINS,
  actions,
  scrollerRef,
  onScroll,
}: TimelineLanesProps) {
  // The focused clip must not be unmounted by culling (it would drop keyboard focus).
  const [focusedId, setFocusedId] = useState<string | null>(null);

  let endFrameMax = 0;
  for (const t of tracks) {
    if (t.clips.length === 0) continue;
    const ix = laneIndexOf(t, fps);
    endFrameMax = Math.max(endFrameMax, ix.maxEndPrefix[ix.maxEndPrefix.length - 1]);
  }
  const widthPx = contentWidth(endFrameMax / fps, tickSeconds, pxPerSec, startLeftPx);
  const lastIndex = tracks.length - 1;
  const heightPx = lastIndex >= 0 ? (rowTops[lastIndex] ?? 0) + (rowHeights[lastIndex] ?? 0) : 0;

  const params = laneWindowParams(viewportWidth);
  const frameWindow = laneWindow({
    scrollLeft: windowLeft,
    viewportWidth,
    pxPerSec,
    fps,
    startLeftPx,
    overscanPx: params.overscanPx,
    bucketPx: params.bucketPx,
  });
  // Every viewport inside this scroll bucket lies in [windowLeft, windowLeft + bucket + viewport].
  const viewStartPx = windowLeft;
  const viewEndPx = windowLeft + params.bucketPx + viewportWidth;

  const pinned = new Set<string>(pinnedClipIds);
  for (const s of selection) pinned.add(s.id);
  if (focusedId !== null) pinned.add(focusedId);
  const selectedByTrack = new Map<number, Set<string>>();
  for (const s of selection) {
    const ids = selectedByTrack.get(s.track) ?? new Set<string>();
    ids.add(s.id);
    selectedByTrack.set(s.track, ids);
  }

  const onFocus = (e: FocusEvent<HTMLDivElement>) => setFocusedId(clipIdOf(e.target));
  const onBlur = () => setFocusedId(null);

  return (
    <div
      ref={scrollerRef}
      role="group"
      aria-label="Timeline tracks"
      tabIndex={-1}
      data-testid={TIMELINE_TEST_IDS.scroller}
      // D-437 S4 — the library-era scroller class is an inert alias (S6 deletes it).
      className={`${TIMELINE_LIBRARY_ALIAS_CLASSES.scroller} absolute right-0 bottom-0 left-0 overflow-auto outline-none`}
      style={{ top: topPx }}
      onScroll={onScroll}
      onFocus={onFocus}
      onBlur={onBlur}
    >
      <div className="relative" style={{ width: widthPx, minWidth: '100%', height: heightPx, minHeight: '100%' }}>
        {tracks.map((track, i) => (
          <TrackLane
            // Lanes have no identity of their own (a track is addressed by index everywhere).
            key={i}
            track={track}
            trackIndex={i}
            label={trackLabels[i] ?? `Track ${i + 1}`}
            top={rowTops[i] ?? 0}
            height={rowHeights[i] ?? 0}
            contentWidthPx={widthPx}
            frameWindow={frameWindow}
            pinnedIds={pinned}
            selectedIds={selectedByTrack.get(i) ?? NO_PINS}
            syncLinkedIds={syncLinkedIds}
            avLinkedIds={avLinkedIds}
            cutStyleById={cutStyleById}
            curveEditor={curveEditor}
            fps={fps}
            pxPerSec={pxPerSec}
            startLeftPx={startLeftPx}
            viewStartPx={viewStartPx}
            viewEndPx={viewEndPx}
            bandRatio={bandRatio}
            showClipNames={showClipNames}
            showClipBadges={showClipBadges}
            actions={actions}
          />
        ))}
      </div>
    </div>
  );
});
