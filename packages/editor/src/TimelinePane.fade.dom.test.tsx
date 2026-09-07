// @vitest-environment jsdom
/**
 * @chroma/editor — real-DOM regression coverage for the timeline's on-clip
 * fade handles (D-207), built on `testUtils/pointerHarness.ts` (D-142) and
 * modelled on `TimelinePane.marquee.dom.test.tsx`.
 *
 * **Why this file exists.** `clipFade.test.ts` is exhaustive at the pure-
 * function level (frames↔px, the drag clamp, the curve path geometry), but it
 * cannot prove the thing that actually matters about this feature: that
 * dragging a handle writes the REAL `fade_in_frames`/`fade_out_frames` field
 * on the store's clip — the same field the Inspector's numeric Fade control,
 * MCP's `set_clip_fade`, the compositor and the exporter all read — rather
 * than moving a picture around in local component state. That is the exact
 * failure mode a canvas affordance over an existing model invites, so it is
 * asserted here against the real store, through the real `TimelinePane`, with
 * real `PointerEvent`s.
 *
 * It also pins the **one-op-on-pointer-up** convention (`TransformOverlay.tsx`
 * states it in full): the store's `timeline` must be REFERENTIALLY UNCHANGED
 * across every intermediate pointermove, and change exactly once on release.
 * A regression to per-move `applyOp` would still look right on screen while
 * pushing one undo entry per pixel of drag, which no unit test would catch.
 *
 * **Tier and its honest limits.** jsdom, not real Chromium — the same
 * disclosure `TimelinePane.marquee.dom.test.tsx` makes, and for the same
 * reason (no layout engine; `stubOffsetMetrics` fakes one viewport). It does
 * NOT prove hit-testing: that a press at a clip's top-left corner reaches the
 * fade handle rather than the timeline library's own full-height edge-trim
 * handle underneath it is a paint-order/geometry question jsdom cannot answer,
 * and is covered by the interactive tier. Every drag below therefore presses
 * the handle ELEMENT directly, which is what the gesture wiring itself owns.
 * That is deliberate, and it is why this file's own subject is the gesture and
 * its committed effect, not the hit test.
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
import { FADE_PRESETS, type Timeline } from './timeline';

const FPS = 24;
const PX_PER_SEC = 90; // DEFAULT_PX_PER_SEC, as `TimelinePane.tsx` defines it

// Fixture: one video track and one audio track, each with a single 2-second
// (48-frame) clip starting at 0 — so each clip is exactly
// `48 / 24 * 90 = 180px` wide, and one second of drag is 90px / 24 frames.
//   track 0 (video): 'v' [0,48)
//   track 1 (audio): 'm' [0,48)
const CLIP_FRAMES = 48;
const CLIP_WIDTH_PX = (CLIP_FRAMES / FPS) * PX_PER_SEC;

function buildFixture(): Timeline {
  return {
    id: 'fade-fixture-tl',
    name: 'fade fixture',
    rate: { num: FPS, den: 1 },
    tracks: [
      {
        kind: 'video',
        clips: [
          { id: 'v', name: 'V', source_path: '/v.mp4', source_start: 0, duration: CLIP_FRAMES, source_len: 480, start_frame: 0 },
        ],
      },
      {
        kind: 'audio',
        clips: [
          { id: 'm', name: 'M', source_path: '/m.wav', source_start: 0, duration: CLIP_FRAMES, source_len: 480, start_frame: 0 },
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
      openProjectKey: '/projects/fade-fixture.chroma',
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
    }),
  );
  expect(errors, `console.error fired during the test:\n${errors.map((e) => e.join(' ')).join('\n')}`).toEqual([]);
});

/** Every fade handle rendered for `side`, in DOM order — track 0's clip first,
 *  then track 1's, matching the fixture's own track order. */
function handles(side: 'in' | 'out'): HTMLElement[] {
  return Array.from(mounted!.container.querySelectorAll(`[data-chroma-fade-handle="${side}"]`));
}

/** The `d` of the fade-IN ramp actually drawn on `track`'s clip, or `null` if
 *  no ramp is drawn there. Identified by its start point — a fade-in ramp is
 *  the only path that begins at the clip's bottom-left corner (`M 0 <height>`),
 *  which keeps this independent of child ordering inside the `<svg>`. */
