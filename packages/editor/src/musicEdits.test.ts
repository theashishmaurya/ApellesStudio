/**
 * D-408 — music edits by story beat: the range math of the `music_edits` op
 * (`applyMusicEdit(s)` / `checkMusicEdit` in `timeline.ts`) and the pure half
 * in `musicEdits.ts` (wire parsing, word → frame anchors, review rows).
 */
import { describe, expect, it } from 'vitest';

import {
  applyMusicEdit,
  applyMusicEdits,
  applyOp,
  checkMusicEdit,
  DEFAULT_MUSIC_FADE_IN_FRAMES,
  DEFAULT_MUSIC_FADE_OUT_FRAMES,
  endFrame,
  labelForOp,
  type Clip,
  type MusicEditRange,
  type Timeline,
} from './timeline';
import {
  breathBefore,
  musicTrackFor,
  parseMusicEditRequest,
  resolveAnchor,
  rowFrom,
  rowProblem,
  rowsToApply,
  toMusicEditRange,
  wordRangeFrames,
  type MusicEditProposalSet,
  type MusicEditRequest,
  type WordContext,
} from './musicEdits';
import type { WordViewInput } from './retakeWordView';

const FPS = 24;

function bed(id: string, start: number, duration: number, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    name: id,
    source_path: '/music/bed.mp3',
    source_start: 0,
    duration,
    source_len: 10_000,
    start_frame: start,
    ...extra,
  };
}

function tl(...tracks: Array<{ kind: 'video' | 'audio'; clips: Clip[]; locked?: boolean; duck_from?: number }>): Timeline {
  return { id: 'tl', name: 'T', rate: { num: FPS, den: 1 }, tracks: tracks.map((t) => ({ gain: 1, ...t })) };
}

const range = (track: number, start: number, end: number, extra: Partial<MusicEditRange> = {}): MusicEditRange => ({
  track,
  start,
  end,
  fadeOutFrames: DEFAULT_MUSIC_FADE_OUT_FRAMES,
  fadeInFrames: DEFAULT_MUSIC_FADE_IN_FRAMES,
  ...extra,
});

const voice = { kind: 'video' as const, clips: [bed('v', 0, 2000, { source_path: '/talk.mov' })] };

describe('applyMusicEdit — inside one bed clip', () => {
  const t = tl(voice, { kind: 'audio', clips: [bed('m', 0, 1000)] });

  it('splits twice, lifts the middle, fades either side, and never ripples', () => {
    const { timeline, result } = applyMusicEdit(t, range(1, 100, 124), FPS);
    expect(result).toMatchObject({ applied: true, splits: 2, removed: 1 });
    const clips = timeline.tracks[1].clips;
    expect(clips.map((c) => [c.start_frame, endFrame(c, FPS)])).toEqual([
      [0, 100],
      [124, 1000],
    ]);
    expect(clips[0].fade_out_frames).toBe(DEFAULT_MUSIC_FADE_OUT_FRAMES);
    expect(clips[1].fade_in_frames).toBe(DEFAULT_MUSIC_FADE_IN_FRAMES);
    // Continuous: the re-entry is exactly where the bed would have been.
    expect(clips[1].source_start).toBe(124);
    expect(result.fadeOutClipId).toBe(clips[0].id);
    expect(result.fadeInClipId).toBe(clips[1].id);
    // The voice is untouched and nothing moved later.
    expect(timeline.tracks[0]).toEqual(t.tracks[0]);
  });

  it('pause mode resumes the bed from where it stopped', () => {
    const { timeline, result } = applyMusicEdit(t, range(1, 100, 124, { mode: 'pause' }), FPS);
    expect(result.applied).toBe(true);
    const right = timeline.tracks[1].clips[1];
    expect(right.start_frame).toBe(124);
    expect(right.source_start).toBe(100);
    expect(endFrame(right, FPS)).toBe(1000);
  });

  it('is one history entry through the op, with a label', () => {
    const op = { kind: 'music_edits' as const, edits: [range(1, 100, 124)] };
    const after = applyOp(t, op);
    expect(after.tracks[1].clips).toHaveLength(2);
    expect(labelForOp(op, t)).toBe('Music dropout on track 2');
    expect(labelForOp({ kind: 'music_edits', edits: [range(1, 1, 2), range(1, 5, 6)] }, t)).toBe('2 music edits');
  });

  it('clamps a fade to the piece it lands on', () => {
    const { timeline } = applyMusicEdit(t, range(1, 3, 50, { fadeOutFrames: 40 }), FPS);
    expect(timeline.tracks[1].clips[0].fade_out_frames).toBe(3);
  });
});

