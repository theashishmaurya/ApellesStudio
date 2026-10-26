// D-396/D-397 — the highlight suggester's matching: runs of spoken words found
// in the OCR text, trimmed, boxed, timed, and the headline fallback.
import { describe, expect, it } from 'vitest';
import {
  MIN_CONTENT_WORDS,
  normaliseToken,
  padHighlightBox,
  suggestHighlights,
  tokensMatch,
  type OcrLine,
  type SpokenWord,
} from './highlightSuggest';

/** A line of OCR words laid out left to right across `[x0, x1]` at row `y`. */
function line(text: string, y: number, h = 0.05, x0 = 0.1, x1 = 0.9): OcrLine {
  const words = text.split(' ');
  const step = (x1 - x0) / words.length;
  return {
    text,
    bbox: [x0, y, x1, y + h],
    confidence: 0.9,
    words: words.map((w, i) => ({
      text: w,
      bbox: [x0 + i * step, y, x0 + (i + 1) * step - 0.005, y + h],
      confidence: 0.9,
    })),
  };
}

/** Spoken words one every 10 frames starting at `from`, each 8 frames long. */
function speech(text: string, from = 100): SpokenWord[] {
  return text.split(' ').map((w, i) => ({ text: w, startFrame: from + i * 10, endFrame: from + i * 10 + 8 }));
}

// Clip placed so timeline frame F is source frame F - 90 (source_start 10,
// start_frame 100): the identity-plus-offset a plain 1x clip has.
const base = {
  sourceFrameAt: (f: number) => f - 90,
  clipSourceStart: 10,
  clipSourceFps: 30,
  clipSourceFrames: 400,
};

describe('token matching', () => {
  it('normalises to lowercase letters and digits', () => {
    expect(normaliseToken('“Trust,”')).toBe('trust');
    expect(normaliseToken('$4.5M')).toBe('45m');
    expect(normaliseToken('—')).toBe('');
  });

  it('forgives one slip in a long word but not in a short one', () => {
    expect(tokensMatch('customers', 'customer')).toBe(true);
    expect(tokensMatch('breech', 'breach')).toBe(true);
    expect(tokensMatch('cat', 'cut')).toBe(false);
    // Five-letter words are too short to forgive a slip: trust/crust differ.
    expect(tokensMatch('trust', 'crust')).toBe(false);
  });
});

