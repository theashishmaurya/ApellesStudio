// D-420 — the edit-by-text cut planner (`planCutWords`), pure.
//
// Fixtures at 24 fps with source_fps 24, so a source frame IS a timeline frame
// offset and every expected frame below can be checked by hand:
// frame = round(seconds × 24).
import { describe, expect, it } from 'vitest';

import { CUT_PAD_MAX_SECS, DEFAULT_KEEP_BREATH_SECS, deletedIndices, planCutWords, type CutWordsPlan } from './cutWords';
import type { ViewWord, WordViewInput } from './retakeWordView';
import type { Clip } from './timeline';

const FPS = 24;

function clip(id: string, startFrame: number, sourceStartSecs: number, secs: number): Clip {
  return {
    id,
    name: id,
    source_path: '/vo.wav',
    source_start: Math.round(sourceStartSecs * FPS),
    duration: Math.round(secs * FPS),
    source_len: 100_000,
    source_fps: FPS,
    start_frame: startFrame,
  } as Clip;
}

/** A view over `clips` (each one piece), with `words` given as [text, start, end, piece]. */
function view(clips: Clip[], spec: Array<[string, number, number, number]>): { input: WordViewInput; words: ViewWord[] } {
  const input: WordViewInput = {
    track: 0,
    fps: FPS,
    sources: [{ path: '/vo.wav', segments: [] }],
    pieces: clips.map((c, i) => ({
      source: 0,
      startSecs: c.source_start / FPS,
      endSecs: (c.source_start + c.duration) / FPS,
      clip: i,
      clipId: c.id,
      c,
    })),
    pending: [],
    failed: [],
  };
  return { input, words: spec.map(([text, start, end, piece]) => ({ text, start, end, piece })) };
}

function plan(v: { input: WordViewInput; words: ViewWord[] }, ...args: Parameters<typeof planCutWords> extends [unknown, unknown, ...infer R] ? R : never): CutWordsPlan {
  const p = planCutWords(v.input, v.words, ...args);
  if ('error' in p) throw new Error(p.error);
  return p;
}


/** No kept word overlaps any cut, and every deleted word lies wholly inside one. */
function assertClean(v: { words: ViewWord[] }, p: CutWordsPlan) {
  const deleted = new Set(p.deleted);
  v.words.forEach((w, i) => {
    const inside = p.cuts.filter((c) => c.piece === w.piece && c.startSecs < w.end && c.endSecs > w.start);
    if (deleted.has(i)) {
      expect(inside.some((c) => c.startSecs <= w.start + 1e-9 && c.endSecs >= w.end - 1e-9)).toBe(true);
    } else {
      expect(inside).toEqual([]);
    }
  });
}

// "So um the idea is simple" — one 10 s clip.
const SPEECH: Array<[string, number, number, number]> = [
  ['So', 0.5, 0.8, 0],
  ['um', 1.0, 1.3, 0],
  ['the', 1.4, 1.6, 0],
  ['idea', 1.7, 2.2, 0],
  ['is', 2.3, 2.45, 0],
  ['simple', 2.5, 3.0, 0],
];

describe('planCutWords — deleting words', () => {
  it('cuts a deleted word between two kept ones with no fragment and no clipped neighbour (the fragment case)', () => {
    const v = view([clip('a', 0, 0, 10)], SPEECH);
    const p = plan(v, [{ first: 1, last: 1 }]);
    // Pad toward each kept neighbour stops at the middle of the gap:
    // start 1.00 - 0.10 = 0.90 s -> frame 22 (0.917 s, after "So" ends at 0.80)
    // end   1.30 + 0.05 = 1.35 s -> frame 32 (1.333 s, before "the" at 1.40)
    expect(p.cuts.map((c) => [c.startFrame, c.endFrame, c.kind, c.words])).toEqual([[22, 32, 'words', [1]]]);
    assertClean(v, p);
  });

  it('cuts a run of deleted neighbours as ONE cut, pauses between them included', () => {
    const v = view([clip('a', 0, 0, 10)], SPEECH);
    const p = plan(v, [{ first: 1, last: 1 }, { first: 2, last: 3 }]);
    expect(p.cuts).toHaveLength(1);
    expect(p.cuts[0].words).toEqual([1, 2, 3]);
    assertClean(v, p);
  });

  it('keeps two cuts apart when a kept word sits between them', () => {
    const v = view([clip('a', 0, 0, 10)], SPEECH);
    const p = plan(v, [{ first: 1, last: 1 }, { first: 3, last: 3 }]);
    expect(p.cuts.map((c) => c.words)).toEqual([[1], [3]]);
    assertClean(v, p);
  });

  it('pads a full token past an edge with no kept neighbour, clamped to the clip', () => {
    // Deleting the first word: start = max(clip start, 0.50 - 0.32) = 0.18 s -> frame 4.
    const v = view([clip('a', 0, 0, 10)], SPEECH);
    const p = plan(v, [{ first: 0, last: 0 }]);
    expect(p.cuts[0].startFrame).toBe(Math.round((0.5 - CUT_PAD_MAX_SECS) * FPS));
    expect(p.cuts[0].endFrame).toBe(Math.round(0.9 * FPS)); // middle of the 0.2 s gap to "um"
    // And at the very start of a clip the pad stops at the clip.
    const early = view([clip('a', 0, 0, 10)], [['Hi', 0.1, 0.4, 0], ['there', 0.6, 0.9, 0]]);
    expect(plan(early, [{ first: 0, last: 0 }]).cuts[0].startFrame).toBe(0);
  });

  it('reports a deleted word under one frame from a kept one, and splits the gap', () => {
    // "is" ends 2.51 s (frame 60.24), "uh" starts 2.53 s (60.72): no frame boundary between.
    const v = view([clip('a', 0, 0, 10)], [['is', 2.0, 2.51, 0], ['uh', 2.53, 2.8, 0], ['fine', 3.2, 3.6, 0]]);
    const p = plan(v, [{ first: 1, last: 1 }]);
    expect(p.tight).toEqual([{ index: 1, side: 'start' }]);
    expect(p.cuts[0].startFrame).toBe(Math.round(2.52 * FPS));
  });

  it('cuts a range spanning a clip boundary in both clips, to the boundary, leaving nothing between', () => {
    // Clip a: source 0-3 s at timeline 0..72; clip b: source 10-13 s at 72..144.
    const v = view(
      [clip('a', 0, 0, 3), clip('b', 72, 10, 3)],
      [
        ['keep', 0.5, 1.0, 0],
        ['cut', 2.0, 2.5, 0],
        ['also', 10.4, 10.8, 1],
        ['kept', 11.5, 12.0, 1],
      ],
    );
    const p = plan(v, [{ first: 1, last: 2 }]);
    expect(p.cuts.map((c) => [c.clip, c.startFrame, c.endFrame])).toEqual([
      [0, Math.round((2.0 - CUT_PAD_MAX_SECS) * FPS), 72], // to the end of clip a
      [1, 72, 72 + Math.round((10.8 + CUT_PAD_MAX_SECS - 10) * FPS)], // from the start of clip b
    ]);
    assertClean(v, p);
  });

  it('refuses bad ranges with a reason', () => {
    const v = view([clip('a', 0, 0, 10)], SPEECH);
    expect(planCutWords(v.input, v.words, [])).toEqual({ error: expect.stringContaining('nothing asked for') });
    expect(planCutWords(v.input, v.words, [{ first: 3, last: 1 }])).toEqual({ error: expect.stringContaining('first <= last') });
    expect(planCutWords(v.input, v.words, [{ first: 0, last: 6 }])).toEqual({ error: expect.stringContaining('past the end') });
    expect(deletedIndices([{ first: 1, last: 2 }, { first: 2, last: 3 }], 6)).toEqual([1, 2, 3]);
  });
});

