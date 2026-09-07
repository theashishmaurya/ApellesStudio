// @vitest-environment jsdom
/**
 * @chroma/editor — real-DOM coverage for the D-211 follow-up: a text clip
 * gets the on-canvas box and its MOVE drag, never the four corner (scale)
 * handles. See `TransformOverlay.tsx`'s own module doc for the full "why" —
 * in short, a scale drag would silently write a `scale` value nothing in
 * either engine ever reads for a text clip (the same shape B-053 was).
 *
 * Same tier as `PreviewPane.transform.dom.test.tsx`: jsdom, the real
 * `PreviewPane`/`TransformOverlay`/store/ops, a stubbed frame + geometry.
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
  type ObjectUrlStub,
} from './testUtils/pointerHarness';

const CANVAS_W = 1000;
const CANVAS_H = 500;
const FPS = 24;

/** Whatever `chroma_timeline_frame` answers with — since D-217 that is the
 *  JPEG's raw bytes, not a data URL. Nothing here inspects the picture; the
 *  frame just has to arrive so the preview surface (and with it the transform
 *  overlay) mounts at all. */
const STUB_FRAME = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]).buffer;

// D-211 — `clip_geometry`'s own `is_text()` branch: a text clip's natural
// footprint is exactly the composition, `naturalWidth`/`naturalHeight` both 1.
const TEXT_NATURAL_FULL_FRAME = { naturalWidth: 1, naturalHeight: 1 };

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_timeline_frame: () => STUB_FRAME,
    chroma_timeline_composition_size: () => ({
      compWidth: CANVAS_W,
      compHeight: CANVAS_H,
      ...TEXT_NATURAL_FULL_FRAME,
    }),
    chroma_timeline_clip_geometry: () => ({
      compWidth: CANVAS_W,
      compHeight: CANVAS_H,
      ...TEXT_NATURAL_FULL_FRAME,
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
import type { Clip, Timeline, Track } from './timeline';
import { DEFAULT_TEXT_FONT } from './timeline';

function textClip(extra: Partial<Clip> = {}): Clip {
  return {
    id: 'title-1',
    name: 'AFTER',
    source_path: '',
    source_start: 0,
    duration: 120,
    source_len: 120,
    start_frame: 0,
    text: { content: 'AFTER', font: DEFAULT_TEXT_FONT, size: 0.12, color: '#FFFFFF' },
    ...extra,
  };
}

function timelineOf(tracks: Track[]): Timeline {
  return { id: 'transform-tl', name: 'transform', rate: { num: FPS, den: 1 }, tracks };
}

function currentClip(id: string): Clip {
  const clip = useEditorTimelineStore.getState().timeline?.tracks[0].clips.find((c) => c.id === id);
  if (!clip) throw new Error(`clip ${id} vanished from the store`);
  return clip;
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let objectUrls: ObjectUrlStub;
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

async function mountWithSelected(clip: Clip): Promise<HTMLElement> {
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
    }),
  );
  mounted = mount(React.createElement(PreviewPane), { strictMode: true });
  await waitFrames(4);
  const box = mounted.container.querySelector('[data-transform-overlay] > div');
  if (!box) throw new Error('the transform box never rendered — frame/geometry stubs are broken');
  return box as HTMLElement;
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

async function dragBodyBy(box: HTMLElement, dx: number, dy = 0): Promise<void> {
  const body = box.querySelector('div') as HTMLElement;
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
  // D-217 — jsdom has no `URL.createObjectURL`, and `PreviewPane` shows every
  // frame through one now.
  objectUrls = installObjectUrlStub();
  console_ = captureConsole();
});

afterEach(() => {
  const errors = console_.errors;
  console_.restore();
  mounted?.unmount();
  mounted = null;
  objectUrls.restore();
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  expect(errors).toEqual([]);
});

describe("D-211 follow-up — a text clip's on-canvas box", () => {
  it('renders a full-frame box (its natural footprint is the whole composition) with zero corner handles', async () => {
    const box = await mountWithSelected(textClip());
    const rect = boxRect(box);
    expect(rect.width).toBeCloseTo(CANVAS_W, 3);
    expect(rect.height).toBeCloseTo(CANVAS_H, 3);
    expect(box.querySelectorAll('[data-transform-handle]').length).toBe(0);
  });

  it('the body drag still works — a MOVE commits position_x/position_y via set_clip_transform', async () => {
    const box = await mountWithSelected(textClip());
    await dragBodyBy(box, 100, 50); // 0.1 canvas-widths right, 0.1 canvas-heights down

    const after = currentClip('title-1');
    expect(after.position_x).toBeCloseTo(0.1, 3);
    expect(after.position_y).toBeCloseTo(0.1, 3);
    // Untouched — a text clip's scale is never written by anything, on-canvas
    // included, now that the corner handles are gone.
    expect(after.scale ?? 1).toBe(1);
  });

  it('a locked track hides even the move affordance, same as a video clip', async () => {
    const box = await mountWithSelected(textClip());
    actSync(() =>
      useEditorTimelineStore.setState((s) => ({
        timeline: s.timeline
          ? { ...s.timeline, tracks: s.timeline.tracks.map((t) => ({ ...t, locked: true })) }
          : s.timeline,
      })),
    );
    await waitFrames(2);
    expect(box.querySelector('.cursor-move')).toBeNull();
  });
});
