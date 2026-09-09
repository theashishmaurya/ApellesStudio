// @vitest-environment jsdom
/**
 * @apelles/editor — real-DOM coverage for D-272: the Edit tab Inspector
 * column's "nothing selected" slot fills with the docked `ProjectSettingsPanel`
 * (Resolution / Frame Rate / Colour Space, via the shared `ProjectSettingsForm`)
 * instead of the plain "Select a clip" message.
 *
 * **Why a DOM test and not more unit tests.** `ProjectSettingsForm.dom.test.tsx`
 * already proves the form's own patch shapes in isolation. What only this
 * level proves is the thing the roadmap item actually asked for: (1) the
 * REAL `EditorInspectorPanel` branches to this panel exactly when nothing is
 * selected, and back to the ordinary `ClipInspectorPanel` for a real
 * selection, and (2) the panel is wired to the SAME `chroma_project_get_
 * settings` / `chroma_project_set_settings` commands (and their
 * `chroma://project-settings-changed` broadcast) the Colorist tab's own
 * `ProjectSettingsModal` uses — i.e. no forked, docked-panel-only copy of
 * project settings. That last part is asserted by simulating a write from
 * OUTSIDE this panel (standing in for the modal, or the `set_project_
 * settings` MCP tool) and checking the docked panel picks it up live,
 * exactly like `useCompositionSize`'s own B-086 proof does for the preview's
 * canvas boundary.
 *
 * Same tier as its neighbours: jsdom, the real component, a stubbed Tauri
 * `invoke`/`listen` pair. The stub's `chroma_project_set_settings` handler
 * mirrors the REAL Rust command's own two behaviours exactly (merge-patch —
 * a present key applies, `null` clears, an absent key is untouched — and an
 * unconditional broadcast on every write) rather than a simplified stand-in,
 * since B-086's own bug was a broadcast gap and this test's whole point is
 * proving there isn't a second one here.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React, { act } from 'react';

import { actSync, mount, waitFrames, type MountedComponent } from './testUtils/pointerHarness';

interface SettingsFixture {
  width?: number | null;
  height?: number | null;
  fps?: number | null;
  colorSpace?: string | null;
}

/** Hoisted so the `vi.mock` factories below (hoisted above every `const`)
 *  can close over it. Mirrors `crates/apelles-project/src/manifest.rs`'s own
 *  `ProjectSettings` + `merge_patch`: the real per-project manifest state,
 *  not a copy this test owns independently of what the panel reads/writes. */
const backend = vi.hoisted(() => ({
  settings: {} as SettingsFixture,
  setCalls: [] as SettingsFixture[],
}));

const bus = vi.hoisted(() => ({
  listeners: new Set<(ev: { payload: SettingsFixture }) => void>(),
}));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string, args?: Record<string, unknown>) => {
    if (cmd === 'chroma_project_get_settings') return backend.settings;
    if (cmd === 'chroma_project_set_settings') {
      const patch = (args?.partial ?? {}) as SettingsFixture;
      backend.setCalls.push(patch);
      // The same merge-patch contract `ProjectSettings::merge_patch` has:
      // a PRESENT key applies (`null` clears it), an ABSENT key is left
      // alone — not a blind `Object.assign`, which would silently treat
      // "didn't touch fps" the same as "cleared fps".
      if ('width' in patch) backend.settings.width = patch.width;
      if ('height' in patch) backend.settings.height = patch.height;
      if ('fps' in patch) backend.settings.fps = patch.fps;
      if ('colorSpace' in patch) backend.settings.colorSpace = patch.colorSpace;
      // B-086's own real behaviour: broadcast on every successful write,
      // unconditionally, regardless of which caller made it.
      for (const l of bus.listeners) l({ payload: { ...backend.settings } });
      return { ...backend.settings };
    }
    throw new Error(`no invoke stub for "${cmd}"`);
  },
}));

vi.mock('@tauri-apps/api/event', () => ({
  listen: (event: string, handler: (ev: { payload: SettingsFixture }) => void) => {
    if (event !== 'chroma://project-settings-changed') return Promise.resolve(() => {});
    bus.listeners.add(handler);
    return Promise.resolve(() => {
      bus.listeners.delete(handler);
    });
  },
}));

const { useEditorTimelineStore } = await import('./timelineStore');
const { EditorInspectorPanel } = await import('./EditorInspectorPanel');
import type { Clip, Timeline } from './timeline';

