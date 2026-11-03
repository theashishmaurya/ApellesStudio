// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for the context-sensitive trim tool
 * (D-235, roadmap item 27), built on `testUtils/pointerHarness.ts` (D-142) and
 * modelled on `TimelinePane.fade.dom.test.tsx`.
 *
 * **Why this file exists.** `trimMode.test.ts` is exhaustive at the pure level
 * — every branch of the mode rule, every op it builds, and the two decision
 * functions the pane's handlers are adapters over. What it cannot prove is the
 * part that only exists once the component is really mounted: that a real
 * Alt-held `PointerEvent` drag on a real clip body reaches the store as a real
 * `slip`/`slide` op on the right clip, and that the mode readout an editor
 * actually reads before pressing agrees with the op that would fire. Both are
 * asserted here against the real store, through the real `TimelinePane`, with
 * real `PointerEvent`s.
 *
 * **Tier and its honest limits — read before adding to this file.**
 *
 * 1. jsdom, not real Chromium: the same disclosure the marquee and fade DOM
 *    tests both make. `stubOffsetMetrics` fakes one viewport and
 *    `stubBoundingRectsFromInlineStyle` derives each clip's box from the inline
 *    `left`/`width`/`height` the timeline library really writes, which is what
 *    makes the slip-vs-slide vertical band a real geometric question here
 *    rather than a constant.
 *
 * 2. **The EDGE drags (ripple and roll) are deliberately NOT driven from
 *    pointer events here, because they cannot be.** Those gestures are owned by
 *    `@xzdarcy/react-timeline-editor`'s interact.js resize, which does not run
 *    under jsdom at all — established directly while building this, not
 *    assumed: a full, correctly-targeted `PointerEvent` sequence on the
 *    library's own right-stretch handle (with real
 *    rects and real `pageX`/`pageY`) commits nothing, and that is equally true
 *    of the plain pre-D-235 trim, which has never been drivable in this tier
 *    either. (D-432 P2 replaced that resize with Apelles' own edge gesture,
 *    which jsdom does drive: `TimelinePane.clipBlock.dom.test.tsx` covers the
 *    edge edits end to end.)
 *    What this file adds for those two modes is the half jsdom CAN answer: that
 *    hovering the real edge handles resolves to Roll and Ripple in the real
 *    component, through the same `resolveTrimMode`/`edgeIsEditPoint` call the
 *    commit path uses. Do not "fix" this by faking a library callback — that
 *    would assert the adapter against itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  firePointerEvent,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
  nextFrame,
  stubBoundingRectsFromInlineStyle,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_clip_thumbnails: () => [],
    chroma_audio_waveform: () => [],
    chroma_timeline_set: () => undefined,
  }),
}));

import { useEditorTimelineStore } from './timelineStore';
import { TimelinePane } from './TimelinePane';
import { TRIM_ARM_HINT } from './trimMode';
import { GESTURE_CURSOR_TEST_ID } from './gestureCursor';
import type { Timeline } from './timeline';

const FPS = 24;
const PX_PER_SEC = 90; // DEFAULT_PX_PER_SEC, as `TimelinePane.tsx` defines it
const ROW_HEIGHT_PX = 52; // the library's own rendered action height
/** Frames per pixel of horizontal drag, at the default zoom: 90px == 1s == 24f. */
const framesFor = (px: number) => Math.round((px / PX_PER_SEC) * FPS);

// Fixture: three 48-frame clips butted end to end on one video track, each
// showing a 48-frame window out of a 480-frame source starting at frame 100 —
// so every clip has real source room on BOTH sides and any of the four modes
// has somewhere to go.
//   'a' [0,48)   'b' [48,96)   'c' [96,144)
const CLIP_FRAMES = 48;

function clipFixture(id: string, start: number) {
  return {
    id,
    name: id.toUpperCase(),
    source_path: `/${id}.mp4`,
    source_start: 100,
    duration: CLIP_FRAMES,
    source_len: 480,
    start_frame: start,
  };
}

function buildFixture(): Timeline {
  return {
    id: 'trim-fixture-tl',
    name: 'trim fixture',
    rate: { num: FPS, den: 1 },
    tracks: [{ kind: 'video', clips: [clipFixture('a', 0), clipFixture('b', 48), clipFixture('c', 96)] }],
  };
}

