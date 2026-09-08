// @vitest-environment jsdom
/**
 * @chroma/editor — real-DOM coverage for the timeline curve editor (D-232),
 * built on `testUtils/pointerHarness.ts` (D-142) and modelled on
 * `TimelinePane.fade.dom.test.tsx`.
 *
 * **Why this file exists.** `curveEditor.test.ts` is exhaustive at the pure-
 * geometry level and `clipKeyframesEase.test.ts` at the model level, but
 * neither can prove the thing this feature actually has to get right: that
 * dragging a control handle writes a REAL `ease` curve into the store's own
 * `chroma_keyframes` — the same field the Rust compositor resolves, the
 * exporter compiles and MCP writes — rather than moving a picture around in
 * local component state. That is the exact failure mode a canvas affordance
 * over an existing model invites, so it is asserted here against the real
 * store, through the real `TimelinePane`, with real `PointerEvent`s.
 *
 * It also pins the **one-op-on-pointer-up** convention (`TransformOverlay.tsx`
 * states it in full, D-207's fade handles follow it): the store's `timeline`
 * must be REFERENTIALLY UNCHANGED across every intermediate pointermove and
 * change exactly once on release. A regression to per-move `applyOp` would
 * still look right on screen while pushing one undo entry per pixel dragged,
 * which no unit test would catch.
 *
 * **Tier and its honest limits.** jsdom, not real Chromium — the same
 * disclosure the fade DOM test makes, and for the same reason (no layout
 * engine; `stubOffsetMetrics` fakes one viewport, and the lane's own
 * `ResizeObserver`-measured plot box comes from the stub). It does NOT prove
 * that the drawn curve looks right on a real screen, only that the right
 * numbers reach the model and come back out as the right geometry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  dragPointer,
  firePointerEvent,
  installPointerCaptureStub,
  installResizeObserverStub,
  mount,
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
import { EASE_PRESETS, type Timeline } from './timeline';

const FPS = 24;
const CLIP_FRAMES = 96;

const EASE_IN = EASE_PRESETS[1].curve;

/** One video track, one clip, `opacity` animated 0 -> 1 across its whole
 *  length with a second `scale` animation on top — so the tests can check
 *  that one property's curve edit leaves the other alone. */
function buildFixture(): Timeline {
  return {
    id: 'curve-fixture-tl',
    name: 'curve fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          {
            id: 'v',
            name: 'V',
            source_path: '/v.mp4',
            source_start: 0,
            duration: CLIP_FRAMES,
            source_len: 480,
            start_frame: 0,
            chroma_keyframes: [
              { frame: 0, params: { opacity: 0, scale: 1 } },
              { frame: 48, params: { opacity: 1, scale: 2 } },
            ],
          },
        ],
      },
    ],
  };
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

beforeEach(async () => {
  restoreOffsets = stubOffsetMetrics(1200, 600);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  console_ = captureConsole();

  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: buildFixture(),
      openProjectKey: '/projects/curve-fixture.chroma',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [],
      selectedGap: null,
      curveEditor: null,
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
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: null,
      openProjectKey: null,
      status: 'idle',
      selection: [],
      selectedGap: null,
      curveEditor: null,
    }),
  );
  expect(errors, `console.error fired during the test:\n${errors.map((e) => e.join(' ')).join('\n')}`).toEqual([]);
});

function clipAt(track = 0, index = 0) {
  const clip = useEditorTimelineStore.getState().timeline?.tracks[track]?.clips[index];
  if (!clip) throw new Error(`fixture clip ${track}/${index} is missing`);
  return clip;
}

function openLane(param: 'opacity' | 'scale' = 'opacity') {
  actSync(() => useEditorTimelineStore.getState().setCurveEditor({ track: 0, id: 'v', param }));
}

function lane(): HTMLElement | null {
  return mounted!.container.querySelector('[data-chroma-curve-editor]');
}

