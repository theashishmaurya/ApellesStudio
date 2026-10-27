/**
 * D-413 — the timeline's beat grid: beats placed through a clip's trim and
 * position, the grid op, and the cut-snapping plan (dry-run through the real
 * `roll` op).
 */
import { describe, expect, it } from 'vitest';
import type { FileBeats } from '@apelles/beats';
import {
  beatFramesOf,
  clipBeats,
  cutsOf,
  gridQueries,
  gridTrackIndex,
  medianBeatSpacing,
  planCutSnaps,
  timelineBeats,
  trackBeats,
} from './beatGrid';
import { applyOp, endFrame, labelForOp, type Clip, type Timeline } from './timeline';
import { visibleBeats } from './TimelineBeats';

const BED = '/music/bed.mp3';

/** 120 BPM from 0.5 s, a downbeat every 4 beats starting at 1.0 s. */
function bedBeats(): FileBeats {
  const beats = Array.from({ length: 40 }, (_, i) => {
    const k = i - 1; // beat index relative to the first downbeat
    return {
      time: 0.5 + i * 0.5,
      bar: k < 0 ? 0 : Math.floor(k / 4) + 1,
      beat: k < 0 ? 4 : (k % 4) + 1,
      downbeat: k >= 0 && k % 4 === 0,
      strength: k >= 0 && k % 4 === 0 ? 1 : 0.4,
      strong: k >= 0 && k % 4 === 0,
    };
  });
  return {
    path: BED,
    contentHash: 'abc',
    params: { meter: 4 },
    truncated: false,
    cached: false,
    analysis: { algorithmVersion: 1, duration: 20, tempoBpm: 120, meter: 4, beats },
  };
}

function clip(over: Partial<Clip>): Clip {
  return {
    id: over.id ?? 'c',
    name: over.name ?? 'c',
    source_path: over.source_path ?? '/v.mov',
    source_start: 0,
    duration: 48,
    source_len: 400,
    start_frame: 0,
    ...over,
  };
}

/** 24 fps. Track 0: two touching video clips with a cut at frame 50. Track 1:
 *  the bed, trimmed to start one second in. */
function tl(): Timeline {
  return {
    id: 't',
    name: 't',
    rate: { num: 24, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          clip({ id: 'a', name: 'A', source_start: 20, duration: 50, start_frame: 0 }),
          clip({ id: 'b', name: 'B', source_start: 20, duration: 46, start_frame: 50 }),
          clip({ id: 'c', name: 'C', source_start: 0, duration: 40, start_frame: 96 }),
        ],
      },
      {
        kind: 'audio',
        clips: [clip({ id: 'bed', name: 'bed', source_path: BED, source_start: 24, duration: 192, start_frame: 0 })],
        beat_grid: {},
      },
    ],
  };
}

describe('placing beats', () => {
  it('maps file seconds through the trim and position, dropping beats outside the clip', () => {
    const t = tl();
    const beats = clipBeats(t.tracks[1].clips[0], 0, bedBeats(), 24);
    // In point is 1.0 s: the 0.5 s pickup is not played; 1.0 s lands on frame 0.
    expect(beats[0]).toMatchObject({ frame: 0, bar: 1, beat: 1, downbeat: true });
    expect(beats.map((b) => b.frame).slice(0, 5)).toEqual([0, 12, 24, 36, 48]);
    // The clip plays 192 frames: beats at 0..180.
    expect(beats.at(-1)?.frame).toBe(180);
    expect(beats).toHaveLength(16);
  });

  it('a clip moved later moves its beats with it', () => {
    const c = clip({ source_path: BED, source_start: 24, duration: 48, start_frame: 100 });
    expect(clipBeats(c, 0, bedBeats(), 24).map((b) => b.frame)).toEqual([100, 112, 124, 136]);
  });

  it('a clip at another native rate is converted', () => {
    // 48 fps source, 24 fps timeline: 1.0 s = source frame 48 = timeline frame 0.
    const c = clip({ source_path: BED, source_fps: 48, source_start: 48, duration: 96, start_frame: 0 });
    expect(clipBeats(c, 0, bedBeats(), 24).map((b) => b.frame)).toEqual([0, 12, 24, 36]);
  });

  it('reads the grid track, reports files not yet analysed, and kinds filter', () => {
    const t = tl();
    expect(gridTrackIndex(t)).toBe(1);
    expect(gridQueries(t.tracks[1])).toEqual([{ path: BED, meter: null, tempoHintBpm: null }]);
    expect(timelineBeats(t, () => undefined)).toEqual({ track: 1, beats: [], pending: [BED] });
    const placed = timelineBeats(t, () => bedBeats());
    expect(beatFramesOf(placed.beats, 'downbeat')).toEqual([0, 48, 96, 144]);
    expect(medianBeatSpacing(placed.beats)).toBe(12);
    expect(trackBeats(t, 0, () => undefined).pending).toEqual(['/v.mov']);
  });
});