describe('applyMusicEdit — edges and spans', () => {
  it('a range touching the bed start needs one split and no fade-out', () => {
    const t = tl(voice, { kind: 'audio', clips: [bed('m', 48, 500)] });
    const { timeline, result } = applyMusicEdit(t, range(1, 48, 72), FPS);
    expect(result).toMatchObject({ applied: true, splits: 1, removed: 1 });
    expect(result.fadeOutClipId).toBeUndefined();
    const c = timeline.tracks[1].clips;
    expect(c).toHaveLength(1);
    expect(c[0].start_frame).toBe(72);
    expect(c[0].fade_in_frames).toBe(DEFAULT_MUSIC_FADE_IN_FRAMES);
  });

  it('a range that starts before the bed (a dry cold open) trims its head', () => {
    const t = tl(voice, { kind: 'audio', clips: [bed('m', 48, 500)] });
    const { timeline, result } = applyMusicEdit(t, range(1, 0, 96), FPS);
    expect(result.applied).toBe(true);
    expect(timeline.tracks[1].clips[0].start_frame).toBe(96);
  });

  it('spans two bed clips across a gap', () => {
    const t = tl(voice, { kind: 'audio', clips: [bed('a', 0, 100), bed('b', 150, 300)] });
    const { timeline, result } = applyMusicEdit(t, range(1, 80, 200), FPS);
    expect(result).toMatchObject({ applied: true, splits: 2, removed: 2 });
    const c = timeline.tracks[1].clips;
    expect(c.map((x) => [x.start_frame, endFrame(x, FPS)])).toEqual([
      [0, 80],
      [200, 450],
    ]);
    expect(c[0].fade_out_frames).toBe(DEFAULT_MUSIC_FADE_OUT_FRAMES);
    expect(c[1].fade_in_frames).toBe(DEFAULT_MUSIC_FADE_IN_FRAMES);
  });

  it('a range ending exactly on the next clip fades that clip in without cutting it', () => {
    const t = tl(voice, { kind: 'audio', clips: [bed('a', 0, 100), bed('b', 100, 100)] });
    const { timeline, result } = applyMusicEdit(t, range(1, 60, 100), FPS);
    expect(result).toMatchObject({ applied: true, splits: 1, removed: 1 });
    const c = timeline.tracks[1].clips;
    expect(c[1].id).toBe('b');
    expect(c[1].fade_in_frames).toBe(DEFAULT_MUSIC_FADE_IN_FRAMES);
  });

  it('targets only the track it is given when there are several beds', () => {
    const t = tl(voice, { kind: 'audio', clips: [bed('m1', 0, 500)] }, { kind: 'audio', clips: [bed('m2', 0, 500)] });
    const { timeline } = applyMusicEdit(t, range(2, 10, 20), FPS);
    expect(timeline.tracks[1]).toEqual(t.tracks[1]);
    expect(timeline.tracks[2].clips).toHaveLength(2);
  });
});

describe('checkMusicEdit — refusals', () => {
  const t = tl(voice, { kind: 'audio', clips: [bed('m', 0, 100), bed('n', 200, 100)] });
  const reason = (tline: Timeline, e: MusicEditRange) => {
    const c = checkMusicEdit(tline, e, FPS);
    return c.ok ? null : c.reason;
  };

  it('refuses when no music is under the range', () => {
    expect(reason(t, range(1, 120, 180))).toMatch(/no music clip under frames 120..180/);
  });
  it('refuses a video track, a missing track, a locked track and a non-range', () => {
    expect(reason(t, range(0, 10, 20))).toMatch(/video track/);
    expect(reason(t, range(5, 10, 20))).toMatch(/no track 5/);
    expect(reason(tl(voice, { kind: 'audio', clips: [bed('m', 0, 100)], locked: true }), range(1, 10, 20))).toMatch(/locked/);
    expect(reason(t, range(1, 20, 20))).toMatch(/not a range/);
  });
  it('refuses an A/V-linked clip (a picture\'s own sound)', () => {
    const linked = tl(voice, { kind: 'audio', clips: [bed('m', 0, 100, { link_group: 'g' }), bed('n', 200, 10)] });
    expect(reason(linked, range(1, 10, 20))).toMatch(/A\/V-linked/);
  });
  it('refuses the voice — a track other tracks duck under (B-279)', () => {
    const ducked = tl(
      voice,
      { kind: 'audio', clips: [bed('vo', 0, 400)] },
      { kind: 'audio', clips: [bed('m', 0, 400)], duck_from: 1 },
    );
    expect(reason(ducked, range(1, 10, 20))).toMatch(/track 1 is the voice — track 2 ducks under it/);
    expect(reason(ducked, range(2, 10, 20))).toBeNull();
  });
  it('refuses a range that would remove the whole bed', () => {
    expect(reason(t, range(1, 0, 400))).toMatch(/whole bed/);
  });
  it('refuses pause mode across a clip edge', () => {
    expect(reason(t, range(1, 50, 250, { mode: 'pause' }))).toMatch(/pause/);
    expect(reason(t, range(1, 0, 50, { mode: 'pause' }))).toMatch(/pause/);
  });
  it('applyMusicEdit returns the timeline unchanged on a refusal', () => {
    const out = applyMusicEdit(t, range(1, 120, 180), FPS);
    expect(out.timeline).toBe(t);
    expect(out.result.applied).toBe(false);
  });
});