let restore: Array<() => void> = [];
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

beforeEach(async () => {
  restore = [
    stubOffsetMetrics(1200, 600),
    installResizeObserverStub(),
    installPointerCaptureStub(),
    stubBoundingRectsFromInlineStyle(),
  ];
  console_ = captureConsole();

  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: buildFixture(),
      openProjectKey: '/projects/trim-fixture.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
    }),
  );

  mounted = mount(React.createElement(TimelinePane), { strictMode: true });
  await waitFrames(2);
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  for (const r of restore) r();
  restore = [];
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: null,
      openProjectKey: null,
      status: 'idle',
      selection: [],
      selectedGap: null,
    }),
  );
  expect(errors, `console.error fired during the test:\n${errors.map((e) => e.join(' ')).join('\n')}`).toEqual([]);
});

/** The rendered clip bodies, in track order — index 0 is 'a'. */
function bodies(): HTMLElement[] {
  return Array.from(mounted!.container.querySelectorAll('[data-chroma-clip-drag]'));
}

function clips() {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('fixture timeline is gone');
  return tl.tracks[0].clips;
}

/** Each clip's source window by id: what a slip or a slide changes and a plain move does not. */
function sourceWindows(list: readonly { id: string; source_start: number; duration: number }[]) {
  return Object.fromEntries(list.map((c) => [c.id, { source_start: c.source_start, duration: c.duration }]));
}

function clipById(id: string) {
  const c = clips().find((x) => x.id === id);
  if (!c) throw new Error(`no clip ${id}`);
  return c;
}

/** A real pointer drag on a clip BODY. dnd-kit listens on the owning document
 *  (not `window`, where this pane's own fade/marquee listeners live), so the
 *  moves are dispatched there — established by probe while building this, and
 *  the reason the harness's default `moveTarget` is overridden. */
async function bodyDrag(el: HTMLElement, fromX: number, toX: number, y: number, opts: Record<string, boolean> = {}) {
  firePointerEvent(el, 'pointerdown', { x: fromX, y }, opts);
  await nextFrame();
  const step = (toX - fromX) / 4;
  for (let i = 1; i <= 4; i++) {
    firePointerEvent(document, 'pointermove', { x: fromX + step * i, y }, opts);
    await nextFrame();
  }
  firePointerEvent(document, 'pointerup', { x: toX, y }, opts);
  await nextFrame();
}

/** Hold / release Alt, the smart-trim arm. */
async function setAlt(down: boolean) {
  actSync(() => {
    window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', { key: 'Alt', altKey: down, bubbles: true }));
  });
  await nextFrame();
}

function hintText(): string | null {
  return mounted!.container.querySelector('[data-chroma-trim-hint]')?.textContent ?? null;
}

// --------------------------------------------------------------------------- //
// the armed BODY drags — slip and slide, end to end
// --------------------------------------------------------------------------- //