function fadeInRampD(track: number): string | null {
  const svg = mounted!.container.querySelectorAll('[data-chroma-fade-ramp]')[track];
  const hit = Array.from(svg?.querySelectorAll('path') ?? []).find((p) => (p.getAttribute('d') ?? '').startsWith('M 0 52'));
  return hit?.getAttribute('d') ?? null;
}

function clipAt(track: number, index = 0) {
  const clip = useEditorTimelineStore.getState().timeline?.tracks[track]?.clips[index];
  if (!clip) throw new Error(`fixture clip ${track}/${index} is missing`);
  return clip;
}

describe('on-clip fade handles — real DOM, real PointerEvents (D-207)', () => {
  it('1. renders a fade handle on both ends of EVERY clip, video track and audio track alike', () => {
    // One fade pair drives picture and sound together in this model, so the
    // affordance is not audio-only — see `Clip::fade_in_frames`' own doc.
    expect(handles('in')).toHaveLength(2);
    expect(handles('out')).toHaveLength(2);
  });

  it('2. dragging a video clip’s fade-in handle inward writes the real fade_in_frames field', async () => {
    expect(clipAt(0).fade_in_frames ?? 0).toBe(0);

    // +45px == half a second == 12 frames at 24fps.
    await dragPointer(handles('in')[0], [
      { x: 200, y: 50 },
      { x: 222, y: 50 },
      { x: 245, y: 50 },
    ]);

    expect(clipAt(0).fade_in_frames).toBe(12);
    // The op is a whole-fade write, exactly as the Inspector's `applyFade`
    // makes it: the other side is preserved and both curves are stated.
    expect(clipAt(0).fade_out_frames).toBe(0);
    expect(clipAt(0).fade_in_curve).toEqual(FADE_PRESETS[0].curve);
    expect(clipAt(0).fade_out_curve).toEqual(FADE_PRESETS[0].curve);
  });

  it('3. dragging an AUDIO clip’s fade-out handle leftward writes fade_out_frames on that clip only', async () => {
    // A fade-out grows right-to-left: the handle starts at the clip's own
    // out-point and is dragged back into the clip.
    await dragPointer(handles('out')[1], [
      { x: 400, y: 50 },
      { x: 355, y: 50 },
      { x: 310, y: 50 },
    ]);

    expect(clipAt(1).fade_out_frames).toBe(24); // 90px == 1s == 24 frames
    expect(clipAt(1).fade_in_frames).toBe(0);
    // The video clip on the other track is untouched.
    expect(clipAt(0).fade_in_frames ?? 0).toBe(0);
    expect(clipAt(0).fade_out_frames ?? 0).toBe(0);
  });

  it('4. commits exactly ONE op, on pointer-up — never one per pointermove', async () => {
    // The convention `TransformOverlay.tsx` documents: `applyOp` snapshots the
    // whole timeline onto the undo stack per call, so a per-move commit would
    // be one undo entry per pixel dragged. `timeline` is replaced (never
    // mutated) by `applyOp`, so referential identity is the exact signal.
    const before = useEditorTimelineStore.getState().timeline;

    firePointerEvent(handles('in')[0], 'pointerdown', { x: 200, y: 50 });
    await waitFrames();
    for (const x of [210, 230, 250, 270]) {
      firePointerEvent(window, 'pointermove', { x, y: 50 });
      await waitFrames();
      expect(
        useEditorTimelineStore.getState().timeline,
        'the store changed mid-drag — a fade drag must be local until release',
      ).toBe(before);
    }
    firePointerEvent(window, 'pointerup', { x: 270, y: 50 });
    await waitFrames();

    const after = useEditorTimelineStore.getState().timeline;
    expect(after).not.toBe(before);
    expect(clipAt(0).fade_in_frames).toBe(19); // 70px / 90 * 24, rounded
  });

  it('5. the live ramp and readout track the drag before anything is committed', async () => {
    // No fade set yet, so there is no ramp to draw — only the flat unity line
    // across the clip.
    expect(fadeInRampD(0)).toBeNull();

    firePointerEvent(handles('in')[0], 'pointerdown', { x: 200, y: 50 });
    await waitFrames();
    firePointerEvent(window, 'pointermove', { x: 245, y: 50 });
    await waitFrames();

    // The DRAWN ramp moves with the pointer, mid-gesture: 12 frames == 45px,
    // rising from silence at the clip's own left edge (y = ROW_HEIGHT) to
    // unity (y = FADE_TOP_INSET_PX) at x = 45.
    expect(fadeInRampD(0)).toMatch(/^M 0 52 C .*, 45 1( L 0 1 Z)?$/);
    const readout = mounted!.container.querySelector('[data-chroma-fade-readout]');
    expect(readout?.textContent).toBe('12f');
    expect(clipAt(0).fade_in_frames ?? 0).toBe(0); // still uncommitted

    firePointerEvent(window, 'pointerup', { x: 245, y: 50 });
    await waitFrames();
    expect(mounted!.container.querySelector('[data-chroma-fade-readout]')).toBeNull();
    expect(clipAt(0).fade_in_frames).toBe(12);
    // …and the committed field draws the same ramp the drag was showing, so
    // release is not a visual jump.
    expect(fadeInRampD(0)).toMatch(/^M 0 52 C .*, 45 1( L 0 1 Z)?$/);
  });

  it('6. Escape abandons an in-flight drag with nothing committed', async () => {
    const before = useEditorTimelineStore.getState().timeline;

    firePointerEvent(handles('in')[0], 'pointerdown', { x: 200, y: 50 });
    await waitFrames();
    firePointerEvent(window, 'pointermove', { x: 290, y: 50 });
    await waitFrames();
    actSync(() => window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })));
    await waitFrames();
    firePointerEvent(window, 'pointerup', { x: 290, y: 50 });
    await waitFrames();

    expect(useEditorTimelineStore.getState().timeline).toBe(before);
    expect(clipAt(0).fade_in_frames ?? 0).toBe(0);
  });

  it('7. a press with no movement is not an edit', async () => {
    const before = useEditorTimelineStore.getState().timeline;
    await dragPointer(handles('in')[0], [{ x: 200, y: 50 }]);
    expect(useEditorTimelineStore.getState().timeline).toBe(before);
  });

  it('8. the drag is clamped to the clip it lives on, but the MODEL is not', async () => {
    // Dragging far past the clip's far edge stops at the clip's own length —
    // the handle has run out of timeline to travel along. This is a drag
    // clamp only: `set_clip_fade` itself deliberately allows a longer fade
    // (see its doc), which the Inspector and MCP still reach.
    await dragPointer(handles('in')[0], [
      { x: 200, y: 50 },
      { x: 500, y: 50 },
      { x: 900, y: 50 },
    ]);
    expect(clipAt(0).fade_in_frames).toBe(CLIP_FRAMES);
    expect(CLIP_WIDTH_PX).toBe(180); // the fixture's own premise
  });

  it('9. a fade set from the timeline is the same stored value the Inspector reads back', async () => {
    // Not a tautology: this is the whole point of the feature — the canvas
    // affordance and the numeric field are two views of ONE persisted field,
    // so a value written by one must be exactly what the other reads. Both
    // read `clip.fade_in_frames` off the same store; asserting the store, plus
    // scenario 2's proof that the write goes through `set_clip_fade`, is what
    // makes that true by construction rather than by coincidence.
    await dragPointer(handles('out')[0], [
      { x: 400, y: 50 },
      { x: 377, y: 50 },
      { x: 355, y: 50 },
    ]);
    const clip = clipAt(0);
    expect(clip.fade_out_frames).toBe(12);
    expect(clip.fade_out_curve).toEqual(FADE_PRESETS[0].curve);
  });

  it('10. a locked track offers no fade handles (its ramps still draw)', async () => {
    actSync(() =>
      useEditorTimelineStore.setState((s) => ({
        timeline: s.timeline
          ? { ...s.timeline, tracks: s.timeline.tracks.map((t, i) => (i === 0 ? { ...t, locked: true } : t)) }
          : s.timeline,
      })),
    );
    await waitFrames(2);

    // Track 1's clip still has both; track 0's has neither.
    expect(handles('in')).toHaveLength(1);
    expect(handles('out')).toHaveLength(1);
    expect(mounted!.container.querySelectorAll('[data-chroma-fade-ramp]')).toHaveLength(2);
  });
});
