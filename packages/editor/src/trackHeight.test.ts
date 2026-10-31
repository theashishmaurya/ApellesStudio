/**
 * D-432 P3 — per-track height: the pure geometry (`trackHeight.ts`), the two
 * track ops that store a name and a height (`timeline.ts` `applyOp`), and the
 * labels the header and `editor_list_tracks` show (`trackOps.ts`).
 */
import { describe, expect, it } from 'vitest';

import {
  clampTrackHeight,
  presetOfHeight,
  rowAtY,
  rowHeightAt,
  rowTopAt,
  trackAtY,
  trackBoundaryNear,
  trackHeights,
  trackTops,
  yAtRow,
  TRACK_HEIGHT_MAX,
  TRACK_HEIGHT_MIN,
} from './trackHeight';
import { applyOp, labelForOp, type Timeline } from './timeline';
import { heightArg, trackBadges, trackLabels } from './trackOps';

const tl = (): Timeline => ({
  id: 't',
  name: 't',
  rate: { num: 24, den: 1 },
  tracks: [
    { kind: 'video', clips: [] },
    { kind: 'video', clips: [], height: 108 },
    { kind: 'audio', clips: [] },
    { kind: 'subtitle', clips: [] },
  ],
});

describe('track geometry', () => {
  it('a track draws at its own height, else the view default; tops are prefix sums', () => {
    const heights = trackHeights(tl().tracks, 52);
    expect(heights).toEqual([52, 108, 52, 52]);
    expect(trackTops(heights)).toEqual([0, 52, 160, 212, 264]);
  });

  it('maps a y to its row at any mix of heights, with -1 above and n below', () => {
    const tops = trackTops([52, 108, 52]);
    expect(trackAtY(tops, -1)).toBe(-1);
    expect(trackAtY(tops, 0)).toBe(0);
    expect(trackAtY(tops, 51.9)).toBe(0);
    expect(trackAtY(tops, 52)).toBe(1);
    expect(trackAtY(tops, 159)).toBe(1);
    expect(trackAtY(tops, 160)).toBe(2);
    expect(trackAtY(tops, 212)).toBe(3);
  });

  it('a fractional row maps back to the same y (the marquee works in rows)', () => {
    const tops = trackTops([52, 108, 52]);
    for (const y of [-30, 0, 26, 52, 106, 159, 200, 212, 260]) {
      expect(yAtRow(tops, rowAtY(tops, y, 52), 52)).toBeCloseTo(y, 9);
    }
    expect(rowAtY(tops, 106, 52)).toBeCloseTo(1.5, 9);
  });

  it('with every row the default height it is exactly the old index × ROW_HEIGHT', () => {
    const tops = trackTops([52, 52, 52]);
    expect(rowAtY(tops, 130, 52)).toBeCloseTo(130 / 52, 9);
    expect(rowTopAt(tops, 2, 52)).toBe(104);
    expect(rowTopAt(tops, 4, 52)).toBe(208); // the ghost row below the stack
    expect(rowHeightAt(tops, 1, 52)).toBe(52);
    expect(rowHeightAt(tops, 9, 40)).toBe(40);
  });

  it('finds the insert-a-track boundary within the band only', () => {
    const tops = trackTops([52, 108]);
    expect(trackBoundaryNear(tops, 50, 11)).toBe(1);
    expect(trackBoundaryNear(tops, 80, 11)).toBeNull();
    expect(trackBoundaryNear(tops, 158, 11)).toBe(2);
  });

  it('clamps a height into 32..200 and names the presets', () => {
    expect(clampTrackHeight(10)).toBe(TRACK_HEIGHT_MIN);
    expect(clampTrackHeight(999)).toBe(TRACK_HEIGHT_MAX);
    expect(clampTrackHeight(80.4)).toBe(80);
    expect(presetOfHeight(76)).toBe('L');
    expect(presetOfHeight(80)).toBeNull();
  });
});

describe('set_track_name / set_track_height', () => {
  it('stores a trimmed name, and a blank one drops the key', () => {
    const named = applyOp(tl(), { kind: 'set_track_name', track: 2, name: '  Music ' });
    expect(named.tracks[2].name).toBe('Music');
    expect(trackLabels(named)).toEqual(['Video 1', 'Video 2', 'Music', 'Subtitle 1']);
    expect(trackBadges(named)).toEqual(['V1', 'V2', 'A1', 'C1']);
    const cleared = applyOp(named, { kind: 'set_track_name', track: 2, name: '   ' });
    expect('name' in cleared.tracks[2]).toBe(false);
    expect(labelForOp({ kind: 'set_track_name', track: 2, name: 'x' }, named)).toBe('Rename track 3');
  });

  it('stores a clamped height, and null drops the key', () => {
    const tall = applyOp(tl(), { kind: 'set_track_height', track: 0, height: 500 });
    expect(tall.tracks[0].height).toBe(200);
    const back = applyOp(tall, { kind: 'set_track_height', track: 0, height: null });
    expect('height' in back.tracks[0]).toBe(false);
    // out of range is a no-op, never a throw
    const same = tl();
    expect(applyOp(same, { kind: 'set_track_height', track: 9, height: 60 })).toBe(same);
  });

  it('heightArg reads presets, px and "default", and refuses anything else', () => {
    expect(heightArg('xl', 'height')).toBe(108);
    expect(heightArg(64, 'height')).toBe(64);
    expect(heightArg('default', 'height')).toBeNull();
    expect(heightArg(undefined, 'height')).toBeUndefined();
    expect(heightArg('tall', 'height')).toMatchObject({ error: expect.stringMatching(/S \/ M \/ L \/ XL/) });
  });
});
