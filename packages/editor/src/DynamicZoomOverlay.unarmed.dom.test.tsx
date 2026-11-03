// @vitest-environment jsdom
/**
 * B-374 (D-437 S11) — an UNARMED dynamic-zoom overlay measures nothing.
 *
 * Every selection change used to make it probe the selected clip's geometry (an
 * IPC round trip) and mount the preview content box, whose layout effect reads
 * the container's `clientWidth`. On the select-and-trim of an edit gesture that
 * read forced the freshly committed 300-clip page to lay out inside the
 * release's commit, then re-rendered the overlay, for an overlay that draws only
 * while armed.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
  installResizeObserverStub,
  mount,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

const invokeMock = vi.hoisted(() =>
  vi.fn(async (cmd: string) => {
    if (cmd === 'chroma_timeline_clip_geometry')
      return { compWidth: 1000, compHeight: 500, naturalWidth: 1, naturalHeight: 1 };
    throw new Error(`no stub for ${cmd}`);
  }),
);
vi.mock('@tauri-apps/api/core', () => ({ invoke: invokeMock }));

import { useEditorTimelineStore } from './timelineStore';
import { DynamicZoomOverlay } from './DynamicZoomOverlay';
import { DEFAULT_EASE_CURVE, type Clip } from './timeline';

const clip: Clip = {
  id: 'c',
  name: 'C',
  source_path: '/c.mov',
  source_start: 0,
  duration: 48,
  source_len: 480,
  start_frame: 0,
};

let mounted: MountedComponent | null = null;
let restoreRo: () => void;
let container: HTMLDivElement;
let widthReads = 0;

const geometryCalls = () => invokeMock.mock.calls.filter(([cmd]) => cmd === 'chroma_timeline_clip_geometry').length;

beforeEach(() => {
  restoreRo = installResizeObserverStub();
  invokeMock.mockClear();
  widthReads = 0;
  container = document.createElement('div');
  Object.defineProperty(container, 'clientWidth', {
    get: () => {
      widthReads += 1;
      return 1000;
    },
  });
  Object.defineProperty(container, 'clientHeight', { get: () => 500 });
  document.body.appendChild(container);
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: { id: 'tl', name: 'tl', rate: { num: 24, den: 1 }, tracks: [{ kind: 'video', clips: [clip] }] },
      openProjectKey: 'p',
      status: 'ready',
      selection: [],
      dynamicZoom: null,
    }),
  );
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  container.remove();
  restoreRo();
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: null,
      selection: [],
      dynamicZoom: null,
      openProjectKey: null,
      status: 'idle',
    }),
  );
});

describe('DynamicZoomOverlay measures only while armed (B-374)', () => {
  it('a selection change with dynamic zoom off probes no geometry and reads no layout', async () => {
    mounted = mount(React.createElement(DynamicZoomOverlay, { container }), { strictMode: true });
    await waitFrames(2);
    actSync(() => useEditorTimelineStore.setState({ selection: [{ track: 0, id: 'c' }] }));
    await waitFrames(3);

    expect(geometryCalls(), 'an unarmed overlay must not ask Rust for the clip geometry').toBe(0);
    expect(widthReads, 'an unarmed overlay must not read the container (a forced layout)').toBe(0);
    expect(document.querySelector('[data-dynamic-zoom-overlay]')).toBeNull();
  });

  it('arming it on the selected clip measures as before', async () => {
    mounted = mount(React.createElement(DynamicZoomOverlay, { container }), { strictMode: true });
    actSync(() =>
      useEditorTimelineStore.setState({
        selection: [{ track: 0, id: 'c' }],
        dynamicZoom: { clipId: 'c', curve: DEFAULT_EASE_CURVE },
      }),
    );
    await waitFrames(3);

    expect(geometryCalls()).toBeGreaterThan(0);
    expect(widthReads).toBeGreaterThan(0);
  });
});