describe('armed body drag — real DOM, real PointerEvents (D-235)', () => {
  it('1. an UNARMED body drag never slips or slides — the plain gesture is untouched', async () => {
    // The regression this feature must not cause, stated as what is actually
    // provable in this tier: an unarmed drag NEVER slips or slides.
    //
    // It deliberately does not assert where the clip lands: whether dnd-kit
    // resolves a drop target under jsdom depends on the rect stub (since D-437
    // S8 the drop zones sit inside the lanes' content box, whose inline size
    // the stub reads, so a plain move may really land). What matters here is
    // that the identical gesture minus the Alt key leaves every clip's source
    // window and duration exactly as they were — i.e. it did not fall into
    // either armed branch (a slip changes `source_start`, a slide a
    // neighbour's `duration`).
    const before = sourceWindows(clips());

    await bodyDrag(bodies()[1], 200, 290, 26);

    expect(sourceWindows(clips())).toEqual(before);
  });

  it('2. Alt + drag on the UPPER half of a clip slips it — new source window, same position', async () => {
    const y = ROW_HEIGHT_PX * 0.25; // over the thumbnails: Resolve's own slip zone
    await bodyDrag(bodies()[1], 200, 290, y, { altKey: true });

    const b = clipById('b');
    // The source window moved by the drag…
    expect(b.source_start).toBe(100 + framesFor(90));
    // …and NOTHING about the clip's place on the timeline did. That pair is the
    // entire definition of a slip.
    expect(b.start_frame).toBe(48);
    expect(b.duration).toBe(CLIP_FRAMES);
    expect(clipById('a').start_frame).toBe(0);
    expect(clipById('a').duration).toBe(CLIP_FRAMES);
    expect(clipById('c').start_frame).toBe(96);
    expect(clipById('c').duration).toBe(CLIP_FRAMES);
  });

  it('3. Alt + drag on the LOWER half of the same clip slides it — neighbours absorb the move', async () => {
    const y = ROW_HEIGHT_PX * 0.75; // under the thumbnails: Resolve's own slide zone
    await bodyDrag(bodies()[1], 200, 290, y, { altKey: true });

    const shift = framesFor(90);
    const b = clipById('b');
    // The clip moved, but is unchanged in every other respect…
    expect(b.start_frame).toBe(48 + shift);
    expect(b.duration).toBe(CLIP_FRAMES);
    expect(b.source_start).toBe(100);
    // …because its neighbours gave and took the difference.
    expect(clipById('a').duration).toBe(CLIP_FRAMES + shift);
    expect(clipById('c').start_frame).toBe(96 + shift);
    expect(clipById('c').duration).toBe(CLIP_FRAMES - shift);
    expect(clipById('c').source_start).toBe(100 + shift);
  });

  it('4. one press, one op — the store is untouched until release', async () => {
    // The convention `TransformOverlay.tsx` states in full and every gesture on
    // this pane keeps: `applyOp` snapshots the whole timeline onto the undo
    // stack per call, so a per-move commit is one undo entry per pixel dragged.
    const before = useEditorTimelineStore.getState().timeline;
    const y = ROW_HEIGHT_PX * 0.25;

    firePointerEvent(bodies()[1], 'pointerdown', { x: 200, y }, { altKey: true });
    await nextFrame();
    for (const x of [220, 250, 280]) {
      firePointerEvent(document, 'pointermove', { x, y }, { altKey: true });
      await nextFrame();
      expect(
        useEditorTimelineStore.getState().timeline,
        'the store changed mid-drag — a slip must be local until release',
      ).toBe(before);
    }
    firePointerEvent(document, 'pointerup', { x: 280, y }, { altKey: true });
    await nextFrame();

    expect(useEditorTimelineStore.getState().timeline).not.toBe(before);
    expect(clipById('b').source_start).toBe(100 + framesFor(80));
  });

  it('5. a slip is clamped by the source media and never silently overruns it', async () => {
    // 'b' shows [100,148) of a 480-frame source, so it can slip at most 332
    // frames later. Dragging far past that must land exactly on the bound.
    const y = ROW_HEIGHT_PX * 0.25;
    await bodyDrag(bodies()[1], 200, 1900, y, { altKey: true });

    expect(clipById('b').source_start).toBe(480 - CLIP_FRAMES);
    expect(clipById('b').duration).toBe(CLIP_FRAMES);
    expect(clipById('b').start_frame).toBe(48);
  });

  it('6. an armed drag selects the clip it edited, like every other drag here', async () => {
    await bodyDrag(bodies()[1], 200, 260, ROW_HEIGHT_PX * 0.25, { altKey: true });
    expect(useEditorTimelineStore.getState().selection).toEqual([{ track: 0, id: 'b' }]);
  });
});

// --------------------------------------------------------------------------- //
// the mode readout — the hover affordance, for all four modes
// --------------------------------------------------------------------------- //

