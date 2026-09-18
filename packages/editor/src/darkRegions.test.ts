import { describe, expect, it } from 'vitest';

import {
  MAX_RECOVERY_WINDOW_SECS,
  MIN_RECOVERY_WINDOW_SECS,
  recoveredCount,
  recoveryWindows,
  spliceTranscript,
  spliceTranscriptDoc,
  type DarkRegionWire,
  type RecoveredWindow,
} from './darkRegions';
import type { Transcript, TranscriptSegment, TranscriptWord } from './mediaUnderstandingStore';

/** A region as `chroma_detect_dark_regions` puts it on the wire. `stretch`
 *  defaults to the region itself, which is the common single-burst case. */
function region(
  start: number,
  end: number,
  stretch: [number, number] = [start, end],
): DarkRegionWire {
  return {
    start_secs: start,
    end_secs: end,
    duration_secs: end - start,
    stretch_start_secs: stretch[0],
    stretch_end_secs: stretch[1],
    stretch_speech_secs: end - start,
    rms_peak: 0.2,
  };
}

function word(text: string, start: number, end: number): TranscriptWord {
  return { word: text, start, end };
}

/** A segment built from its own words, so `text`/`start`/`end` cannot disagree
 *  with them — the invariant the splice relies on and preserves. */
function segment(words: TranscriptWord[]): TranscriptSegment {
  return {
    start: words[0].start,
    end: words[words.length - 1].end,
    text: words.map((w) => w.word).join('').trim(),
    words,
  };
}

describe('recoveryWindows', () => {
  it('turns one region into one window covering its stretch', () => {
    const [w] = recoveryWindows([region(10, 15, [9, 16])], 0, 100);
    expect(w.startSecs).toBeCloseTo(9);
    expect(w.durationSecs).toBeCloseTo(7);
  });

  /** The reason windows are keyed by STRETCH: a dropped take split by a pause
   *  produces several regions inside one stretch, and re-transcribing each of
   *  them separately would be several Whisper passes over the same audio, each
   *  with less context than the one pass that covers all of them. */
  it('collapses several regions in one stretch into a single window', () => {
    const windows = recoveryWindows(
      [region(10, 11, [9, 20]), region(14, 15, [9, 20]), region(18, 19, [9, 20])],
      0,
      100,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].startSecs).toBeCloseTo(9);
    expect(windows[0].durationSecs).toBeCloseTo(11);
  });

  /** A window must never read material the clip does not show — a recovery
   *  outside the trim would splice words into a transcript for audio that is
   *  not on the timeline. */
  it('clamps a window to the clip range at both edges', () => {
    const windows = recoveryWindows([region(48, 62, [45, 65])], 50, 10);
    expect(windows).toHaveLength(1);
    expect(windows[0].startSecs).toBe(50);
    expect(windows[0].startSecs + windows[0].durationSecs).toBe(60);
  });

  it('drops a stretch that does not intersect the range at all', () => {
    expect(recoveryWindows([region(5, 8)], 50, 10)).toEqual([]);
    expect(recoveryWindows([region(5, 8)], 0, 0)).toEqual([]);
    expect(recoveryWindows([], 0, 100)).toEqual([]);
  });

  /** A 1.3 s extract with nothing around it is where whisper starts inventing;
   *  every confirmed recovery in the research had a second or two of room. */
  it('grows a short stretch to the minimum window, symmetrically', () => {
    const [w] = recoveryWindows([region(50, 51.3)], 0, 100);
    expect(w.durationSecs).toBeCloseTo(MIN_RECOVERY_WINDOW_SECS);
    // Centred on the region: the same amount of context either side.
    expect(50 - w.startSecs).toBeCloseTo(w.startSecs + w.durationSecs - 51.3);
  });

  /** Growing at the very start of a clip cannot reach backwards, so it takes
   *  the whole allowance from the other side rather than returning half a
   *  window. */
  it('takes the whole context from one side when the other is clamped', () => {
    const [w] = recoveryWindows([region(0, 1.3)], 0, 100);
    expect(w.startSecs).toBe(0);
    expect(w.durationSecs).toBeCloseTo(MIN_RECOVERY_WINDOW_SECS);
  });

  /** Whisper's own sliding window is 30 s, so a longer extract would simply be
   *  chunked again — reintroducing the whole-file behaviour the recovery exists
   *  to escape. Splitting rather than truncating is what keeps every located
   *  region inside some window. */
  it('splits a stretch longer than whisper own window into equal pieces', () => {
    const span = MAX_RECOVERY_WINDOW_SECS * 2.5;
    const windows = recoveryWindows([region(0, span, [0, span])], 0, 200);
    expect(windows.length).toBeGreaterThan(1);
    for (const w of windows) expect(w.durationSecs).toBeLessThanOrEqual(MAX_RECOVERY_WINDOW_SECS + 1e-9);
    // No gaps: the pieces tile the stretch, so nothing inside it goes unread.
    expect(windows[0].startSecs).toBeCloseTo(0);
    const last = windows[windows.length - 1];
    expect(last.startSecs + last.durationSecs).toBeCloseTo(span);
  });

  it('returns windows in time order with no overlaps', () => {
    const windows = recoveryWindows(
      [region(80, 82), region(10, 12), region(11.5, 13)],
      0,
      100,
    );
    for (let i = 1; i < windows.length; i += 1) {
      const prev = windows[i - 1];
      expect(windows[i].startSecs).toBeGreaterThanOrEqual(prev.startSecs + prev.durationSecs);
    }
  });

  it('is pure — the same regions give the same windows', () => {
    const regions = [region(10, 11, [9, 20]), region(14, 15, [9, 20])];
    expect(recoveryWindows(regions, 0, 100)).toEqual(recoveryWindows(regions, 0, 100));
  });
});

