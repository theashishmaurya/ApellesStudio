/**
 * `@apelles/editor` — put the original continuous take back together before
 * retake detection reads it, and take the answer apart again afterwards
 * (D-364, fixes B-237).
 *
 * **What it is.** The pure layer between "the clips on a track" and "the
 * utterances one `detect_retakes` call is handed". It groups consecutive clips
 * that came from **one continuous stretch of one source file** into a *run*,
 * merges those clips' transcript views into a single utterance list, and maps
 * a group's takes — which are absolute source seconds — back onto the real
 * clips and frames a cut is expressed in.
 *
 * **Why it exists** (B-237, measured on a real project, not inferred). The
 * whole-track sweep used to call `detect_retakes` once per clip, each call's
 * view scoped to that clip's own trimmed source range. After a fine-grained
 * silence cut a clip is routinely shorter than the sentence it is part of —
 * the project this was found on has clips of 0.25 s and 0.58 s — so the two
 * halves of a restart land in *different* clips' views and **no call ever sees
 * both halves to compare them**. A chain needs two members; a view holding one
 * half can never produce one, however good the scoring is. Six of seven real
 * retakes on that project spanned 2-5 clips each and were structurally
 * invisible; the one the sweep caught is the one whose takes happened to share
 * a single clip. The grouping algorithm itself (`apelles-speech`'s
 * `retake.rs`) is *not* the problem and is untouched by this module — it
 * scores the same footage correctly the moment it is handed both takes.
 *
 * **What a run is, exactly, and what it is not.** Consecutive analysable clips,
 * in track order, that share a `source_path`, move **forward** through that
 * source, and are separated by at most [`RETAKE_WINDOW_SECS`] of source the
 * timeline no longer shows. That is the reconstruction of "one continuous
 * recording, chopped up and with bits removed". It is deliberately **not**
 * "every clip on the track": merging across a source change, a jump backwards,
 * or a long-removed stretch would invent comparisons between material that was
 * never one take, which is a different bug in the other direction.
 *
 * **What it does NOT do.** No detection, no transcript slicing (that is
 * `darkRecovery.ts`'s `clipTranscriptView`, once per clip, unchanged — this
 * module only *merges* its results), no store access, no React, and nothing
 * destructive. Pure functions, which is what makes the run rule and the
 * take→clip mapping testable on their own.
 */

import { clipSourceRangeSecs, clipSourceRate, spanToFrames, type DetectedSpan } from './recut';
import type { SweepTarget } from './recutSweep';

/**
 * How far apart in SOURCE time two clips may sit and still be one run.
 *
 * Not a free parameter: it mirrors `apelles_speech::retake::RetakeParams`'s own
 * `window_secs` default, which is the furthest apart two takes may be before
 * the detector refuses to pair them at all ("a line repeated half an hour later
 * is a callback, not a retake"). Material separated by more removed source than
 * that could never be grouped even if it were merged, so merging across it
 * would be cost with no possible finding. A caller that raises `window_secs`
 * raises this with it — see [`runGapSecs`].
 */
export const RETAKE_WINDOW_SECS = 30;

/** One continuous stretch of one source file, as the timeline still holds it. */
export interface ClipRun {
  /** The source every clip in the run came from. */
  source: string;
  /** The clips, in track order, which is also source order by construction. */
  targets: SweepTarget[];
  /** The run's own source range — from the first clip's in-point to the last
   *  clip's out-point, gaps included. This is what a detection is keyed on, so
   *  every clip of a run asks the detector one identical question. */
  startSecs: number;
  durationSecs: number;
}

/** The effective run gap for a call, honouring a caller's own `windowSecs`. */
export function runGapSecs(windowSecs: number | undefined): number {
  return windowSecs !== undefined && Number.isFinite(windowSecs) && windowSecs > 0
    ? windowSecs
    : RETAKE_WINDOW_SECS;
}

/** The clip's trimmed source range in the source's own FRAMES — integers, so
 *  adjacency is exact arithmetic rather than a float tolerance. */
function sourceFrames(t: SweepTarget): { start: number; end: number } {
  return { start: t.c.source_start, end: t.c.source_start + t.c.duration };
}

