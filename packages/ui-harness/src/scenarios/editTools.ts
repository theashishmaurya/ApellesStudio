/**
 * editTools.ts — the trim/edit tools, driven exactly as a human does (D-434).
 *
 * The owner's own report: "features like roll etc. that we built don't work,
 * or the UI doesn't show the change / animate properly". So every tool here
 * is reached through the GUI (its toolbar button or its shortcut), dragged on
 * the real hit zone, and judged three ways:
 *   1. the store result — both neighbours' start / duration / source start,
 *      and the timeline length (ripple changes it; roll / slip / slide must not);
 *   2. the live feedback DURING the drag — the affected clip blocks' rects
 *      sampled on every frame must actually move/resize while the hand moves,
 *      and the cursor over the hit zone must change;
 *   3. the matching MCP op, applied after an undo, must produce the same
 *      result the GUI did.
 * Each drag is measured against the frame budget.
 *
 * References: Resolve's smart trim (`scratch/resolve-reference/trim.jpg`,
 * "automatically switches between ripple, roll, slip and slide"), Premiere's
 * Tools panel (V/B/N/Y/U, D-261), Final Cut's two-up viewer for roll/slip.
 */

import { getPath, type Scope } from '../assertions.ts';
import type { Scenario, Step, TargetRef } from '../scenario.ts';
import { atFrame, byFrames, clip, clipSelector, trimLeft, trimRight, TIMELINE_TEST_IDS } from '../targets.ts';
import { clipIs, clipUnchanged, FPS_GUARD, pickTool, sameAsGui, THREE_CLIPS, toolActive, TRIM_CURSORS } from './common.ts';

const num = (scope: Scope, path: string) => Number(getPath(scope, path));

/** Drag a target by `frames`, watching `watch` clips (plus any `extraSelectors`
 *  verbatim) and the cursor, measured. */
const drag = (target: TargetRef, frames: number, watch: string[], label: string, modifiers?: string[], extraSelectors: string[] = []): Step => ({
  pointer: {
    action: 'drag',
    target,
    to: byFrames(frames),
    steps: 15,
    durationMs: 450,
    ...(modifiers ? { modifiers } : {}),
    watch: { selectors: [...watch.map(clipSelector), ...extraSelectors], cursor: true },
  },
  label,
  measure: true,
});

/** Undo the GUI edit and confirm the fixture is back where it started. */
const undoToBefore = (names: string[]): Step[] => [
  { op: 'undo', label: 'undo the GUI edit before replaying it through MCP' },
  ...names.map((n): Step => ({ waitFor: clipIs(n, 'duration', { ref: `before.clips.${n}.duration` }), label: `undo restored ${n}` })),
];

/** `editor_trim_clip`'s `delta` MOVES the edge (B-337, fixed docstring): for
 *  `edge: 'end'`, negative = earlier = shorter. A 15-frame shortening is -15. */
const TRIM_END_SHORTEN_15 = -15;

/** The filmstrip tiles inside a clip body: they are laid out from the clip's
 *  source window, so they are what slip must visibly move. */
const SLIP_PICTURE = (name: string) => `${clipSelector(name)} img`;

const ROLL_FIELDS = ['startFrame', 'duration', 'sourceStart'] as const;

