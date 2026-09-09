// @vitest-environment jsdom
/**
 * @apelles/editor — the caption library's real behaviour (D-243; docked by
 * D-263, which is why this file is no longer `CaptionPanel.dom.test.tsx`).
 *
 * `captionPresets.test.ts` proves the preset DATA is sane and
 * `captionAnim.test.ts` proves the model's arithmetic. What neither can catch
 * is the wiring: a library tile that renders but applies nothing, or applies
 * the wrong preset, or drops a caption onto a video track. Those are only
 * visible by mounting the thing and clicking it, which is what this file does.
 *
 * The placement path itself (`applyCaptionPreset`) is exercised here through
 * the UI rather than being stubbed, deliberately: it is the SAME function
 * `editor_add_caption_preset` calls, so proving it through the library proves
 * it for the agent surface too (CLAUDE.md's human-AND-AI rule).
 *
 * **What D-263 changed for these tests.** There is no trigger to click and no
 * popover to open: the library is docked content now, so it is in the DOM as
 * soon as it is mounted, and it stays there after a pick (which is the point —
 * a second look can be tried straight after the first). Every assertion below
 * about what the library DOES is unchanged.
 */

import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import React from 'react';

import {
  installElementAnimationsStub,
  installResizeObserverStub,
  mount,
  waitFrames,
  type MountedComponent,
} from './testUtils/pointerHarness';

vi.mock('@tauri-apps/api/core', () => ({
  invoke: async () => null,
}));
vi.mock('@tauri-apps/plugin-dialog', () => ({
  open: async () => null,
}));

const { useEditorTimelineStore } = await import('./timelineStore');
const { CaptionLibrary } = await import('./CaptionLibrary');
const { CAPTION_PRESETS } = await import('./captionPresets');
const { captionAnimationOf } = await import('./captionAnim');
import type { Clip, Timeline } from './timeline';

function fixture(): Timeline {
  const videoClip: Clip = {
    id: 'v1',
    name: 'shot.mp4',
    source_path: '/media/shot.mp4',
    source_start: 0,
    duration: 240,
    source_len: 240,
    source_fps: 24,
    start_frame: 0,
  } as Clip;
  return {
    id: 'tl',
    name: 'Timeline',
    rate: 24,
    tracks: [{ kind: 'video', clips: [videoClip] }],
  } as unknown as Timeline;
}

let mounted: MountedComponent | null = null;
let restoreResizeObserver: (() => void) | null = null;
let restoreAnimations: (() => void) | null = null;

