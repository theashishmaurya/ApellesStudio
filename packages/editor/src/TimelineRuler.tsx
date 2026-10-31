/**
 * @apelles/editor — the timeline's time ruler (D-432 P3, `docs/notes/ui-redesign.md`
 * §4.6; fixes B-350).
 *
 * What it is: our own ruler, drawn over the timeline library's (which the
 * override stylesheet hides but keeps for layout). 24 px, `surface`, a 1 px
 * `border-color` line along its bottom; major ticks 8 px and minor 4 px drawn
 * as two repeating background layers (no DOM per tick); one label per visible
 * major tick in the adaptive format (`0:05`, `1:02:10`, frames only at
 * frame-level zoom, `formatRulerLabel`), 3 px right of its tick. The label
 * interval follows the zoom (`niceTickIntervalSeconds`, passed in) and so does
 * the minor-tick density (`rulerSplitCount`).
 *
 * Press seeks; press and drag scrubs (Premiere / Resolve), which the library's
 * click-only ruler never did (B-350). The scrub drives the same three
 * callbacks the playhead head's drag drives (`beginScrub` / `updateScrub` /
 * `endScrub` in the pane), so scrub audio and snapping behave the same.
 *
 * What it does NOT do: draw the playhead (still the library's, until D-437
 * replaces the library), hold state, or re-render per pointer move — the drag
 * only calls the pane's callbacks, which write the store.
 *
 * Built as its own component so D-437's lane renderer keeps it unchanged.
 */

import type { CSSProperties, PointerEvent as ReactPointerEvent } from 'react';

import { formatRulerLabel, rulerSplitCount, RULER_HEIGHT_PX } from './ruler';
import { TIMELINE_TEST_IDS } from './timelineTestIds';

/** Major / minor tick heights, px (spec §4.6). */
const MAJOR_TICK_PX = 8;
const MINOR_TICK_PX = 4;
/** A label's gap to the right of its major tick, px. */
const LABEL_GAP_PX = 3;
/** Labels are kept for ticks this far left of the viewport, so a label whose
 *  tick has just scrolled off still shows its tail. */
const LABEL_OVERSCAN_PX = 80;

export interface TimelineRulerProps {
  fps: number;
  pxPerSec: number;
  scrollLeft: number;
  startLeftPx: number;
  viewportWidth: number;
  /** the labelled interval, seconds (`niceTickIntervalSeconds` at this zoom) */
  tickSeconds: number;
  /** the frame under a press / drag, after any snapping the pane applies */
  snapFrame: (frame: number) => number;
  onScrubStart: (frame: number) => void;
  onScrub: (frame: number) => void;
  onScrubEnd: () => void;
}

export function TimelineRuler({
  fps,
  pxPerSec,
  scrollLeft,
  startLeftPx,
  viewportWidth,
  tickSeconds,
  snapFrame,
  onScrubStart,
  onScrub,
  onScrubEnd,
}: TimelineRulerProps) {
  const split = rulerSplitCount(tickSeconds, pxPerSec);
  const tickPx = tickSeconds * pxPerSec;
  const minorPx = tickPx / split;
  // x of time 0 in this element's own space
  const zeroX = startLeftPx - scrollLeft;
  const ticksLeft = Math.max(0, zeroX);

  const labels: Array<{ x: number; text: string; seconds: number }> = [];
  if (tickPx > 0) {
    const first = Math.max(0, Math.floor((scrollLeft - startLeftPx - LABEL_OVERSCAN_PX) / tickPx));
    const last = Math.ceil((scrollLeft - startLeftPx + viewportWidth) / tickPx);
    for (let k = first; k <= last; k++) {
      const seconds = k * tickSeconds;
      labels.push({ x: zeroX + k * tickPx, text: formatRulerLabel(seconds, fps, tickSeconds), seconds });
    }
  }

  // A 1 px tick line (text-primary at 18 %) repeated every interval.
  const tickLayer = `linear-gradient(to right, color-mix(in srgb, var(--color-text-primary) 18%, transparent) 1px, transparent 1px) ${zeroX - ticksLeft}px 100% / `;
  const ticksStyle: CSSProperties = {
    left: ticksLeft,
    // two layers, major on top: each a 1 px line repeated every interval
    background:
      `${tickLayer}${tickPx}px ${MAJOR_TICK_PX}px repeat-x, ` +
      `${tickLayer}${minorPx}px ${MINOR_TICK_PX}px repeat-x`,
  };

  const frameAt = (clientX: number, el: HTMLElement): number => {
    const rect = el.getBoundingClientRect();
    const contentX = clientX - rect.left + scrollLeft - startLeftPx;
    return snapFrame(Math.max(0, Math.round((contentX / pxPerSec) * fps)));
  };

  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const pointerId = e.pointerId;
    let last = frameAt(e.clientX, el);
    onScrubStart(last);
    const onMove = (ev: PointerEvent) => {
      if (ev.pointerId !== pointerId) return;
      const f = frameAt(ev.clientX, el);
      if (f === last) return;
      last = f;
      onScrub(f);
    };
    const finish = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', finish);
      onScrubEnd();
    };
    const onUp = (ev: PointerEvent) => {
      if (ev.pointerId === pointerId) finish();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', finish);
  };

  return (
    <div
      data-testid={TIMELINE_TEST_IDS.ruler}
      data-chroma-no-marquee=""
      data-chroma-tick-seconds={tickSeconds}
      data-chroma-tick-split={split}
      className="absolute top-0 right-0 left-0 z-(--z-timeline-markers) cursor-pointer overflow-hidden select-none"
      style={{
        height: RULER_HEIGHT_PX,
        background: 'linear-gradient(to top, var(--color-border-color) 1px, var(--color-surface) 1px)',
      }}
      onPointerDown={onPointerDown}
    >
      <div aria-hidden className="pointer-events-none absolute top-0 right-0 bottom-px" style={ticksStyle} />
      {labels.map((l) => (
        <span
          key={l.seconds}
          data-testid={TIMELINE_TEST_IDS.rulerLabel}
          className="pointer-events-none absolute top-0.5 text-2xs whitespace-nowrap text-text-secondary tabular-nums"
          style={{ left: l.x + LABEL_GAP_PX }}
        >
          {l.text}
        </span>
      ))}
    </div>
  );
}