export const EDIT_TOOL_SCENARIOS: Scenario[] = [
  {
    id: 'trim-tool-shortcuts',
    title: 'V / B / T / Y / U select the Select, Ripple, Roll, Slip and Slide tools',
    area: 'edit tools',
    reference: "Premiere Pro's Tools panel shortcuts (D-261), Roll on T since D-432 P3 (N is Final Cut's snapping); the palette must show which tool is active",
    fixture: THREE_CLIPS,
    steps: [
      { pointer: { action: 'click', target: clip('a') }, label: 'focus the timeline' },
      { key: { keys: ['KeyB'] } },
      toolActive('ripple', 'B did not select the Ripple tool'),
      { key: { keys: ['KeyT'] } },
      toolActive('roll', 'T did not select the Roll tool'),
      { key: { keys: ['KeyY'] } },
      toolActive('slip', 'Y did not select the Slip tool'),
      { key: { keys: ['KeyU'] } },
      toolActive('slide', 'U did not select the Slide tool'),
      { key: { keys: ['KeyV'] } },
      toolActive('select', 'V did not return to the Select tool'),
    ],
  },
  {
    id: 'trim-right-edge-select-tool',
    title: 'Select tool: dragging a clip’s right edge trims only that clip, leaving a gap',
    area: 'edit tools',
    reference: 'Premiere / Resolve normal (non-ripple) trim: the clip shortens, its neighbour stays put',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { capture: 'timeline', as: 'before' },
      drag(trimRight('b'), -15, ['b'], 'drag b’s right edge 15 frames left'),
      { expect: { live: { selector: clipSelector('b'), prop: 'width', minDistinct: 4, label: 'b visibly shrinks during the drag' } } },
      { expect: { cursor: { anyOf: TRIM_CURSORS, label: 'the cursor shows a trim over the edge' } } },
      { waitFor: clipIs('b', 'duration', 75) },
      { expect: [clipIs('b', 'end', 165), clipUnchanged('b', 'startFrame'), clipUnchanged('c', 'startFrame'), { path: 'timeline.durationFrames', op: 'unchanged', from: 'before' }] },
      { capture: 'timeline', as: 'gui' },
      ...undoToBefore(['b']),
      { op: 'editor_trim_clip', args: (s) => ({ track: 0, clip: num(s, 'before.clips.b.index'), edge: 'end', delta: TRIM_END_SHORTEN_15 }) },
      { waitFor: clipIs('b', 'duration', 75) },
      { expect: sameAsGui('b', ROLL_FIELDS) },
    ],
  },
  {
    id: 'trim-left-edge-select-tool',
    title: 'Select tool: dragging a clip’s left edge trims its head (source in-point moves with it)',
    area: 'edit tools',
    reference: 'Premiere / Resolve normal trim of an in-point',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { capture: 'timeline', as: 'before' },
      drag(trimLeft('c'), 15, ['c'], 'drag c’s left edge 15 frames right'),
      { expect: { live: { selector: clipSelector('c'), prop: 'x', minDistinct: 4, label: 'c’s head visibly moves during the drag' } } },
      { waitFor: clipIs('c', 'startFrame', 195) },
      { expect: [clipIs('c', 'sourceStart', 45), clipIs('c', 'duration', 75), clipUnchanged('b', 'end')] },
    ],
  },
  {
    id: 'ripple-trim-tool',
    title: 'Ripple tool: trimming b’s out-point pulls everything after it along — no gap, shorter timeline',
    area: 'edit tools',
    reference: 'Premiere Ripple Edit tool (B) / Resolve ripple trim: later clips shift by the trim amount',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { capture: 'timeline', as: 'before' },
      pickTool('ripple'),
      toolActive('ripple', 'the Ripple tool button did not activate'),
      drag(trimRight('b'), -15, ['b', 'c'], 'ripple-drag b’s right edge 15 frames left'),
      { expect: { live: { selector: clipSelector('b'), prop: 'width', minDistinct: 4, label: 'b visibly shrinks during the drag' } } },
      { expect: { live: { selector: clipSelector('c'), prop: 'x', minDistinct: 4, label: 'c visibly follows during the drag (the ripple is previewed live)' } } },
      { expect: { cursor: { anyOf: TRIM_CURSORS } } },
      { waitFor: clipIs('b', 'duration', 75) },
      { expect: [clipIs('c', 'startFrame', 165), clipUnchanged('c', 'duration'), { path: 'timeline.durationFrames', op: 'eq', value: { ref: 'before.durationFrames', plus: -15 } }] },
      { capture: 'timeline', as: 'gui' },
      ...undoToBefore(['b']),
      { op: 'editor_trim_clip', args: (s) => ({ track: 0, clip: num(s, 'before.clips.b.index'), edge: 'end', delta: TRIM_END_SHORTEN_15, ripple: true }) },
      { waitFor: clipIs('b', 'duration', 75) },
      { expect: [...sameAsGui('b', ROLL_FIELDS), ...sameAsGui('c', ROLL_FIELDS)] },
    ],
  },
  {
    id: 'roll-edit-tool',
    title: 'Roll tool: dragging the a|b cut moves it — a lengthens exactly what b loses, timeline length unchanged',
    area: 'edit tools',
    reference: 'Premiere Rolling Edit tool (N) / Resolve roll: both sides of the edit point move together',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { capture: 'timeline', as: 'before' },
      pickTool('roll'),
      toolActive('roll', 'the Roll tool button did not activate'),
      drag(trimRight('a'), 15, ['a', 'b'], 'roll the a|b cut 15 frames right'),
      { expect: { live: { selector: clipSelector('a'), prop: 'width', minDistinct: 4, label: 'a visibly lengthens during the roll' } } },
      { expect: { live: { selector: clipSelector('b'), prop: 'x', minDistinct: 4, label: 'b’s head visibly moves during the roll' } } },
      { expect: { cursor: { anyOf: TRIM_CURSORS } } },
      { waitFor: clipIs('a', 'duration', 105) },
      {
        expect: [
          clipIs('b', 'startFrame', 105),
          clipIs('b', 'sourceStart', 45),
          clipIs('b', 'duration', 75),
          clipUnchanged('c', 'startFrame'),
          { path: 'timeline.durationFrames', op: 'unchanged', from: 'before' },
        ],
      },
      { capture: 'timeline', as: 'gui' },
      ...undoToBefore(['a', 'b']),
      { op: 'editor_roll_edit', args: (s) => ({ track: 0, clip: num(s, 'before.clips.a.index'), delta: num(s, 'gui.clips.a.end') - num(s, 'before.clips.a.end') }) },
      { waitFor: clipIs('a', 'duration', { ref: 'gui.clips.a.duration' }) },
      { expect: [...sameAsGui('a', ROLL_FIELDS), ...sameAsGui('b', ROLL_FIELDS)] },
    ],
  },
  {
    id: 'roll-smart-trim-alt',
    title: 'Smart trim: Alt-dragging the a|b cut with the Select tool rolls it',
    area: 'edit tools',
    reference: 'Resolve smart trim (trim.jpg) / D-235: at an edit point the context-sensitive trim is a roll',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { capture: 'timeline', as: 'before' },
      drag(trimRight('a'), 15, ['a', 'b'], 'Alt-drag the a|b cut 15 frames right', ['alt']),
      { expect: { live: { selector: clipSelector('b'), prop: 'x', minDistinct: 4, label: 'b’s head visibly moves during the roll' } } },
      { waitFor: clipIs('a', 'duration', 105) },
      { expect: [clipIs('b', 'startFrame', 105), clipIs('b', 'duration', 75), { path: 'timeline.durationFrames', op: 'unchanged', from: 'before' }] },
    ],
  },
  {
    id: 'slip-tool',
    title: 'Slip tool: dragging b changes which source frames it shows — position, length and neighbours fixed',
    area: 'edit tools',
    reference: 'Premiere Slip tool (Y) / Resolve slip: in and out points move together inside a fixed clip',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { capture: 'timeline', as: 'before' },
      pickTool('slip'),
      toolActive('slip', 'the Slip tool button did not activate'),
      drag(clip('b'), 15, ['a', 'b', 'c'], 'slip b by 15 frames', undefined, [SLIP_PICTURE('b')]),
      // H9 / B-345: the clip body stays put while slipping, so what must move
      // live is the PICTURE inside it (the filmstrip tiles slide as the source
      // window moves). Expected to FAIL until redesign P2 builds live slip.
      { expect: { live: { selector: SLIP_PICTURE('b'), prop: 'x', minDistinct: 4, label: 'b’s filmstrip visibly slides inside the clip during the slip' } } },
      { waitFor: { path: 'timeline.clips.b.sourceStart', op: 'in', value: [15, 45] } },
      {
        expect: [
          clipUnchanged('b', 'startFrame'),
          clipUnchanged('b', 'duration'),
          clipUnchanged('a', 'end'),
          clipUnchanged('c', 'startFrame'),
          { path: 'timeline.durationFrames', op: 'unchanged', from: 'before' },
        ],
      },
      { capture: 'timeline', as: 'gui' },
      ...undoToBefore(['b']),
      { op: 'editor_slip_clip', args: (s) => ({ track: 0, clip: num(s, 'before.clips.b.index'), delta: num(s, 'gui.clips.b.sourceStart') - num(s, 'before.clips.b.sourceStart') }) },
      { waitFor: clipIs('b', 'sourceStart', { ref: 'gui.clips.b.sourceStart' }) },
      { expect: sameAsGui('b', ROLL_FIELDS) },
    ],
  },
  {
    id: 'slide-tool',
    title: 'Slide tool: dragging b moves it between its neighbours — a and c absorb the move, timeline length fixed',
    area: 'edit tools',
    reference: 'Premiere Slide tool (U) / Resolve slide: "a slide is a roll between 3 clips"',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { capture: 'timeline', as: 'before' },
      pickTool('slide'),
      toolActive('slide', 'the Slide tool button did not activate'),
      drag(clip('b'), 15, ['a', 'b', 'c'], 'slide b 15 frames right'),
      { expect: { live: { selector: clipSelector('b'), prop: 'x', minDistinct: 4, label: 'b visibly slides during the drag' } } },
      { expect: { live: { selector: clipSelector('a'), prop: 'width', minDistinct: 4, label: 'a visibly lengthens during the slide' } } },
      { waitFor: clipIs('b', 'startFrame', 105) },
      {
        expect: [
          clipUnchanged('b', 'duration'),
          clipUnchanged('b', 'sourceStart'),
          clipIs('a', 'duration', 105),
          clipIs('c', 'startFrame', 195),
          clipIs('c', 'sourceStart', 45),
          clipIs('c', 'duration', 75),
          { path: 'timeline.durationFrames', op: 'unchanged', from: 'before' },
        ],
      },
      { capture: 'timeline', as: 'gui' },
      ...undoToBefore(['a', 'b', 'c']),
      { op: 'editor_slide_clip', args: (s) => ({ track: 0, clip: num(s, 'before.clips.b.index'), delta: num(s, 'gui.clips.b.startFrame') - num(s, 'before.clips.b.startFrame') }) },
      { waitFor: clipIs('b', 'startFrame', { ref: 'gui.clips.b.startFrame' }) },
      { expect: [...sameAsGui('a', ROLL_FIELDS), ...sameAsGui('b', ROLL_FIELDS), ...sameAsGui('c', ROLL_FIELDS)] },
    ],
  },
  {
    id: 'trim-two-up-viewer',
    title: 'While a roll is held, the viewer shows the outgoing and incoming frames side by side',
    area: 'edit tools',
    reference: 'Final Cut Pro two-up viewer during roll/slip; Resolve shows the trim frames in its viewer',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      pickTool('roll'),
      { pointer: { action: 'down', target: trimRight('a') }, label: 'press on the a|b cut' },
      { pointer: { action: 'move', target: atFrame(100, 0) }, label: 'start rolling (button still held)' },
      {
        reachable: {
          selector: `[data-testid="${TIMELINE_TEST_IDS.twoUpViewer}"]`,
          reason: 'no two-up trim viewer: nothing in the preview shows the out/in frames during a roll',
        },
      },
      { pointer: { action: 'up', target: atFrame(100, 0) }, label: 'release' },
    ],
  },
  {
    id: 'razor-blade-tool',
    title: 'A Blade / Razor tool exists: click on a clip to cut it there',
    area: 'edit tools',
    reference: 'Premiere Razor tool (C), Final Cut Blade (B), Resolve Blade Edit mode (B)',
    fixture: THREE_CLIPS,
    steps: [
      {
        reachable: {
          selector: `[data-testid="${TIMELINE_TEST_IDS.trimTool}"][data-chroma-trim-tool="blade"]`,
          reason: 'there is no Blade/Razor tool in the trim palette — cutting is only "split at playhead"',
        },
      },
    ],
  },
  {
    id: 'split-at-playhead-shortcut',
    title: 'Cmd+K splits the selected clip at the playhead',
    area: 'edit tools',
    reference: 'Premiere Add Edit (Cmd+K) / Final Cut Blade at playhead (Cmd+B)',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { capture: 'timeline', as: 'before' },
      { op: 'editor_set_playhead', args: { frame: 135 } },
      { pointer: { action: 'click', target: clip('b', { fy: 0.8 }) }, label: 'select b' },
      { op: 'editor_set_playhead', args: { frame: 135 } },
      { key: { keys: ['meta+KeyK'] }, measure: true },
      { waitFor: { path: 'timeline.tracks.0.length', op: 'eq', value: 4 } },
      { expect: [clipIs('b', 'duration', 45), { path: 'timeline.tracks.0.2.startFrame', op: 'eq', value: 135 }, { path: 'timeline.durationFrames', op: 'unchanged', from: 'before' }] },
      { capture: 'timeline', as: 'gui' },
      { op: 'undo' },
      { waitFor: { path: 'timeline.tracks.0.length', op: 'eq', value: 3 } },
      { op: 'editor_split_clip', args: (s) => ({ track: 0, clip: num(s, 'before.clips.b.index'), atFrame: 135 }) },
      { waitFor: { path: 'timeline.tracks.0.length', op: 'eq', value: 4 } },
      { expect: [{ path: 'timeline.tracks.0.2.startFrame', op: 'eq', value: { ref: 'gui.tracks.0.2.startFrame' } }, ...sameAsGui('b', ROLL_FIELDS)] },
    ],
  },
  {
    id: 'split-toolbar-button',
    title: 'The toolbar Split button splits the selected clip at the playhead',
    area: 'edit tools',
    reference: 'Resolve / Premiere: a split ("add edit") action on the timeline toolbar',
    fixture: THREE_CLIPS,
    steps: [
      FPS_GUARD,
      { pointer: { action: 'click', target: clip('b', { fy: 0.8 }) }, label: 'select b' },
      { op: 'editor_set_playhead', args: { frame: 135 } },
      { pointer: { action: 'click', target: { testid: TIMELINE_TEST_IDS.split } }, label: 'click Split' },
      { waitFor: { path: 'timeline.tracks.0.length', op: 'eq', value: 4 } },
    ],
  },
];
