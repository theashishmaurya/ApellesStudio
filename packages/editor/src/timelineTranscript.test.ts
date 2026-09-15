/**
 * @apelles/editor — stitching one timeline transcript out of many per-file
 * ones (D-329): the frame math, the ordering, and the filter.
 *
 * **Why this file is heavier than the feature looks.** The conversion it pins
 * is exactly the one B-077 got wrong in production: a clip's `duration` and
 * `source_start` are its OWN native frames, `start_frame` is a TIMELINE frame,
 * and adding one to the other without converting is silently correct on every
 * fixture where the source and the project run at the same rate. So the
 * fixtures here deliberately include a clip whose `source_fps` differs from
 * the timeline's, and the assertions are exact frame numbers worked out by
 * hand in the comments rather than recomputed by the same code under test.
 *
 * The other thing asserted is ORDER, because the realistic failure is not a
 * wrong number but a right number in the wrong place: a silence cut produces
 * many clips from ONE file, and a per-file walk would emit them in the order
 * they were shot rather than the order they play. The `sameSourceCut` fixture
 * is that case, with a gap between the two clips' source ranges and the later
 * source range placed FIRST on the timeline.
 */
import { describe, expect, it } from 'vitest';

import {
  dialogueClips,
  locateTimelineFrame,
  rowAtTimelineFrame,
  stitchTimelineTranscript,
  transcriptSources,
  type TimelineTranscriptRow,
} from './timelineTranscript';
import type { Timeline, Clip } from './timeline';
import type { Transcript, TranscriptSegment, TranscriptWord } from './mediaUnderstandingStore';

const FPS = 24;
const A = '/media/take-a.mov';
const B = '/media/take-b.mov';

function clip(over: Partial<Clip> & Pick<Clip, 'id' | 'start_frame'>): Clip {
  return {
    name: over.id,
    source_path: A,
    source_start: 0,
    duration: 240,
    source_len: 24000,
    ...over,
  } as Clip;
}

function timeline(clips: Clip[], over: Partial<Timeline> = {}): Timeline {
  return {
    id: 't',
    name: 'T',
    rate: { num: FPS, den: 1 },
    tracks: [{ kind: 'video', clips }],
    ...over,
  } as Timeline;
}

function seg(start: number, end: number, text: string): TranscriptSegment {
  return { start, end, text, words: [] };
}

/** A segment carrying real per-word timings, the shape `wordTimestamps: true`
 *  produces. Each entry is `[word, start, end]` in absolute SOURCE seconds. */
function wordSeg(text: string, words: Array<[string, number, number]>): TranscriptSegment {
  const ws: TranscriptWord[] = words.map(([word, start, end]) => ({ word, start, end }));
  return { start: ws[0].start, end: ws[ws.length - 1].end, text, words: ws };
}

function transcript(path: string, segments: TranscriptSegment[]): Transcript {
  return {
    text: segments.map((s) => s.text).join(' '),
    language: 'en',
    model: 'test',
    source: path,
    segments,
  };
}

/** A post-cut timeline: TWO clips from the SAME file, with a gap between their
 *  source ranges (the silence that was cut out), and — deliberately — the
 *  LATER source range placed FIRST on the timeline, which is what a retake
 *  reorder produces. A per-file walk would read these out backwards. */
function sameSourceCut(): Timeline {
  return timeline([
    // Timeline 0..120 plays source frames 240..360 (source seconds 10..15).
    clip({ id: 'second-half', start_frame: 0, source_start: 240, duration: 120 }),
    // Timeline 120..240 plays source frames 0..120 (source seconds 0..5).
    clip({ id: 'first-half', start_frame: 120, source_start: 0, duration: 120 }),
  ]);
}

