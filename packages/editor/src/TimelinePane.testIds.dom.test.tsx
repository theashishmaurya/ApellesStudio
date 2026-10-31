// @vitest-environment jsdom
/**
 * D-434 / H7 — the track-header divider reaches the DOM under its stable name.
 *
 * `react-resizable-panels` 4.x's `Separator` writes `data-testid` from its own
 * `id`, so a `data-testid` prop passed to `ResizableHandle` is overwritten by an
 * auto-generated id and the UI harness could never find the divider. The pane
 * therefore passes `id={TIMELINE_TEST_IDS.headerResize}`; this pins that a real
 * render carries it as both the `id` and the `data-testid`.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

import {
  actSync,
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
import { TIMELINE_TEST_IDS } from './timelineTestIds';
import type { Timeline } from './timeline';

const timeline: Timeline = {
  id: 'ids-tl',
  name: 'ids',
  rate: { num: 24, den: 1 },
  tracks: [{ kind: 'video', clips: [{ id: 'v', name: 'V', source_path: '/v.mp4', source_start: 0, duration: 240, source_len: 240, start_frame: 0 }] }],
};

let restoreOffsets: () => void;
let restoreResizeObserver: () => void;
let restorePointerCapture: () => void;
let ui: MountedComponent | null = null;

beforeEach(() => {
  restoreOffsets = stubOffsetMetrics(1200, 600);
  restoreResizeObserver = installResizeObserverStub();
  restorePointerCapture = installPointerCaptureStub();
});

afterEach(() => {
  ui?.unmount();
  ui = null;
  restorePointerCapture();
  restoreResizeObserver();
  restoreOffsets();
  actSync(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle' }));
});

describe('the track-header divider (H7)', () => {
  it('is addressable by its id and by data-testid, both the catalogued name', async () => {
    actSync(() =>
      useEditorTimelineStore.setState({ timeline, openProjectKey: '/p/ids.chroma', status: 'ready', error: null, playhead: 0, selection: [] }),
    );
    ui = mount(React.createElement(TimelinePane));
    await waitFrames(2);

    const byId = document.getElementById(TIMELINE_TEST_IDS.headerResize);
    expect(byId, 'no element has the divider id').not.toBeNull();
    expect(byId?.getAttribute('data-testid')).toBe(TIMELINE_TEST_IDS.headerResize);
    expect(document.querySelectorAll(`[data-testid="${TIMELINE_TEST_IDS.headerResize}"]`)).toHaveLength(1);
  });
});
