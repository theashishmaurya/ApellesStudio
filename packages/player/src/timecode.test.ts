/**
 * `fmtTimecode` / `parseTimecode` — the `HH:MM:SS:FF` pair (D-328).
 *
 * **What this pins.** That the formatter and the parser are real inverses, and
 * that the parser refuses junk instead of silently returning frame 0. Both
 * matter because the marker popover's Time and Duration fields write straight
 * into `project.json` through a `set_marker` op: a parser that read a typo as
 * `0` would move a marker to the start of the timeline and look like it had
 * worked, which is exactly the class of bug D-328 put the two functions in one
 * file to prevent.
 */
import { describe, expect, it } from 'vitest';

import { fmtTimecode, parseTimecode } from './timecode';

describe('parseTimecode (D-328)', () => {
  it('round-trips every frame fmtTimecode can render, at several rates', () => {
    // The property that matters: format then parse must be the identity, or a
    // user who opens the popover and presses Done without typing would move
    // the marker.
    for (const fps of [24, 25, 30, 60]) {
      for (const frame of [0, 1, 23, 24, 100, 1439, 86399, 123456]) {
        expect(parseTimecode(fmtTimecode(frame, fps), fps)).toBe(frame);
      }
    }
  });

  it('reads the short forms right-anchored, so the last segment is always frames', () => {
    expect(parseTimecode('12', 24)).toBe(12);
    expect(parseTimecode('4:12', 24)).toBe(4 * 24 + 12);
    expect(parseTimecode('1:04:12', 24)).toBe(64 * 24 + 12);
    expect(parseTimecode('00:01:04:12', 24)).toBe(64 * 24 + 12);
    // The two spellings of the same instant agree — the whole point of
    // anchoring on the right rather than the left.
    expect(parseTimecode('4:12', 24)).toBe(parseTimecode('00:00:04:12', 24));
  });

  it('refuses junk with null rather than defaulting to frame 0', () => {
    for (const bad of ['', '   ', 'abc', '1.5', '-1', '1:-2', '1e3', '0:0:0:0:0', ':', '4:', '1:2:x']) {
      expect(parseTimecode(bad, 24)).toBeNull();
    }
  });

  it('accepts out-of-range minutes and seconds instead of refusing a fast typist', () => {
    // `90` seconds is a legal way to type a minute and a half; refusing it
    // would be a surprise in a field people type quickly.
    expect(parseTimecode('00:00:90:00', 24)).toBe(90 * 24);
    expect(parseTimecode('00:90:00:00', 24)).toBe(90 * 60 * 24);
  });

  it('without a usable fps, only the bare-frames form is meaningful', () => {
    // Mirrors fmtTimecode's own "no fps → frame counter only" contract rather
    // than inventing a rate to multiply by.
    expect(parseTimecode('120', 0)).toBe(120);
    expect(parseTimecode('120', undefined)).toBe(120);
    expect(parseTimecode('00:00:04:12', 0)).toBeNull();
  });

  it('is tolerant of surrounding whitespace, which a paste commonly carries', () => {
    expect(parseTimecode('  00:00:04:12  ', 24)).toBe(4 * 24 + 12);
    expect(parseTimecode(' 4 : 12 ', 24)).toBe(4 * 24 + 12);
  });
});
