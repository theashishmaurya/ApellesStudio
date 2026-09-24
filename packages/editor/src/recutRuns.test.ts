// @apelles/editor — source runs: the layer B-237 was missing (D-364).
//
// **What these pin, and why one of them is the whole bug.** Retake detection
// itself was never wrong — `apelles-speech`'s `retake.rs` scores the real
// footage correctly the moment it is handed both takes. What was wrong is what
// it got handed: the sweep scoped every call to ONE clip's own trimmed source
// range, so after a fine-grained silence cut the two halves of a restart sat in
// different clips' views and no call ever saw both. Six of seven real retakes
// on the owner's own project were invisible for exactly that reason.
//
// The decisive test here is `the restart that spans several clips`: it asserts
// that each clip's own view holds AT MOST ONE of the two takes (which is the
// pre-fix input, and is why the pre-fix answer was nothing) and that the merged
// run holds both. It fails against the pre-clip-runs code by construction,
// because that code has no merged view to assert about.
//
// The rest pin the two ways this fix could have become a different bug: runs
// that are too greedy (merging across a source change, a jump backwards, or a
// long-removed stretch, inventing comparisons between material that was never
// one take) and a take→frames mapping that assumes one take is one clip.
import { describe, expect, it } from 'vitest';

import { clipRuns, mergeRunUtterances, runGapSecs, takeSegments, RETAKE_WINDOW_SECS } from './recutRuns';
import type { SweepTarget } from './recutSweep';
import type { Clip } from './timeline';

const FPS = 24;
const SOURCE = '/fixtures/talk.mov';

/** One clip, addressed the way a sweep addresses it. `sourceStart`/`duration`
 *  are SOURCE FRAMES, which is what `Clip` actually holds. */
function target(
  clip: number,
  sourceStart: number,
  duration: number,
  extra: Partial<Clip> = {},
): SweepTarget {
  const c = {
    id: `c${clip}`,
    name: `clip ${clip}`,
    source_path: SOURCE,
    source_start: sourceStart,
    duration,
    source_len: 24 * 600,
    source_fps: 24,
    start_frame: sourceStart,
    ...extra,
  } as Clip;
  return { clip, c, source: c.source_path };
}

// --------------------------------------------------------------------------- #
// the real case, reconstructed
// --------------------------------------------------------------------------- #

/**
 * B-237's own first table row, as a fixture.
 *
 * **What is real here** (`docs/notes/retake-detection.md` §4): the restart
 * "…the trick behind used…" → "down. And the trick being used…" at source
 * **210-230 s**, split by an earlier silence cut across several original clips
 * **including ones of 0.25 s and 0.58 s**, and never flagged. Those numbers are
 * the measured ones.
 *
 * **What is reconstructed:** the note records the clip COUNT and the two
 * sub-second lengths but not the exact original partition, so this lays those
 * lengths out across that window in the shape a silence cut leaves behind —
 * a long clip holding the first take, two slivers, and a long clip holding the
 * rest of the second. The second take deliberately starts inside the 0.58 s
 * sliver, so this fixture also covers a take that straddles a clip boundary.
 */
function realCase(): { targets: SweepTarget[]; u0: Utt; u1: Utt } {
  return {
    targets: [
      target(0, 5030, 228), // 209.583 – 219.083 s
      target(1, 5258, 6), //   219.083 – 219.333 s  (0.25 s)
      target(2, 5264, 14), //  219.333 – 219.917 s  (0.58 s)
      target(3, 5278, 251), // 219.917 – 230.375 s
    ],
    u0: {
      start: 210.4,
      end: 219.05,
      text: 'and this is the trick behind used in every one of these models',
    },
    u1: {
      start: 219.5,
      end: 229.6,
      text: 'down and the trick being used in every one of these models is the same',
    },
  };
}

interface Utt {
  start: number;
  end: number;
  text: string;
}

/** What `clipTranscriptView` filters a whole-file transcript down to for one
 *  clip — the exact overlap rule it uses, so "what each clip's own view holds"
 *  is measured and not assumed. */
function viewOf(t: SweepTarget, utterances: Utt[]): Utt[] {
  const start = t.c.source_start / FPS;
  const end = (t.c.source_start + t.c.duration) / FPS;
  return utterances.filter((u) => u.end > start && u.start < end);
}

