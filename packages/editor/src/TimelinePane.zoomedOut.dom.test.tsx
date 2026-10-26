// @vitest-environment jsdom
/**
 * @apelles/editor — a long, many-clip timeline still DRAWS its clips when
 * zoomed all the way out (B-267).
 *
 * The owner's report: after restarting the app and reopening a ~240-clip,
 * 21,992-frame project at ~1% zoom, every track row was empty while markers
 * still drew and the data was intact. Real layout is not available in jsdom, so
 * this counts the clip bodies the pane puts in the DOM and measures what the
 * library was told about each one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  captureConsole,
  createInvokeStub,
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
import type { Clip, Timeline } from './timeline';

const FPS = 30;
const AREA = { left: 0, top: 0, width: 1200, height: 600 };
const CLIPS = 240;
/** 21,992 frames over 240 clips, the owner's shape: ~91.6 frames each. */
const TOTAL_FRAMES = 21992;

function fixture(): Timeline {
  const clips: Clip[] = Array.from({ length: CLIPS }, (_, i) => {
    const start = Math.floor((i * TOTAL_FRAMES) / CLIPS);
    const end = Math.floor(((i + 1) * TOTAL_FRAMES) / CLIPS);
    return {
      id: `c${i}`,
      name: `c${i}`,
      source_path: '/v.mp4',
      source_start: start,
      duration: end - start,
      source_len: TOTAL_FRAMES,
      source_fps: FPS,
      start_frame: start,
    } as Clip;
  });
  return { id: 'tl', name: 'tl', rate: { num: FPS, den: 1 }, tracks: [{ kind: 'video', clips }], markers: [] } as unknown as Timeline;
}

function stubEditAreaRect(): HTMLElement {
  const el = document.querySelector<HTMLElement>('[data-bench-id="timeline-edit-area"]');
  if (!el) throw new Error('the timeline edit area is not mounted');
  el.getBoundingClientRect = () =>
    ({ ...AREA, x: 0, y: 0, right: AREA.width, bottom: AREA.height, toJSON: () => ({}) }) as DOMRect;
  return el;
}

function zoomOut(el: HTMLElement, times: number): void {
  for (let i = 0; i < times; i++) {
    actSync(() => {
      const e = new Event('wheel', { bubbles: true, cancelable: true });
      Object.defineProperty(e, 'ctrlKey', { value: true });
      Object.defineProperty(e, 'clientX', { value: 300 });
      Object.defineProperty(e, 'clientY', { value: 200 });
      Object.defineProperty(e, 'deltaY', { value: 120 });
      el.dispatchEvent(e);
    });
  }
}

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let ui: MountedComponent | null = null;
let console_: ReturnType<typeof captureConsole>;

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(AREA.width, AREA.height);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
  console_ = captureConsole();
});

afterEach(() => {
  console_.restore();
  ui?.unmount();
  ui = null;
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  actSync(() => useEditorTimelineStore.setState({ timeline: null, status: 'idle', selection: [] }));
});

const clipBodies = () => document.querySelectorAll('[data-chroma-clip-drag]');

describe('B-267 — a zoomed-out, many-clip timeline draws its clips', () => {
  it('draws clips at the default zoom and again after zooming all the way out', async () => {
    actSync(() =>
      useEditorTimelineStore.setState({
        timeline: fixture(),
        openProjectKey: '/projects/b267.chroma',
        status: 'ready',
        error: null,
        playhead: 0,
        playing: false,
        selection: [],
        selectedGap: null,
      }),
    );
    ui = mount(React.createElement(TimelinePane), { strictMode: true });
    await waitFrames(2);
    const area = stubEditAreaRect();
    await waitFrames(3);
    const atDefault = clipBodies().length;
    zoomOut(area, 60);
    await waitFrames(4);
    const zoomedOut = clipBodies().length;
    expect(atDefault).toBeGreaterThan(0);
    expect(zoomedOut).toBe(CLIPS);
    // Each clip's host has a real, positive width and they run left to right
    // with no overlap: nothing the layout could collapse to nothing.
    const hosts = [...document.querySelectorAll<HTMLElement>('.timeline-editor-action')];
    expect(hosts).toHaveLength(CLIPS);
    let previousRight = -Infinity;
    for (const host of hosts) {
      const left = Number.parseFloat(host.style.left);
      const width = Number.parseFloat(host.style.width);
      expect(width).toBeGreaterThan(1);
      expect(left).toBeGreaterThanOrEqual(previousRight - 0.001);
      previousRight = left + width;
    }
  }, 60000);
});
