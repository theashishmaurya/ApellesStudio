/**
 * @apelles/editor — previous / next edit point (D-432 P5).
 *
 * **What it is.** The pure lookup behind the viewer transport's outer buttons
 * (`SkipBack` / `SkipForward`, `docs/notes/ui-redesign.md` §4.11) and their
 * keys (`edit.prev_edit` / `edit.next_edit`, Up / Down — the keys Final Cut,
 * Premiere and Resolve all use to jump between edits). An edit point is any
 * clip's start or end frame on any track, plus the timeline's first frame and
 * its last.
 *
 * **What it does NOT do.** It moves nothing; the caller sets the playhead
 * (`setPlayhead`), the same action `editor_set_playhead` drives, so an agent
 * reaches the same frame by asking for it.
 */
import { endFrame, timelineDuration, timelineFps, type Timeline } from './timeline';

/** Every edit point on `timeline`, ascending and unique. */
export function editPoints(timeline: Timeline | null): number[] {
  if (!timeline) return [0];
  const fps = timelineFps(timeline);
  const last = Math.max(0, timelineDuration(timeline) - 1);
  const points = new Set<number>([0, last]);
  for (const track of timeline.tracks) {
    for (const clip of track.clips) {
      points.add(clip.start_frame);
      points.add(endFrame(clip, fps));
    }
  }
  return [...points].filter((f) => f >= 0 && f <= last).sort((a, b) => a - b);
}

/** The nearest edit point strictly before `frame`, or the first frame. */
export function prevEditPoint(points: readonly number[], frame: number): number {
  let best = 0;
  for (const p of points) {
    if (p < frame) best = p;
    else break;
  }
  return best;
}

/** The nearest edit point strictly after `frame`, or `frame` itself when none
 *  is (the playhead is already at or past the last one). */
export function nextEditPoint(points: readonly number[], frame: number): number {
  for (const p of points) if (p > frame) return p;
  return frame;
}
