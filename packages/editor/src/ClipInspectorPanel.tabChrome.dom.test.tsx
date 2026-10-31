// @vitest-environment jsdom
/**
 * @apelles/editor — the clip Inspector tab bar's own CHROME: the deselected
 * panel actually stops painting (B-124), the selected tab has a visible
 * selected state (D-254), and adjacent sections are separated by a real rule
 * (D-254).
 *
 * **What this tier can and cannot prove — read this before trusting it.**
 * B-124 was a bug about what the browser PAINTS, and jsdom paints nothing: it
 * has no layout, it never applies a Tailwind class to anything, and its
 * `getComputedStyle` will happily report a `display` that no stylesheet ever
 * set. Worse, jsdom is the one environment in which B-124 structurally
 * *cannot* happen — Base UI's `useAnimationsFinished` starts with
 * `if (typeof element.getAnimations !== 'function') { run(); return; }`, and
 * jsdom does not implement `getAnimations`, so the deselected panel unmounts
 * synchronously here no matter how broken the real thing is. A test in this
 * file asserting "only one panel is in the DOM" would pass on the BROKEN
 * build. That is the same trap B-123 documented (every tier seeded the one
 * arrangement that cannot see the defect), and it is why the real proof for
 * B-124 is a real-Chromium CDP run with `requestAnimationFrame` stubbed dead
 * — the numbers are in that bug's entry in `docs/BUGS.md`.
 *
 * So what these tests pin is the part jsdom CAN hold honestly: the CONTRACT
 * the fix depends on. Base UI marks the selected tab with `data-active` and
 * the deselected panel with `inert` — both written straight from render, both
 * checked here against the real primitive. If Base UI ever renames either,
 * these fail loudly, which is exactly the warning that was missing when the
 * `data-selected:` styling quietly matched nothing for four days. The class
 * strings that key off those attributes are asserted alongside them, so the
 * attribute and the rule that consumes it can never drift apart silently.
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
const { useHistoryStore } = await import('@apelles/history');
import type { Clip, Timeline } from './timeline';
import { sectionTitles } from './testUtils/inspectorDom';

const CLIP_ID = 'clip-1';

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
  return {
    id: 'tl',
    name: 'Timeline',
    rate: 24,
    tracks: [{ kind: 'video', clips: [clip] }],
  } as unknown as Timeline;
}

let mounted: MountedComponent | null = null;
let restoreResizeObserver: (() => void) | null = null;
let restoreOffsetMetrics: (() => void) | null = null;

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
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

function triggers(): HTMLElement[] {
  return [...(mounted?.container.querySelectorAll('[role="tab"]') ?? [])] as HTMLElement[];
}

function trigger(label: string): HTMLElement {
  const hit = triggers().find((t) => t.getAttribute('aria-label') === label);
  if (!hit) throw new Error(`no ${label} tab`);
  return hit;
}

function panels(): HTMLElement[] {
  return [...(mounted?.container.querySelectorAll('[data-slot="tabs-content"]') ?? [])] as HTMLElement[];
}

async function clickTab(label: string) {
  const el = trigger(label);
  actSync(() => el.click());
  await waitFrames(2);
}

describe('clip Inspector tab chrome (B-124 / D-254)', () => {
  it('marks the selected tab with `data-active` — the attribute the styling keys on', async () => {
    await render();

    expect(trigger('Video').hasAttribute('data-active')).toBe(true);
    expect(trigger('Audio').hasAttribute('data-active')).toBe(false);
    // The dead selector that shipped. Base UI has never emitted this; if a
    // future Base UI starts to, that is a real signal worth failing on, not a
    // silent restyle.
    expect(trigger('Video').hasAttribute('data-selected')).toBe(false);

    await clickTab('Audio');
    expect(trigger('Audio').hasAttribute('data-active')).toBe(true);
    expect(trigger('Video').hasAttribute('data-active')).toBe(false);
  });

  it('styles the selected tab off `data-active`, with the app’s own accent underline', async () => {
    await render();
    // Both triggers carry the same rule — it is the attribute that moves, not
    // the class — so reading either one pins it.
    // D-432 — an icon tab: the active one is an accent icon on bg-secondary
    // (the old accent underline went with the full-width line tabs).
    const cls = trigger('Video').className;
    expect(cls).toContain('data-active:bg-bg-secondary');
    expect(cls).toContain('data-active:text-accent-text');
    expect(cls).not.toContain('data-selected:');
  });

  it('gives the tab panel both rules that stop a stuck deselected panel painting', async () => {
    await render();
    const cls = panels()[0].className;
    // B-124 — `inert` is render-derived (Base UI writes it straight from
    // `open`), so this one is correct on the very commit the tab changes even
    // when the rAF-gated unmount never runs.
    expect(cls).toContain('[&[inert]]:hidden');
    // …and this one beats the UA `[hidden]{display:none}` losing to any
    // author-origin `display` utility on the same element.
    expect(cls).toContain('[&[hidden]]:hidden');
  });

  it('marks the deselected panel `inert` whenever it is still in the DOM', async () => {
    await render();
    await clickTab('Audio');
    // jsdom usually unmounts it outright (see this file's header) — the
    // assertion is conditional on purpose rather than asserting a DOM shape
    // this environment does not honestly reproduce. When Base UI DOES keep it,
    // as the real webview does, it must be inert, because that is the single
    // signal the hiding rule above depends on.
    for (const p of panels()) {
      const isAudio = sectionTitles(p).includes('Audio');
      if (!isAudio) expect(p.hasAttribute('inert')).toBe(true);
    }
    // Whatever is NOT inert is the audio panel, and there is exactly one.
    const live = panels().filter((p) => !p.hasAttribute('inert'));
    expect(live).toHaveLength(1);
    expect(sectionTitles(live[0])).toContain('Audio');
  });

  it('separates sections with a real rule, on BOTH tabs (each section owns its bottom border)', async () => {
    await render();

    const videoPanel = panels().filter((p) => !p.hasAttribute('inert'))[0];
    const videoSections = [...videoPanel.children] as HTMLElement[];
    // D-432 — the rule moved from a `* + *` selector on the panel into the
    // section itself, so a section can never lose its divider by being
    // reordered, and sections are full-bleed (no panel padding).
    expect(videoSections.length).toBeGreaterThanOrEqual(7);
    for (const sec of videoSections) {
      expect(sec.hasAttribute('data-chroma-section')).toBe(true);
      expect(sec.className).toContain('border-b');
      expect(sec.className).toContain('border-border-color');
    }

    await clickTab('Audio');
    const audioPanel = panels().filter((p) => !p.hasAttribute('inert'))[0];
    expect([...audioPanel.children].map((c) => c.getAttribute('data-chroma-section'))).toEqual(['audio', 'eq']);
  });
});
