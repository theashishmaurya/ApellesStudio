/**
 * twoUp.ts — which two frames the Edit viewer shows while a roll, slip or
 * slide is dragged (D-432 P3, `docs/notes/ui-redesign.md` §5.1 "Two-up
 * viewer", after Final Cut's "Show 2-Up When Trimming").
 *
 * | Tool  | Left                          | Right                          |
 * |-------|-------------------------------|--------------------------------|
 * | Roll  | outgoing clip's last frame    | incoming clip's first frame    |
 * | Slip  | the clip's new first frame    | the clip's new last frame      |
 * | Slide | left neighbour's last frame   | right neighbour's first frame  |
 *
 * Pure: given the timeline before the drag, the gesture's target and the
 * timeline the drop would leave (`previewEdit`'s `after`), it names each half
 * as a frame of a clip's SOURCE (the persisted timeline does not hold the
 * new cut yet, so no timeline position shows it) plus the timeline frame its
 * timecode reads. Trim and ripple are one-up in the spec and get `null` here
 * (the viewer keeps the playhead's frame).
 *
 * What it does NOT do: fetch anything (`TwoUpViewer.tsx`) or decide where the
 * edit lands (`editGesture.ts`).
 */

import { editBrackets, type EditTarget } from './editGesture';
import type { TwoUpHalf, TwoUpView } from './previewPeek';
import { endFrame, timelineFps, type Clip, type Timeline } from './timeline';

function findClip(tl: Timeline, track: number, id: string): Clip | null {
  return tl.tracks[track]?.clips.find((c) => c.id === id) ?? null;
}

function firstFrame(c: Clip, label: string): TwoUpHalf {
  return { sourcePath: c.source_path, sourceFrame: c.source_start, label, timelineFrame: c.start_frame };
}

function lastFrame(c: Clip, label: string, fps: number): TwoUpHalf {
  return {
    sourcePath: c.source_path,
    sourceFrame: c.source_start + Math.max(0, c.duration - 1),
    label,
    timelineFrame: Math.max(c.start_frame, endFrame(c, fps) - 1),
  };
}

/** The two-up halves for a gesture, or `null` when it is one-up (trim, ripple)
 *  or has nothing on one side (a roll at a free edge). */
export function twoUpView(before: Timeline, target: EditTarget, after: Timeline): TwoUpView | null {
  const fps = timelineFps(after);
  if (target.mode === 'slip') {
    const id = before.tracks[target.track]?.clips[target.clip]?.id;
    const c = id ? findClip(after, target.track, id) : null;
    return c ? { left: firstFrame(c, 'Start'), right: lastFrame(c, 'End', fps) } : null;
  }
  if (target.mode !== 'roll' && target.mode !== 'slide') return null;
  // The brackets name exactly the two clips whose edges the tool moves: the
  // `out` one ends at the edit, the `in` one starts there (for a slide, the
  // two neighbours).
  const brackets = editBrackets(before, target);
  const out = brackets.find((b) => b.side === 'out');
  const inn = brackets.find((b) => b.side === 'in');
  if (!out || !inn) return null;
  const outClip = findClip(after, out.track, out.clipId);
  const inClip = findClip(after, inn.track, inn.clipId);
  if (!outClip || !inClip) return null;
  return { left: lastFrame(outClip, 'Out', fps), right: firstFrame(inClip, 'In') };
}