describe('mode readout — what the editor sees before pressing (D-235)', () => {
  it('7. is absent entirely until the tool is armed', async () => {
    expect(hintText()).toBeNull();
    await setAlt(true);
    expect(hintText()).toBe('Trim: hover a clip');
    await setAlt(false);
    expect(hintText()).toBeNull();
  });

  it('8. reads Slip over a clip’s upper half and Slide over its lower half', async () => {
    await setAlt(true);
    const action = bodies()[1].closest('[data-testid="timeline-clip-slot"]') as HTMLElement;

    firePointerEvent(action, 'pointermove', { x: 200, y: ROW_HEIGHT_PX * 0.2 }, { altKey: true });
    await nextFrame();
    expect(hintText()).toBe('Slip');

    firePointerEvent(action, 'pointermove', { x: 200, y: ROW_HEIGHT_PX * 0.8 }, { altKey: true });
    await nextFrame();
    expect(hintText()).toBe('Slide');
  });

  it('9. reads Roll on an edge that is a real edit point', async () => {
    await setAlt(true);
    // 'b' touches a clip on both sides, so both of its handles are edit points.
    const action = bodies()[1].closest('[data-testid="timeline-clip-slot"]') as HTMLElement;
    const right = action.querySelector('[data-chroma-trim-edge="end"]') as HTMLElement;
    const left = action.querySelector('[data-chroma-trim-edge="start"]') as HTMLElement;
    expect(right, 'the clip did not render its own edge-trim zones').not.toBeNull();

    firePointerEvent(right, 'pointermove', { x: 199, y: 26 }, { altKey: true });
    await nextFrame();
    expect(hintText()).toBe('Roll');

    firePointerEvent(left, 'pointermove', { x: 21, y: 26 }, { altKey: true });
    await nextFrame();
    expect(hintText()).toBe('Roll');
  });

  it('10. reads Ripple on a FREE edge, where there is no edit point to roll', async () => {
    await setAlt(true);
    // 'a' starts the track; 'c' ends it. Neither of those outer edges touches
    // anything, so neither can roll.
    const first = bodies()[0].closest('[data-testid="timeline-clip-slot"]') as HTMLElement;
    const last = bodies()[2].closest('[data-testid="timeline-clip-slot"]') as HTMLElement;

    firePointerEvent(first.querySelector('[data-chroma-trim-edge="start"]')!, 'pointermove', { x: 21, y: 26 }, { altKey: true });
    await nextFrame();
    expect(hintText()).toBe('Ripple');

    firePointerEvent(last.querySelector('[data-chroma-trim-edge="end"]')!, 'pointermove', { x: 559, y: 26 }, { altKey: true });
    await nextFrame();
    expect(hintText()).toBe('Ripple');
  });

  it('11. Shift forces Ripple at an edit point, where Roll would otherwise win', async () => {
    await setAlt(true);
    const right = bodies()[1]
      .closest('[data-testid="timeline-clip-slot"]')!
      .querySelector('[data-chroma-trim-edge="end"]') as HTMLElement;

    firePointerEvent(right, 'pointermove', { x: 199, y: 26 }, { altKey: true, shiftKey: true });
    await nextFrame();
    expect(hintText()).toBe('Ripple');
  });

  it('12. falls back to the un-hovered text off a clip, and clears when the tool is disarmed', async () => {
    await setAlt(true);
    const action = bodies()[1].closest('[data-testid="timeline-clip-slot"]') as HTMLElement;
    firePointerEvent(action, 'pointermove', { x: 200, y: ROW_HEIGHT_PX * 0.2 }, { altKey: true });
    await nextFrame();
    expect(hintText()).toBe('Slip');

    // Somewhere on the edit area that is not a clip at all.
    const area = mounted!.container.querySelector('[data-testid="timeline-edit-area"]') as HTMLElement;
    firePointerEvent(area, 'pointermove', { x: 900, y: 300 }, { altKey: true });
    await nextFrame();
    expect(hintText()).toBe('Trim: hover a clip');

    await setAlt(false);
    expect(hintText()).toBeNull();
  });
});

// --------------------------------------------------------------------------- //
// D-250 — the affordance AT THE POINTER, and the unarmed hint that teaches
// the arm key exists at all
// --------------------------------------------------------------------------- //

/** The pointer-adjacent badge, or `null` when it is not showing. `hidden` is
 *  how it is suppressed (it stays mounted so its own width can be measured for
 *  the edge clamp), so a hidden badge must read as absent here. */
