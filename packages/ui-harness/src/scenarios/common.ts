/**
 * common.ts — shared fixtures and assertion shorthands for the starter suite (D-434).
 *
 * Frames are TIMELINE frames at the fixture media's 30 fps; every scenario
 * starts with `FPS_GUARD`, which skips it on a timeline running at another
 * rate rather than asserting frame numbers that mean something else there.
 */

import type { Assertion, Value } from '../assertions.ts';
import type { FixtureSpec, Step } from '../scenario.ts';
import { clipSelector, TIMELINE_TEST_IDS } from '../targets.ts';

export const FPS = 30;

/** Skip on a timeline that is not at the fixture's rate. */
export const FPS_GUARD: Step = {
  require: { path: 'state.activeTimeline.fps', op: 'eq', value: FPS },
  reason: `the scenario's frame numbers assume a ${FPS} fps timeline`,
};

/** Three butted 3-second clips on one video track, each starting 1 s into its
 *  source so every edge has trim handles in both directions, and an empty
 *  second video track below for cross-track moves. */
export const THREE_CLIPS: FixtureSpec = {
  tracks: [
    {
      kind: 'video',
      clips: [
        { name: 'a', sourceStart: 30, duration: 90, startFrame: 0 },
        { name: 'b', sourceStart: 30, duration: 90, startFrame: 90 },
        { name: 'c', sourceStart: 30, duration: 90, startFrame: 180 },
      ],
    },
    { kind: 'video', clips: [] },
  ],
};

/** Two clips with a 60-frame gap between them (60-120), and one on the track
 *  below that sits wholly BEFORE the gap's end. Closing a gap ripples every
 *  sync-locked track from the gap's end, and `checkRemoveGap` rightly refuses
 *  when a clip straddles that point (B-033), so a clip spanning frame 120 on
 *  track 1 would make the close scenario test the refusal, not the close (H6).
 *  The timeline is 180 frames long: nothing is at frame 200. */
export const GAPPED: FixtureSpec = {
  tracks: [
    {
      kind: 'video',
      clips: [
        { name: 'a', duration: 60, startFrame: 0 },
        { name: 'b', duration: 60, startFrame: 120 },
      ],
    },
    { kind: 'video', clips: [{ name: 'c', duration: 60, startFrame: 30 }] },
  ],
};

/** One long clip — wider than the window at any normal zoom, for scrolling. */
export const LONG: FixtureSpec = {
  tracks: [{ kind: 'video', clips: [{ name: 'a', duration: 840, startFrame: 0 }] }],
};

/** Clip field `=`. */
export const clipIs = (name: string, field: string, value: Value, tolerance?: number): Assertion =>
  tolerance === undefined
    ? { path: `timeline.clips.${name}.${field}`, op: 'eq', value }
    : { path: `timeline.clips.${name}.${field}`, op: 'near', value, tolerance };

/** Clip field unchanged from a captured snapshot. */
export const clipUnchanged = (name: string, field: string, from = 'before'): Assertion => ({
  path: `timeline.clips.${name}.${field}`,
  op: 'unchanged',
  from,
});

/** The scope paths of one captured clip — for MCP-vs-GUI parity. */
export const sameAsGui = (name: string, fields: readonly string[], gui = 'gui'): Assertion[] =>
  fields.map((f) => ({ path: `timeline.clips.${name}.${f}`, op: 'eq', value: { ref: `${gui}.clips.${name}.${f}` }, label: `MCP agrees with the GUI on ${name}.${f}` }));

export const playheadNear = (frame: Value, tolerance = 2): Assertion => ({ path: 'state.playhead', op: 'near', value: frame, tolerance });

/** Every watched-frame selector for one clip body, and the library wrapper (which is what trims resize). */
export const watchClip = (name: string) => clipSelector(name);

export const GHOST = `[data-testid="${TIMELINE_TEST_IDS.dragGhost}"]`;

/** The cursors an edge trim can legitimately show (Resolve swaps per mode; the
 *  web has no bitmap trim cursors, so the resize family counts). */
export const TRIM_CURSORS = ['ew-resize', 'col-resize', 'e-resize', 'w-resize'] as const;

/** Select a trim-palette tool through the toolbar, as a human does. */
export const pickTool = (tool: string): Step => ({
  pointer: { action: 'click', target: { selector: `[data-testid="${TIMELINE_TEST_IDS.trimTool}"][data-chroma-trim-tool="${tool}"]` } },
  label: `pick the ${tool} tool in the toolbar`,
});

export const toolActive = (tool: string, reason: string): Step => ({
  reachable: { selector: `[data-testid="${TIMELINE_TEST_IDS.trimTool}"][data-chroma-trim-tool="${tool}"][aria-pressed="true"]`, reason },
});
