// B-289 / D-420 — word-aware silences: a VAD silence never overlaps a word.
import { describe, expect, it } from 'vitest';

import { SILENCE_WORD_GUARD_SECS, transcriptWordSpans, wordAwareSilences, type SilenceSecs } from './silenceWords';
import type { Transcript } from './mediaUnderstandingStore';

const sil = (start: number, end: number): SilenceSecs => ({ start_secs: start, end_secs: end, duration_secs: end - start });
const G = SILENCE_WORD_GUARD_SECS;

describe('wordAwareSilences', () => {
  it('pulls a silence that starts inside a soft trailing word back to the word end + guard (the B-289 shape)', () => {
    // "…where you are at" — the VAD's silence starts at 10.20 inside "at"
    // (10.05-10.40); the next sentence starts at 11.50.
    const words = [
      { start: 9.6, end: 9.9 },
      { start: 10.05, end: 10.4 },
      { start: 11.5, end: 11.8 },
    ];
    const got = wordAwareSilences([sil(10.2, 11.6)], words, 0.35);
    expect(got.silences).toHaveLength(1);
    expect(got.silences[0].start_secs).toBeCloseTo(10.4 + G, 9);
    expect(got.silences[0].end_secs).toBeCloseTo(11.5 - G, 9);
    expect(got.trimmed).toBe(1);
    expect(got.dropped).toBe(0);
  });

  it('never returns a range overlapping any word widened by the guard', () => {
    const words = Array.from({ length: 40 }, (_, i) => ({ start: i * 0.9, end: i * 0.9 + 0.5 }));
    const vad = [sil(0.3, 3.0), sil(4.1, 9.7), sil(12.0, 12.6), sil(20.0, 36.0)];
    const { silences } = wordAwareSilences(vad, words, 0.2);
    for (const s of silences) {
      for (const w of words) {
        expect(s.end_secs <= w.start - G + 1e-9 || s.start_secs >= w.end + G - 1e-9).toBe(true);
      }
    }
  });

  it('splits a silence around a word inside it, and drops pieces under the minimum', () => {
    // "Two weeks ago" — the first word buried in a long leading silence.
    const got = wordAwareSilences([sil(0, 3.0)], [{ start: 1.0, end: 1.3 }, { start: 2.95, end: 3.4 }], 0.5);
    expect(got.silences.map((s) => [s.start_secs, s.end_secs])).toEqual([
      [0, 1.0 - G],
      [1.3 + G, 2.95 - G],
    ]);
    const tiny = wordAwareSilences([sil(5.0, 5.6)], [{ start: 5.2, end: 5.4 }], 0.35);
    expect(tiny.silences).toEqual([]);
    expect(tiny.dropped).toBe(1);
  });

  it('only ever shrinks: a silence no word touches is returned exactly, and nothing is added', () => {
    const vad = [sil(1, 2), sil(5, 7)];
    const got = wordAwareSilences(vad, [{ start: 3, end: 4 }], 0.35);
    expect(got.silences).toEqual(vad);
    expect(got.trimmed).toBe(0);
    expect(wordAwareSilences([], [{ start: 0, end: 1 }], 0.1).silences).toEqual([]);
  });

  it('ignores an untimed or inverted word instead of blocking everything', () => {
    const got = wordAwareSilences([sil(1, 2)], [{ start: Number.NaN, end: Number.NaN }, { start: 1.8, end: 1.2 }], 0.35);
    expect(got.silences).toEqual([sil(1, 2)]);
  });
});

describe('transcriptWordSpans', () => {
  const transcript: Transcript = {
    text: 'a b',
    language: 'en',
    model: 't',
    source: '/s.wav',
    segments: [
      { start: 0, end: 1, text: 'a', words: [{ word: ' a', start: 0, end: 1 }] },
      { start: 20, end: 21, text: 'b', words: [{ word: ' b', start: 20, end: 21 }] },
    ],
  };

  it('is null without a transcript — the caller answers VAD-only', () => {
    expect(transcriptWordSpans(undefined, [])).toBeNull();
  });

  it('includes recovered words, the same splice every consumer reads', () => {
    const got = transcriptWordSpans(transcript, [
      {
        window: { startSecs: 5, durationSecs: 10 },
        segments: [{ start: 9, end: 10, text: 'r', words: [{ word: ' r', start: 9, end: 10 }] }],
      },
    ]);
    expect(got).toEqual([
      { start: 0, end: 1 },
      { start: 9, end: 10 },
      { start: 20, end: 21 },
    ]);
  });
});