function badge(): HTMLElement | null {
  const el = mounted!.container.querySelector<HTMLElement>('[data-chroma-trim-badge]');
  return el && !el.hidden ? el : null;
}

function editArea(): HTMLElement {
  return mounted!.container.querySelector('[data-testid="timeline-edit-area"]') as HTMLElement;
}

describe('pointer-adjacent mode badge (D-250)', () => {
  it('13. does not show until the tool is armed AND the pointer is over a clip', async () => {
    const action = bodies()[1].closest('[data-testid="timeline-clip-slot"]') as HTMLElement;

    // Unarmed, over a clip: nothing. The plain gestures are untouched, so
    // there is nothing to announce.
    firePointerEvent(action, 'pointermove', { x: 200, y: ROW_HEIGHT_PX * 0.2 });
    await nextFrame();
    expect(badge()).toBeNull();

    // Armed but not over a clip: still nothing AT THE POINTER — there is no
    // resolved mode to name. (The toolbar readout covers that state; see 12.)
    await setAlt(true);
    firePointerEvent(editArea(), 'pointermove', { x: 900, y: 300 }, { altKey: true });
    await nextFrame();
    expect(badge()).toBeNull();

    // Armed, over a clip: the badge.
    firePointerEvent(action, 'pointermove', { x: 200, y: ROW_HEIGHT_PX * 0.2 }, { altKey: true });
    await nextFrame();
    expect(badge()).not.toBeNull();
  });

  it('14. names each of the four modes, and says what each one does', async () => {
    await setAlt(true);
    const action = bodies()[1].closest('[data-testid="timeline-clip-slot"]') as HTMLElement;
    const first = bodies()[0].closest('[data-testid="timeline-clip-slot"]') as HTMLElement;

    // Every case mirrors one row of D-235's own mode table, so a change to the
    // rule that this badge did not follow shows up here as a failure.
    const cases: Array<[HTMLElement, { x: number; y: number }, Record<string, boolean>, string, string]> = [
      [action, { x: 200, y: ROW_HEIGHT_PX * 0.2 }, {}, 'Slip', 'change what is shown'],
      [action, { x: 200, y: ROW_HEIGHT_PX * 0.8 }, {}, 'Slide', 'neighbours absorb it'],
      [
        action.querySelector('[data-chroma-trim-edge="end"]') as HTMLElement,
        { x: 199, y: 26 },
        {},
        'Roll',
        'both clips keep their length',
      ],
      [
        first.querySelector('[data-chroma-trim-edge="start"]') as HTMLElement,
        { x: 21, y: 26 },
        {},
        'Ripple',
        'push everything after it',
      ],
      [
        action.querySelector('[data-chroma-trim-edge="end"]') as HTMLElement,
        { x: 199, y: 26 },
        { shiftKey: true },
        'Ripple',
        'push everything after it',
      ],
    ];

    for (const [target, at, mods, label, gloss] of cases) {
      firePointerEvent(target, 'pointermove', at, { altKey: true, ...mods });
      await nextFrame();
      const text = badge()?.textContent ?? '';
      expect(text, `${label} badge`).toContain(label);
      // The name alone is not an affordance for someone who does not already
      // know slip from slide — the gloss is the half that teaches it.
      expect(text, `${label} gloss`).toContain(gloss);
    }
  });

  it('15. agrees with the toolbar readout, because both read one resolution', async () => {
    await setAlt(true);
    const action = bodies()[1].closest('[data-testid="timeline-clip-slot"]') as HTMLElement;

    firePointerEvent(action, 'pointermove', { x: 200, y: ROW_HEIGHT_PX * 0.8 }, { altKey: true });
    await nextFrame();
    // D-235's whole reason for computing its hint from `resolveTrimMode`: a
    // hint that could promise an edit the press would not make is worse than
    // no hint. Two hints that could disagree with each OTHER would be worse
    // still, so this pins them to one answer.
    expect(hintText()).toBe('Slide');
    expect(badge()?.textContent ?? '').toContain('Slide');
  });

  it('16. follows the pointer, and swaps the cursor with the mode', async () => {
    await setAlt(true);
    const action = bodies()[1].closest('[data-testid="timeline-clip-slot"]') as HTMLElement;

    firePointerEvent(action, 'pointermove', { x: 200, y: ROW_HEIGHT_PX * 0.2 }, { altKey: true });
    await nextFrame();
    const near = badge()!.style.transform;

    firePointerEvent(action, 'pointermove', { x: 260, y: ROW_HEIGHT_PX * 0.2 }, { altKey: true });
    await nextFrame();
    expect(
      badge()!.style.transform,
      'the badge must track the pointer — a fixed position is the toolbar readout again',
    ).not.toBe(near);

    // The cursor half of the same affordance (D-250; D-432 §5.1 keywords): a
    // body mode slides the clip or its content (`ew-resize`), an edge mode is
    // a trim zone (`col-resize`).
    expect(editArea().style.cursor).toBe('ew-resize');
    const right = action.querySelector('[data-chroma-trim-edge="end"]') as HTMLElement;
    firePointerEvent(right, 'pointermove', { x: 199, y: 26 }, { altKey: true });
    await nextFrame();
    expect(editArea().style.cursor).toBe('col-resize');

    // Disarming puts every cursor on this surface back exactly as it was.
    await setAlt(false);
    expect(editArea().style.cursor).toBe('');
  });

  it('17. every clip carries the hint that the arm key exists at all', async () => {
    // The gap the owner actually hit: with nothing held, D-235's four edits
    // had no on-screen sign anywhere that a key would reach them. This is the
    // unarmed half of the affordance, and it belongs on the clips themselves —
    // the thing the gesture acts on.
    for (const body of bodies()) {
      expect(body.getAttribute('title')).toBe(TRIM_ARM_HINT);
    }
    expect(TRIM_ARM_HINT).toMatch(/Option|Alt/);
    for (const mode of ['roll', 'ripple', 'slip', 'slide']) {
      expect(TRIM_ARM_HINT.toLowerCase()).toContain(mode);
    }
  });
});