describe('spliceTranscript', () => {
  const recovered = (start: number, end: number, segments: TranscriptSegment[]): RecoveredWindow => ({
    window: { startSecs: start, durationSecs: end - start },
    segments,
  });

  it('returns the transcript unchanged when nothing was recovered', () => {
    const segments = [segment([word(' hello', 0, 0.5), word(' there', 0.5, 1)])];
    expect(spliceTranscript(segments, [])).toEqual(segments);
  });

  it('inserts recovered segments in time order and marks them', () => {
    const segments = [
      segment([word(' before', 0, 1)]),
      segment([word(' after', 20, 21)]),
    ];
    const out = spliceTranscript(segments, [
      recovered(9, 16, [segment([word(' the', 10, 10.4), word(' dropped', 10.4, 11)])]),
    ]);
    expect(out.map((s) => s.text)).toEqual(['before', 'the dropped', 'after']);
    expect(out.map((s) => s.recovered)).toEqual([undefined, true, undefined]);
  });

  /**
   * **The case the whole splice rule exists for.** A recovery window is an
   * uncovered stretch, so the only whole-file words inside it are the >2 s ones
   * the DTW alignment smeared across the hole — c038's ` down.` at
   * 217.26-222.74 is 5.48 s for one word. Keeping that fragment alongside the
   * recovered full sentence would hand the retake grouper the same line twice
   * and invite it to call one a retake of the other.
   */
  it('replaces the stretched word the alignment smeared across the hole', () => {
    const stretched = segment([
      word(' cost', 216, 216.6),
      word(' back', 216.6, 217.2),
      word(' down.', 217.26, 222.74),
    ]);
    const out = spliceTranscript(
      [stretched],
      [
        recovered(217.26, 222.74, [
          segment([word(' tricks', 218, 218.5), word(' being', 218.5, 219), word(' used', 219, 219.5)]),
        ]),
      ],
    );
    expect(out).toHaveLength(2);
    // The two real words either side survive; the 5.48s one does not.
    expect(out[0].text).toBe('cost back');
    expect(out[0].words.map((w) => w.word)).toEqual([' cost', ' back']);
    expect(out[0].end).toBeCloseTo(217.2);
    expect(out[1].recovered).toBe(true);
  });

  it('drops a segment entirely swallowed by a recovery window', () => {
    const out = spliceTranscript(
      [segment([word(' the', 10, 14)])],
      [recovered(9, 16, [segment([word(' real', 10, 10.5), word(' words', 10.5, 11)])])],
    );
    expect(out).toHaveLength(1);
    expect(out[0].recovered).toBe(true);
  });

  /** Everything outside the window is untouched, including the rest of a
   *  segment that merely straddles the edge — which is why the trim is per word
   *  rather than per segment. */
  it('leaves words outside the window alone', () => {
    const straddling = segment([
      word(' kept', 8, 9),
      word(' gone', 10, 12),
      word(' alsokept', 17, 18),
    ]);
    const out = spliceTranscript([straddling], [recovered(9.5, 16, [])]);
    expect(out).toHaveLength(1);
    expect(out[0].words.map((w) => w.word)).toEqual([' kept', ' alsokept']);
    expect(out[0].start).toBe(8);
    expect(out[0].end).toBe(18);
  });

  /** A word is judged by its MIDPOINT. An endpoint test would drop a word that
   *  merely abuts the window edge — which every word at a stretch boundary
   *  does, by construction. */
  it('judges a word by its midpoint, not its edges', () => {
    const s = segment([
      word(' abutting', 8, 10), // midpoint 9, outside a [10, 14) window
      word(' inside', 10.5, 11.5), // midpoint 11, inside
      word(' abutting2', 14, 16), // midpoint 15, outside
    ]);
    const out = spliceTranscript([s], [recovered(10, 14, [])]);
    expect(out[0].words.map((w) => w.word)).toEqual([' abutting', ' abutting2']);
  });

  /** Without word timings the trim cannot be that fine, so a partially
   *  overlapping segment is KEPT whole — the honest fallback rather than a
   *  silent approximation that would delete real words. */
  it('falls back to all-or-nothing when there are no word timings', () => {
    const noWords: TranscriptSegment = { start: 8, end: 18, text: 'straddles', words: [] };
    const swallowed: TranscriptSegment = { start: 11, end: 12, text: 'inside', words: [] };
    const out = spliceTranscript([noWords, swallowed], [recovered(10, 14, [])]);
    expect(out.map((s) => s.text)).toEqual(['straddles']);
  });

  it('ignores a recovery pass that came back empty', () => {
    const segments = [segment([word(' kept', 0, 1)])];
    const out = spliceTranscript(segments, [
      recovered(10, 14, [{ start: 10, end: 11, text: '   ', words: [] }]),
    ]);
    expect(out.map((s) => s.text)).toEqual(['kept']);
  });

  it('does not mutate its input', () => {
    const segments = [segment([word(' a', 10, 11), word(' b', 12, 13)])];
    const before = JSON.parse(JSON.stringify(segments));
    spliceTranscript(segments, [recovered(11.5, 14, [])]);
    expect(segments).toEqual(before);
  });

  it('is deterministic', () => {
    const segments = [segment([word(' a', 0, 1)]), segment([word(' b', 20, 21)])];
    const rec = [recovered(9, 16, [segment([word(' x', 10, 11)])])];
    expect(spliceTranscript(segments, rec)).toEqual(spliceTranscript(segments, rec));
  });
});

describe('spliceTranscriptDoc', () => {
  const doc: Transcript = {
    text: 'before after',
    language: 'en',
    model: 'large-v3',
    source: '/a.mov',
    segments: [segment([word(' before', 0, 1)]), segment([word(' after', 20, 21)])],
    words: [word(' before', 0, 1), word(' after', 20, 21)],
  };

  it('returns the same object when there is nothing to splice', () => {
    expect(spliceTranscriptDoc(doc, [])).toBe(doc);
  });

  /** A transcript whose `text` disagreed with its own `segments` would be a
   *  worse artefact than either, so `text` and `words` are rebuilt rather than
   *  carried over. */
  it('rebuilds text and words from the spliced segments', () => {
    const out = spliceTranscriptDoc(doc, [
      { window: { startSecs: 9, durationSecs: 7 }, segments: [segment([word(' middle', 10, 11)])] },
    ]);
    expect(out.text).toBe('before middle after');
    expect(out.words?.map((w) => w.word)).toEqual([' before', ' middle', ' after']);
    expect(out.language).toBe('en');
    expect(recoveredCount(out.segments)).toBe(1);
  });
});