describe('applyMusicEdits — batches', () => {
  const t = tl(voice, { kind: 'audio', clips: [bed('m', 0, 2000)] });

  it('applies several, each reporting its own outcome', () => {
    const { timeline, results } = applyMusicEdits(t, [range(1, 100, 124), range(1, 500, 560), range(1, 3000, 3100)], FPS);
    expect(results.map((r) => r.applied)).toEqual([true, true, false]);
    expect(timeline.tracks[1].clips).toHaveLength(3);
    // A sliver between two dropouts gets both fades, never overlapping.
    const mid = timeline.tracks[1].clips[1];
    expect(mid.fade_in_frames).toBe(DEFAULT_MUSIC_FADE_IN_FRAMES);
    expect(mid.fade_out_frames).toBe(DEFAULT_MUSIC_FADE_OUT_FRAMES);
  });

  it('refuses the later of two overlapping edits', () => {
    const { results } = applyMusicEdits(t, [range(1, 100, 200), range(1, 150, 250)], FPS);
    expect(results[1]).toMatchObject({ applied: false });
    expect(results[1].reason).toMatch(/overlaps the edit at frames 100..200/);
  });
});

// ---------------------------------------------------------------------------

/** A voice track of two clips; the second skips 2 s of source. */
function wordCtx(): WordContext {
  const c0 = bed('v0', 0, 96, { source_path: '/talk.mov', source_fps: FPS });
  const c1 = bed('v1', 96, 96, { source_path: '/talk.mov', source_fps: FPS, source_start: 144 });
  const input: WordViewInput = {
    track: 0,
    fps: FPS,
    sources: [{ path: '/talk.mov', segments: [] }],
    pieces: [
      { source: 0, startSecs: 0, endSecs: 4, clip: 0, clipId: 'v0', c: c0 },
      { source: 0, startSecs: 6, endSecs: 10, clip: 1, clipId: 'v1', c: c1 },
    ],
    pending: [],
    failed: [],
  };
  const words = [
    { text: 'so', start: 1, end: 1.5, piece: 0 },
    { text: 'here', start: 2, end: 2.5, piece: 0 },
    { text: 'is', start: 6.5, end: 7, piece: 1 },
    { text: 'Bot', start: 8, end: 8.5, piece: 1 },
  ];
  return { input, words };
}

describe('word anchors', () => {
  it('maps a word range across two clips to timeline frames', () => {
    const w = wordRangeFrames(wordCtx(), 1, 2);
    // "here" at 2 s on clip 0 = frame 48; "is" ends at 7 s of source = 1 s into clip 1 = frame 120.
    expect(w).toEqual({ start: 48, end: 120, text: 'here is' });
  });

  it('refuses out-of-range and inverted words', () => {
    expect(wordRangeFrames(wordCtx(), 2, 9)).toMatchObject({ error: expect.stringMatching(/past the end/) });
    expect(wordRangeFrames(wordCtx(), 2, 1)).toMatchObject({ error: expect.stringMatching(/after last_word/) });
  });

  it('a breath before a word ends ON the word and lasts a second by default', () => {
    const req = parseMusicEditRequest({ kind: 'breath', before_word: 3 }) as MusicEditRequest;
    // "Bot" at 8 s of source = 2 s into clip 1 = frame 144.
    expect(resolveAnchor(req, FPS, wordCtx())).toMatchObject({ start: 120, end: 144, text: 'Bot' });
    const short = parseMusicEditRequest({ kind: 'breath', before_word: 3, length_frames: 12 }) as MusicEditRequest;
    expect(resolveAnchor(short, FPS, wordCtx())).toMatchObject({ start: 132, end: 144 });
  });

  it('a word anchor without a view is refused', () => {
    const req = parseMusicEditRequest({ first_word: 0, last_word: 1 }) as MusicEditRequest;
    expect(resolveAnchor(req, FPS, null)).toMatchObject({ error: expect.stringMatching(/word_track and view_id/) });
  });
});

