/**
 * marks.ts — the timeline's IN / OUT marks (B-348; keys I, O, Alt+X).
 *
 * What it is: the pure rules for the two marks `timelineStore` keeps as
 * `inPoint` / `outPoint`. A marked range is `[inPoint, outPoint]` INCLUSIVE of
 * both frames, as Premiere, Resolve and Final Cut mark it ("O" marks the last
 * frame you want). Either side may be absent: an In alone means "from here to
 * the end", an Out alone "from the start to here".
 *
 * Rules (all in `applyMarks`, so the keys, the ruler, the MCP tool and the
 * tests cannot disagree):
 *   - a mark is clamped to `0 .. duration - 1` (an empty timeline has none);
 *   - setting an In AFTER the current Out clears the Out, and setting an Out
 *     BEFORE the current In clears the In (Resolve's behaviour: the new mark
 *     wins, the one it crossed is dropped rather than silently swapped);
 *   - `null` clears a side.
 *
 * What it does NOT do: sit on the undo stack, persist, or drive Export. The
 * marks are session state like the playhead (cleared on a project or timeline
 * switch). `editor_export` renders the whole timeline today; a range export is
 * a separate, not-yet-built feature (B-348 notes), so the marks only mark.
 */

export interface Marks {
  inPoint: number | null;
  outPoint: number | null;
}

export type MarksPatch = { inPoint?: number | null; outPoint?: number | null };

function clampMark(frame: number, duration: number): number | null {
  if (!Number.isFinite(frame) || duration <= 0) return null;
  return Math.min(Math.max(Math.round(frame), 0), duration - 1);
}

/** The marks after applying `patch`. `undefined` leaves a side untouched. */
export function applyMarks(current: Marks, patch: MarksPatch, duration: number): Marks {
  let inPoint = current.inPoint;
  let outPoint = current.outPoint;
  if (patch.inPoint !== undefined) {
    inPoint = patch.inPoint === null ? null : clampMark(patch.inPoint, duration);
    if (inPoint !== null && outPoint !== null && inPoint > outPoint && patch.outPoint === undefined) outPoint = null;
  }
  if (patch.outPoint !== undefined) {
    outPoint = patch.outPoint === null ? null : clampMark(patch.outPoint, duration);
    if (outPoint !== null && inPoint !== null && outPoint < inPoint && patch.inPoint === undefined) inPoint = null;
  }
  // Both sides given and crossed: keep them ordered rather than inventing a rule.
  if (inPoint !== null && outPoint !== null && inPoint > outPoint) [inPoint, outPoint] = [outPoint, inPoint];
  return { inPoint, outPoint };
}

/** The marks as the frame range they cover on a timeline of `duration` frames
 *  (an absent side extends to that end), or null when neither is set. */
export function markedRange(marks: Marks, duration: number): { start: number; end: number } | null {
  if (marks.inPoint === null && marks.outPoint === null) return null;
  return { start: marks.inPoint ?? 0, end: marks.outPoint ?? Math.max(0, duration - 1) };
}
