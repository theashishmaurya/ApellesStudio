/**
 * B-323 — `retimeTimeline` / `fpsToRational`, the TS mirror of `retime.rs`.
 * The cases are the Rust tests' cases with the same numbers, so the two sides
 * are pinned to the same answers.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_FPS, timelineDuration, type Clip, type Timeline } from './timeline';
import { fpsToRational, isValidTimelineRate, retimeTimeline } from './timelineRetime';

function clip(start: number, duration: number, sourceFps?: number): Clip {
  return {
    id: 'c',
    name: 'c',
    source_path: '/x.mov',
    source_start: 0,
    duration,
    source_len: duration,
    start_frame: start,
    ...(sourceFps !== undefined ? { source_fps: sourceFps } : {}),
  } as Clip;
}

function timeline(rate: Timeline['rate'], clips: Clip[]): Timeline {
  return { id: 't', name: 't', rate, tracks: [{ kind: 'video', clips, gain: 1 }] } as Timeline;
}

describe('fpsToRational', () => {
  it('gives the exact rational', () => {
    expect(fpsToRational(30)).toEqual({ num: 30, den: 1 });
    expect(fpsToRational(29.97)).toEqual({ num: 30000, den: 1001 });
    expect(fpsToRational(23.976)).toEqual({ num: 24000, den: 1001 });
    expect(fpsToRational(59.94)).toEqual({ num: 60000, den: 1001 });
    expect(fpsToRational(12.5)).toEqual({ num: 12500, den: 1000 });
    expect(fpsToRational(0)).toBeNull();
    expect(fpsToRational(Number.NaN)).toBeNull();
    expect(fpsToRational(1000)).toBeNull();
  });
  it('validates a rate', () => {
    expect(isValidTimelineRate({ num: 30, den: 1 })).toBe(true);
    expect(isValidTimelineRate({ num: 0, den: 1 })).toBe(false);
    expect(isValidTimelineRate({ num: 1000, den: 1 })).toBe(false);
  });
});

describe('retimeTimeline', () => {
  it('treats an unrated timeline as 24 fps and converts from there', () => {
    const next = retimeTimeline(timeline(null, [clip(240, 120)]), { num: 30, den: 1 }, DEFAULT_FPS);
    const c = next.tracks[0].clips[0];
    expect([c.start_frame, c.duration, c.source_len]).toEqual([300, 150, 150]);
    expect(next.rate).toEqual({ num: 30, den: 1 });
  });

  it('keeps timeline-frame fields at the same second', () => {
    const tl = timeline({ num: 24, den: 1 }, [{ ...clip(48, 72), fade_in_frames: 12 }]);
    tl.tracks[0].transitions = [{ id: 't', kind: 'cross_dissolve', at_frame: 120, duration: 24, alignment: 'center' }] as never;
    tl.markers = [{ id: 'm', frame: 96, color: '#fff', duration_frames: 48 }];
    const next = retimeTimeline(tl, { num: 30, den: 1 }, DEFAULT_FPS);
    const c = next.tracks[0].clips[0];
    expect([c.start_frame, c.duration, c.fade_in_frames]).toEqual([60, 90, 15]);
    expect(next.tracks[0].transitions?.[0]).toMatchObject({ at_frame: 150, duration: 30 });
    expect(next.markers?.[0]).toMatchObject({ frame: 120, duration_frames: 60 });
    expect(tl.tracks[0].clips[0].start_frame).toBe(48); // the input is not mutated
  });

  it('leaves the source-native fields of a clip with a source rate, so its length in seconds holds', () => {
    const tl = timeline({ num: 24, den: 1 }, [{ ...clip(24, 100, 25), source_start: 10 }]);
    const next = retimeTimeline(tl, { num: 30, den: 1 }, DEFAULT_FPS);
    const c = next.tracks[0].clips[0];
    expect([c.source_start, c.duration, c.source_len, c.start_frame]).toEqual([10, 100, 100, 30]);
    // 100 frames of 25 fps media is 4 s: 96 frames at 24, 120 at 30.
    expect(timelineDuration(tl)).toBe(24 + 96);
    expect(timelineDuration(next)).toBe(30 + 120);
  });

  it('is a no-op for the same rate, and a short span never collapses', () => {
    const tl = timeline({ num: 30, den: 1 }, [clip(7, 13)]);
    expect(retimeTimeline(tl, { num: 30, den: 1 }, DEFAULT_FPS)).toBe(tl);
    const tiny = retimeTimeline(timeline({ num: 60, den: 1 }, [clip(0, 1)]), { num: 24, den: 1 }, DEFAULT_FPS);
    expect(tiny.tracks[0].clips[0].duration).toBe(1);
  });

  it('moves keyframes and speed points of a clip with no source rate', () => {
    const c = {
      ...clip(0, 60),
      chroma_keyframes: [
        { frame: 0, params: {} },
        { frame: 24, params: {} },
      ],
      speed_points: [{ source_frame: 24, speed: 2 }],
    } as Clip;
    const next = retimeTimeline(timeline({ num: 24, den: 1 }, [c]), { num: 48, den: 1 }, DEFAULT_FPS);
    expect(next.tracks[0].clips[0].chroma_keyframes?.[1].frame).toBe(48);
    expect(next.tracks[0].clips[0].speed_points?.[0].source_frame).toBe(48);
  });
});
