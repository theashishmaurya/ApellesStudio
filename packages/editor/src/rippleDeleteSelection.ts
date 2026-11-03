/**
 * rippleDeleteSelection.ts — Shift+Delete: ripple-delete the selected clips (B-348).
 *
 * What it is: the GUI half of Premiere's Ripple Delete / Resolve's Ripple
 * Delete. It takes the selection's clip ids and lifts each clip's span out of
 * its track AND closes the hole, by dispatching the existing
 * `ripple_delete_ranges` op (D-318) once per clip. That op is the one place
 * the rules live (A/V-linked partners come out with the clip, sync-locked
 * tracks ripple with it, locked tracks and B-033 straddlers refuse), so this
 * file adds no ripple logic of its own, and the agent's equivalent is
 * `editor_ripple_delete_ranges` with the clip's own frames.
 *
 * Order: the clips are processed from the LAST on the timeline to the first,
 * because each ripple moves everything after its cut earlier and would
 * invalidate the frame numbers of a later clip, but never of an earlier one.
 * A clip that an earlier iteration already removed (the linked partner of one
 * that was just cut) is skipped by id, so a selected V/A pair is cut once.
 *
 * What it does NOT do: ripple a plain Delete (that lifts and leaves a gap,
 * `remove`), or a selected GAP (that is `remove_gap`, already a ripple).
 */
import { endFrame, timelineFps, type Timeline } from './timeline';
import { useEditorTimelineStore } from './timelineStore';

/** Where `id` sits in `tl`, or null once it has been removed. */
function locate(tl: Timeline | null, id: string): { track: number; start: number; end: number } | null {
  if (!tl) return null;
  const fps = timelineFps(tl);
  for (let ti = 0; ti < tl.tracks.length; ti++) {
    const clip = tl.tracks[ti].clips.find((c) => c.id === id);
    if (clip) return { track: ti, start: clip.start_frame, end: endFrame(clip, fps) };
  }
  return null;
}

/** Ripple-delete every clip in `ids` from the open timeline. Returns how many
 *  ripple deletes were dispatched (0 = nothing selected or all refused). */
export function rippleDeleteClips(ids: ReadonlyArray<string>): number {
  const store = useEditorTimelineStore.getState();
  const order = ids
    .map((id) => ({ id, at: locate(store.timeline, id) }))
    .filter((e): e is { id: string; at: NonNullable<ReturnType<typeof locate>> } => e.at !== null)
    .sort((a, b) => b.at.start - a.at.start);
  let dispatched = 0;
  for (const { id } of order) {
    const state = useEditorTimelineStore.getState();
    const at = locate(state.timeline, id);
    if (!at) continue; // went out with a linked partner
    const before = state.timeline;
    state.applyOp({ kind: 'ripple_delete_ranges', track: at.track, ranges: [{ start: at.start, end: at.end }] });
    if (useEditorTimelineStore.getState().timeline !== before) dispatched++;
  }
  return dispatched;
}
