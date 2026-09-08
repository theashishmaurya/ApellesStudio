// @vitest-environment jsdom
/**
 * @chroma/editor — real-DOM coverage for dynamic zoom's on-canvas boxes
 * (D-234): that arming draws two boxes and writes nothing, that dragging one
 * writes the whole animation through the existing keyframe op, and that the
 * ordinary transform box stands aside while the mode is on.
 *
 * **Why this tier.** `dynamicZoom.test.ts` proves the box→keyframe math, but
 * the gesture is the feature: which box the user grabbed, whether releasing it
 * commits once, and whether the two overlays can ever both draw. None of that
 * is visible to a pure-math test. This mounts the real `PreviewPane` (real
 * overlays, real store, real ops) and reads the boxes' own CSS geometry back
 * off the DOM, exactly as `PreviewPane.transform.dom.test.tsx` does for the
 * single transform box — same harness, same stubs, same honest jsdom limits
 * (no layout engine; `stubOffsetMetrics` supplies the one fixed viewport).
 *
 * Geometry is chosen so every expected number is readable by inspection: the
 * stubbed container and the composition share a 2:1 aspect ratio (no
 * letterboxing) and the source exactly fills the composition at `scale: 1`, so
 * `box_width_px === scale * CANVAS_W`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  dragPointer,
  installObjectUrlStub,
  installPointerCaptureStub,
  installResizeObserverStub,
  linearPath,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

const CANVAS_W = 1000;
const CANVAS_H = 500;
const FPS = 24;
const DURATION = 240;

const STUB_FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;
const NATURAL_FULL_FRAME = { naturalWidth: 1, naturalHeight: 1 };

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_timeline_frame: () => STUB_FRAME,
    chroma_timeline_composition_size: () => ({
      compWidth: CANVAS_W,
      compHeight: CANVAS_H,
      ...NATURAL_FULL_FRAME,
    }),
    chroma_timeline_clip_geometry: () => ({
      compWidth: CANVAS_W,
      compHeight: CANVAS_H,
      ...NATURAL_FULL_FRAME,
    }),
    chroma_project_get_settings: () => ({ width: CANVAS_W, height: CANVAS_H }),
    chroma_audio_play: () => undefined,
    chroma_audio_stop: () => undefined,
    chroma_audio_set_volume: () => undefined,
    chroma_timeline_set: () => undefined,
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
}));

import { useEditorTimelineStore } from './timelineStore';
import { PreviewPane } from './PreviewPane';
import { DEFAULT_FADE_CURVE, type Clip, type Timeline, type Track } from './timeline';
import { paramValueAt } from './clipKeyframes';

function plainClip(extra: Partial<Clip> = {}): Clip {
  return {
    id: 'zoomee',
    name: 'ZOOMEE',
    source_path: '/zoomee.mov',
    source_start: 0,
    duration: DURATION,
    source_len: 480,
    source_fps: FPS,
    start_frame: 0,
    ...extra,
  };
}

function timelineOf(tracks: Track[]): Timeline {
  return { id: 'dz-tl', name: 'dz', rate: { num: FPS, den: 1 }, tracks };
}

function currentClip(): Clip {
  const clip = useEditorTimelineStore.getState().timeline?.tracks[0].clips[0];
  if (!clip) throw new Error('clip vanished from the store');
  return clip;
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let objectUrls: ReturnType<typeof installObjectUrlStub>;
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

/** Seed the store with `clip` selected, optionally with dynamic zoom armed on
 *  it, and mount the real `PreviewPane`. */
async function mountWith(clip: Clip, armed: boolean): Promise<void> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: timelineOf([{ kind: 'video', clips: [clip] }]),
      openProjectKey: 'test-project',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [{ track: 0, id: clip.id }],
      selectedGap: null,
      dynamicZoom: armed ? { clipId: clip.id, curve: DEFAULT_FADE_CURVE } : null,
    }),
  );
  mounted = mount(React.createElement(PreviewPane), { strictMode: true });
  await waitFrames(4);
}

