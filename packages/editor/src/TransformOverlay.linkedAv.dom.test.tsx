// @vitest-environment jsdom
/**
 * @apelles/editor — the on-canvas transform box belongs to the PICTURE half of
 * an A/V-linked pair, whichever half is selected (B-334, D-430).
 *
 * Selecting the audio half used to draw the video transform box (its source
 * file has a picture, so geometry resolved) and a drag wrote a transform onto
 * the audio clip, which nothing draws. Same tier as
 * `TransformOverlay.textClip.dom.test.tsx`: jsdom, the real `PreviewPane` /
 * `TransformOverlay` / store, a stubbed frame and geometry.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  PREVIEW_SURFACE_STUBS,
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

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    ...PREVIEW_SURFACE_STUBS,
    chroma_timeline_composition_size: () => ({ compWidth: CANVAS_W, compHeight: CANVAS_H, naturalWidth: 0.5, naturalHeight: 0.5 }),
    chroma_timeline_clip_geometry: () => ({ compWidth: CANVAS_W, compHeight: CANVAS_H, naturalWidth: 0.5, naturalHeight: 0.5 }),
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
import type { Clip, Timeline } from './timeline';

function clip(id: string, extra: Partial<Clip> = {}): Clip {
  return {
    id,
    name: 'C01 hook demo',
    source_path: '/media/hook.mp4',
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
    ...extra,
  } as unknown as Clip;
}

function timelineOf(linked: boolean): Timeline {
  const link = linked ? { link_group: 'lg' } : {};
  return {
    id: 'tl',
    name: 'tl',
    rate: { num: 24, den: 1 },
    tracks: [
      { kind: 'video', clips: linked ? [clip('v', link)] : [] },
      { kind: 'audio', clips: [clip('a', link)] },
    ],
  } as unknown as Timeline;
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let objectUrls: ObjectUrlStub;
let mounted: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

async function mountWith(tl: Timeline, selected: { track: number; id: string }): Promise<HTMLElement | null> {
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: tl,
      openProjectKey: 'test-project',
      status: 'ready',
      error: null,
      playhead: 0,
      playing: false,
      selection: [selected],
      selectedGap: null,
    }),
  );
  mounted = mount(React.createElement(PreviewPane), { strictMode: true });
  await waitFrames(4);
  return mounted.container.querySelector('[data-transform-overlay] > div');
}

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(CANVAS_W, CANVAS_H);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
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

describe('the transform box on a linked A/V pair (B-334)', () => {
  it('draws for the picture half when the picture is selected', async () => {
    expect(await mountWith(timelineOf(true), { track: 0, id: 'v' })).not.toBeNull();
  });

  it('also draws when the AUDIO half is selected — it belongs to the picture', async () => {
    expect(await mountWith(timelineOf(true), { track: 1, id: 'a' })).not.toBeNull();
  });

  it('a drag with the audio half selected moves the PICTURE and writes nothing to the audio clip', async () => {
    const box = await mountWith(timelineOf(true), { track: 1, id: 'a' });
    if (!box) throw new Error('no transform box');
    const px = (v: string) => Number.parseFloat(v);
    const rect = { left: px(box.style.left), top: px(box.style.top), width: px(box.style.width), height: px(box.style.height) };
    const body = box.querySelector('div') as HTMLElement;
    const from = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 };
    await dragPointer(body, linearPath(from, { x: from.x + 100, y: from.y }), { moveTarget: body, release: body });
    await waitFrames(2);

    const tl = useEditorTimelineStore.getState().timeline;
    expect(tl?.tracks[0].clips[0].position_x).toBeCloseTo(0.1, 3);
    expect(tl?.tracks[1].clips[0].position_x).toBeUndefined();
  });

  it('a standalone audio clip draws no box at all, whatever its source file contains', async () => {
    expect(await mountWith(timelineOf(false), { track: 1, id: 'a' })).toBeNull();
  });
});
