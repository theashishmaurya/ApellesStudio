// @apelles/editor — the D-318 seconds↔frames edge.
//
// The detector measures in source seconds and the timeline cuts in frames, so
// every candidate crosses this boundary exactly once. These tests pin the two
// properties a cut depends on: each endpoint rounds independently (never a
// rounded duration), and no span can escape the clip it was found in.
import { describe, expect, it } from 'vitest';

import {
  clipSourceRangeSecs,
  cuttableSpans,
  groupTakes,
  spanToFrames,
  type RetakeGroupWire,
} from './recut';
import type { Clip } from './timeline';

const FPS = 24;

/** A clip trimmed to start 10s into its source and run for 20s. */
function trimmed(): Clip {
  return {
    id: 'c',
    name: 'c',
    source_path: '/fixtures/talk.mov',
    source_start: 240, // 10s @24
    duration: 480, // 20s
    source_len: 2400,
    source_fps: 24,
    start_frame: 100,
  } as Clip;
}

describe('clipSourceRangeSecs', () => {
  it('describes only the material the clip actually shows', () => {
    expect(clipSourceRangeSecs(trimmed(), FPS)).toEqual({ startSecs: 10, durationSecs: 20 });
  });

  it('falls back to the timeline fps when the clip carries none', () => {
    const c = { ...trimmed(), source_fps: undefined } as Clip;
    expect(clipSourceRangeSecs(c, FPS)).toEqual({ startSecs: 10, durationSecs: 20 });
  });
});

describe('spanToFrames', () => {
  it('maps a span in source seconds onto the right timeline frames', () => {
    // 12s–14s of source. The clip starts at source 10s and sits at timeline
    // frame 100, so that is 2s–4s into the clip → timeline 148–196.
    const s = spanToFrames(trimmed(), 12, 14, FPS);
    expect(s.sourceStartFrame).toBe(288);
    expect(s.sourceEndFrame).toBe(336);
    expect(s.startFrame).toBe(148);
    expect(s.endFrame).toBe(196);
  });

  it('rounds each endpoint independently, not via a rounded duration', () => {
    // 0.02s is under half a frame; both endpoints round to the nearest frame on
    // their own, so the span keeps its true length rather than inheriting a
    // duration rounded once.
    const s = spanToFrames(trimmed(), 12.02, 13.98, FPS);
    expect(s.sourceStartFrame).toBe(Math.round(12.02 * FPS));
    expect(s.sourceEndFrame).toBe(Math.round(13.98 * FPS));
  });

  it('clamps a span that starts before the clip does', () => {
    const s = spanToFrames(trimmed(), 0, 11, FPS);
    expect(s.sourceStartFrame, 'cannot reach back past source_start').toBe(240);
    expect(s.startFrame, 'cannot reach back past the clip on the timeline').toBe(100);
  });

  it('clamps a span that runs past the end of the clip', () => {
    const s = spanToFrames(trimmed(), 29, 999, FPS);
    expect(s.sourceEndFrame, 'source_start + duration').toBe(720);
    expect(s.endFrame, 'start_frame + duration').toBe(580);
  });

  it('never produces an inverted span, even from inverted input', () => {
    const s = spanToFrames(trimmed(), 14, 12, FPS);
    expect(s.sourceEndFrame).toBeGreaterThanOrEqual(s.sourceStartFrame);
    expect(s.endFrame).toBeGreaterThanOrEqual(s.startFrame);
  });
});

describe('cuttableSpans', () => {
  it('drops spans that collapsed to nothing after rounding', () => {
    const c = trimmed();
    const real = spanToFrames(c, 12, 14, FPS);
    // Both endpoints land on the same frame — nothing to remove.
    const empty = spanToFrames(c, 12, 12.001, FPS);
    expect(cuttableSpans([real, empty])).toEqual([real]);
  });

  it('is empty for empty input', () => {
    expect(cuttableSpans([])).toEqual([]);
  });
});

describe('groupTakes (D-327)', () => {
  /** Three deliveries of one line, where the middle one spans TWO transcript
   *  utterances — the shape an ASR produces when its segment boundaries do not
   *  line up with the speaker's restarts (B-198). */
  function straddling(): RetakeGroupWire {
    return {
      similarity: 0.9,
      keep: 2,
      takes: [
        { first: 0, last: 0 },
        { first: 1, last: 2 },
        { first: 3, last: 3 },
      ],
      members: [
        { index: 0, start_secs: 1.0, end_secs: 2.5, text: 'The cat sat—' },
        { index: 1, start_secs: 3.0, end_secs: 4.0, text: 'The cat sat' },
        { index: 2, start_secs: 4.0, end_secs: 5.0, text: 'on the mat.' },
        { index: 3, start_secs: 6.0, end_secs: 8.0, text: 'The cat sat on the mat!' },
      ],
    };
  }

  it('makes one entry per DELIVERY, not per utterance', () => {
    const takes = groupTakes(straddling());
    expect(takes).toHaveLength(3);
    expect(takes.map((t) => [t.startSecs, t.endSecs])).toEqual([
      [1.0, 2.5],
      [3.0, 5.0],
      [6.0, 8.0],
    ]);
  });

  it('joins a multi-utterance delivery back into one readable line', () => {
    expect(groupTakes(straddling())[1].text).toBe('The cat sat on the mat.');
  });

  /** The defect this function exists to prevent. `keep` indexes TAKES; reading
   *  it as a member index would mark utterance #2 — the second half of the
   *  middle delivery — as the keeper, and offer the real last take for
   *  deletion. */
  it('marks exactly the delivery `keep` names, and only that one', () => {
    const takes = groupTakes(straddling());
    expect(takes.map((t) => t.suggestedKeep)).toEqual([false, false, true]);
    expect(takes.filter((t) => t.suggestedKeep)).toHaveLength(1);
  });

  /** Cutting every non-keeper must never reach into the keeper. */
  it('leaves the keeper untouched when every other delivery is cut', () => {
    const takes = groupTakes(straddling());
    const keeper = takes.find((t) => t.suggestedKeep);
    expect(keeper).toBeDefined();
    for (const c of takes.filter((t) => !t.suggestedKeep)) {
      expect(c.endSecs).toBeLessThanOrEqual(keeper!.startSecs);
    }
  });

  /** A detector older than D-327 sends no `takes`; every member was its own
   *  delivery, which is what the fallback must reproduce. */
  it('treats a group with no `takes` as one delivery per member', () => {
    const legacy: RetakeGroupWire = { ...straddling(), takes: [], keep: 3 };
    const takes = groupTakes(legacy);
    expect(takes).toHaveLength(4);
    expect(takes.map((t) => t.suggestedKeep)).toEqual([false, false, false, true]);
  });
});
