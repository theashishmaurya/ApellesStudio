// @chroma/editor — auto-captioning from the D-189 transcript (D-238).
//
// Fixture-based: every test asserts the EXACT cues (count, text, start/end)
// a known transcript produces, not just "some cues came out" — the same
// discipline `caption.test.ts` holds `captionLayout` to.
import { describe, expect, it } from 'vitest';

import type { TranscriptSegment, TranscriptWord } from './mediaUnderstandingStore';
import {
  DEFAULT_MAX_CUE_DURATION_S,
  DEFAULT_MAX_PAUSE_GAP_S,
  DEFAULT_MAX_WORDS_PER_CUE,
  generatedCuesToCaptions,
  groupTranscriptIntoCues,
  sanitiseIdStem,
} from './captionsFromTranscript';

/** Build a word with mlx-whisper's own leading-space convention. */
function w(word: string, start: number, end: number): TranscriptWord {
  return { word, start, end };
}

function segment(words: TranscriptWord[]): TranscriptSegment {
  const start = words[0]?.start ?? 0;
  const end = words[words.length - 1]?.end ?? 0;
  return { start, end, text: words.map((x) => x.word).join('').trim(), words };
}

describe('groupTranscriptIntoCues', () => {
  it('groups a short segment of ordinary speech into one cue', () => {
    const seg = segment([
      w(' We', 0.0, 0.2),
      w(' always', 0.2, 0.5),
      w(' visit', 0.5, 0.8),
      w(' this', 0.8, 1.0),
      w(' beach', 1.0, 1.4),
    ]);
    const cues = groupTranscriptIntoCues([seg]);
    expect(cues).toEqual([{ text: 'We always visit this beach', start_s: 0.0, end_s: 1.4 }]);
  });

  it('never merges two segments into one cue, even when both are short', () => {
    // This IS the sentence-boundary-awareness the module doc describes:
    // mlx-whisper's own segment break is reused as a cue break rather than
    // re-detected from punctuation.
    const segA = segment([w(' Hello', 0.0, 0.3), w(' there.', 0.3, 0.7)]);
    const segB = segment([w(' Second', 1.0, 1.3), w(' sentence.', 1.3, 1.8)]);
    const cues = groupTranscriptIntoCues([segA, segB]);
    expect(cues).toEqual([
      { text: 'Hello there.', start_s: 0.0, end_s: 0.7 },
      { text: 'Second sentence.', start_s: 1.0, end_s: 1.8 },
    ]);
  });

  it('breaks at DEFAULT_MAX_WORDS_PER_CUE words even mid-segment', () => {
    expect(DEFAULT_MAX_WORDS_PER_CUE).toBe(8);
    // 10 words, each 0.2s with no gaps and no punctuation — nothing else
    // would force a break, so the word-count cap is the only thing that can.
    const words: TranscriptWord[] = [];
    const labels = ['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten'];
    for (let i = 0; i < labels.length; i++) {
      words.push(w(` ${labels[i]}`, i * 0.2, i * 0.2 + 0.2));
    }
    const cues = groupTranscriptIntoCues([segment(words)]);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ text: 'one two three four five six seven eight', start_s: 0, end_s: 1.6 });
    expect(cues[1]).toEqual({ text: 'nine ten', start_s: 1.6, end_s: 2.0 });
  });

  it('breaks at DEFAULT_MAX_CUE_DURATION_S even under the word cap', () => {
    expect(DEFAULT_MAX_CUE_DURATION_S).toBe(3.0);
    // 4 words spanning 4 seconds total (1s each), well under the 8-word cap.
    const words = [
      w(' one', 0.0, 1.0),
      w(' two', 1.0, 2.0),
      w(' three', 2.0, 3.0),
      w(' four', 3.0, 4.0),
    ];
    const cues = groupTranscriptIntoCues([segment(words)]);
    // "three" ends the first group: start(0) to its own end(3.0) hits the cap.
    expect(cues).toEqual([
      { text: 'one two three', start_s: 0.0, end_s: 3.0 },
      { text: 'four', start_s: 3.0, end_s: 4.0 },
    ]);
  });

  it('breaks early on a pause at least DEFAULT_MAX_PAUSE_GAP_S long', () => {
    expect(DEFAULT_MAX_PAUSE_GAP_S).toBe(0.7);
    const words = [
      w(' Wait', 0.0, 0.3),
      // 0.8s gap to the next word — a real pause, forces a break here.
      w(' for', 1.1, 1.3),
      w(' it', 1.3, 1.5),
    ];
    const cues = groupTranscriptIntoCues([segment(words)]);
    expect(cues).toEqual([
      { text: 'Wait', start_s: 0.0, end_s: 0.3 },
      { text: 'for it', start_s: 1.1, end_s: 1.5 },
    ]);
  });

  it('respects an overridden maxWords/maxDurationS/maxPauseGapS', () => {
    const words = [w(' a', 0.0, 0.1), w(' b', 0.1, 0.2), w(' c', 0.2, 0.3)];
    const cues = groupTranscriptIntoCues([segment(words)], { maxWords: 2 });
    expect(cues).toEqual([
      { text: 'a b', start_s: 0.0, end_s: 0.2 },
      { text: 'c', start_s: 0.2, end_s: 0.3 },
    ]);
  });

  it('degrades a non-finite or non-positive option override to the default', () => {
    const words = [w(' a', 0.0, 0.1), w(' b', 0.1, 0.2)];
    const withBadOptions = groupTranscriptIntoCues([segment(words)], {
      maxWords: Number.NaN,
      maxDurationS: -1,
      maxPauseGapS: 0,
    });
    const withDefaults = groupTranscriptIntoCues([segment(words)]);
    expect(withBadOptions).toEqual(withDefaults);
  });

  it('skips a segment with no word-level timings rather than emitting a segment-level cue', () => {
    const noWords: TranscriptSegment = { start: 0, end: 5, text: 'untimed speech', words: [] };
    expect(groupTranscriptIntoCues([noWords])).toEqual([]);
  });

  it('returns [] for no segments at all', () => {
    expect(groupTranscriptIntoCues([])).toEqual([]);
  });

  it('joins mlx-whisper leading-space words into clean natural text', () => {
    const seg = segment([w(' Swimming,', 8.0, 8.5), w(' surfing', 8.5, 9.0), w(' sunsets.', 9.0, 9.6)]);
    const cues = groupTranscriptIntoCues([seg]);
    expect(cues[0].text).toBe('Swimming, surfing sunsets.');
  });
});