// --------------------------------------------------------------------------- //
// B-123 — the LATE-MOUNT regression: the edit area does not exist yet when the
// pane first commits.
// --------------------------------------------------------------------------- //

describe('B-123 — the smart trim tool survives a late-mounted edit area', () => {
  // WHY THIS BLOCK EXISTS, and why all 17 tests above it passed while the
  // feature was completely dead in the real app.
  //
  // Every other test in this file — and the whole real-Chromium harness tier,
  // and D-235's own verification — seeds a POPULATED timeline before mounting
  // `TimelinePane`. On that order the edit-area node exists on the very first
  // commit, so the pane's `[]`-dependency effects find it and bind their
  // native listeners. Nothing in that order can observe the bug.
  //
  // The real app does the opposite. `TimelinePane` early-returns the "Empty
  // timeline — drag a clip from Sources to get started" placeholder whenever
  // `tracks.length === 0`, which is exactly what a freshly created project
  // has. The effects ran once against nothing and never re-ran, so the edit
  // area mounted — for the rest of the session — with no capture-phase
  // `pointerdown` listener. `trimPressRef` stayed `null`, every gesture
  // resolved UNARMED, and Alt+drag silently fell back to the plain move it has
  // always been, while the badge and cursor (React props, bound with the JSX)
  // kept correctly announcing "Slip".
  //
  // So this block mounts in the REAL APP'S order. It is the only test in this
  // file that fails without B-123's fix.
  it('18. an Alt body drag still SLIPS when the timeline starts empty and gains its clips later', async () => {
    // Re-mount over a timeline that has NO tracks: the pane renders its
    // placeholder and the edit area genuinely is not in the DOM.
    actSync(() =>
      useEditorTimelineStore.setState({
        timeline: { id: 'late-tl', name: 'late', rate: { num: FPS, den: 1 }, tracks: [] },
      }),
    );
    mounted?.unmount();
    mounted = mount(React.createElement(TimelinePane), { strictMode: true });
    await waitFrames(2);
    expect(mounted.container.querySelector('[data-testid="timeline-edit-area"]')).toBeNull();

    // Now the clips arrive, exactly as the first drag from Sources delivers them.
    actSync(() => useEditorTimelineStore.setState({ timeline: buildFixture() }));
    await waitFrames(2);
    expect(mounted.container.querySelector('[data-testid="timeline-edit-area"]')).not.toBeNull();

    const before = clipById('a').source_start;
    await setAlt(true);
    // Upper band of clip 'a' — Resolve's over-the-thumbnails half, so: slip.
    await bodyDrag(bodies()[0], 20, 50, 8, { altKey: true });
    await setAlt(false);

    // The assertion that fails without the fix: the drag committed a real
    // slip, which is only possible if the capture-phase press listener was
    // actually bound to the node that mounted late.
    expect(clipById('a').source_start).not.toBe(before);
    // A slip never moves the clip — this is what separates it from the move
    // the broken build silently did instead.
    expect(clipById('a').start_frame).toBe(0);
  });
});