/** The two dynamic-zoom boxes, in render order (start, then end). */
function boxes(): HTMLElement[] {
  const found = mounted?.container.querySelectorAll('[data-dynamic-zoom-overlay] [data-transform-box]');
  return [...(found ?? [])] as HTMLElement[];
}

function boxRect(box: HTMLElement) {
  const px = (v: string) => Number.parseFloat(v);
  return {
    left: px(box.style.left),
    top: px(box.style.top),
    width: px(box.style.width),
    height: px(box.style.height),
  };
}

/** Drag one box's BODY (a reposition) by `dx`/`dy` screen pixels. */
async function dragBodyBy(box: HTMLElement, dx: number, dy = 0): Promise<void> {
  const body = box.querySelector('div:not([data-transform-box-label])') as HTMLElement;
  const rect = boxRect(box);
  const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
  await dragPointer(body, linearPath(from, { x: from.x + dx, y: from.y + dy }), {
    moveTarget: body,
    release: body,
  });
  await waitFrames(2);
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(CANVAS_W, CANVAS_H);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  objectUrls = installObjectUrlStub();
  console_ = captureConsole();
});

afterEach(() => {
  // Same bar every prior pointer-gesture suite sets: zero console errors under
  // real StrictMode double-invoke, asserted rather than eyeballed — which is
  // also what catches a commit run from inside a state updater (the `draftRef`
  // hazard `TransformBox` inherited from D-209).
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  actSync(() => useEditorTimelineStore.setState({ dynamicZoom: null }));
  objectUrls.restore();
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  expect(errors).toEqual([]);
});