describe('the restart that spans several clips (B-237, the whole bug)', () => {
  const { targets, u0, u1 } = realCase();
  const all = [u0, u1];

  it('leaves each clip holding at most ONE of the two takes — which is why the per-clip sweep found nothing', () => {
    const perClip = targets.map((t) => viewOf(t, all));

    // This is the pre-fix input, clip by clip. A chain needs two members; no
    // view here has two, so no call to `detect_retakes` could produce a group
    // however good its scoring is.
    expect(perClip.map((v) => v.length)).toEqual([1, 0, 1, 1]);
    expect(perClip.every((v) => v.length < 2)).toBe(true);
    expect(perClip[0]).toEqual([u0]);
    expect(perClip[2]).toEqual([u1]);
  });

  it('puts both takes into ONE view once the clips are merged back into their run', () => {
    const runs = clipRuns(targets, FPS);
    expect(runs).toHaveLength(1);
    expect(runs[0].targets.map((t) => t.clip)).toEqual([0, 1, 2, 3]);

    const merged = mergeRunUtterances(runs[0].targets.map((t) => viewOf(t, all)));

    // Both halves of the restart, in one list, in time order — for the first
    // time. This is the input the detector needed all along.
    expect(merged).toEqual([u0, u1]);
  });

  it('counts an utterance overlapping two clips of the run ONCE', () => {
    const runs = clipRuns(targets, FPS);
    // `u1` genuinely overlaps clips 2 and 3, so it is in both clips' views.
    expect(viewOf(targets[2], all)).toEqual([u1]);
    expect(viewOf(targets[3], all)).toEqual([u1]);
    // Handing the detector the same words twice would offer it a perfect
    // self-match — the double-count that made `editor_get_timeline_transcript`
    // look like a Whisper bug during B-237's investigation.
    expect(mergeRunUtterances(runs[0].targets.map((t) => viewOf(t, all)))).toHaveLength(2);
  });

  it('maps the straddling take back onto BOTH clips it lands in, with real frames', () => {
    const run = clipRuns(targets, FPS)[0];
    const segments = takeSegments(run, u1.start, u1.end, FPS);

    expect(segments.map((s) => s.clip)).toEqual([2, 3]);
    // Clip 2 is the 0.58s sliver: the take enters it at 219.5s and it ends at
    // 219.917s, so only its tail is cut here.
    expect(segments[0].span.sourceStartFrame).toBe(Math.round(219.5 * FPS));
    expect(segments[0].span.sourceEndFrame).toBe(5278);
    // Clip 3 carries the rest, from its own in-point.
    expect(segments[1].span.sourceStartFrame).toBe(5278);
    expect(segments[1].span.sourceEndFrame).toBe(Math.round(u1.end * FPS));
    // Every piece is a real, non-empty range a ripple delete can take.
    for (const s of segments) expect(s.span.endFrame).toBeGreaterThan(s.span.startFrame);
  });

  it('leaves a take that lives inside one clip as exactly one range', () => {
    const run = clipRuns(targets, FPS)[0];
    const segments = takeSegments(run, u0.start, u0.end, FPS);
    expect(segments).toHaveLength(1);
    expect(segments[0].clip).toBe(0);
  });
});

// --------------------------------------------------------------------------- #
// what a run must NOT swallow
// --------------------------------------------------------------------------- #

describe('clipRuns is a reconstruction, not a concatenation', () => {
  it('breaks a run at a source change', () => {
    const runs = clipRuns(
      [
        target(0, 0, 240),
        target(1, 240, 240, { source_path: '/fixtures/other.mov' }),
        target(2, 480, 240),
      ],
      FPS,
    );
    expect(runs.map((r) => r.targets.map((t) => t.clip))).toEqual([[0], [1], [2]]);
  });

  it('breaks a run where the timeline jumps BACKWARDS through the source', () => {
    // Clip 1 is earlier material placed after clip 0 — a re-order, not one
    // continuous take, and comparing across it would invent a pairing.
    const runs = clipRuns([target(0, 4800, 240), target(1, 240, 240)], FPS);
    expect(runs.map((r) => r.targets.map((t) => t.clip))).toEqual([[0], [1]]);
  });

  it('breaks a run once more source has been removed than two takes could ever span', () => {
    const gap = (RETAKE_WINDOW_SECS + 1) * FPS;
    const joined = clipRuns([target(0, 0, 240), target(1, 240 + gap - FPS, 240)], FPS);
    const split = clipRuns([target(0, 0, 240), target(1, 240 + gap, 240)], FPS);
    expect(joined).toHaveLength(1);
    expect(split).toHaveLength(2);
  });

  it('follows the caller’s own window_secs, because that is the bound it mirrors', () => {
    const targets = [target(0, 0, 240), target(1, 240 + 60 * FPS, 240)];
    expect(clipRuns(targets, FPS, runGapSecs(undefined))).toHaveLength(2);
    expect(clipRuns(targets, FPS, runGapSecs(90))).toHaveLength(1);
    expect(runGapSecs(undefined)).toBe(RETAKE_WINDOW_SECS);
    expect(runGapSecs(0)).toBe(RETAKE_WINDOW_SECS);
  });

  it('tolerates one frame of overlap, which a plain split can leave behind', () => {
    expect(clipRuns([target(0, 0, 240), target(1, 239, 240)], FPS)).toHaveLength(1);
    expect(clipRuns([target(0, 0, 240), target(1, 200, 240)], FPS)).toHaveLength(2);
  });

  it('makes a lone clip a run of one, so there is no special case to handle', () => {
    const runs = clipRuns([target(0, 240, 480)], FPS);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ source: SOURCE, startSecs: 10, durationSecs: 20 });
  });

  it('spans the run from the first in-point to the last out-point, gaps included', () => {
    const runs = clipRuns([target(0, 240, 240), target(1, 720, 240)], FPS);
    expect(runs).toHaveLength(1);
    expect(runs[0].startSecs).toBe(10);
    expect(runs[0].durationSecs).toBe(30);
  });
});

describe('takeSegments', () => {
  it('drops a clip a take only grazes, rather than proposing an empty cut', () => {
    const run = clipRuns([target(0, 0, 240), target(1, 240, 240)], FPS)[0];
    // Ends exactly on clip 1's in-point: clip 1 gets nothing.
    expect(takeSegments(run, 2, 10, FPS).map((s) => s.clip)).toEqual([0]);
  });

  it('reports each piece in the piece’s own seconds, not the whole take’s', () => {
    const run = clipRuns([target(0, 0, 240), target(1, 240, 240)], FPS)[0];
    const segments = takeSegments(run, 5, 15, FPS);
    expect(segments.map((s) => [s.span.startSecs, s.span.endSecs])).toEqual([
      [5, 10],
      [10, 15],
    ]);
  });
});
