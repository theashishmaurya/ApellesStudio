/**
 * @apelles/editor — the pure half of the whole-track recut sweep (D-342,
 * fixes B-216).
 *
 * **What this pins.** `recutSweep.ts` has one job that is easy to get subtly
 * wrong and impossible to eyeball on a 75-clip track: deciding which clips a
 * sweep may say anything about, and folding N per-clip answers into a report
 * where "these three need a decision" is readable without scanning the other
 * seventy-two. Both are pure functions over data, so both are testable with no
 * store, no backend and no React — which is the point of them being a module
 * rather than inline in the op handler.
 *
 * The counting invariant that proves the sweep is actually ONE dispatch lives
 * next door, in `recutSweep.dom.test.tsx`, because that claim is about the op
 * layer rather than about this arithmetic.
 */

import { describe, expect, it } from 'vitest';

import {
  RETAKE_SWEEP,
  SILENCE_SWEEP,
  sweepReport,
  sweepTargets,
  type SweepClipResult,
} from './recutSweep';
import type { Clip, Track } from './timeline';

function clip(over: Partial<Clip> & { id: string }): Clip {
  return {
    name: over.id,
    source_path: '/footage/talk.mov',
    source_start: 0,
    duration: 240,
    source_len: 2400,
    source_fps: 24,
    start_frame: 0,
    ...over,
  } as Clip;
}

function track(clips: Clip[]): Track {
  return { kind: 'video', clips } as Track;
}

/** A finished clip with `n` findings. */
function done(clipIndex: number, n: number): SweepClipResult {
  return {
    clip: clipIndex,
    clipId: `c${clipIndex}`,
    source: '/footage/talk.mov',
    state: 'done',
    findings: Array.from({ length: n }, (_, i) => ({ startFrame: i, endFrame: i + 10 })),
  };
}

function inState(clipIndex: number, state: SweepClipResult['state'], error?: string): SweepClipResult {
  return {
    clip: clipIndex,
    clipId: `c${clipIndex}`,
    source: '/footage/talk.mov',
    state,
    findings: [],
    ...(error ? { error } : {}),
  };
}

describe('sweepTargets', () => {
  it('takes every clip that has audio, in track order, keeping each clip INDEX', () => {
    const { targets, skipped } = sweepTargets(
      track([clip({ id: 'a' }), clip({ id: 'b' }), clip({ id: 'c' })]),
    );

    expect(targets.map((t) => t.clip)).toEqual([0, 1, 2]);
    expect(targets.map((t) => t.c.id)).toEqual(['a', 'b', 'c']);
    expect(skipped).toEqual([]);
  });

  /** The index is what `editor_ripple_delete_ranges` and every other op speak
   *  in, so a skip must not shift the ones after it. This is the assertion
   *  that a naive `filter().map((_, i) => i)` would fail. */
  it('keeps the original clip index across a skip rather than renumbering', () => {
    const { targets, skipped } = sweepTargets(
      track([
        clip({ id: 'a' }),
        clip({ id: 'title', source_path: null }),
        clip({ id: 'c' }),
        clip({ id: 'still', source_path: '/art/card.png' }),
        clip({ id: 'e' }),
      ]),
    );

    expect(targets.map((t) => t.clip)).toEqual([0, 2, 4]);
    expect(skipped.map((s) => s.clip)).toEqual([1, 3]);
  });

  it('says WHY each skipped clip was skipped rather than dropping it silently', () => {
    const { skipped } = sweepTargets(
      track([clip({ id: 'title', source_path: null }), clip({ id: 'still', source_path: '/a/b.JPG' })]),
    );

    expect(skipped[0]).toMatchObject({ clip: 0, clipId: 'title' });
    expect(skipped[0].reason).toMatch(/generated/i);
    expect(skipped[1]).toMatchObject({ clip: 1, clipId: 'still' });
    expect(skipped[1].reason).toMatch(/still/i);
  });

  it('answers an empty track, and a track that is not there, without throwing', () => {
    expect(sweepTargets(track([]))).toEqual({ targets: [], skipped: [] });
    expect(sweepTargets(undefined)).toEqual({ targets: [], skipped: [] });
  });
});