describe('the set_beat_grid op', () => {
  it('sets one track and clears the others; null hides it', () => {
    const on = applyOp(tl(), { kind: 'set_beat_grid', track: 0, grid: { meter: 3, tempo_hint_bpm: 90 } });
    expect(on.tracks[0].beat_grid).toEqual({ meter: 3, tempo_hint_bpm: 90 });
    expect(on.tracks[1].beat_grid).toBeUndefined();
    const off = applyOp(on, { kind: 'set_beat_grid', track: 0, grid: null });
    expect(off.tracks.every((t) => t.beat_grid === undefined)).toBe(true);
    expect(labelForOp({ kind: 'set_beat_grid', track: 1, grid: {} }, on)).toBe('Show beats of track 2');
  });
});

describe('snapping cuts to beats', () => {
  const targets = beatFramesOf(timelineBeats(tl(), () => bedBeats()).beats);

  it('finds the cuts between touching clips', () => {
    expect(cutsOf(tl(), 0)).toEqual([
      { clip: 0, frame: 50 },
      { clip: 1, frame: 96 },
    ]);
  });

  it('rolls a cut onto the nearest beat and leaves one already on a beat', () => {
    const plan = planCutSnaps(tl(), 0, targets, 6);
    expect(plan.rolls).toEqual([{ clip: 0, delta: -2 }]);
    expect(plan.cuts).toEqual([
      { clip: 0, fromFrame: 50, toFrame: 48 },
      { clip: 1, fromFrame: 96, toFrame: null, reason: 'already on a beat' },
    ]);
    const after = applyOp(tl(), { kind: 'rolls', track: 0, rolls: plan.rolls });
    expect(endFrame(after.tracks[0].clips[0], 24)).toBe(48);
    expect(after.tracks[0].clips[1].start_frame).toBe(48);
    // A roll keeps the sequence length.
    expect(endFrame(after.tracks[0].clips[2], 24)).toBe(136);
  });

  it('refuses a roll the media cannot make, and a cut too far from any beat', () => {
    const t = tl();
    t.tracks[0].clips[1].source_start = 0; // B has no head handle to roll into
    const plan = planCutSnaps(t, 0, targets, 6);
    expect(plan.rolls).toEqual([]);
    expect(plan.cuts[0].reason).toMatch(/no media handle/);
    const far = planCutSnaps(tl(), 0, [200], 6);
    expect(far.cuts[0].reason).toBe('no beat within 6 frames');
  });

  it('restricts to the cuts named', () => {
    const plan = planCutSnaps(tl(), 0, targets, 6, [1]);
    expect(plan.cuts).toHaveLength(1);
    expect(plan.cuts[0].clip).toBe(1);
  });
});

describe('the beat lane thins with zoom', () => {
  const beats = timelineBeats(tl(), () => bedBeats()).beats;
  it('draws every beat when they are far apart, labels bars', () => {
    const v = visibleBeats(beats, 24, 100); // 12 frames = 50 px apart
    expect(v.beats).toHaveLength(beats.length);
    expect(v.barStep).toBe(1);
    expect(v.labels).toBe(true);
  });
  it('drops the in-between beats, then every other bar, as you zoom out', () => {
    const mid = visibleBeats(beats, 24, 8); // beats 4 px apart, bars 16 px
    expect(mid.beats.every((b) => b.downbeat)).toBe(true);
    expect(mid.beats).toHaveLength(4);
    const far = visibleBeats(beats, 24, 3); // bars 6 px apart: every 2nd bar
    expect(far.barStep).toBe(2);
    expect(far.beats.map((b) => b.bar)).toEqual([1, 3]);
    expect(far.labels).toBe(false);
  });
});
