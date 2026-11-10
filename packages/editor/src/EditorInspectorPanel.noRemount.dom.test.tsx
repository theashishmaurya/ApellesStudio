// @vitest-environment jsdom
/**
 * @apelles/editor — B-379: the Inspector SWAPS its data for a newly selected
 * clip instead of being remounted for it.
 *
 * D-193 put a `key` on `ClipInspectorPanel` keyed by the selected clip ids,
 * for one reason: to reset that component's own local ratio-lock state to the
 * new clip's default. The cost was a full remount of the panel after every
 * release — its tabs, sections and Base UI composites, one of which forces a
 * layout on first mount — measured at 10–20 ms in D-437 S11.
 *
 * The remount is gone. The two things that test proves, together, are the
 * whole of the fix: the panel's DOM survives a selection change (a `key`
 * change would replace it), and the ratio lock still returns to the new
 * clip's own default, because the component that owns that state now resets
 * it itself.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import React from 'react';

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
import { openAllInspectorSections } from './testUtils/inspectorSections';
import type { Timeline } from './timeline';

/** Two picture clips, neither with a size override — so each one's own
 *  ratio-lock default is "linked". */
function fixture(): Timeline {
  const clip = (id: string, start: number) => ({
    id,
    name: id.toUpperCase(),
    source_path: `/${id}.mov`,
    source_start: 0,
    duration: 100,
    source_len: 100,
    start_frame: start,
  });
  return {
    id: 'no-remount',
    name: 'no-remount',
    rate: { num: 25, den: 1 },
    tracks: [{ kind: 'video', clips: [clip('a', 0), clip('b', 100)] }],
  } as unknown as Timeline;
}

let ui: MountedComponent | null = null;
let restoreRO: () => void;
let console_: ReturnType<typeof captureConsole>;

const panel = () => document.querySelector('[data-chroma-panel="clip-inspector"]');
const ratioToggle = () => document.querySelector('[aria-label="Link width and height"]') as HTMLButtonElement | null;
const select = (id: string) => actSync(() => useEditorTimelineStore.setState({ selection: [{ track: 0, id }] }));

beforeEach(async () => {
  restoreRO = installResizeObserverStub();
  console_ = captureConsole();
  actSync(() =>
    useEditorTimelineStore.setState({
      timeline: fixture(),
      openProjectKey: '/p/no-remount.chroma',
      status: 'ready',
      error: null,
      selection: [],
      playhead: 0,
    }),
  );
  openAllInspectorSections(useEditorTimelineStore);
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

describe('B-379 — the Inspector is not remounted for a new clip', () => {
  it('keeps the very same panel element across a selection change', async () => {
    select('a');
    await waitFrames(3);
    const first = panel();
    expect(first).not.toBeNull();

    select('b');
    await waitFrames(3);

    // The identical node, not merely an equivalent one. With D-193's `key`
    // this was a different element every time the selection changed.
    expect(panel()).toBe(first);
  });

  it('still resets the ratio lock to the newly selected clip default', async () => {
    select('a');
    await waitFrames(3);
    const toggle = ratioToggle();
    expect(toggle).not.toBeNull();
    expect(toggle?.getAttribute('aria-pressed')).toBe('true');

    // Unlink it on this clip — the ephemeral, per-clip UI state D-193 cared about.
    actSync(() => toggle?.click());
    expect(ratioToggle()?.getAttribute('aria-pressed')).toBe('false');

    select('b');
    await waitFrames(3);

    // Back to the new clip's own default, with no remount to do it.
    expect(ratioToggle()?.getAttribute('aria-pressed')).toBe('true');
  });

  it('does not carry the unlinked state back when the first clip is reselected', async () => {
    select('a');
    await waitFrames(3);
    actSync(() => ratioToggle()?.click());
    expect(ratioToggle()?.getAttribute('aria-pressed')).toBe('false');

    select('b');
    await waitFrames(3);
    select('a');
    await waitFrames(3);

    // Reselecting is a shot change like any other: the default, not the state
    // this clip happened to be left in.
    expect(ratioToggle()?.getAttribute('aria-pressed')).toBe('true');
  });
});