describe('suggestHighlights', () => {
  it('highlights a spoken phrase over the exact frames it is spoken', () => {
    const out = suggestHighlights({
      ...base,
      lines: [line('Breach of customer trust at Acme', 0.3)],
      spoken: speech('the breach of customer trust was huge'),
    });
    expect(out.basis).toBe('transcript');
    expect(out.phrases).toEqual([{ text: 'breach of customer trust', startFrame: 110, endFrame: 148 }]);
    expect(out.highlights).toHaveLength(1);
    const [h] = out.highlights;
    expect(h.at).toBe(20); // timeline 110 -> source 20
    expect(h.dur).toBe(38); // 110 -> 148
    // Box spans words 0..3 of the six OCR words, padded, on row y 0.3..0.35.
    expect(h.box[0]).toBeLessThan(0.1);
    expect(h.box[2]).toBeGreaterThan(0.1 + (0.8 / 6) * 4 - 0.01);
    expect(h.box[2]).toBeLessThan(0.1 + (0.8 / 6) * 4 + 0.02);
    expect(h.box[1]).toBeLessThan(0.3);
    expect(h.box[3]).toBeGreaterThan(0.35);
  });

  it('trims stopwords off both ends but keeps them inside the run', () => {
    const out = suggestHighlights({
      ...base,
      lines: [line('the loss of data in the cloud', 0.4)],
      spoken: speech('the loss of data in the cloud'),
    });
    // The leading "the" is dropped; "of" and "in the" stay because content
    // words stand on both sides of them.
    expect(out.phrases[0].text).toBe('loss of data in the cloud');
  });

  it('ignores a run with fewer than two content words', () => {
    expect(MIN_CONTENT_WORDS).toBe(2);
    const out = suggestHighlights({
      ...base,
      lines: [line('Quarterly report', 0.2)],
      spoken: speech('and the quarterly numbers'),
    });
    expect(out.basis).toBe('headline'); // fell back: only "quarterly" matched
    expect(out.phrases).toEqual([]);
  });

  it('sweeps a phrase that wraps across two lines in order, sharing the duration by width', () => {
    const out = suggestHighlights({
      ...base,
      lines: [line('Hackers stole customer', 0.2, 0.05, 0.1, 0.7), line('passwords overnight', 0.28, 0.05, 0.1, 0.4)],
      spoken: speech('hackers stole customer passwords overnight', 200),
    });
    expect(out.highlights).toHaveLength(2);
    const [a, b] = out.highlights;
    expect(a.box[1]).toBeLessThan(b.box[1]);
    // The second part starts where the first ended.
    expect(b.at).toBe(a.at + a.dur);
    // Together they cover the whole spoken span 200..(240+8).
    expect(b.at + b.dur).toBe(248 - 90);
    expect(out.phrases).toHaveLength(1);
  });

  it('claims words once: the same headline words are not highlighted for two utterances', () => {
    const out = suggestHighlights({
      ...base,
      lines: [line('customer trust', 0.3)],
      spoken: [...speech('customer trust', 100), ...speech('customer trust', 300)],
    });
    expect(out.phrases).toHaveLength(1);
    expect(out.phrases[0].startFrame).toBe(100);
  });

  it('matches several phrases from one picture, in spoken order', () => {
    const out = suggestHighlights({
      ...base,
      lines: [line('Breach hits banks', 0.2), line('Regulators demand answers', 0.5)],
      spoken: [...speech('regulators demand answers', 100), ...speech('breach hits banks', 200)],
    });
    expect(out.phrases.map((p) => p.text)).toEqual(['regulators demand answers', 'breach hits banks']);
    expect(out.highlights.map((h) => Math.round(h.box[1] * 100))).toEqual([49, 19]);
  });

  it('forgives an OCR/ASR slip inside a long word', () => {
    const out = suggestHighlights({
      ...base,
      lines: [line('Million customers affected', 0.3)],
      spoken: speech('million customer affected'),
    });
    expect(out.phrases).toHaveLength(1);
  });

  it('falls back to the largest line, swept once at the clip start', () => {
    const out = suggestHighlights({
      ...base,
      lines: [line('Small print here', 0.8, 0.02), line('HUGE HEADLINE TEXT', 0.1, 0.12)],
      spoken: speech('totally unrelated narration about weather'),
    });
    expect(out.basis).toBe('headline');
    expect(out.highlights).toHaveLength(1);
    const [h] = out.highlights;
    expect(h.at).toBe(10);
    expect(h.dur).toBe(18); // 0.6 s at 30 fps
    expect(h.box[1]).toBeLessThan(0.1);
    expect(h.box[3]).toBeGreaterThan(0.22);
  });

  it('caps the fallback sweep at the clip length and reports no text honestly', () => {
    const short = suggestHighlights({
      ...base,
      clipSourceFrames: 5,
      lines: [line('Headline', 0.1, 0.1)],
      spoken: [],
    });
    expect(short.highlights[0].dur).toBe(5);
    const none = suggestHighlights({ ...base, lines: [], spoken: speech('anything at all') });
    expect(none).toMatchObject({ basis: 'none', highlights: [], phrases: [] });
  });

  it('pads boxes without leaving the image', () => {
    const padded = padHighlightBox([0, 0, 1, 0.05]);
    expect(padded[0]).toBe(0);
    expect(padded[2]).toBe(1);
    expect(padded[1]).toBe(0);
    expect(padded[3]).toBeGreaterThan(0.05);
  });
});