describe('sweepReport', () => {
  /** B-216's own shape: one long track, almost all of it clean. The report has
   *  to make the three that matter findable without reading the rest. */
  it('carries full detail ONLY for the flagged clips and collapses clean ones to indices', () => {
    const results = Array.from({ length: 20 }, (_, i) =>
      i === 3 || i === 11 ? done(i, 2) : done(i, 0),
    );

    const r = sweepReport(SILENCE_SWEEP, 0, results, []);

    expect(r.flagged.map((f) => f.clip)).toEqual([3, 11]);
    expect(r.clean).toHaveLength(18);
    expect(r.clean).not.toContain(3);
    // The findings ride under the SAME key the single-clip tool uses, so one
    // clip's answer and a sweep's read identically.
    expect(r.flagged[0].silences).toHaveLength(2);
    // …and a clean clip contributes an index and nothing else: no sub-report
    // to scan, which is the whole reason this shape exists.
    expect(r.clean.every((c) => typeof c === 'number')).toBe(true);
    expect(r.totals).toMatchObject({ clips: 20, analysable: 20, flagged: 2, clean: 18, findings: 4 });
  });

  it('reports retake groups under `groups`, not `silences`', () => {
    const r = sweepReport(RETAKE_SWEEP, 1, [done(0, 1)], []);
    expect(r.flagged[0].groups).toHaveLength(1);
    expect(r.flagged[0].silences).toBeUndefined();
    expect(r.track).toBe(1);
  });

  it('is `running` while any clip is, and names the status tool to poll', () => {
    const r = sweepReport(SILENCE_SWEEP, 0, [done(0, 0), inState(1, 'running')], []);

    expect(r.state).toBe('running');
    expect(r.running).toEqual([1]);
    expect(r.note).toContain('editor_detect_silences_status');
  });

  /** A retake clip waiting on WORDS is not the same as one waiting on the
   *  grouping — the thing to poll differs — and the single-clip tool already
   *  draws that distinction. */
  it('keeps `transcribing` separate from `running`', () => {
    const r = sweepReport(RETAKE_SWEEP, 0, [inState(0, 'transcribing'), inState(1, 'running')], []);

    expect(r.transcribing).toEqual([0]);
    expect(r.running).toEqual([1]);
    expect(r.state).toBe('running');
    expect(r.totals).toMatchObject({ transcribing: 1, running: 1 });
  });

  it('is `idle` only when NOTHING on the track was ever started', () => {
    expect(sweepReport(SILENCE_SWEEP, 0, [inState(0, 'idle'), inState(1, 'idle')], []).state).toBe(
      'idle',
    );
    // One real answer in hand is not "idle", even with untouched clips beside it.
    const mixed = sweepReport(SILENCE_SWEEP, 0, [done(0, 0), inState(1, 'idle')], []);
    expect(mixed.state).toBe('done');
    expect(mixed.notStarted).toEqual([1]);
    expect(mixed.note).toContain('editor_detect_silences');
  });

  /** The failure mode this bug is about is a confident "all clear" over
   *  material nobody looked at. The claim is only made when every analysable
   *  clip has actually answered. */
  it('never claims the track is clean while anything is unanswered', () => {
    const pending = sweepReport(SILENCE_SWEEP, 0, [done(0, 0), inState(1, 'running')], []);
    expect(pending.note).not.toMatch(/anywhere on this track/);
    expect(pending.note).toMatch(/that have finished/);

    const untouched = sweepReport(SILENCE_SWEEP, 0, [done(0, 0), inState(1, 'idle')], []);
    expect(untouched.note).not.toMatch(/anywhere on this track/);

    const complete = sweepReport(SILENCE_SWEEP, 0, [done(0, 0), done(1, 0)], []);
    expect(complete.note).toMatch(/no silences anywhere on this track/);
    expect(complete.state).toBe('done');
  });

  it('lets one clip fail without failing the sweep', () => {
    const r = sweepReport(
      SILENCE_SWEEP,
      0,
      [done(0, 1), inState(1, 'error', 'no audio stream'), done(2, 0)],
      [],
    );

    expect(r.ok).toBe(true);
    expect(r.failed).toEqual([{ clip: 1, error: 'no audio stream' }]);
    expect(r.flagged.map((f) => f.clip)).toEqual([0]);
    expect(r.clean).toEqual([2]);
    expect(r.note).toContain('failed[]');
  });

  /** Nothing is cut, ever — the same promise the single-clip tools make. The
   *  report has to say so where a caller will read it. */
  it('tells a caller with findings that nothing was cut', () => {
    const r = sweepReport(SILENCE_SWEEP, 0, [done(0, 3)], []);
    expect(r.note).toMatch(/nothing was cut/);
    expect(r.note).toContain('editor_ripple_delete_ranges');
  });

  it('counts skipped clips into `clips` but never into `analysable`', () => {
    const r = sweepReport(SILENCE_SWEEP, 0, [done(0, 0)], [
      { clip: 1, clipId: 'title', reason: 'generated clip (a title or adjustment) — no audio to analyse' },
    ]);

    expect(r.totals).toMatchObject({ clips: 2, analysable: 1, skipped: 1 });
    expect(r.skipped[0].clip).toBe(1);
  });
});