beforeEach(() => {
  restoreResizeObserver = installResizeObserverStub();
  // Base UI's `Tabs` reaches for `Element.getAnimations` — absent in jsdom
  // (see the stub).
  restoreAnimations = installElementAnimationsStub();
  useEditorTimelineStore.setState({
    timeline: fixture(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [],
    selectedGap: null,
  });
});

afterEach(() => {
  mounted?.unmount();
  mounted = null;
  restoreResizeObserver?.();
  restoreResizeObserver = null;
  restoreAnimations?.();
  restoreAnimations = null;
});

async function render() {
  mounted = mount(React.createElement(CaptionLibrary), { strictMode: true });
  await waitFrames(2);
}

function q(selector: string): HTMLElement | null {
  return document.querySelector(selector);
}

describe('the caption library', () => {
  /** B-121 — the styles were once behind a button labelled like the file-picker
   *  button it had replaced, and the owner could not find them. D-263 removed
   *  the button entirely: selecting Subtitles on the library rail puts the
   *  styled tiles on screen, on the Styles tab, with nothing to click first.
   *  That is the same property, pinned at its new (stronger) location. */
  it('shows the styled preset tiles immediately, with no trigger to find first', async () => {
    await render();
    expect(q('[data-testid="caption-library"]'), 'the library is docked content').not.toBeNull();
    expect(
      q('[data-testid="caption-preset-caption-highlight"]'),
      'a real preset tile, on the default (Styles) tab',
    ).not.toBeNull();
  });

  it('renders a tile with a live thumbnail for every preset in the library', async () => {
    await render();
    for (const preset of CAPTION_PRESETS) {
      expect(q(`[data-testid="caption-preset-${preset.id}"]`), `${preset.id} tile`).not.toBeNull();
      // The thumbnail is the preset's own style in CSS — its absence would
      // mean the library shows names with no indication of what they look
      // like, which is the whole point of a library.
      expect(
        q(`[data-testid="caption-preset-thumb-${preset.id}"]`),
        `${preset.id} thumbnail`,
      ).not.toBeNull();
    }
  });

  it('offers the D-229 import path as its own tab', async () => {
    await render();
    const importTab = [...document.querySelectorAll('button')].find(
      (b) => b.textContent?.trim() === 'Import',
    );
    expect(importTab, 'an Import tab').toBeDefined();
    importTab!.click();
    await waitFrames(3);
    expect(q('[data-testid="caption-import"]')).not.toBeNull();
  });

  it('clicking a preset creates a subtitle track and drops a caption on it', async () => {
    await render();

    expect(
      useEditorTimelineStore.getState().timeline?.tracks.some((t) => t.kind === 'subtitle'),
      'no subtitle track before the click',
    ).toBe(false);

    const preset = CAPTION_PRESETS.find((p) => p.id === 'caption-highlight')!;
    (q(`[data-testid="caption-preset-${preset.id}"]`) as HTMLElement).click();
    await waitFrames(3);

    const tl = useEditorTimelineStore.getState().timeline!;
    const subIndex = tl.tracks.findIndex((t) => t.kind === 'subtitle');
    expect(subIndex, 'a subtitle track was created').toBeGreaterThanOrEqual(0);

    // The preset's STYLE landed on the track...
    const style = tl.tracks[subIndex].caption_style;
    expect(style).toBeTruthy();
    expect(style?.color).toBe(preset.style.color);
    expect(captionAnimationOf(style).kind).toBe('highlight');
    expect(captionAnimationOf(style).active_box_color).toBe('#FF1745');

    // ...and a real caption clip is on it, so the preset is visible at once
    // rather than being an invisible style change on an empty track.
    const clips = tl.tracks[subIndex].clips;
    expect(clips).toHaveLength(1);
    expect(clips[0].caption?.text?.length ?? 0).toBeGreaterThan(0);
    expect(clips[0].duration).toBeGreaterThan(0);
  });

  it('applies a different preset to the SAME track rather than stacking tracks', async () => {
    await render();
    (q('[data-testid="caption-preset-caption-highlight"]') as HTMLElement).click();
    await waitFrames(3);

    const afterFirst = useEditorTimelineStore.getState().timeline!;
    expect(afterFirst.tracks.filter((t) => t.kind === 'subtitle').length).toBe(1);

    // D-263 — no re-opening step: the library stayed on screen after the pick,
    // which is exactly why a second look can be tried straight away.
    expect(q('[data-testid="caption-preset-caption-kinetic-slam"]'), 'still docked').not.toBeNull();
    (q('[data-testid="caption-preset-caption-kinetic-slam"]') as HTMLElement).click();
    await waitFrames(3);

    const tl = useEditorTimelineStore.getState().timeline!;
    expect(
      tl.tracks.filter((t) => t.kind === 'subtitle').length,
      'a second preset reuses the existing subtitle track',
    ).toBe(1);
    const subIndex = tl.tracks.findIndex((t) => t.kind === 'subtitle');
    // The style is REPLACED, not merged — the previous preset's accent must
    // not survive, or the library's tiles would lie about what they apply.
    expect(captionAnimationOf(tl.tracks[subIndex].caption_style).kind).toBe('slam');
    expect(captionAnimationOf(tl.tracks[subIndex].caption_style).active_box_color).toBeNull();
  });

  it('a static preset applies with no animation at all', async () => {
    await render();
    (q('[data-testid="caption-preset-plain-subtitle"]') as HTMLElement).click();
    await waitFrames(3);

    const tl = useEditorTimelineStore.getState().timeline!;
    const subIndex = tl.tracks.findIndex((t) => t.kind === 'subtitle');
    expect(captionAnimationOf(tl.tracks[subIndex].caption_style).kind).toBe('none');
  });
});