describe('dialogueClips — what counts as transcribable, and in what order', () => {
  it('orders by timeline position, not by Vec order or by file', () => {
    const tl = timeline([
      clip({ id: 'late', start_frame: 500 }),
      clip({ id: 'early', start_frame: 10 }),
      clip({ id: 'middle', start_frame: 100 }),
    ]);
    expect(dialogueClips(tl).map((p) => p.clip.id)).toEqual(['early', 'middle', 'late']);
  });

  it('tie-breaks clips that start on the same frame by track index', () => {
    const tl = timeline([], {
      tracks: [
        { kind: 'video', clips: [clip({ id: 'v0', start_frame: 48 })] },
        { kind: 'video', clips: [clip({ id: 'v1', start_frame: 48 })] },
      ],
    });
    expect(dialogueClips(tl).map((p) => p.clip.id)).toEqual(['v0', 'v1']);
    expect(dialogueClips(tl).map((p) => p.track)).toEqual([0, 1]);
  });

  it('skips audio tracks, hidden tracks, source-less clips and stills', () => {
    const tl = timeline([], {
      tracks: [
        {
          kind: 'video',
          clips: [
            clip({ id: 'real', start_frame: 0 }),
            // A title clip: no file to transcribe.
            clip({ id: 'title', start_frame: 300, source_path: undefined }),
            // D-292 still: a PNG has no audio at all.
            clip({ id: 'still', start_frame: 400, source_path: '/media/card.png' }),
          ],
        },
        // Hidden: does not composite, so its speech is not in this edit.
        { kind: 'video', hidden: true, clips: [clip({ id: 'hidden', start_frame: 0 })] },
        // Audio track: excluded on purpose — an A/V-linked pair would otherwise
        // be counted twice. See `dialogueClips`' own note and D-329.
        { kind: 'audio', clips: [clip({ id: 'audio', start_frame: 0 })] },
      ],
    });
    expect(dialogueClips(tl).map((p) => p.clip.id)).toEqual(['real']);
  });

  it('is empty, not a throw, for a null timeline', () => {
    expect(dialogueClips(null)).toEqual([]);
  });
});

describe('transcriptSources — the deduped fetch list', () => {
  it('counts many clips from one file as ONE source to transcribe', () => {
    // The whole point: a silence cut makes dozens of clips against one file and
    // that must cost one transcription.
    expect(transcriptSources(sameSourceCut())).toEqual([{ path: A, clipCount: 2 }]);
  });

  it('lists several files in FIRST-USE timeline order', () => {
    const tl = timeline([
      clip({ id: 'b-first', start_frame: 0, source_path: B }),
      clip({ id: 'a-later', start_frame: 200, source_path: A }),
      clip({ id: 'b-again', start_frame: 400, source_path: B }),
    ]);
    // B first because it is first on the TIMELINE, and once only.
    expect(transcriptSources(tl)).toEqual([
      { path: B, clipCount: 2 },
      { path: A, clipCount: 1 },
    ]);
  });
});

