/**
 * TimelineRange.tsx — the marked In / Out range drawn on the ruler (B-348).
 *
 * What it is: a translucent accent band over the ruler's tick row spanning
 * `[inPoint, outPoint]` (inclusive of both frames; an absent side runs to that
 * end of the timeline), with a solid 2 px edge where each mark sits, as
 * Premiere / Resolve / Final Cut draw the sequence range. Nothing is drawn
 * when neither mark is set.
 *
 * What it does NOT do: take input (`pointer-events-none`: the ruler beneath
 * still seeks), own the marks (`timelineStore.inPoint/outPoint`, rules in
 * `marks.ts`), or compute timeline geometry (`pxPerSec` / `scrollLeft` /
 * `startLeftPx` come from `TimelinePane`, like `MarkerStrip`'s).
 */
import { markedRange } from './marks';
import { RULER_HEIGHT_PX } from './ruler';
import { timelineDuration } from './timeline';
import { useEditorTimelineStore } from './timelineStore';
import { TIMELINE_TEST_IDS } from './timelineTestIds';

export interface TimelineRangeProps {
  fps: number;
  pxPerSec: number;
  scrollLeft: number;
  startLeftPx: number;
}

/** Width of a mark's solid edge, in px. */
const EDGE_PX = 2;

export function TimelineRange({ fps, pxPerSec, scrollLeft, startLeftPx }: TimelineRangeProps) {
  const inPoint = useEditorTimelineStore((s) => s.inPoint);
  const outPoint = useEditorTimelineStore((s) => s.outPoint);
  const timeline = useEditorTimelineStore((s) => s.timeline);
  const range = markedRange({ inPoint, outPoint }, timelineDuration(timeline));
  if (!range) return null;
  const px = (frame: number) => startLeftPx + (frame / fps) * pxPerSec - scrollLeft;
  const left = px(range.start);
  const right = px(range.end + 1);
  return (
    <div
      data-testid={TIMELINE_TEST_IDS.markRange}
      data-in={inPoint ?? undefined}
      data-out={outPoint ?? undefined}
      aria-hidden
      className="pointer-events-none absolute left-0 right-0 z-(--z-timeline-markers) overflow-hidden"
      style={{ top: 0, height: RULER_HEIGHT_PX }}
    >
      <div className="absolute inset-y-0 bg-accent/20" style={{ left, width: Math.max(right - left, 0) }} />
      {inPoint !== null && <div className="absolute inset-y-0 bg-accent" style={{ left, width: EDGE_PX }} />}
      {outPoint !== null && (
        <div className="absolute inset-y-0 bg-accent" style={{ left: right - EDGE_PX, width: EDGE_PX }} />
      )}
    </div>
  );
}