const CLIP_ID = 'clip-1';

function fixtureTimeline(): Timeline {
  const clip: Clip = {
    id: CLIP_ID,
    name: 'shot.mp4',
    source_path: '/media/shot.mp4',
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
  } as unknown as Clip;
  return { id: 'tl', name: 'Timeline', rate: 24, tracks: [{ kind: 'video', clips: [clip] }] } as unknown as Timeline;
}

let mounted: MountedComponent | null = null;

beforeEach(() => {
  backend.settings = {};
  backend.setCalls = [];
  bus.listeners.clear();
  useEditorTimelineStore.setState({
    timeline: fixtureTimeline(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [],
    selectedGap: null,
    inspectorTab: 'video',
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
});

async function render() {
  mounted = mount(React.createElement(EditorInspectorPanel), { strictMode: true });
  await waitFrames(2);
}

function text(): string {
  return mounted?.container.textContent ?? '';
}

function buttons(name: string): HTMLElement[] {
  return [...(mounted?.container.querySelectorAll('button') ?? [])].filter((b) => b.textContent === name);
}

function button(name: string, index = 0): HTMLElement {
  const el = buttons(name)[index];
  if (!el) throw new Error(`no button "${name}" at index ${index}`);
  return el;
}

async function click(el: HTMLElement) {
  actSync(() => el.click());
  await waitFrames(2);
}

describe('EditorInspectorPanel — Project Settings (D-272)', () => {
  it('fills the "nothing selected" slot with the docked Project Settings panel', async () => {
    await render();
    expect(text()).toContain('Project Settings');
    expect(text()).toContain('Canvas');
    expect(text()).toContain('Resolution');
    expect(text()).toContain('Frame Rate');
    expect(text()).toContain('Colour Space');
    // The generic clip-Inspector empty state is gone from this branch.
    expect(text()).not.toContain('Select a clip to edit its properties.');
  });

  it('falls back to the ordinary ClipInspectorPanel once a clip is selected', async () => {
    await render();
    expect(text()).toContain('Project Settings');

    actSync(() => useEditorTimelineStore.setState({ selection: [{ track: 0, id: CLIP_ID }] }));
    await waitFrames(2);

    expect(text()).not.toContain('Project Settings');
    expect(text()).toContain('shot.mp4');
    expect(text()).toContain('Transform');
  });

  it('a resolution preset click writes through the real chroma_project_set_settings command', async () => {
    await render();
    await click(button('Preset', 0));
    await click(button('1080×1920 (vertical)'));

    expect(backend.setCalls).toContainEqual({ width: 1080, height: 1920 });
    expect(backend.settings.width).toBe(1080);
    expect(backend.settings.height).toBe(1920);
  });

  it('single source of truth: a write from OUTSIDE this panel (the Colorist modal, or MCP) is reflected live, with no forked state', async () => {
    await render();

    // Put the Frame Rate section into Custom mode locally (writes an initial
    // seed, 24fps, through the same command).
    await click(button('Custom', 1));
    expect(backend.settings.fps).toBe(24);

    function fpsField(): HTMLInputElement {
      const input = mounted?.container.querySelector('input[type="number"]') as HTMLInputElement | null;
      if (!input) throw new Error('no custom fps field on screen');
      return input;
    }

    // Sanity: the custom fps field really does show the panel's own write.
    // (An `<input>`'s value is never part of `.textContent` — this reads the
    // DOM element's own `value` directly, not `text()`.)
    expect(fpsField().value).toBe('24');

    // Now simulate a write from a DIFFERENT caller entirely — this panel
    // never called `save` for this — standing in for the Colorist tab's
    // `ProjectSettingsModal` (or the `set_project_settings` MCP tool), both
    // of which call the exact same `chroma_project_set_settings` command.
    const externalCallsBefore = backend.setCalls.length;
    const { invoke } = await import('@tauri-apps/api/core');
    await act(async () => {
      await invoke('chroma_project_set_settings', { path: null, partial: { fps: 29.97 } });
    });
    await waitFrames(3);

    expect(backend.setCalls.length).toBe(externalCallsBefore + 1);
    expect(backend.settings.fps).toBe(29.97);
    // The docked panel picked up the SAME write via the broadcast — no
    // separate, stale copy of the fps value left behind in its own state.
    expect(fpsField().value).toBe('29.97');
  });
});