describe('stitchTimelineTranscript — source seconds to timeline frames', () => {
  /** Compact view of what a row claims, for readable assertions. */
  function summarise(rows: TimelineTranscriptRow[]): Array<[string, number, number]> {
    return rows.map((r) => [r.text, r.startFrame, r.endFrame]);
  }

  it('remaps a trimmed, offset clip’s segment onto the timeline', () => {
    // Clip plays source frames 24..504 (source seconds 1..21) at timeline 48.
    const tl = timeline([clip({ id: 'c1', start_frame: 48, source_start: 24, duration: 480 })]);
    const rows = stitchTimelineTranscript(tl, {
      [A]: transcript(A, [seg(3.0, 6.0, 'a line')]),
    });

    // Source second 3.0 is source frame 72. The clip is trimmed to start at
    // source frame 24 and sits at timeline frame 48, so:
    //   48 + (72 - 24) = 96.   End: source 6.0 = frame 144 -> 48 + 120 = 168.
    // A naive "seconds x fps" would say 72; ignoring the trim would say 120.
    expect(summarise(rows)).toEqual([['a line', 96, 168]]);
  });

  it('stitches TWO clips from the SAME file into one continuous, timeline-ordered list', () => {
    const tl = sameSourceCut();
    // One transcript for the whole file. Its second segment (10..15s) was shot
    // LATER but is placed FIRST on this timeline.
    const rows = stitchTimelineTranscript(tl, {
      [A]: transcript(A, [
        seg(0.0, 5.0, 'shot first'),
        // Speech in the cut-out gap (5..10s) — on the file, not on the timeline.
        seg(6.0, 8.0, 'the bit that got cut'),
        seg(10.0, 15.0, 'shot last'),
      ]),
    });

    // Reading order follows the TIMELINE, so the later take comes first:
    //   'shot last'  plays from the clip at timeline 0, which starts at source
    //                frame 240 (=10s): 0 + (240-240)=0 .. 0 + (360-240)=120.
    //   'shot first' plays from the clip at timeline 120, source_start 0:
    //                120 + 0 = 120 .. 120 + 120 = 240.
    // And the cut-out line appears NOWHERE, because no clip shows it.
    expect(summarise(rows)).toEqual([
      ['shot last', 0, 120],
      ['shot first', 120, 240],
    ]);
  });

  it('interleaves clips from DIFFERENT files in timeline order', () => {
    const tl = timeline([
      clip({ id: 'a1', start_frame: 0, source_path: A, source_start: 0, duration: 48 }),
      clip({ id: 'b1', start_frame: 48, source_path: B, source_start: 0, duration: 48 }),
      clip({ id: 'a2', start_frame: 96, source_path: A, source_start: 120, duration: 48 }),
    ]);
    const rows = stitchTimelineTranscript(tl, {
      [A]: transcript(A, [seg(0, 2, 'A early'), seg(5, 7, 'A late')]),
      [B]: transcript(B, [seg(0, 2, 'B middle')]),
    });

    // a1 shows source 0..2s -> timeline 0..48.
    // b1 shows source 0..2s of B -> 48 + 0 .. 48 + 48 = 48..96.
    // a2 is trimmed to source frames 120..168 (5..7s) -> 96 + 0 .. 96 + 48.
    expect(summarise(rows)).toEqual([
      ['A early', 0, 48],
      ['B middle', 48, 96],
      ['A late', 96, 144],
    ]);
    expect(rows.map((r) => r.clipId)).toEqual(['a1', 'b1', 'a2']);
    expect(rows.map((r) => r.sourcePath)).toEqual([A, B, A]);
  });

  it('converts at the CLIP’s own source_fps, not the timeline’s (B-077)', () => {
    // A 48fps source on a 24fps timeline. Its `source_start`/`duration` are
    // 48fps frames; `start_frame` is a 24fps frame.
    // Clip plays source frames 480..960, i.e. source seconds 10..20.
    const tl = timeline([
      clip({ id: 'hi', start_frame: 100, source_start: 480, duration: 480, source_fps: 48 }),
    ]);
    const rows = stitchTimelineTranscript(tl, {
      [A]: transcript(A, [seg(12.0, 14.0, 'fast source')]),
    });

    // Source second 12.0 is source frame 576 (12 x 48). That is 96 source
    // frames past the in-point, which is 2 seconds, which is 48 TIMELINE
    // frames: 100 + 48 = 148. End: 14.0s -> 672 -> 192 source frames in ->
    // 4s -> 96 timeline frames -> 196.
    //
    // The unconverted arithmetic B-077 shipped — start_frame + (sourceFrame -
    // source_start) — would have said 100 + 96 = 196 for the START, i.e. the
    // row's start landing on its own correct END. That is the whole reason
    // this fixture exists.
    expect(summarise(rows)).toEqual([['fast source', 148, 196]]);
  });

  it('keeps a segment that straddles the in-point, clamped to what is on the timeline', () => {
    // Clip starts 2s (48 frames) into the source.
    const tl = timeline([clip({ id: 'c1', start_frame: 0, source_start: 48, duration: 240 })]);
    const rows = stitchTimelineTranscript(tl, {
      [A]: transcript(A, [seg(1.0, 3.0, 'starts before the cut')]),
    });

    // The speech runs 1..3s but the clip only shows from 2s, so the row starts
    // at timeline 0 (clamped) and ends at 3.0s = source frame 72 = 24 frames
    // past the in-point = timeline 24.
    expect(summarise(rows)).toEqual([['starts before the cut', 0, 24]]);
  });

  it('excludes a segment that only touches the boundary', () => {
    // Clip shows source seconds 2.0 onward; a segment ending exactly at 2.0
    // contributes no audible frame.
    const tl = timeline([clip({ id: 'c1', start_frame: 0, source_start: 48, duration: 240 })]);
    const rows = stitchTimelineTranscript(tl, {
      [A]: transcript(A, [seg(0.5, 2.0, 'entirely before'), seg(2.0, 3.0, 'just inside')]),
    });
    expect(summarise(rows)).toEqual([['just inside', 0, 24]]);
  });

  it('renders the files that ARE transcribed and skips the ones that are not', () => {
    // The partial-progress case: B is still transcribing, A is done. The reader
    // gets A's rows now rather than an empty panel until the slowest file lands.
    const tl = timeline([
      clip({ id: 'a1', start_frame: 0, source_path: A, duration: 48 }),
      clip({ id: 'b1', start_frame: 48, source_path: B, duration: 48 }),
    ]);
    const rows = stitchTimelineTranscript(tl, { [A]: transcript(A, [seg(0, 2, 'A only')]) });
    expect(summarise(rows)).toEqual([['A only', 0, 48]]);
  });

  it('trims each row’s text and reports the source seconds it came from', () => {
    const tl = timeline([clip({ id: 'c1', start_frame: 0, duration: 240 })]);
    const [row] = stitchTimelineTranscript(tl, {
      [A]: transcript(A, [seg(1.0, 2.0, '  padded  ')]),
    });
    expect(row.text).toBe('padded');
    expect(row.sourceStart).toBe(1.0);
    expect(row.sourceEnd).toBe(2.0);
    expect(row.track).toBe(0);
  });

  it('is empty for a null timeline and for an empty transcript map', () => {
    expect(stitchTimelineTranscript(null, {})).toEqual([]);
    expect(stitchTimelineTranscript(sameSourceCut(), {})).toEqual([]);
  });
});

