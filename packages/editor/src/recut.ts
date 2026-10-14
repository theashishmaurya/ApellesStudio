/**
 * @apelles/editor — the seconds↔frames edge of silence + retake detection (D-318).
 *
 * **What it is.** The small, pure conversion layer between `apelles-speech`,
 * which speaks in **source seconds** and knows nothing about timelines, and the
 * Edit tab, which cuts in **timeline frames**. Every detected span crosses this
 * boundary exactly once, through `spanToFrames`, so the human's Recut panel and
 * the `editor_detect_*` MCP ops cannot round differently.
 *
 * **What it does NOT do.** No detection of its own (that is the Rust crate's
 * job, reached through `chroma_detect_silences` / `chroma_detect_retakes`), no
 * store access, no React. Pure functions over a `Clip`, which is what makes the
 * rounding rule testable on its own.
 *
 * **The rounding rule is not a detail.** Each endpoint is rounded to a frame
 * *independently*, rather than rounding the start and deriving the end from an
 * un-rounded duration — the same rule `captionsFromTranscript.ts` follows for
 * transcript timestamps and `apelles_timeline::subtitle_import` follows for
 * imported cues. Rounding a duration instead lets a span drift by a frame
 * against the very words it was measured from.
 */

import {
  endFrame,
  sourceFramesToTimeline,
  timelineFps,
  type Clip,
  type Timeline,
} from './timeline';

/** Mirrors `apelles_speech::silence::SilenceParams`'s own default. */
export const DEFAULT_MIN_SILENCE_MS = 600;

/** One detected span, in every coordinate system a caller might want it in. */
export interface DetectedSpan {
  /** Source seconds — what the detector actually measured. */
  startSecs: number;
  endSecs: number;
  /** The clip's own source frames, the space `source_start`/`duration` live in. */
  sourceStartFrame: number;
  sourceEndFrame: number;
  /** Timeline frames — what a cut is expressed in. */
  startFrame: number;
  endFrame: number;
}

/** One member of a retake group — a single transcript utterance. */
export interface RetakeMemberWire {
  index: number;
  start_secs: number;
  end_secs: number;
  text: string;
}

/** A retake group as `chroma_detect_retakes` puts it on the wire.
 *
 *  `takes` is the unit that matters, not `members`: since D-327 a single
 *  delivery can span several utterances (the ASR's segment boundaries do not
 *  line up with a speaker's restarts), and `keep` indexes `takes`. Cutting
 *  "every member except `members[keep]`" — which is what this panel did before
 *  D-327, when every take was exactly one utterance — would now eat the tail of
 *  the delivery the speaker meant to keep. Use [`groupTakes`]. */
export interface RetakeGroupWire {
  members: RetakeMemberWire[];
  /** Inclusive `members` index ranges, one per delivery, in spoken order. */
  takes: Array<{ first: number; last: number }>;
  /** Index into `takes` of the delivery the detector suggests keeping. */
  keep: number;
  similarity: number;
}

/** One delivery, flattened to the range a cut needs. */
export interface RetakeTake {
  /** Index into the group's `takes`. */
  index: number;
  startSecs: number;
  endSecs: number;
  /** Every member's text, joined — what the speaker actually said this time. */
  text: string;
  /** This is the group's suggested keeper. */
  suggestedKeep: boolean;
}

/** Flatten a group's `takes` into the spans a reviewer ticks and a cut removes.
 *
 *  Tolerates a group with no `takes` (a detector older than D-327, or a hand-
 *  written fixture) by treating every member as its own delivery, which is
 *  exactly what `takes` meant before it existed. */
export function groupTakes(g: RetakeGroupWire): RetakeTake[] {
  const ranges =
    g.takes && g.takes.length > 0
      ? g.takes
      : g.members.map((_, i) => ({ first: i, last: i }));

  return ranges.map((t, index) => {
    const slice = g.members.slice(t.first, t.last + 1);
    return {
      index,
      startSecs: slice[0].start_secs,
      endSecs: slice[slice.length - 1].end_secs,
      text: slice.map((m) => m.text.trim()).join(' '),
      suggestedKeep: index === g.keep,
    };
  });
}

/** The clip's source rate, falling back to the timeline's (a clip with no
 *  `source_fps` is assumed to share it — the same fallback `scrubSource.ts`
 *  and `clipAt` already use).
 *
 *  Exported because `recutRuns.ts` reasons about two clips' source positions in
 *  the same units and must not re-derive this fallback differently (D-364). */
export function clipSourceRate(c: Clip, fps: number): number {
  return c.source_fps && c.source_fps > 0 ? c.source_fps : fps;
}

/** The trimmed range of `c`'s source that is actually on the timeline, in
 *  source seconds — what a detector should be pointed at, so it never reports
 *  a candidate in material the clip does not show. */
export function clipSourceRangeSecs(c: Clip, fps: number): { startSecs: number; durationSecs: number } {
  const rate = clipSourceRate(c, fps);
  return { startSecs: c.source_start / rate, durationSecs: c.duration / rate };
}

/** Convert one detected span (absolute SOURCE seconds) into the clip's source
 *  frames and the timeline frames a cut needs, clamped to the clip itself.
 *
 *  Clamping matters: the detector is handed a range in seconds and rounding at
 *  its edges can land a frame outside the clip, which would make a ripple
 *  delete reach into a neighbour. */
export function spanToFrames(c: Clip, startSecs: number, endSecs: number, fps: number): DetectedSpan {
  const rate = clipSourceRate(c, fps);
  const clipEndSource = c.source_start + c.duration;

  const rawStart = Math.round(startSecs * rate);
  const rawEnd = Math.round(endSecs * rate);
  const sourceStartFrame = Math.min(Math.max(rawStart, c.source_start), clipEndSource);
  const sourceEndFrame = Math.min(Math.max(rawEnd, sourceStartFrame), clipEndSource);

  const startFrame = c.start_frame + sourceFramesToTimeline(c, sourceStartFrame - c.source_start, fps);
  const endFrameOut = c.start_frame + sourceFramesToTimeline(c, sourceEndFrame - c.source_start, fps);

  return {
    startSecs,
    endSecs,
    sourceStartFrame,
    sourceEndFrame,
    startFrame,
    endFrame: endFrameOut,
  };
}

/** Every span in `spans` that is worth cutting — non-empty, and inside the
 *  clip. The panel and the MCP op both filter with this so "12 candidates" and
 *  "12 cuts" can never disagree. */
export function cuttableSpans(spans: DetectedSpan[]): DetectedSpan[] {
  return spans.filter((s) => s.endFrame > s.startFrame);
}

/** Locate a clip by stable id, the way every other single-clip consumer in
 *  this package does (an index moves under you; an id does not). */
export function findClipById(
  tl: Timeline,
  track: number,
  id: string,
): { clip: Clip; index: number } | null {
  const tr = tl.tracks[track];
  if (!tr) return null;
  const index = tr.clips.findIndex((c) => c.id === id);
  return index < 0 ? null : { clip: tr.clips[index], index };
}

/** The timeline-frame span a clip occupies — used by the panel to show what a
 *  pending cut will remove relative to the clip it came from. */
export function clipSpanFrames(c: Clip, tl: Timeline): { startFrame: number; endFrame: number } {
  const fps = timelineFps(tl);
  return { startFrame: c.start_frame, endFrame: endFrame(c, fps) };
}
