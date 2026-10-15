import { describe, expect, it } from 'vitest';

import {
  MAX_RECOVERY_HOLE_SECS,
  MAX_RECOVERY_WINDOW_SECS,
  RECOVERY_CONTEXT_SECS,
  RECOVERY_PLAN,
  recoveredCount,
  recoveryWindows,
  spliceTranscript,
  spliceTranscriptDoc,
  unreadRegions,
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
  const end = (w: { startSecs: number; durationSecs: number }) => w.startSecs + w.durationSecs;

  /** D-387 — the hole is the stretch; the read is the stretch plus context
   *  either side, because a bare stretch is read without the sentence around
   *  it (C038 836-852 s came back empty that way). */
  it('reads a stretch with context either side and marks the stretch as the hole', () => {
    const [w] = recoveryWindows([region(50, 55, [49, 56])], 0, 100);
    expect(w.startSecs).toBeCloseTo(49 - RECOVERY_CONTEXT_SECS);
    expect(end(w)).toBeCloseTo(56 + RECOVERY_CONTEXT_SECS);
    expect(w.holes).toEqual([{ startSecs: 49, endSecs: 56 }]);
    expect(w.plan).toBe(RECOVERY_PLAN);
  });

  /** The reason holes are keyed by STRETCH: a dropped take split by a pause
   *  produces several regions inside one stretch, and they share one pass. */
  it('collapses several regions in one stretch into a single hole', () => {
    const windows = recoveryWindows(
      [region(10, 11, [9, 20]), region(14, 15, [9, 20]), region(18, 19, [9, 20])],
      0,
      100,
    );
    expect(windows).toHaveLength(1);
    expect(windows[0].holes).toEqual([{ startSecs: 9, endSecs: 20 }]);
  });

  /** A window must never read material the clip does not show. */
  it('clamps the read and the hole to the clip range at both edges', () => {
    const windows = recoveryWindows([region(48, 62, [45, 65])], 50, 10);
    expect(windows).toHaveLength(1);
    expect(windows[0].startSecs).toBe(50);
    expect(end(windows[0])).toBe(60);
    expect(windows[0].holes).toEqual([{ startSecs: 50, endSecs: 60 }]);
  });

  it('drops a stretch that does not intersect the range at all', () => {
    expect(recoveryWindows([region(5, 8)], 50, 10)).toEqual([]);
    expect(recoveryWindows([region(5, 8)], 0, 0)).toEqual([]);
    expect(recoveryWindows([], 0, 100)).toEqual([]);
  });

  /** A clip shorter than hole + context reads the whole clip — the most
   *  context there is — and never past it. */
  it('reads the whole clip when the clip is shorter than hole plus context', () => {
    const [w] = recoveryWindows([region(50.2, 51.3)], 50, 5);
    expect(w.startSecs).toBe(50);
    expect(w.durationSecs).toBeCloseTo(5);
  });

  it('splits a stretch longer than the maximum hole into equal pieces that tile it', () => {
    const span = MAX_RECOVERY_HOLE_SECS * 2.5;
    const windows = recoveryWindows([region(100, 100 + span, [100, 100 + span])], 0, 400);
    const holes = windows.flatMap((w) => w.holes ?? []);
    expect(holes.length).toBe(3);
    for (const w of windows) expect(w.durationSecs).toBeLessThanOrEqual(MAX_RECOVERY_WINDOW_SECS + 1e-9);
    expect(holes[0].startSecs).toBeCloseTo(100);
    for (let i = 1; i < holes.length; i += 1) expect(holes[i].startSecs).toBeCloseTo(holes[i - 1].endSecs);
    expect(holes[holes.length - 1].endSecs).toBeCloseTo(100 + span);
  });

  /** Nearby holes whose reads touch cost one pass, but never past the maximum. */
  it('merges touching reads within the maximum and keeps their holes separate', () => {
    const windows = recoveryWindows([region(30, 32), region(36, 38)], 0, 100);
    expect(windows).toHaveLength(1);
    expect(windows[0].holes).toEqual([
      { startSecs: 30, endSecs: 32 },
      { startSecs: 36, endSecs: 38 },
    ]);
    expect(windows[0].durationSecs).toBeLessThanOrEqual(MAX_RECOVERY_WINDOW_SECS);
  });

  it('returns windows in time order with disjoint holes', () => {
    const windows = recoveryWindows(
      [region(80, 82), region(10, 12), region(12.5, 13), region(60, 75, [60, 75])],
      0,
      100,
    );
    for (let i = 1; i < windows.length; i += 1) {
      expect(windows[i].startSecs).toBeGreaterThanOrEqual(windows[i - 1].startSecs);
    }
    const holes = windows.flatMap((w) => w.holes ?? []).sort((a, b) => a.startSecs - b.startSecs);
    for (let i = 1; i < holes.length; i += 1) {
      expect(holes[i].startSecs).toBeGreaterThanOrEqual(holes[i - 1].endSecs - 1e-9);
    }
  });

  it('is pure — the same regions give the same windows', () => {
    const regions = [region(10, 11, [9, 20]), region(14, 15, [9, 20])];
    expect(recoveryWindows(regions, 0, 100)).toEqual(recoveryWindows(regions, 0, 100));
  });
});

