// @vitest-environment jsdom
/**
 * @chroma/editor — the clip Inspector's Video / Audio tabs (D-246).
 *
 * **Why a DOM test.** `clipInspectorTabs.test.ts` proves the pure model (which
 * tabs a clip has, how a remembered one resolves). What only this level can
 * prove is the thing the owner actually asked for and the thing a
 * reorganisation like this most easily breaks: that no control was LOST in the
 * move. Every section that existed down the old single scroll is still on
 * screen, on exactly one tab, reachable by clicking the same tab bar a human
 * clicks — and the controls themselves still write the same ops through the
 * same store, unchanged, on either tab.
 *
 * It also pins the two state questions a tab split introduces: switching tabs
 * does not throw away an in-progress edit or the panel's own local UI state,
 * and the tab itself is store state (`inspectorTab`) so the human's click and
 * `debug_set_inspector_tab` drive one thing, not two — CLAUDE.md's
 * one-action-under-both-interfaces rule.
 *
 * Same tier and same honest limits as its neighbours: jsdom, real components,
 * a real store, a stubbed Tauri `invoke`.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

import {
  actSync,
  installResizeObserverStub,
  mount,
  stubOffsetMetrics,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

/** The backend's copy of the timeline, for the one path that really re-reads
 *  it: undo/redo (`restoreSnapshot` persists, then refetches to reconcile).
 *  Hoisted so the `vi.mock` factory below can see it. */
const backend = vi.hoisted(() => ({ timeline: null as unknown }));

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async (cmd: string) => {
    if (cmd === 'chroma_timeline_get') return backend.timeline;
    if (cmd === 'chroma_timeline_set') return null;
    if (cmd === 'chroma_timeline_clip_geometry') {
      return { compWidth: 1920, compHeight: 1080, naturalWidth: 1, naturalHeight: 1 };
    }
    return null;
  },
}));

const { useEditorTimelineStore } = await import('./timelineStore');
const { EditorInspectorPanel } = await import('./EditorInspectorPanel');
const { useHistoryStore } = await import('@chroma/history');
import { DEFAULT_TEXT_FONT, type Clip, type Timeline } from './timeline';

const CLIP_ID = 'clip-1';
const TEXT_CLIP_ID = 'title-1';

/** Every section the pre-D-246 Inspector rendered for an ordinary media clip,
 *  by its own heading. The point of the list is completeness: the union of the
 *  two tabs has to be exactly this, or the reorganisation dropped something. */
const ALL_SECTIONS = ['Transform', 'Crop', 'Dynamic Zoom', 'Speed', 'Fade', 'Audio', 'EQ', 'Keyframes'];
const VIDEO_SECTIONS = ['Transform', 'Crop', 'Dynamic Zoom', 'Speed', 'Fade', 'Keyframes'];
const AUDIO_SECTIONS = ['Audio', 'EQ'];

function fixture(): Timeline {
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
  const title: Clip = {
    id: TEXT_CLIP_ID,
    name: 'AFTER',
    source_path: '',
    source_start: 0,
    duration: 120,
    source_len: 120,
    start_frame: 0,
    text: { content: 'AFTER', font: DEFAULT_TEXT_FONT, size: 0.12, color: '#FFFFFF' },
  } as unknown as Clip;
  return {
    id: 'tl',
    name: 'Timeline',
    rate: 24,
    tracks: [{ kind: 'video', clips: [clip, title] }],
  } as unknown as Timeline;
}

