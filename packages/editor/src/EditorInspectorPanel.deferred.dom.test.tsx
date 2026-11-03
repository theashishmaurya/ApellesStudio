// @vitest-environment jsdom
/**
 * @apelles/editor — D-437 S10: the Inspector's re-mount for a new selection is
 * NOT part of the commit that changed the selection.
 *
 * Profiled at 300 clips (production React, headless Chromium): a select-and-trim
 * release spent about half its React time mounting the Inspector for the newly
 * selected clip (its tabs, sections and Base UI composites, one of which forces
 * a layout on first mount). `EditorInspectorPanel` now shows a DEFERRED
 * selection (`useDeferredValue`), so the urgent commit (the timeline's own
 * change) paints first and the Inspector follows in a background render.
 *
 * The instrument: `flushSync` flushes only the urgent (sync) lane, exactly the
 * work a release frame has to do; the deferred lane is left for later. After
 * it, the panel still shows the old selection; after the background render,
 * the new one.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';
import { flushSync } from 'react-dom';

import {
  actSync,
  captureConsole,
  createInvokeStub,
  installResizeObserverStub,
  mount,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: createInvokeStub({
    chroma_timeline_clip_geometry: () => ({ compWidth: 1000, compHeight: 500, naturalWidth: 1000, naturalHeight: 500 }),
    chroma_project_get_settings: () => ({ width: 1000, height: 500 }),
    chroma_timeline_set: () => undefined,
    chroma_text_fonts: () => [],
  }),
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));

import { useEditorTimelineStore } from './timelineStore';
import { EditorInspectorPanel } from './EditorInspectorPanel';
import type { Timeline } from './timeline';

function fixture(): Timeline {
  return {
    id: 'deferred',
    name: 'deferred',
    rate: { num: 25, den: 1 },
    tracks: [{ kind: 'video', clips: [{ id: 'c', name: 'C', source_path: '/c.mov', source_start: 0, duration: 100, source_len: 100, start_frame: 0 }] }],
  } as unknown as Timeline;
}

let ui: MountedComponent | null = null;
let restoreRO: () => void;
let console_: ReturnType<typeof captureConsole>;
const projectSettingsShown = () => document.querySelector('[data-chroma-panel="project-settings"]') !== null;

beforeEach(async () => {
  restoreRO = installResizeObserverStub();
  console_ = captureConsole();
  actSync(() =>
    useEditorTimelineStore.setState({ timeline: fixture(), openProjectKey: '/p/deferred.chroma', status: 'ready', error: null, selection: [], playhead: 0 }),
  );
  ui = mount(React.createElement(EditorInspectorPanel), { strictMode: false });
  await waitFrames(2);
});

afterEach(() => {
  ui?.unmount();
  ui = null;
  restoreRO();
  console_.restore();
  actSync(() => useEditorTimelineStore.setState({ timeline: null, openProjectKey: null, status: 'idle', selection: [] }));
});

describe('D-437 S10 — the Inspector follows a selection in a background render', () => {
  it('the urgent commit leaves the Inspector on the old selection; the background render brings the new one', async () => {
    expect(projectSettingsShown()).toBe(true);
    const env = globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean };
    env.IS_REACT_ACT_ENVIRONMENT = false;
    try {
      flushSync(() => useEditorTimelineStore.setState({ selection: [{ track: 0, id: 'c' }] }));
      // What a release frame commits: the store has the selection, the panel does not yet.
      expect(useEditorTimelineStore.getState().selection).toHaveLength(1);
      expect(projectSettingsShown()).toBe(true);
      await waitFrames(3);
    } finally {
      env.IS_REACT_ACT_ENVIRONMENT = true;
    }
    expect(projectSettingsShown()).toBe(false);
  });
});
