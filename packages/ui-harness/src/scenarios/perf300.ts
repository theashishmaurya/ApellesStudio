/**
 * perf300.ts - the timeline's perf baseline at 300 clips on 8 tracks (D-437 S0c).
 *
 * What it is: the edit tools, a clip move, three zoom gestures, both scrolls and
 * playback, each run on `BIG_300` (`bigFixture.ts`) and each measured, so the same
 * set run on the library build and again after the lanes switch (D-437 S4, S9) gives
 * comparable numbers. `docs/notes/ui-harness.md` "Baseline recipe" has the commands.
 *
 * What it does NOT do: judge correctness. The functional checks are the starter
 * suite's, on three clips; here the only assertions are that the gesture reached the
 * timeline (a `waitFor` on something the gesture must change) and every step is
 * `measure: true`, so the report carries frame p95/worst/dropped, the move and
 * release phases and the commit marks. Opt-in: a run with no `--filter` leaves these
 * out (`optIn`); `--filter perf-300` runs them.
 *
 * Targets are clips near the start of a track, where the generator butts the first
 * four clips together, so every tool has neighbours on screen at the default zoom.
 */

import { BIG_300, bigClipName } from '../bigFixture.ts';
import type { Scenario, Step, TargetRef } from '../scenario.ts';
import { byFrames, clip, editArea, trimRight } from '../targets.ts';
import { FPS_GUARD, pickTool, toolActive } from './common.ts';

const AREA = 'perf-300';
const REFERENCE = 'Snappy at scale (CLAUDE.md priority order; D-437 section 4 targets): the tools must feel the same on a 300-clip timeline as on three clips';

const c = (track: number, index: number) => bigClipName(track, index);

/** A measured drag of `frames`, with the starter suite's gesture shape (15 moves over 450 ms; the runner stretches it to 1.5 s). */
const drag = (target: TargetRef, frames: number, label: string): Step => ({
  pointer: { action: 'drag', target, to: byFrames(frames), steps: 15, durationMs: 450 },
  label,
  measure: true,
});

/** A ripple shifts every sync-locked track, and refuses (B-033) when a clip on one straddles the edit point: on a dense 8-track
 *  timeline one always does. Unlock every other track, as an editor would to ripple one. */
const unsyncOthers = (keep: number): Step[] =>
  Array.from({ length: BIG_300.tracks.length }, (_, t) => t)
    .filter((t) => t !== keep)
    .map((t) => ({ op: 'editor_set_track_sync_locked', args: { track: t, syncLocked: false }, label: `sync-unlock track ${t}` }));

const scenario = (id: string, title: string, steps: Step[]): Scenario => ({
  id: `perf-300-${id}`,
  title: `300 clips: ${title}`,
  area: AREA,
  reference: REFERENCE,
  fixture: BIG_300,
  optIn: true,
  steps: [FPS_GUARD, ...steps],
});

export const PERF_300_SCENARIOS: Scenario[] = [
  scenario('trim-select', 'Select-tool trim of a right edge', [
    drag(trimRight(c(1, 1)), -15, `trim ${c(1, 1)}'s right edge 15 frames left`),
    { waitFor: { path: `timeline.clips.${c(1, 1)}.duration`, op: 'lt', value: 75 } },
  ]),
  scenario('ripple-trim', 'Ripple trim (every later clip on the track moves)', [
    ...unsyncOthers(2),
    pickTool('ripple'),
    toolActive('ripple', 'the Ripple tool button did not activate'),
    drag(trimRight(c(2, 1)), -15, `ripple-trim ${c(2, 1)}'s right edge 15 frames left`),
    { waitFor: { path: `timeline.clips.${c(2, 1)}.duration`, op: 'lt', value: 150 } },
  ]),
  scenario('roll', 'Roll of a cut', [
    pickTool('roll'),
    toolActive('roll', 'the Roll tool button did not activate'),
    drag(trimRight(c(3, 1)), 15, `roll the ${c(3, 1)}|${c(3, 2)} cut 15 frames right`),
    { waitFor: { path: `timeline.clips.${c(3, 1)}.duration`, op: 'gt', value: 30 } },
  ]),
  scenario('slip', 'Slip of a clip', [
    pickTool('slip'),
    toolActive('slip', 'the Slip tool button did not activate'),
    drag(clip(c(1, 2)), 15, `slip ${c(1, 2)} by 15 frames`),
    { waitFor: { path: `timeline.clips.${c(1, 2)}.sourceStart`, op: 'in', value: [15, 45] } },
  ]),
  scenario('slide', 'Slide of a clip between its neighbours', [
    { capture: 'timeline', as: 'before' },
    pickTool('slide'),
    toolActive('slide', 'the Slide tool button did not activate'),
    drag(clip(c(2, 2)), 15, `slide ${c(2, 2)} 15 frames right`),
    { waitFor: { path: `timeline.clips.${c(2, 2)}.startFrame`, op: 'gt', value: { ref: `before.clips.${c(2, 2)}.startFrame` } } },
  ]),
  scenario('move-clip', 'Drag a clip along its track', [
    { pointer: { action: 'drag', target: clip(c(4, 3), { fy: 0.8 }), to: byFrames(30), steps: 15, durationMs: 450 }, label: `move ${c(4, 3)} 30 frames right`, measure: true },
  ]),
  scenario('zoom-pinch-in', 'Trackpad pinch zooms in', [
    { capture: 'view', as: 'before' },
    { pointer: { action: 'pinch', target: editArea({ fx: 0.5, fy: 0.6 }), scale: 1.5 }, expectHit: false, measure: true },
    { waitFor: { path: 'view.pxPerSec', op: 'gt', value: { ref: 'before.pxPerSec' } } },
  ]),
  scenario('zoom-pinch-out', 'Trackpad pinch zooms out (more clips on screen)', [
    { capture: 'view', as: 'before' },
    { pointer: { action: 'pinch', target: editArea({ fx: 0.5, fy: 0.6 }), scale: 0.4 }, expectHit: false, measure: true },
    { waitFor: { path: 'view.pxPerSec', op: 'lt', value: { ref: 'before.pxPerSec' } } },
  ]),
  scenario('zoom-ctrl-wheel', 'Ctrl+wheel zooms around the cursor', [
    { capture: 'view', as: 'before' },
    { pointer: { action: 'wheel', target: editArea({ fx: 0.4, fy: 0.6 }), modifiers: ['ctrl'], deltaY: -120, steps: 3 }, expectHit: false, measure: true },
    { waitFor: { path: 'view.pxPerSec', op: 'gt', value: { ref: 'before.pxPerSec' } } },
  ]),
  scenario('scroll-horizontal', 'Horizontal two-finger scroll', [
    { capture: 'view', as: 'before' },
    { pointer: { action: 'wheel', target: editArea({ fx: 0.5, fy: 0.6 }), deltaX: 600, steps: 8 }, expectHit: false, measure: true },
    { waitFor: { path: 'view.scrollLeft', op: 'gt', value: { ref: 'before.scrollLeft' } } },
  ]),
  scenario('scroll-vertical', 'Vertical scroll across the tracks', [
    { capture: 'view', as: 'before' },
    { pointer: { action: 'wheel', target: editArea({ fx: 0.5, fy: 0.6 }), deltaY: 300, steps: 6 }, expectHit: false, measure: true },
    { wait: 200 },
  ]),
  scenario('playback', 'Playback holds the frame rate', [{ playback: { seconds: 3, fromFrame: 0 } }]),
];