let mounted: MountedComponent | null = null;
let restoreResizeObserver: (() => void) | null = null;
let restoreOffsetMetrics: (() => void) | null = null;

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  // The EQ response graph needs a real offset size to draw against (jsdom has
  // no layout) — the same stub `ClipInspectorPanel.eq.dom.test.tsx` installs,
  // and needed here for the same reason: the Audio tab renders that graph.
  restoreOffsetMetrics = stubOffsetMetrics(280, 92);
  useHistoryStore.getState().clear();
  backend.timeline = fixture();
  useEditorTimelineStore.setState({
    timeline: fixture(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [{ track: 0, id: CLIP_ID }],
    selectedGap: null,
    inspectorTab: 'video',
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
  restoreOffsetMetrics?.();
  restoreOffsetMetrics = null;
});

async function render() {
  mounted = mount(React.createElement(EditorInspectorPanel), { strictMode: true });
  await waitFrames(2);
}

/** The section headings currently on screen, in render order. */
function sections(): string[] {
  return [...(mounted?.container.querySelectorAll('h3') ?? [])].map((h) => h.textContent ?? '');
}

function tab(label: string): HTMLElement {
  const el = [...(mounted?.container.querySelectorAll('[role="tab"]') ?? [])].find(
    (t) => t.textContent === label,
  );
  if (!el) throw new Error(`no ${label} tab — tabs are ${tabLabels().join(', ') || '(none)'}`);
  return el as HTMLElement;
}

function tabLabels(): string[] {
  return [...(mounted?.container.querySelectorAll('[role="tab"]') ?? [])].map(
    (t) => t.textContent ?? '',
  );
}

async function clickTab(label: string) {
  const el = tab(label);
  actSync(() => el.click());
  await waitFrames(2);
}

function field(label: string): HTMLInputElement {
  const labels = [...(mounted?.container.querySelectorAll('label') ?? [])];
  const hit = labels.find((l) => l.querySelector('span')?.textContent === label);
  const input = hit?.querySelector('input');
  if (!input) throw new Error(`no field labelled "${label}"`);
  return input as HTMLInputElement;
}

function type(input: HTMLInputElement, value: number) {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  actSync(() => {
    setter?.call(input, String(value));
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

function currentClip(): Clip {
  const tl = useEditorTimelineStore.getState().timeline;
  if (!tl) throw new Error('no timeline');
  return tl.tracks[0].clips[0];
}

describe('the clip Inspector’s Video / Audio tabs (D-246)', () => {
  it('opens on Video, showing the picture sections and none of the sound ones', async () => {
    await render();
    expect(tabLabels()).toEqual(['Video', 'Audio']);
    expect(tab('Video').getAttribute('aria-selected')).toBe('true');
    expect(tab('Audio').getAttribute('aria-selected')).toBe('false');
    expect(sections()).toEqual(VIDEO_SECTIONS);
  });

  it('clicking Audio swaps the panel to the sound sections', async () => {
    await render();
    await clickTab('Audio');
    expect(sections()).toEqual(AUDIO_SECTIONS);
    expect(tab('Audio').getAttribute('aria-selected')).toBe('true');
    // The rows themselves came with it, not just the headings.
    expect(field('Volume').value).toBe('1');
    expect(field('Pan').value).toBe('0');
  });

  it('every section the old single scroll had is still reachable, on exactly one tab', async () => {
    await render();
    const video = sections();
    await clickTab('Audio');
    const audio = sections();

    // Nothing lost…
    expect([...video, ...audio].sort()).toEqual([...ALL_SECTIONS].sort());
    // …and nothing duplicated across the two, which would be two controls
    // editing one value from two places.
    expect(video.filter((s) => audio.includes(s))).toEqual([]);
  });

  it('the tab is one piece of state: the human’s click writes what the debug op reads', async () => {
    await render();
    await clickTab('Audio');
    // What `debug_set_inspector_tab` / `debug_get_ui_state` see.
    expect(useEditorTimelineStore.getState().inspectorTab).toBe('audio');

    // …and the reverse direction: driving the store (which is exactly what
    // that op does — the same action, never a simulated click) moves the UI.
    actSync(() => useEditorTimelineStore.getState().setInspectorTab('video'));
    await waitFrames(2);
    expect(sections()).toEqual(VIDEO_SECTIONS);
    expect(tab('Video').getAttribute('aria-selected')).toBe('true');
  });

  it('the tab bar is reachable from the keyboard, like any real tab strip', async () => {
    await render();
    const videoTab = tab('Video');
    actSync(() => videoTab.focus());
    expect(document.activeElement).toBe(videoTab);

    // Base UI's tab strip is a composite: the roving arrow-key handler lives
    // on the LIST, not on the individual tab (it bubbles there from the
    // focused tab in a browser), and it moves FOCUS — `activateOnFocus` is
    // off by default, so the panel does not swap out from under a user who is
    // only arrowing along the strip.
    const list = mounted?.container.querySelector('[role="tablist"]');
    actSync(() => {
      list?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true, cancelable: true }),
      );
    });
    await waitFrames(2);
    expect(document.activeElement).toBe(tab('Audio'));
    expect(useEditorTimelineStore.getState().inspectorTab).toBe('video');

    // Activation is the second press. Every tab is a real <button>, so in a
    // browser Enter/Space raise the same `click` the mouse does — which is the
    // path the cases above already drive end to end. jsdom does not synthesise
    // that click from a key event, so this asserts the property that makes it
    // true rather than pretending to press the key.
    expect((document.activeElement as HTMLElement).tagName).toBe('BUTTON');
    actSync(() => (document.activeElement as HTMLElement).click());
    await waitFrames(2);
    expect(useEditorTimelineStore.getState().inspectorTab).toBe('audio');
    expect(sections()).toEqual(AUDIO_SECTIONS);
  });

  it('switching tabs does not throw away an edit, on either side of the trip', async () => {
    await render();
    type(field('Opacity'), 0.5);
    await waitFrames(1);
    expect(currentClip().opacity).toBe(0.5);

    await clickTab('Audio');
    type(field('Volume'), 0.25);
    await waitFrames(1);

    await clickTab('Video');
    // The transform edit survived the round trip, in the store AND on screen…
    expect(currentClip().opacity).toBe(0.5);
    expect(field('Opacity').value).toBe('0.5');
    // …and so did the audio edit made while it was hidden.
    expect(currentClip().volume).toBe(0.25);
  });

  it('the panel’s own local UI state survives a tab round trip', async () => {
    await render();
    const lock = [...(mounted?.container.querySelectorAll('button') ?? [])].find(
      (b) => b.getAttribute('title') === 'Unlock aspect ratio',
    );
    expect(lock).toBeTruthy();
    actSync(() => (lock as HTMLElement).click());
    await waitFrames(1);

    await clickTab('Audio');
    await clickTab('Video');
    // The ratio lock (D-193) is component-local, ephemeral state; a tab switch
    // is not a new selection, so it must not reset the way `key={clip.id}`
    // resets it when the user really does pick a different clip.
    const after = [...(mounted?.container.querySelectorAll('button') ?? [])].find(
      (b) => b.getAttribute('title')?.includes('aspect ratio'),
    );
    expect(after?.getAttribute('title')).toBe('Lock aspect ratio');
  });

  it('the chosen tab is sticky across selections, and a title falls back without forgetting it', async () => {
    await render();
    await clickTab('Audio');

    // A title has no audio at all, so no Audio tab — and with one tab left,
    // no tab bar: exactly the panel a title had before tabs existed.
    actSync(() => {
      useEditorTimelineStore.setState({ selection: [{ track: 0, id: TEXT_CLIP_ID }] });
    });
    await waitFrames(2);
    expect(tabLabels()).toEqual([]);
    expect(sections()).toContain('Transform');
    // The fallback is a display resolution, not a write: the user's choice is
    // still there…
    expect(useEditorTimelineStore.getState().inspectorTab).toBe('audio');

    // …and comes back the moment they select a clip that has that tab.
    actSync(() => {
      useEditorTimelineStore.setState({ selection: [{ track: 0, id: CLIP_ID }] });
    });
    await waitFrames(2);
    expect(sections()).toEqual(AUDIO_SECTIONS);
  });

  it('undo still works from either tab, and the tab itself is not undoable', async () => {
    await render();
    await clickTab('Audio');
    type(field('Volume'), 0.25);
    await waitFrames(1);
    expect(useHistoryStore.getState().undoStack.length).toBe(1);

    actSync(() => useHistoryStore.getState().undo());
    await waitFrames(2);
    expect(currentClip().volume).toBeUndefined();
    // D-216 — a tab is session chrome, never an `EditOp`: undoing an edit must
    // not also drag the panel back to a tab the user left, and switching tabs
    // must never push a history entry of its own.
    expect(useEditorTimelineStore.getState().inspectorTab).toBe('audio');
    const depth = useHistoryStore.getState().undoStack.length;
    await clickTab('Video');
    expect(useHistoryStore.getState().undoStack.length).toBe(depth);
  });
});