/** D-387 — a window with holes changes only its holes. */
describe('spliceTranscript with holes', () => {
  const holed = (
    start: number,
    end: number,
    holes: Array<[number, number]>,
    segments: TranscriptSegment[],
  ): RecoveredWindow => ({
    window: {
      startSecs: start,
      durationSecs: end - start,
      holes: holes.map(([a, b]) => ({ startSecs: a, endSecs: b })),
      plan: RECOVERY_PLAN,
    },
    segments,
  });
  const read = (ss: TranscriptSegment[]) =>
    ss.flatMap((s) => s.words ?? []).sort((x, y) => x.start - y.start).map((w) => w.word.trim());

  /** The measured fault (C038 501.2 s): the old 4 s window began inside
   *  "everything.", its re-read had no such word, and the splice deleted the
   *  whole-file one. The context a window reads is never spliced. */
  it('keeps the whole-file words in the context it read, even when the read lost them', () => {
    const wholeFile = [
      segment([word(' reread', 500.64, 501.2), word(' everything.', 501.2, 501.92)]),
      segment([word(' Plus', 505.04, 505.68)]),
    ];
    const out = spliceTranscript(wholeFile, [
      holed(491.92, 515.04, [[501.92, 505.04]], [
        segment([word(' Word', 501.88, 502.28), word(' two,', 502.28, 502.84), word(' reread', 502.84, 503.4)]),
        segment([word(' sent', 507.5, 507.8)]),
      ]),
    ]);
    expect(read(out)).toEqual(['reread', 'everything.', 'Word', 'two,', 'reread', 'Plus']);
    expect(out.filter((s) => s.recovered).flatMap((s) => s.words.map((w) => w.word.trim()))).toEqual([
      'Word',
      'two,',
      'reread',
    ]);
  });

  /** The same spoken word, timed a few frames apart by two passes, at a hole
   *  edge: added once, not twice. */
  it('does not add a recovered word that repeats the kept word it overlaps', () => {
    const wholeFile = [segment([word(' Plus', 505.04, 505.68)])];
    const out = spliceTranscript(wholeFile, [
      holed(495, 515, [[501.92, 505.04]], [
        segment([word(' again.', 504.0, 504.6), word(' Plus', 504.84, 505.16)]),
      ]),
    ]);
    expect(read(out)).toEqual(['again.', 'Plus']);
  });

  it('replaces zero-width whole-file words inside a hole (a timestamp collapse)', () => {
    const wholeFile = [segment([word(' before', 320, 320.5)]), segment([word(' inference', 330.84, 330.84)])];
    const out = spliceTranscript(wholeFile, [
      holed(320.84, 345.64, [[330.84, 335.64]], [segment([word(' Inference', 334.2, 334.8)])]),
    ]);
    expect(read(out)).toEqual(['before', 'Inference']);
  });
});

describe('unreadRegions', () => {
  it('reports a region no word overlaps, and not one a recovered word reads', () => {
    const regions = [region(839.49, 840.13), region(850.95, 852.0)];
    const spliced = [segment([word(' So', 850.6, 850.76), word(' kickup.', 850.92, 851.64)])];
    expect(unreadRegions(regions, spliced).map((r) => r.start_secs)).toEqual([839.49]);
  });

  it('counts a zero-width word inside a region as read — its text is present', () => {
    expect(unreadRegions([region(330, 335)], [segment([word(' is', 331, 331)])])).toEqual([]);
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

  /** D-380 step 2 — a client's re-read may overlap an earlier recovery. Applied
   *  in order, the later window replaces the earlier window's words it holds
   *  rather than sitting beside them as a duplicate. */
  it('a later window replaces an earlier window\'s words where they overlap', () => {
    const segments = [segment([word(' a', 0, 1), word(' type', 10, 11), word(' z', 20, 21)])];
    const first = recovered(9, 14, [segment([word(' type', 10, 11), word(' it', 12, 13)])]);
    const later = recovered(9.5, 11.5, [segment([word(' time', 10, 11)])]);
    const out = spliceTranscript(segments, [first, later]);
    const read = (ss: typeof out) =>
      ss.flatMap((s) => s.words).sort((x, y) => x.start - y.start).map((w) => w.word.trim());
    expect(read(out)).toEqual(['a', 'time', 'it', 'z']);
    // The order is the rule: applied the other way round, the wide window wins.
    const swapped = spliceTranscript(segments, [later, first]);
    expect(read(swapped)).toEqual(['a', 'type', 'it', 'z']);
  });
});

describe('spliceTranscriptDoc', () => {
  const doc: Transcript = {
    text: 'before after',
    language: 'en',
    model: 'parakeet-tdt-0.6b-v3',
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