describe('planCutWords — tightening pauses', () => {
  // "First thought." <1.5 s pause> "Second thought." <0.4 s pause> "Third."
  const PAUSES: Array<[string, number, number, number]> = [
    ['First', 0.5, 0.9, 0],
    ['thought.', 0.95, 1.5, 0],
    ['Second', 3.0, 3.4, 0],
    ['thought.', 3.45, 4.0, 0],
    ['Third.', 4.4, 4.9, 0],
  ];

  it('cuts every pause above the threshold down to the breath, half either side', () => {
    const v = view([clip('a', 0, 0, 10)], PAUSES);
    const p = plan(v, [], { tightenGapsSecs: 0.5, keepBreathSecs: 0.3 });
    // Only the 1.5 s pause qualifies: cut [1.5 + 0.15, 3.0 - 0.15] = frames 40..68.
    expect(p.tightened).toBe(1);
    expect(p.cuts.map((c) => [c.startFrame, c.endFrame, c.kind])).toEqual([[40, 68, 'gap']]);
    assertClean(v, p);
  });

  it('uses the default breath when none is given', () => {
    const v = view([clip('a', 0, 0, 10)], PAUSES);
    const p = plan(v, [], { tightenGapsSecs: 0.5 });
    const half = DEFAULT_KEEP_BREATH_SECS / 2;
    expect(p.cuts[0].startFrame).toBe(Math.round((1.5 + half) * FPS));
    expect(p.cuts[0].endFrame).toBe(Math.round((3.0 - half) * FPS));
  });

  it('merges a word cut and a tightened pause into one cut, and counts what is left against the threshold', () => {
    // A filler alone in a long pause: kept "on." ends 1.0, "um" 2.0-2.3, kept "So" 3.5.
    const v = view([clip('a', 0, 0, 10)], [['on.', 0.6, 1.0, 0], ['um', 2.0, 2.3, 0], ['So', 3.5, 3.8, 0]]);
    const wordsOnly = plan(v, [{ first: 1, last: 1 }]);
    expect(wordsOnly.cuts.map((c) => c.kind)).toEqual(['words']);
    const both = plan(v, [{ first: 1, last: 1 }], { tightenGapsSecs: 0.5, keepBreathSecs: 0.3 });
    expect(both.cuts.map((c) => [c.startFrame, c.endFrame, c.kind, c.words])).toEqual([
      [Math.round(1.15 * FPS), Math.round(3.35 * FPS), 'words+gap', [1]],
    ]);
    assertClean(v, both);
  });

  it('tightens a pause across a clip boundary in both clips', () => {
    // Clip a ends 1.2 s after its last word; clip b starts 0.8 s before its first.
    const v = view(
      [clip('a', 0, 0, 2), clip('b', 48, 10, 2)],
      [['end.', 0.4, 0.8, 0], ['Next', 10.8, 11.2, 1]],
    );
    const p = plan(v, [], { tightenGapsSecs: 0.5, keepBreathSecs: 0.3 });
    expect(p.tightened).toBe(1);
    expect(p.cuts.map((c) => [c.clip, c.startFrame, c.endFrame])).toEqual([
      [0, Math.round(0.95 * FPS), 48],
      [1, 48, 48 + Math.round(0.65 * FPS)],
    ]);
  });

  it('refuses a breath longer than the threshold', () => {
    const v = view([clip('a', 0, 0, 10)], PAUSES);
    expect(planCutWords(v.input, v.words, [], { tightenGapsSecs: 0.2, keepBreathSecs: 0.3 })).toEqual({
      error: expect.stringContaining('must not exceed'),
    });
  });
});