describe('parseMusicEditRequest', () => {
  it('defaults the kind to dropout and keeps optional fields', () => {
    expect(parseMusicEditRequest({ start_frame: 1, end_frame: 5, reason: ' punchline ', mode: 'pause', fade_in_frames: 0 })).toEqual({
      kind: 'dropout',
      anchor: { by: 'frames', startFrame: 1, endFrame: 5 },
      reason: 'punchline',
      fadeInFrames: 0,
      mode: 'pause',
    });
  });
  it('refuses zero or two anchors, an unknown kind or mode, and fractions', () => {
    expect(parseMusicEditRequest({ kind: 'dropout' })).toMatchObject({ error: expect.stringMatching(/exactly ONE anchor/) });
    expect(parseMusicEditRequest({ start_frame: 1, end_frame: 2, first_word: 1, last_word: 2 })).toMatchObject({
      error: expect.stringMatching(/exactly ONE anchor/),
    });
    expect(parseMusicEditRequest({ kind: 'swell', start_frame: 1, end_frame: 2 })).toMatchObject({ error: expect.stringMatching(/kind/) });
    expect(parseMusicEditRequest({ mode: 'loop', start_frame: 1, end_frame: 2 })).toMatchObject({ error: expect.stringMatching(/mode/) });
    expect(parseMusicEditRequest({ start_frame: 1.5, end_frame: 2 })).toMatchObject({ error: expect.stringMatching(/whole/) });
  });
  it('fills the default fades when resolving to a range', () => {
    const req = parseMusicEditRequest({ start_frame: 10, end_frame: 20 }) as MusicEditRequest;
    expect(toMusicEditRange(req, { start: 10, end: 20 }, 3)).toEqual(range(3, 10, 20, { mode: 'continuous' }));
  });
});

describe('review rows', () => {
  const t = tl(voice, { kind: 'audio', clips: [bed('m', 0, 1000)] });
  const req = parseMusicEditRequest({ start_frame: 10, end_frame: 20 }) as MusicEditRequest;
  const set = (statuses: Array<'pending' | 'accepted' | 'rejected'>): MusicEditProposalSet => ({
    timelineId: 'tl',
    track: 1,
    receivedAt: 0,
    nextId: 0,
    rows: statuses.map((s, i) => ({ ...rowFrom(`a${i}`, req, { start: 100 - i * 10, end: 105 - i * 10 }, 'ai'), status: s })),
  });

  it('applies accepted rows only, plus pending on request, never rejected, in timeline order', () => {
    const s = set(['accepted', 'pending', 'rejected', 'accepted']);
    expect(rowsToApply(s, false).map((r) => r.id)).toEqual(['a3', 'a0']);
    expect(rowsToApply(s, true).map((r) => r.id)).toEqual(['a3', 'a1', 'a0']);
  });

  it('reports a row that cannot apply now', () => {
    const row = rowFrom('x', req, { start: 2000, end: 2010 }, 'person');
    expect(rowProblem(t, row, 1)).toMatch(/no music clip/);
    expect(rowProblem(t, { ...row, start: 10, end: 20 }, 1)).toBeNull();
  });
});

describe('GUI helpers', () => {
  it('breathBefore is the second before a frame, clamped at 0', () => {
    expect(breathBefore(100, FPS)).toEqual({ start: 76, end: 100 });
    expect(breathBefore(10, FPS)).toEqual({ start: 0, end: 10 });
    expect(breathBefore(0, FPS)).toBeNull();
  });

  it('musicTrackFor picks the one bed, ignores linked audio, and asks when ambiguous', () => {
    const one = tl(voice, { kind: 'audio', clips: [bed('va', 0, 500, { link_group: 'g' })] }, { kind: 'audio', clips: [bed('m', 0, 500)] });
    expect(musicTrackFor(one, 10, 20, null)).toEqual({ track: 2 });
    const two = tl(voice, { kind: 'audio', clips: [bed('m1', 0, 500)] }, { kind: 'audio', clips: [bed('m2', 0, 500)] });
    expect(musicTrackFor(two, 10, 20, null)).toMatchObject({ error: expect.stringMatching(/more than one/) });
    expect(musicTrackFor(two, 10, 20, 2)).toEqual({ track: 2 });
    expect(musicTrackFor(two, 900, 950, null)).toMatchObject({ error: expect.stringMatching(/no music bed/) });
  });
});
