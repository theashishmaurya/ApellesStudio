// @vitest-environment jsdom
/**
 * @apelles/editor — the beat lane stays out of the lanes (v0.3.0, B-359 item
 * 7): every beat and downbeat mark is drawn inside the ruler + marker band,
 * nothing runs down through the tracks, as in the approved mockup and Final
 * Cut's timeline.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render } from '@testing-library/react';

import { BeatLane } from './TimelineBeats';
import { MARKER_STRIP_HEIGHT } from './TimelineMarkers';
import { RULER_HEIGHT_PX } from './ruler';
import type { TimelineBeat } from './beatGrid';

afterEach(() => cleanup());

const beat = (frame: number, n: number): TimelineBeat =>
  ({ frame, bar: Math.floor(n / 4) + 1, beat: (n % 4) + 1, downbeat: n % 4 === 0, strong: n % 4 === 0, strength: 1 }) as TimelineBeat;

describe('BeatLane (v0.3.0)', () => {
  it('draws downbeats and beats inside the ruler and marker band only', () => {
    const beats = Array.from({ length: 16 }, (_, i) => beat(i * 12, i));
    const { container } = render(
      <BeatLane beats={beats} fps={24} pxPerSec={200} scrollLeft={0} startLeftPx={32} viewportWidth={2000} />,
    );
    const marks = [...container.querySelectorAll<HTMLElement>('[data-chroma-beat-lane] div')].filter(
      (d) => d.style.left !== '',
    );
    expect(container.querySelectorAll('[data-chroma-downbeat]').length).toBe(4);
    expect(marks.length).toBeGreaterThan(4);
    const band = RULER_HEIGHT_PX + MARKER_STRIP_HEIGHT;
    for (const m of marks) {
      // No `bottom`-anchored line, and every mark ends at or above the band.
      expect(m.className).not.toMatch(/\bbottom-0\b/);
      const top = Number.parseFloat(m.style.top);
      const height = Number.parseFloat(m.style.height);
      expect(Number.isFinite(top) && Number.isFinite(height)).toBe(true);
      expect(top + height).toBeLessThanOrEqual(band);
    }
  });
});