describe('stitchTimelineTranscript — WORDS, remapped the same way as their segment', () => {
  it('puts every word on the timeline at its own frame', () => {
    // Clip plays source frames 24..504 (source seconds 1..21) at timeline 48.
    const tl = timeline([clip({ id: 'c1', start_frame: 48, source_start: 24, duration: 480 })]);
    const [row] = stitchTimelineTranscript(tl, {
      [A]: transcript(A, [
        wordSeg('hello there world', [
          ['hello', 1.0, 1.5],
          [' there', 2.0, 2.5],
          [' world', 3.0, 4.0],
        ]),
      ]),
    });

    // Each word is `48 + (word_seconds*24 - 24)`:
    //   1.0s -> frame 24  -> 48 + 0  = 48
    //   1.5s -> frame 36  -> 48 + 12 = 60
    //   2.0s -> frame 48  -> 48 + 24 = 72
    //   3.0s -> frame 72  -> 48 + 48 = 96
    //   4.0s -> frame 96  -> 48 + 72 = 120
    expect(row.words.map((w) => [w.text, w.startFrame, w.endFrame])).toEqual([
      ['hello', 48, 60],
      [' there', 72, 84],
      [' world', 96, 120],
    ]);
  });

  it('keeps each word’s own leading space, so the row reads as prose', () => {
    const tl = timeline([clip({ id: 'c1', start_frame: 0, duration: 240 })]);
    const [row] = stitchTimelineTranscript(tl, {
      [A]: transcript(A, [
        wordSeg("don't stop", [
          ["don't", 0.0, 0.5],
          [' stop', 0.5, 1.0],
        ]),
      ]),
    });
    // A naive `words.join(' ')` would produce "don't  stop"; preserving the
    // model's own spacing is what makes contractions and punctuation survive.
    expect(row.words.map((w) => w.text).join('')).toBe("don't stop");
  });

  it('converts words at the clip’s own source_fps too (B-077)', () => {
    // Same 48fps-source-on-a-24fps-timeline fixture as the segment case.
    const tl = timeline([
      clip({ id: 'hi', start_frame: 100, source_start: 480, duration: 480, source_fps: 48 }),
    ]);
    const [row] = stitchTimelineTranscript(tl, {
      [A]: transcript(A, [
        wordSeg('fast source', [
          ['fast', 12.0, 12.5],
          [' source', 13.0, 14.0],
        ]),
      ]),
    });

    // 12.0s -> source frame 576 -> 96 source frames in -> 2s -> 48 timeline
    // frames -> 148.  13.0s -> 624 -> 144 in -> 3s -> 72 -> 172.
    expect(row.words.map((w) => [w.text, w.startFrame])).toEqual([
      ['fast', 148],
      [' source', 172],
    ]);
  });

  it('drops words that fall outside the clip, and clamps one that straddles the cut', () => {
    // Clip shows source seconds 2.0 onward (source_start 48).
    const tl = timeline([clip({ id: 'c1', start_frame: 0, source_start: 48, duration: 240 })]);
    const [row] = stitchTimelineTranscript(tl, {
      [A]: transcript(A, [
        wordSeg('before straddling after', [
          // Entirely before the in-point: not on the timeline at all.
          ['before', 0.5, 1.0],
          // Straddles it: kept, clamped to the clip's first frame.
          [' straddling', 1.8, 2.5],
          [' after', 3.0, 3.5],
        ]),
      ]),
    });

    expect(row.words.map((w) => [w.text, w.startFrame, w.endFrame])).toEqual([
      // Clamped: starts at timeline 0 rather than before it. 2.5s = source
      // frame 60 = 12 frames past the in-point.
      [' straddling', 0, 12],
      // 3.0s = frame 72 -> 24 past the in-point; 3.5s = 84 -> 36.
      [' after', 24, 36],
    ]);
  });

  it('yields an empty word list when the transcript has no word timings', () => {
    // `wordTimestamps: false`, or a model that returned none. The row is still
    // produced and still seekable — it just has no per-word granularity.
    const tl = timeline([clip({ id: 'c1', start_frame: 0, duration: 240 })]);
    const [row] = stitchTimelineTranscript(tl, {
      [A]: transcript(A, [seg(0.0, 2.0, 'no word timings here')]),
    });
    expect(row.words).toEqual([]);
    expect(row.text).toBe('no word timings here');
  });
});

