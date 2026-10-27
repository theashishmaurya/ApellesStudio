/**
 * D-411 Phase 0 — captions from the TIMELINE transcript follow the edit's cuts.
 *
 * One 24 fps source, one word every half second. The timeline plays it in two
 * pieces with the middle cut out and the second piece pulled up to close the
 * gap (what a ripple delete, or a short assembled from two moments, does), so
 * every later word moves EARLIER on the timeline than in the file. A caption
 * made from the file plus one offset would put those words at their file
 * times; `captionsForTimeline` must put them where they play, drop the words
 * that were cut, and keep a sentence that the cut split as one unit.
 */
import { describe, expect, it } from 'vitest';

import { captionsForTimeline, timelineRowsToCaptions } from './captionsFromTranscript';
import type { Transcript } from './mediaUnderstandingStore';
import type { Timeline } from './timeline';
import type { TimelineTranscriptRow } from './timelineTranscript';

const SOURCE = '/fixtures/talk.mov';
const FPS = 24;

// Word i spans [i*0.5, i*0.5+0.4) s. Two sentences (segments):
//   0..5  "one two three four five six"   (0.0 – 2.9 s)
//   6..11 "seven eight nine ten eleven twelve" (3.0 – 5.9 s)
const WORDS = 'one two three four five six seven eight nine ten eleven twelve'.split(' ');

function transcript(): Transcript {
  const words = WORDS.map((w, i) => ({ word: ` ${w}`, start: i * 0.5, end: i * 0.5 + 0.4 }));
  return {
    text: WORDS.join(' '),
    language: 'en',
    model: 't',
    source: SOURCE,
    segments: [
      { start: 0, end: 2.9, text: WORDS.slice(0, 6).join(' '), words: words.slice(0, 6) },
      { start: 3, end: 5.9, text: WORDS.slice(6).join(' '), words: words.slice(6) },
    ],
    words,
  };
}

/** Plays source 0–1.5 s ("one two three"), then source 4.0–6.0 s ("nine …
 *  twelve") straight after it, at timeline 1.5 s. Source 1.5–4.0 s is cut. */
function cutTimeline(): Timeline {
  const clip = (id: string, sourceStart: number, duration: number, startFrame: number) => ({
    id,
    name: id,
    source_path: SOURCE,
    source_start: sourceStart,
    duration,
    source_len: 6 * FPS,
    source_fps: FPS,
    start_frame: startFrame,
  });
  return {
    id: 'short',
    name: 'Short 1',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [clip('a', 0, 36, 0), clip('b', 96, 48, 36)],
        gain: 1,
        sync_locked: false,
      },
    ],
    markers: [],
  };
}

describe('captions from the timeline transcript', () => {
  it('lands every cue where its words PLAY, without the words that were cut', () => {
    const captions = captionsForTimeline(cutTimeline(), { [SOURCE]: transcript() }, {});
    const text = captions.map((c) => c.text).join(' ');
    expect(text).toBe('one two three nine ten eleven twelve');
    expect(text).not.toMatch(/four|five|six|seven|eight/);

    // "nine" is at source 4.0 s (frame 96) but plays at timeline 1.5 s
    // (frame 36), right after the cut. A file-plus-offset caption would have
    // put it at frame 96.
    const second = captions.find((c) => c.text.startsWith('nine'));
    expect(second?.start_frame).toBe(36);
    expect(captions[0].start_frame).toBe(0);
    // Ids follow the timeline's name, like an imported file's follow its stem.
    expect(captions.every((c) => c.id.startsWith('cap-short-1-'))).toBe(true);
    // Every cue sits inside the timeline's 84 frames.
    for (const c of captions) expect(c.start_frame + c.duration).toBeLessThanOrEqual(84);
  });

  it('keeps a sentence split by a cut as one grouping unit, and plays a cut word once', () => {
    // Two rows from the SAME source segment, as a pause ripple-deleted out of
    // a sentence leaves them; the cut fell inside "two", so each row holds a
    // clamped piece of it.
    const rows: TimelineTranscriptRow[] = [
      {
        clipId: 'a',
        track: 0,
        sourcePath: SOURCE,
        startFrame: 0,
        endFrame: 14,
        sourceStart: 0,
        sourceEnd: 2.9,
        text: 'one two',
        words: [
          { text: ' one', startFrame: 0, endFrame: 10, sourceStart: 0, sourceEnd: 0.4 },
          { text: ' two', startFrame: 12, endFrame: 14, sourceStart: 0.5, sourceEnd: 0.9 },
        ],
      },
      {
        clipId: 'b',
        track: 0,
        sourcePath: SOURCE,
        startFrame: 14,
        endFrame: 40,
        sourceStart: 0,
        sourceEnd: 2.9,
        text: 'two three',
        words: [
          { text: ' two', startFrame: 14, endFrame: 20, sourceStart: 0.5, sourceEnd: 0.9 },
          { text: ' three', startFrame: 22, endFrame: 32, sourceStart: 1, sourceEnd: 1.4 },
        ],
      },
    ];
    const captions = timelineRowsToCaptions(rows, FPS, {}, 'cap-x-');
    expect(captions).toHaveLength(1);
    expect(captions[0]).toEqual({ id: 'cap-x-0', start_frame: 0, duration: 32, text: 'one two three' });
  });

  it('never merges rows from different sentences, even when they are adjacent', () => {
    const captions = captionsForTimeline(cutTimeline(), { [SOURCE]: transcript() }, {}, { maxWords: 20 });
    // With room for 20 words per cue, only the sentence boundary separates them.
    expect(captions.map((c) => c.text)).toEqual(['one two three', 'nine ten eleven twelve']);
  });
});