function handleEl(which: 1 | 2): HTMLElement {
  const el = mounted!.container.querySelector(`[data-chroma-curve-handle="${which}"]`);
  if (!el) throw new Error(`no control handle ${which} on screen`);
  return el as unknown as HTMLElement;
}

function segmentD(): string | null {
  return mounted!.container.querySelector('[data-chroma-curve-segment="0"]')?.getAttribute('d') ?? null;
}

describe('the timeline curve editor — real DOM, real PointerEvents (D-232)', () => {
  it('1. renders no lane until one is opened, and one when it is', async () => {
    expect(lane()).toBeNull();
    openLane();
    await waitFrames(2);
    expect(lane()).not.toBeNull();
    expect(lane()?.getAttribute('data-chroma-curve-editor')).toBe('opacity');
  });

  it('2. offers a curve button on an ANIMATED clip only', async () => {
    // The button opens a lane; a clip with nothing animated has no curve, and
    // a button that opens an empty lane teaches the user it does nothing.
    expect(mounted!.container.querySelector('[aria-label="Toggle the curve editor for this clip"]')).not.toBeNull();

    actSync(() =>
      useEditorTimelineStore.setState((s) => ({
        timeline: s.timeline
          ? {
              ...s.timeline,
              tracks: [{ ...s.timeline.tracks[0], clips: [{ ...s.timeline.tracks[0].clips[0], chroma_keyframes: undefined }] }],
            }
          : s.timeline,
      })),
    );
    await waitFrames(2);
    expect(mounted!.container.querySelector('[aria-label="Toggle the curve editor for this clip"]')).toBeNull();
  });

  it('3. draws an un-eased segment as a straight LINE, not a curve', async () => {
    openLane();
    await waitFrames(2);
    // The path says what it is — see `segmentPath`'s own doc for why the
    // linear case is not emitted as a diagonal-control-point cubic.
    expect(segmentD()).toMatch(/^M .* L /);
    expect(segmentD()).not.toMatch(/ C /);
  });

  it('4. a preset button writes a REAL ease curve into the store', async () => {
    openLane();
    await waitFrames(2);
    const before = clipAt().chroma_keyframes;

    const easeInBtn = mounted!.container.querySelector('[aria-label="Ease ease-in"]') as HTMLElement;
    actSync(() => easeInBtn.click());
    await waitFrames(2);

    // The real model field the Rust compositor and the exporter both read.
    expect(clipAt().chroma_keyframes?.[0].ease).toEqual({ opacity: EASE_IN });
    expect(clipAt().chroma_keyframes).not.toBe(before);
    // ...and the segment is now drawn as a real cubic.
    expect(segmentD()).toMatch(/ C /);
  });

  it('5. the "linear" preset CLEARS the stored curve rather than storing a straight one', async () => {
    openLane();
    await waitFrames(2);
    actSync(() => (mounted!.container.querySelector('[aria-label="Ease ease-in"]') as HTMLElement).click());
    await waitFrames(2);
    expect(clipAt().chroma_keyframes?.[0].ease).toBeDefined();

    actSync(() => (mounted!.container.querySelector('[aria-label="Ease linear"]') as HTMLElement).click());
    await waitFrames(2);
    // Back to exactly the shape an un-eased key has — no husk left behind.
    expect(clipAt().chroma_keyframes?.[0]).not.toHaveProperty('ease');
  });

  it('6. dragging a control handle writes the real curve, and commits EXACTLY ONCE, on pointer-up', async () => {
    openLane();
    await waitFrames(2);

    const seen: unknown[] = [];
    const unsub = useEditorTimelineStore.subscribe((s) => seen.push(s.timeline));
    const before = useEditorTimelineStore.getState().timeline;

    const el = handleEl(1);
    // Press the handle element directly: jsdom has no layout engine, so this
    // file's subject is the gesture wiring and its committed effect, not the
    // hit test (see the module doc).
    firePointerEvent(el, 'pointerdown', { x: 100, y: 100 }, { pointerId: 7 });
    await waitFrames(1);
    // Intermediate moves: the store must not change at all.
    for (const dx of [10, 20, 30]) {
      firePointerEvent(window, 'pointermove', { x: 100 + dx, y: 120 }, { pointerId: 7 });
      await waitFrames(1);
      expect(useEditorTimelineStore.getState().timeline).toBe(before);
    }
    firePointerEvent(window, 'pointerup', { x: 140, y: 120 }, { pointerId: 7 });
    await waitFrames(2);
    unsub();

    // Exactly one real change to the timeline across the whole gesture.
    const changes = seen.filter((t) => t !== before);
    expect(new Set(changes).size).toBe(1);
    // ...and it is a real curve on the real field.
    const ease = clipAt().chroma_keyframes?.[0].ease?.opacity;
    expect(ease).toBeDefined();
    expect(Number.isFinite(ease!.x1)).toBe(true);
  });

  it('7. Escape abandons a drag with nothing committed', async () => {
    openLane();
    await waitFrames(2);
    const before = useEditorTimelineStore.getState().timeline;

    firePointerEvent(handleEl(1), 'pointerdown', { x: 100, y: 100 }, { pointerId: 8 });
    await waitFrames(1);
    firePointerEvent(window, 'pointermove', { x: 160, y: 60 }, { pointerId: 8 });
    await waitFrames(1);
    actSync(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    await waitFrames(1);
    firePointerEvent(window, 'pointerup', { x: 160, y: 60 }, { pointerId: 8 });
    await waitFrames(2);

    expect(useEditorTimelineStore.getState().timeline).toBe(before);
    expect(clipAt().chroma_keyframes?.[0]).not.toHaveProperty('ease');
  });

  it('8. editing one property\'s curve leaves the other property alone', async () => {
    openLane('opacity');
    await waitFrames(2);
    actSync(() => (mounted!.container.querySelector('[aria-label="Ease ease-in"]') as HTMLElement).click());
    await waitFrames(2);

    const key0 = clipAt().chroma_keyframes?.[0];
    expect(key0?.ease).toEqual({ opacity: EASE_IN });
    // `scale` is still animated, still un-eased, and its VALUES are untouched.
    expect(key0?.params).toEqual({ opacity: 0, scale: 1 });
    expect(clipAt().chroma_keyframes?.[1].params).toEqual({ opacity: 1, scale: 2 });
  });

  it('9. the lane closes itself when its property stops being animated', async () => {
    // Turning the Inspector's stopwatch off while the curve is open must not
    // leave a lane pointing at an animation that no longer exists.
    openLane();
    await waitFrames(2);
    expect(lane()).not.toBeNull();

    actSync(() =>
      useEditorTimelineStore.setState((s) => ({
        timeline: s.timeline
          ? {
              ...s.timeline,
              tracks: [{ ...s.timeline.tracks[0], clips: [{ ...s.timeline.tracks[0].clips[0], chroma_keyframes: undefined }] }],
            }
          : s.timeline,
      })),
    );
    await waitFrames(2);
    expect(lane()).toBeNull();
  });

  it('10. a locked track draws the curve but offers no drag', async () => {
    actSync(() =>
      useEditorTimelineStore.setState((s) => ({
        timeline: s.timeline
          ? { ...s.timeline, tracks: [{ ...s.timeline.tracks[0], locked: true }] }
          : s.timeline,
      })),
    );
    openLane();
    await waitFrames(2);
    expect(lane()).not.toBeNull();
    expect(segmentD()).not.toBeNull();

    const before = useEditorTimelineStore.getState().timeline;
    await dragPointer(handleEl(1), [{ x: 100, y: 100 }, { x: 130, y: 80 }, { x: 160, y: 60 }]);
    await waitFrames(2);
    expect(useEditorTimelineStore.getState().timeline).toBe(before);
  });
});