describe('locateTimelineFrame — which row AND which word the playhead is on', () => {
  const tl = timeline([
    clip({ id: 'c1', start_frame: 0, source_start: 0, duration: 120 }),
    clip({ id: 'c2', start_frame: 120, source_start: 240, duration: 120 }),
  ]);
  const rows = stitchTimelineTranscript(tl, {
    [A]: transcript(A, [
      // Clip c1 shows source 0..5s.
      wordSeg('one two', [
        ['one', 0.0, 1.0], // timeline 0..24
        [' two', 2.0, 3.0], // timeline 48..72
      ]),
      // Clip c2 shows source 10..15s, placed at timeline 120.
      wordSeg('three', [['three', 10.0, 11.0]]), // timeline 120..144
    ]),
  });

  it('reports the word inside the row', () => {
    expect(locateTimelineFrame(rows, 0)).toEqual({ row: 0, word: 0 });
    expect(locateTimelineFrame(rows, 23)).toEqual({ row: 0, word: 0 });
    expect(locateTimelineFrame(rows, 48)).toEqual({ row: 0, word: 1 });
  });

  it('reports the row but NO word in a pause between words', () => {
    // Frame 30 is inside the row (0..72) but between 'one' (ends 24) and
    // 'two' (starts 48). Highlighting a word there would be a lie.
    expect(locateTimelineFrame(rows, 30)).toEqual({ row: 0, word: -1 });
  });

  it('finds a word in a row that came from a DIFFERENT clip of the same file', () => {
    // The stitching case: 'three' is source second 10 in the file, but plays
    // at timeline 120 because it is on the second clip.
    expect(locateTimelineFrame(rows, 130)).toEqual({ row: 1, word: 0 });
  });

  it('is (-1, -1) outside every row', () => {
    expect(locateTimelineFrame(rows, 1000)).toEqual({ row: -1, word: -1 });
    expect(locateTimelineFrame([], 0)).toEqual({ row: -1, word: -1 });
  });
});

describe('rowAtTimelineFrame — which row the playhead is inside', () => {
  const rows = stitchTimelineTranscript(sameSourceCut(), {
    [A]: transcript(A, [seg(0.0, 5.0, 'shot first'), seg(10.0, 15.0, 'shot last')]),
  });

  it('finds the row across a clip boundary, using TIMELINE frames', () => {
    // Rows are ['shot last', 0..120] then ['shot first', 120..240].
    expect(rowAtTimelineFrame(rows, 0)).toBe(0);
    expect(rowAtTimelineFrame(rows, 119)).toBe(0);
    // Half-open: the boundary frame belongs to the NEXT row, so the two clips'
    // rows cannot both claim frame 120.
    expect(rowAtTimelineFrame(rows, 120)).toBe(1);
    expect(rowAtTimelineFrame(rows, 239)).toBe(1);
  });

  it('returns -1 outside every row', () => {
    expect(rowAtTimelineFrame(rows, 240)).toBe(-1);
    expect(rowAtTimelineFrame(rows, -1)).toBe(-1);
    expect(rowAtTimelineFrame([], 0)).toBe(-1);
  });
});