describe('D-234 — dynamic zoom on canvas', () => {
  it('draws nothing until the mode is armed, and the ordinary transform box is up', async () => {
    await mountWith(plainClip(), false);
    expect(boxes()).toHaveLength(0);
    expect(mounted?.container.querySelectorAll('[data-transform-overlay] [data-transform-box]')).toHaveLength(1);
  });

  it('armed: draws TWO labelled boxes and the ordinary transform box stands aside', async () => {
    await mountWith(plainClip(), true);
    const [start, end] = boxes();
    expect(boxes()).toHaveLength(2);
    // D-234 — one box per meaning; never a third stroke on the same rectangle.
    expect(mounted?.container.querySelectorAll('[data-transform-overlay] [data-transform-box]')).toHaveLength(0);
    expect(start.querySelector('[data-transform-box-label]')?.textContent).toBe('Start');
    expect(end.querySelector('[data-transform-box-label]')?.textContent).toBe('End');
    // Resolve's own colour convention, and the end box dashed so a coincident
    // pair still reads as two boxes.
    expect(start.className).toContain('border-green-400');
    expect(end.className).toContain('border-red-400');
    expect(end.style.borderStyle).toBe('dashed');
  });

  it('arming writes NOTHING: both boxes sit on the clip’s current framing', async () => {
    await mountWith(plainClip({ scale: 0.5, position_x: 0.1 }), true);
    const [start, end] = boxes().map(boxRect);
    expect(start.width).toBeCloseTo(0.5 * CANVAS_W, 3);
    expect(start).toEqual(end); // exactly coincident — no zoom authored yet
    expect(currentClip().chroma_keyframes).toBeUndefined();
  });

  it('dragging the END box writes the whole animation in ONE keyframe op', async () => {
    await mountWith(plainClip(), true);
    const before = useEditorTimelineStore.getState().timeline;
    // +200px on a 1000px canvas is +0.2 in composition fractions.
    await dragBodyBy(boxes()[1], 200, 0);

    const kfs = currentClip().chroma_keyframes;
    expect(kfs).toBeDefined();
    // Linear ease → exactly two keys, one per end of the clip's own source
    // span (`source_start` .. `source_start + duration - 1`).
    expect(kfs?.map((k) => k.frame)).toEqual([0, DURATION - 1]);
    // The start end is untouched at the clip's rest framing; only the dragged
    // end moved.
    expect(paramValueAt(kfs, 'position_x', 0, 0)).toBeCloseTo(0, 6);
    expect(paramValueAt(kfs, 'position_x', DURATION - 1, 0)).toBeCloseTo(0.2, 6);
    expect(paramValueAt(kfs, 'scale', DURATION - 1, 1)).toBeCloseTo(1, 6);
    expect(useEditorTimelineStore.getState().timeline).not.toBe(before);
  });

  it('dragging the START box moves that end and leaves the other one alone', async () => {
    await mountWith(plainClip(), true);
    // Author an end framing first, then move the start.
    await dragBodyBy(boxes()[1], 200, 0);
    await dragBodyBy(boxes()[0], -100, 0);

    const kfs = currentClip().chroma_keyframes;
    expect(paramValueAt(kfs, 'position_x', 0, 0)).toBeCloseTo(-0.1, 6);
    expect(paramValueAt(kfs, 'position_x', DURATION - 1, 0)).toBeCloseTo(0.2, 6);
  });

  it('a second drag REPLACES the zoom rather than accumulating keys', async () => {
    await mountWith(plainClip(), true);
    await dragBodyBy(boxes()[1], 200, 0);
    await dragBodyBy(boxes()[1], 100, 0);
    const kfs = currentClip().chroma_keyframes;
    expect(kfs).toHaveLength(2);
    expect(paramValueAt(kfs, 'position_x', DURATION - 1, 0)).toBeCloseTo(0.3, 6);
  });

  it('leaves another property’s existing keyframes untouched', async () => {
    await mountWith(
      plainClip({
        chroma_keyframes: [
          { frame: 0, params: { opacity: 0.25 } },
          { frame: 100, params: { opacity: 1, rotation: 30 } },
        ],
      }),
      true,
    );
    await dragBodyBy(boxes()[1], 200, 0);
    const kfs = currentClip().chroma_keyframes;
    expect(paramValueAt(kfs, 'opacity', 0, 1)).toBe(0.25);
    expect(paramValueAt(kfs, 'opacity', 100, 1)).toBe(1);
    expect(paramValueAt(kfs, 'rotation', 100, 0)).toBe(30);
    expect(paramValueAt(kfs, 'position_x', DURATION - 1, 0)).toBeCloseTo(0.2, 6);
  });

  it('a locked track draws the boxes but refuses the drag', async () => {
    actSync(() =>
      useEditorTimelineStore.setState({
        timeline: timelineOf([{ kind: 'video', clips: [plainClip()], locked: true }]),
        openProjectKey: 'test-project',
        status: 'ready',
        error: null,
        playhead: 0,
        playing: false,
        selection: [{ track: 0, id: 'zoomee' }],
        selectedGap: null,
        dynamicZoom: { clipId: 'zoomee', curve: DEFAULT_FADE_CURVE },
      }),
    );
    mounted = mount(React.createElement(PreviewPane), { strictMode: true });
    await waitFrames(4);
    expect(boxes()).toHaveLength(2);
    await dragBodyBy(boxes()[1], 200, 0);
    expect(currentClip().chroma_keyframes).toBeUndefined();
  });

  it('draws nothing for a clip the mode is not armed on', async () => {
    // The mode names a clip by ID, so a selection change simply stops
    // matching rather than drawing over the wrong picture.
    await mountWith(plainClip(), true);
    actSync(() => useEditorTimelineStore.setState({ dynamicZoom: { clipId: 'someone-else', curve: DEFAULT_FADE_CURVE } }));
    await waitFrames(2);
    expect(boxes()).toHaveLength(0);
    expect(mounted?.container.querySelectorAll('[data-transform-overlay] [data-transform-box]')).toHaveLength(1);
  });
});
