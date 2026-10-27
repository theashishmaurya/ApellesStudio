/**
 * @apelles/editor — the beat lane: the grid track's beats drawn on the
 * timeline (D-413).
 *
 * **What it is.** Final Cut Pro 12's beat display, taken from its own
 * description (`scratch/beat-sync-reference/NOTES.md`): weight by importance —
 * a downbeat is a solid line through every track with its bar number in the
 * marker band, every other beat a short tick in that band — and fewer of them
 * as you zoom out, so the grid never turns into a grey wash (beats disappear
 * below [`MIN_BEAT_SPACING_PX`], then every other bar, every fourth…).
 *
 * **What it does NOT do.** No hit targets (everything is
 * `pointer-events-none`; markers, clips and the ruler keep every gesture), no
 * analysis, and no geometry of its own: `pxPerSec`/`scrollLeft`/`startLeftPx`
 * come from `TimelinePane`, through `markerLeftPx`, the one frame→x rule every
 * overlay there uses. Snapping lives in `TimelinePane`'s drag/trim/playhead
 * paths and `beatGrid.ts`.
 */
import { memo, useMemo } from 'react';
import type { TimelineBeat } from './beatGrid';
import { MARKER_STRIP_HEIGHT, markerLeftPx } from './TimelineMarkers';
import { RULER_HEIGHT_PX } from './ruler';

/** Below this many px between beats only downbeats are drawn. */
export const MIN_BEAT_SPACING_PX = 6;
/** Below this many px between drawn bar lines, bars are thinned by powers of two. */
const MIN_BAR_SPACING_PX = 8;
/** Bar numbers are written when bars are at least this far apart. */
const BAR_LABEL_MIN_SPACING_PX = 28;
/** Tick heights inside the marker band. */
const BEAT_TICK_PX = 4;
const DOWNBEAT_TICK_PX = MARKER_STRIP_HEIGHT;

export interface BeatLaneProps {
  beats: readonly TimelineBeat[];
  fps: number;
  pxPerSec: number;
  scrollLeft: number;
  startLeftPx: number;
  /** Visible width of the edit area, px — beats outside are not drawn. */
  viewportWidth: number;
}

/** Which beats to draw at this zoom (pure, for the test). */
export function visibleBeats(
  beats: readonly TimelineBeat[],
  fps: number,
  pxPerSec: number,
): { beats: TimelineBeat[]; barStep: number; labels: boolean } {
  if (beats.length === 0) return { beats: [], barStep: 1, labels: false };
  const spacing = beats.length > 1 ? ((beats[beats.length - 1].frame - beats[0].frame) / (beats.length - 1) / fps) * pxPerSec : Infinity;
  const downs = beats.filter((b) => b.downbeat);
  const barPx = downs.length > 1 ? ((downs[downs.length - 1].frame - downs[0].frame) / (downs.length - 1) / fps) * pxPerSec : Infinity;
  let barStep = 1;
  while (barPx * barStep < MIN_BAR_SPACING_PX && barStep < 1024) barStep *= 2;
  const keep = beats.filter((b) => (b.downbeat ? (b.bar - 1) % barStep === 0 : spacing >= MIN_BEAT_SPACING_PX));
  return { beats: keep, barStep, labels: barPx * barStep >= BAR_LABEL_MIN_SPACING_PX };
}

export const BeatLane = memo(function BeatLane({ beats, fps, pxPerSec, scrollLeft, startLeftPx, viewportWidth }: BeatLaneProps) {
  const shown = useMemo(() => visibleBeats(beats, fps, pxPerSec), [beats, fps, pxPerSec]);
  return (
    <div
      data-chroma-beat-lane
      aria-hidden
      className="pointer-events-none absolute inset-0 z-30 overflow-hidden"
    >
      {shown.beats.map((b) => {
        const x = markerLeftPx(b.frame, fps, pxPerSec, scrollLeft, startLeftPx);
        if (x < -40 || x > viewportWidth + 40) return null;
        if (!b.downbeat) {
          return (
            <div
              key={b.frame}
              data-chroma-beat={b.frame}
              className="absolute w-px bg-text-secondary/60"
              style={{ left: x, top: RULER_HEIGHT_PX + MARKER_STRIP_HEIGHT - BEAT_TICK_PX, height: BEAT_TICK_PX }}
            />
          );
        }
        return (
          <div key={b.frame}>
            <div
              data-chroma-downbeat={b.frame}
              className="absolute w-px bg-accent/80"
              style={{ left: x, top: RULER_HEIGHT_PX, height: DOWNBEAT_TICK_PX }}
            />
            <div className="absolute bottom-0 w-px bg-accent/20" style={{ left: x, top: RULER_HEIGHT_PX + MARKER_STRIP_HEIGHT }} />
            {shown.labels && (
              <span
                className="absolute text-[9px] leading-none text-accent"
                style={{ left: x + 2, top: RULER_HEIGHT_PX + 1 }}
              >
                {b.bar}
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
});
