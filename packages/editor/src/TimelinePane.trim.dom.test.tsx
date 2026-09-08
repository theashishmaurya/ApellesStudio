// @vitest-environment jsdom
/**
 * @chroma/editor — real-DOM coverage for the context-sensitive trim tool
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
 *    library's own `.timeline-editor-action-right-stretch` handle (with real
 *    rects and real `pageX`/`pageY`) commits nothing, and that is equally true
 *    of the plain pre-D-235 trim, which has never been drivable in this tier
 *    either. Rather than leave that path covered by nothing, the decision it
 *    turns on was extracted to `resizeEndOp` (pure, and tested to the branch in
 *    `trimMode.test.ts`), leaving `onActionResizeEndCb` as a two-line adapter.
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
    // It deliberately does not assert where the clip lands. dnd-kit resolves
    // no drop target at all under jsdom (its collision detection never yields
    // an `over`), so the pre-existing move path cannot be driven here — the
    // same gap `TimelinePane.marquee.dom.test.tsx` discloses about dnd-kit,
    // and it predates this pass. What IS driven, and what matters here, is
    // that the identical gesture minus the Alt key leaves every clip's source
    // window and every neighbour's duration exactly as they were — i.e. it
    // did not fall into either armed branch.
    const before = clips().map((c) => ({ ...c }));

    await bodyDrag(bodies()[1], 200, 290, 26);

    expect(clips()).toEqual(before);
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
    const action = bodies()[1].closest('.timeline-editor-action') as HTMLElement;

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
    const action = bodies()[1].closest('.timeline-editor-action') as HTMLElement;
    const right = action.querySelector('.timeline-editor-action-right-stretch') as HTMLElement;
    const left = action.querySelector('.timeline-editor-action-left-stretch') as HTMLElement;
    expect(right, 'the library did not render its own edge handles').not.toBeNull();

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
    const first = bodies()[0].closest('.timeline-editor-action') as HTMLElement;
    const last = bodies()[2].closest('.timeline-editor-action') as HTMLElement;

    firePointerEvent(first.querySelector('.timeline-editor-action-left-stretch')!, 'pointermove', { x: 21, y: 26 }, { altKey: true });
    await nextFrame();
    expect(hintText()).toBe('Ripple');

    firePointerEvent(last.querySelector('.timeline-editor-action-right-stretch')!, 'pointermove', { x: 559, y: 26 }, { altKey: true });
    await nextFrame();
    expect(hintText()).toBe('Ripple');
  });

  it('11. Shift forces Ripple at an edit point, where Roll would otherwise win', async () => {
    await setAlt(true);
    const right = bodies()[1]
      .closest('.timeline-editor-action')!
      .querySelector('.timeline-editor-action-right-stretch') as HTMLElement;

    firePointerEvent(right, 'pointermove', { x: 199, y: 26 }, { altKey: true, shiftKey: true });
    await nextFrame();
    expect(hintText()).toBe('Ripple');
  });

  it('12. falls back to the un-hovered text off a clip, and clears when the tool is disarmed', async () => {
    await setAlt(true);
    const action = bodies()[1].closest('.timeline-editor-action') as HTMLElement;
    firePointerEvent(action, 'pointermove', { x: 200, y: ROW_HEIGHT_PX * 0.2 }, { altKey: true });
    await nextFrame();
    expect(hintText()).toBe('Slip');

    // Somewhere on the edit area that is not a clip at all.
    const area = mounted!.container.querySelector('[data-bench-id="timeline-edit-area"]') as HTMLElement;
    firePointerEvent(area, 'pointermove', { x: 900, y: 300 }, { altKey: true });
    await nextFrame();
    expect(hintText()).toBe('Trim: hover a clip');

    await setAlt(false);
    expect(hintText()).toBeNull();
  });
});