describe('generatedCuesToCaptions', () => {
  it('mirrors cues_to_clips: independent per-timestamp rounding, min 1-frame duration', () => {
    const cues = [
      { text: 'A', start_s: 1.0, end_s: 2.0 },
      // A very short cue (10ms at 24fps rounds both ends to the SAME frame)
      // still gets a real, visible duration — same as the Rust fixture
      // `cues_become_clips_on_the_projects_own_timebase`.
      { text: 'B', start_s: 2.0, end_s: 2.01 },
    ];
    const captions = generatedCuesToCaptions(cues, 24, 0, 'cap-transcript-');
    expect(captions[0]).toEqual({ id: 'cap-transcript-0', start_frame: 24, duration: 24, text: 'A' });
    expect(captions[1].start_frame).toBe(48);
    expect(captions[1].duration).toBe(1);
    expect(captions[1].id).toBe('cap-transcript-1');
  });

  it('honours a non-zero offset — dropping the track at the playhead, not 0:00', () => {
    const cues = [{ text: 'A', start_s: 1.0, end_s: 2.0 }];
    const captions = generatedCuesToCaptions(cues, 24, 100, 'cap-');
    expect(captions[0].start_frame).toBe(124);
  });

  it('falls back to 24fps for a non-finite or non-positive fps', () => {
    const cues = [{ text: 'A', start_s: 1.0, end_s: 2.0 }];
    expect(generatedCuesToCaptions(cues, 0, 0, 'cap-')[0].start_frame).toBe(24);
    expect(generatedCuesToCaptions(cues, Number.NaN, 0, 'cap-')[0].start_frame).toBe(24);
  });
});

describe('sanitiseIdStem', () => {
  it('mirrors the Rust sanitise_id convention', () => {
    expect(sanitiseIdStem('My Film — EN')).toBe('my-film---en');
    expect(sanitiseIdStem('---')).toBe('');
  });
});