// --------------------------------------------------------------------------- //
// the release frame's own cost — B-374 (D-437 S11)
// --------------------------------------------------------------------------- //

describe('the release does no page-wide work (B-374)', () => {
  const layer = () => document.querySelector<HTMLElement>(`[data-testid="${GESTURE_CURSOR_TEST_ID}"]`);

  it('19. shows the gesture cursor on one layer, never as a style on the edit area', async () => {
    const y = ROW_HEIGHT_PX * 0.25;
    const area = mounted!.container.querySelector<HTMLElement>('[data-testid="timeline-edit-area"]')!;
    firePointerEvent(bodies()[1], 'pointerdown', { x: 200, y }, { altKey: true });
    await nextFrame();
    firePointerEvent(document, 'pointermove', { x: 230, y }, { altKey: true });
    await nextFrame();

    expect(layer(), 'the gesture shows its cursor on the full-window layer').not.toBeNull();
    expect(layer()!.hidden).toBe(false);
    expect(layer()!.style.cursor).toBe('ew-resize');
    // The marker stays (the pane reads it), but no stylesheet rule names it
    // (`timelineOverrides.test.ts`), so toggling it restyles nothing.
    expect(area.dataset.chromaEditGesture).toBe('slip');

    firePointerEvent(document, 'pointerup', { x: 230, y }, { altKey: true });
    await nextFrame();
    expect(layer()!.hidden).toBe(true);
    expect(area.dataset.chromaEditGesture).toBeUndefined();
  });

  it('20. swallows the click the release itself produces, and only that one', async () => {
    const y = ROW_HEIGHT_PX * 0.25;
    firePointerEvent(bodies()[1], 'pointerdown', { x: 200, y }, { altKey: true });
    await nextFrame();
    firePointerEvent(document, 'pointermove', { x: 260, y }, { altKey: true });
    await nextFrame();

    let selectionWrites = 0;
    const unsub = useEditorTimelineStore.subscribe((s, prev) => {
      if (s.selection !== prev.selection) selectionWrites += 1;
    });
    // A native release: pointerup, then click, in one task.
    actSync(() => {
      firePointerEvent(document, 'pointerup', { x: 260, y }, { altKey: true });
      bodies()[1].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 260, clientY: y }));
    });
    unsub();
    expect(clipById('b').source_start, 'the slip committed').toBe(100 + framesFor(60));
    expect(selectionWrites, 'the edit selects its clip once; the release click must not select it again').toBe(1);
    expect(useEditorTimelineStore.getState().selection).toEqual([{ track: 0, id: 'b' }]);

    // A real click in a later task is a click again.
    await nextFrame();
    actSync(() => useEditorTimelineStore.setState({ selection: [] }));
    actSync(() => {
      bodies()[0].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, clientX: 20, clientY: y }));
    });
    expect(useEditorTimelineStore.getState().selection).toEqual([{ track: 0, id: 'a' }]);
  });

  it('21. a pane unmounted mid-gesture takes its cursor layer down with it', async () => {
    const y = ROW_HEIGHT_PX * 0.25;
    firePointerEvent(bodies()[1], 'pointerdown', { x: 200, y }, { altKey: true });
    await nextFrame();
    expect(layer()!.hidden).toBe(false);
    mounted!.unmount();
    mounted = null;
    expect(layer()!.hidden, 'a visible full-window layer would swallow every click in the app').toBe(true);
  });
});