/**
 * Split one track's sweep targets into runs (see this module's header for the
 * rule, and why it is that rule).
 *
 * A single clip that neighbours nothing is a run of one, so every caller has
 * exactly one shape to handle and the single-clip path is not a special case.
 */
export function clipRuns(
  targets: readonly SweepTarget[],
  fps: number,
  maxGapSecs: number = RETAKE_WINDOW_SECS,
): ClipRun[] {
  const runs: ClipRun[] = [];

  for (const t of targets) {
    const open = runs[runs.length - 1];
    const prev = open?.targets[open.targets.length - 1];
    if (open && prev && joins(prev, t, fps, maxGapSecs)) {
      open.targets.push(t);
      const range = clipSourceRangeSecs(t.c, fps);
      open.durationSecs = Math.max(open.durationSecs, range.startSecs + range.durationSecs - open.startSecs);
      continue;
    }
    const range = clipSourceRangeSecs(t.c, fps);
    runs.push({
      source: t.source,
      targets: [t],
      startSecs: range.startSecs,
      durationSecs: range.durationSecs,
    });
  }

  return runs;
}

/** Does `next` continue the same recording `prev` was cut from?
 *
 *  One frame of overlap is tolerated because a plain split can produce it; a
 *  real jump backwards through the source is a different take and breaks the
 *  run. */
function joins(prev: SweepTarget, next: SweepTarget, fps: number, maxGapSecs: number): boolean {
  if (prev.source !== next.source) return false;
  const rate = clipSourceRate(next.c, fps);
  if (rate !== clipSourceRate(prev.c, fps)) return false;
  const a = sourceFrames(prev);
  const b = sourceFrames(next);
  if (b.start < a.end - 1) return false;
  return (b.start - a.end) / rate <= maxGapSecs;
}

/**
 * Merge one run's per-clip transcript views into the single list the detector
 * is handed.
 *
 * **Only what the timeline still shows.** Each list is one clip's own filtered,
 * D-349-spliced view, so the merged list is exactly "every utterance any clip
 * of this run still holds" — the removed stretches between clips contribute
 * nothing. That keeps the pre-B-237 invariant ("a source trimmed to its second
 * half must not report retakes from material nobody will ever see") intact at
 * run granularity, instead of trading it away for context.
 *
 * **Dedup is load-bearing.** One transcript segment can overlap two clips of a
 * run, and handing the detector the same words twice would offer it a perfect
 * self-match — the same double-count that made `editor_get_timeline_transcript`
 * look like a Whisper bug during B-237's investigation.
 */
export function mergeRunUtterances<T extends { start: number; end: number; text: string }>(
  views: ReadonlyArray<readonly T[]>,
): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const list of views) {
    for (const u of list) {
      const id = `${u.start}|${u.end}|${u.text}`;
      if (seen.has(id)) continue;
      seen.add(id);
      out.push(u);
    }
  }
  return out.sort((a, b) => a.start - b.start || a.end - b.end);
}

/** One clip's share of a take, with the frames a cut for it needs. */
export interface TakeSegment {
  /** Index into the track's own `clips` — what every `editor_*` op speaks in. */
  clip: number;
  clipId: string;
  span: DetectedSpan;
}

/**
 * Which clips of a run a take actually lands in, and where in each.
 *
 * Returns a LIST, never one span: a take spanning several clips is the whole
 * point of B-237, and assuming one take is one clip is how the frames come out
 * wrong. Each piece is measured against its own clip, through the same
 * [`spanToFrames`] every other detected span crosses, so a run's answer and a
 * single clip's cannot round differently.
 *
 * Pieces that land on no real frame are dropped — a clip can overlap a take by
 * less than a frame, and a zero-length range is not something to hand a ripple
 * delete.
 */
export function takeSegments(
  run: ClipRun,
  startSecs: number,
  endSecs: number,
  fps: number,
): TakeSegment[] {
  const out: TakeSegment[] = [];
  for (const t of run.targets) {
    const range = clipSourceRangeSecs(t.c, fps);
    const from = Math.max(startSecs, range.startSecs);
    const to = Math.min(endSecs, range.startSecs + range.durationSecs);
    if (to <= from) continue;
    const span = spanToFrames(t.c, from, to, fps);
    if (span.endFrame <= span.startFrame) continue;
    out.push({ clip: t.clip, clipId: t.c.id, span });
  }
  return out;
}
