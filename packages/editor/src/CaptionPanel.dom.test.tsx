// @vitest-environment jsdom
/**
 * @chroma/editor — the Captions panel's real behaviour (D-243).
 *
 * `captionPresets.test.ts` proves the preset DATA is sane and
 * `captionAnim.test.ts` proves the model's arithmetic. What neither can catch
 * is the panel wiring: a library tile that renders but applies nothing, or
 * applies the wrong preset, or drops a caption onto a video track. Those are
 * only visible by mounting the thing and clicking it, which is what this file
 * does.
 *
 * The placement path itself (`applyCaptionPreset`) is exercised here through
 * the UI rather than being stubbed, deliberately: it is the SAME function
 * `editor_add_caption_preset` calls, so proving it through the panel proves it
 * for the agent surface too (CLAUDE.md's human-AND-AI rule).
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
const { CaptionPanel } = await import('./CaptionPanel');
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
  // The panel contains a ScrollArea, whose Base UI viewport calls
  // `Element.getAnimations` from a timer — absent in jsdom (see the stub).
  restoreAnimations = installElementAnimationsStub();
  useEditorTimelineStore.setState({
    timeline: fixture(),
    status: 'ready',
    error: null,
    playhead: 0,
    playing: false,
    selection: [],
    selectedGap: null,
    // D-252 — the popover's open flag now lives in this shared store (was a
    // per-mount `useState`), so it must be reset here the same way every
    // other piece of this fixture's state is, or a previous test's open
    // popover leaks into the next test's fresh mount as already-open.
    openPanels: {},
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
  mounted = mount(React.createElement(CaptionPanel), { strictMode: true });
  await waitFrames(2);
}

/** Open the popover by clicking the trigger. The library lives inside it, so
 *  nothing is in the DOM until this runs. */
async function openPanel() {
  const trigger = mounted!.container.querySelector<HTMLElement>(
    '[data-testid="caption-panel-trigger"]',
  );
  expect(trigger, 'the Captions trigger should render').not.toBeNull();
  trigger!.click();
  await waitFrames(3);
}

/** The popover renders in a portal, so queries go against the document. */
function q(selector: string): HTMLElement | null {
  return document.querySelector(selector);
}

describe('the Captions panel', () => {
  /** B-121 — the panel was correctly wired into the toolbar and correctly
   *  rendering, and the owner still could not find the caption styles: its
   *  trigger was labelled "Subtitles", exactly like the D-229 button that went
   *  straight to a file picker and which D-243 replaced. Nothing on the control
   *  said it had become something else, so it read as the thing it used to be.
   *  This pins the two properties that fix that — the name of the feature, and
   *  a visible sign that it opens a panel rather than a file dialog. */
  it('is labelled for the feature it opens, not for the button it replaced', async () => {
    await render();
    const trigger = mounted!.container.querySelector<HTMLElement>(
      '[data-testid="caption-panel-trigger"]',
    );
    expect(trigger, 'the trigger must actually be in the DOM').not.toBeNull();
    expect(trigger!.textContent).toContain('Captions');
    expect(
      trigger!.textContent,
      'a plain "Subtitles" label is what made this indistinguishable from the import button',
    ).not.toContain('Subtitles');
    // A disclosure affordance — the reason a user expects a panel here rather
    // than an immediate file dialog.
    expect(trigger!.querySelectorAll('svg').length).toBeGreaterThanOrEqual(2);
  });

  it('opens on click and shows the preset library', async () => {
    await render();
    expect(q('[data-testid="caption-panel"]'), 'closed before the click').toBeNull();
    await openPanel();
    expect(q('[data-testid="caption-panel"]')).not.toBeNull();
  });

  it('renders a tile with a live thumbnail for every preset in the library', async () => {
    await render();
    await openPanel();
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
    await openPanel();
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
    await openPanel();

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
    await openPanel();
    (q('[data-testid="caption-preset-caption-highlight"]') as HTMLElement).click();
    await waitFrames(3);

    const afterFirst = useEditorTimelineStore.getState().timeline!;
    const subtitleCount = afterFirst.tracks.filter((t) => t.kind === 'subtitle').length;
    expect(subtitleCount).toBe(1);

    // Re-open (the panel closes on pick) and choose a different look.
    await openPanel();
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
    await openPanel();
    (q('[data-testid="caption-preset-plain-subtitle"]') as HTMLElement).click();
    await waitFrames(3);

    const tl = useEditorTimelineStore.getState().timeline!;
    const subIndex = tl.tracks.findIndex((t) => t.kind === 'subtitle');
    expect(captionAnimationOf(tl.tracks[subIndex].caption_style).kind).toBe('none');
  });
});
